import { Router } from "express";
import { z } from "zod";
import { requireAuth, resolveUser } from "../middleware/auth.js";
import { prisma } from "../lib/db.js";

const router = Router();

// GET /api/content/:id - get specific content card
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const card = await prisma.contentCard.findUnique({
      where: { id },
      include: {
        moodEntry: {
          select: { userId: true, moodType: true, moodText: true },
        },
      },
    });

    if (!card) {
      res.status(404).json({ error: "Content card not found" });
      return;
    }

    const user = await resolveUser(req.user!.sub);
    if (!user || card.moodEntry.userId !== user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    res.json(card);
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

    const [cards, total] = await Promise.all([
      prisma.contentCard.findMany({
        where: { moodEntry: { userId: user.id } },
        include: {
          moodEntry: {
            select: { moodType: true, moodText: true, createdAt: true },
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

    res.json({ data: cards, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

export default router;
