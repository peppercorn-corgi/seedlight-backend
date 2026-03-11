import { Router } from "express";
import { z } from "zod";
import { optionalAuth, resolveUser } from "../middleware/auth.js";
import { prisma } from "../lib/db.js";

const router = Router();

const feedbackSchema = z.object({
  message: z.string().min(1).max(2000),
  contact: z.string().max(200).optional(),
  contentCardId: z.string().optional(),
  page: z.string().max(50).optional(),
});

// POST /api/user-feedback — submit text feedback (auth optional)
router.post("/", optionalAuth, async (req, res, next) => {
  try {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid feedback data" });
      return;
    }

    let userId: string | null = null;
    if (req.user?.sub) {
      const user = await resolveUser(req.user.sub);
      userId = user?.id ?? null;
    }

    await prisma.userFeedback.create({
      data: {
        userId,
        message: parsed.data.message,
        contact: parsed.data.contact || null,
        contentCardId: parsed.data.contentCardId || null,
        page: parsed.data.page || null,
      },
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
