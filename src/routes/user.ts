import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/db.js";

const router = Router();

const VALID_FAITH_LEVELS = ["seeker", "new_believer", "growing", "mature"] as const;

const preferencesSchema = z.object({
  faithLevel: z.enum(VALID_FAITH_LEVELS),
});

// GET /api/user/preferences
router.get("/preferences", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { authProviderId: req.user!.sub },
      select: { segment: true, onboarded: true },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ faithLevel: user.segment, onboarded: user.onboarded });
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

    await prisma.user.update({
      where: { id: user.id },
      data: { segment: parsed.data.faithLevel, onboarded: true },
    });

    res.json({ faithLevel: parsed.data.faithLevel, onboarded: true });
  } catch (err) {
    next(err);
  }
});

export default router;
