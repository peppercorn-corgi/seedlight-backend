import { Router } from "express";
import { z } from "zod";
import { requireAuth, resolveUser } from "../middleware/auth.js";
import { generateContent } from "../services/content.js";
import { classifyMood, analyzeMoodTrend } from "../services/mood.js";
import { prisma } from "../lib/db.js";

const router = Router();

const VALID_MOODS = [
  "anxious", "sad", "grateful", "confused", "angry",
  "hopeful", "lonely", "joyful", "fearful", "guilty",
  "peaceful", "overwhelmed", "doubtful", "grieving", "exhausted",
] as const;

const moodSubmitSchema = z.object({
  moodType: z.enum(VALID_MOODS).optional(),
  moodText: z.string().min(2).max(500).optional(),
}).refine((data) => data.moodType || data.moodText, {
  message: "Either moodType or moodText must be provided",
});

// POST /api/mood - submit mood, generate content
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const parsed = moodSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const user = await resolveUser(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "User not found. Please call /api/auth/sync first." });
      return;
    }

    const { moodText } = parsed.data;
    let moodType: string | undefined = parsed.data.moodType;

    // If no moodType but has moodText, classify from text
    if (!moodType && moodText) {
      moodType = classifyMood(moodText);
    }

    // Create mood entry
    const moodEntry = await prisma.moodEntry.create({
      data: {
        userId: user.id,
        moodType: moodType!,
        moodText: moodText || null,
      },
    });

    // Generate content
    const forceLegacy = req.query.flow === "legacy";
    const content = await generateContent(user.id, moodType!, moodText, forceLegacy);

    // Save content card
    const contentCard = await prisma.contentCard.create({
      data: {
        moodEntryId: moodEntry.id,
        scriptureRef: content.scriptureRef,
        scriptureZh: content.scriptureZh,
        scriptureEn: content.scriptureEn,
        exegesis: content.exegesis,
        secularLink: content.secularLink,
        covenant: content.covenant,
        language: content.language,
        aiModel: content.aiModel,
        verified: content.verified,
      },
    });

    // Audio is generated on-demand when user clicks play (POST /api/audio/:id/generate)

    res.status(201).json({
      moodEntry: {
        id: moodEntry.id,
        moodType: moodEntry.moodType,
        moodText: moodEntry.moodText,
        createdAt: moodEntry.createdAt,
      },
      contentCard,
    });
  } catch (err) {
    next(err);
  }
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/mood/history - get user's mood history with pagination
router.get("/history", requireAuth, async (req, res, next) => {
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

    const [entries, total] = await Promise.all([
      prisma.moodEntry.findMany({
        where: { userId: user.id },
        include: {
          contentCard: {
            select: { id: true, scriptureRef: true },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.moodEntry.count({ where: { userId: user.id } }),
    ]);

    res.json({ data: entries, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

const summarySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

// GET /api/mood/summary - mood trend summary for recent period
router.get("/summary", requireAuth, async (req, res, next) => {
  try {
    const parsed = summarySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const user = await resolveUser(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "User not found. Please call /api/auth/sync first." });
      return;
    }

    const trend = await analyzeMoodTrend(user.id, parsed.data.days);
    res.json(trend);
  } catch (err) {
    next(err);
  }
});

export default router;
