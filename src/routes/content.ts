import { Router } from "express";
import { z } from "zod";
import { requireAuth, resolveUser } from "../middleware/auth.js";
import { prisma } from "../lib/db.js";
import { translateContentCard } from "../services/translate.js";

const router = Router();

// GET /api/content/shared/:id - public endpoint for shared content (no auth)
// Optional ?lang=en|zh to return cached translation (used when sharing translated cards)
router.get("/shared/:id", async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const lang = req.query.lang as string | undefined;
    const card = await prisma.contentCard.findUnique({
      where: { id },
      select: {
        id: true,
        scriptureRef: true,
        scriptureZh: true,
        scriptureEn: true,
        exegesis: true,
        secularLink: true,
        covenant: true,
        language: true,
        verified: true,
        createdAt: true,
      },
    });

    if (!card) {
      res.status(404).json({ error: "Content card not found" });
      return;
    }

    // If ?lang= provided and a cached translation exists, overlay translated fields
    if (lang && (lang === "en" || lang === "zh")) {
      const cached = await prisma.contentCardTranslation.findUnique({
        where: { contentCardId_language: { contentCardId: id, language: lang } },
      });
      if (cached) {
        res.json({
          ...card,
          scriptureRef: cached.scriptureRef,
          exegesis: cached.exegesis,
          secularLink: cached.secularLink,
          covenant: cached.covenant,
          language: lang,
        });
        return;
      }
    }

    res.json(card);
  } catch (err) {
    next(err);
  }
});

// POST /api/content/:id/translate - translate content card to target language
router.post("/:id/translate", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const lang = (req.query.lang as string) || "en";

    if (lang !== "en" && lang !== "zh") {
      res.status(400).json({ error: "Supported languages: en, zh" });
      return;
    }

    const user = await resolveUser(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Check card exists and belongs to user
    const card = await prisma.contentCard.findUnique({
      where: { id },
      include: { moodEntry: { select: { userId: true } } },
    });
    if (!card) {
      res.status(404).json({ error: "Content card not found" });
      return;
    }
    if (card.moodEntry.userId !== user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Check cache first
    const cached = await prisma.contentCardTranslation.findUnique({
      where: { contentCardId_language: { contentCardId: id, language: lang } },
    });
    if (cached) {
      res.json({
        scriptureRef: cached.scriptureRef,
        scriptureZh: card.scriptureZh,
        scriptureEn: card.scriptureEn,
        exegesis: cached.exegesis,
        secularLink: cached.secularLink,
        covenant: cached.covenant,
      });
      return;
    }

    // Translate (uses pre-gen exegesis in target language if available, Gemini for the rest)
    const translated = await translateContentCard(
      { contentCardId: id, scriptureRef: card.scriptureRef, exegesis: card.exegesis, secularLink: card.secularLink, covenant: card.covenant },
      user.segment,
      lang as "en" | "zh",
    );

    // Cache the translation
    await prisma.contentCardTranslation.create({
      data: {
        contentCardId: id,
        language: lang,
        scriptureRef: translated.scriptureRef,
        exegesis: translated.exegesis,
        secularLink: translated.secularLink,
        covenant: translated.covenant,
      },
    });

    res.json({
      scriptureRef: translated.scriptureRef,
      scriptureZh: card.scriptureZh,
      scriptureEn: card.scriptureEn,
      exegesis: translated.exegesis,
      secularLink: translated.secularLink,
      covenant: translated.covenant,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/content/:id - get specific content card (includes user's like/save status)
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const user = await resolveUser(req.user!.sub);
    if (!user) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const card = await prisma.contentCard.findUnique({
      where: { id },
      include: {
        moodEntry: {
          select: { userId: true, moodType: true, moodText: true },
        },
        feedbacks: {
          where: { userId: user.id, type: { in: ["like", "save"] } },
          select: { id: true, type: true },
        },
      },
    });

    if (!card) {
      res.status(404).json({ error: "Content card not found" });
      return;
    }

    if (card.moodEntry.userId !== user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const { feedbacks, ...cardData } = card;
    res.json({
      ...cardData,
      likeId: feedbacks.find((f) => f.type === "like")?.id ?? null,
      saveId: feedbacks.find((f) => f.type === "save")?.id ?? null,
    });
  } catch (err) {
    next(err);
  }
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/content/history - get user's content cards with pagination
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { limit, offset } = parsed.data;
    const user = await resolveUser(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "User not found. Please call /api/auth/sync first." });
      return;
    }

    const [cardsRaw, total] = await Promise.all([
      prisma.contentCard.findMany({
        where: { moodEntry: { userId: user.id } },
        include: {
          moodEntry: {
            select: { moodType: true, moodText: true, createdAt: true },
          },
          feedbacks: {
            where: { userId: user.id, type: { in: ["like", "save"] } },
            select: { id: true, type: true },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.contentCard.count({
        where: { moodEntry: { userId: user.id } },
      }),
    ]);

    const cards = cardsRaw.map(({ feedbacks, ...card }) => ({
      ...card,
      likeId: feedbacks.find((f) => f.type === "like")?.id ?? null,
      saveId: feedbacks.find((f) => f.type === "save")?.id ?? null,
    }));

    res.json({ data: cards, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

export default router;
