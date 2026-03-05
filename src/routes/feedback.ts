import { Router } from "express";
import { z } from "zod";
import { requireAuth, resolveUser } from "../middleware/auth.js";
import { prisma } from "../lib/db.js";

const router = Router();

const feedbackSchema = z.object({
  contentCardId: z.string().min(1),
  type: z.enum(["like", "save", "inappropriate"]),
  comment: z.string().max(500).optional(),
});

// POST /api/feedback - submit feedback on a ContentCard
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const user = await resolveUser(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "User not found. Please call /api/auth/sync first." });
      return;
    }

    const { contentCardId, type, comment } = parsed.data;

    // Verify the content card exists and belongs to this user
    const card = await prisma.contentCard.findUnique({
      where: { id: contentCardId },
      select: { moodEntry: { select: { userId: true } } },
    });

    if (!card) {
      res.status(404).json({ error: "Content card not found" });
      return;
    }

    if (card.moodEntry.userId !== user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Upsert: toggle behavior — if feedback exists, this is idempotent
    const feedback = await prisma.feedback.upsert({
      where: {
        contentCardId_userId_type: { contentCardId, userId: user.id, type },
      },
      create: {
        contentCardId,
        userId: user.id,
        type,
        comment: comment || null,
      },
      update: {
        comment: comment || null,
      },
    });

    res.status(201).json(feedback);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/feedback/:id - remove feedback
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const user = await resolveUser(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "User not found. Please call /api/auth/sync first." });
      return;
    }

    const feedback = await prisma.feedback.findUnique({ where: { id } });

    if (!feedback) {
      res.status(404).json({ error: "Feedback not found" });
      return;
    }

    if (feedback.userId !== user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    await prisma.feedback.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/feedback/saved - get user's saved/liked content cards
router.get("/saved", requireAuth, async (req, res, next) => {
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

    const [feedbacks, total] = await Promise.all([
      prisma.feedback.findMany({
        where: {
          userId: user.id,
          type: { in: ["like", "save"] },
        },
        include: {
          contentCard: {
            include: {
              moodEntry: {
                select: { moodType: true, moodText: true, createdAt: true },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.feedback.count({
        where: {
          userId: user.id,
          type: { in: ["like", "save"] },
        },
      }),
    ]);

    res.json({ data: feedbacks, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

export default router;
