import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/db.js";

const router = Router();

const VALID_FAITH_LEVELS = ["seeker", "new_believer", "growing", "mature"] as const;

const VALID_LANGUAGES = ["zh", "en", "both"] as const;

const pushTimeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

const preferencesSchema = z.object({
  faithLevel: z.enum(VALID_FAITH_LEVELS).optional(),
  language: z.enum(VALID_LANGUAGES).optional(),
  pushTime: z.string().regex(pushTimeRegex, "Must be HH:MM format").optional(),
});

// GET /api/user/preferences
router.get("/preferences", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { authProviderId: req.user!.sub },
      select: { segment: true, language: true, onboarded: true, pushTime: true },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ faithLevel: user.segment, language: user.language, onboarded: user.onboarded, pushTime: user.pushTime });
  } catch (err) {
    next(err);
  }
});

// PUT /api/user/preferences
router.put("/preferences", requireAuth, async (req, res, next) => {
  try {
    const parsed = preferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { authProviderId: req.user!.sub },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const updateData: Record<string, unknown> = {};
    if (parsed.data.faithLevel) {
      updateData.segment = parsed.data.faithLevel;
      updateData.onboarded = true;
    }
    if (parsed.data.language) {
      updateData.language = parsed.data.language;
    }
    if (parsed.data.pushTime) {
      updateData.pushTime = parsed.data.pushTime;
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: updateData,
      select: { segment: true, language: true, onboarded: true, pushTime: true },
    });

    res.json({
      faithLevel: updated.segment,
      language: updated.language,
      onboarded: updated.onboarded,
      pushTime: updated.pushTime,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
