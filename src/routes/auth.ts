import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/db.js";

const router = Router();

// POST /api/auth/sync - called after Supabase login, creates/updates User in our DB
router.post("/sync", requireAuth, async (req, res, next) => {
  try {
    const { sub, email } = req.user!;
    const { name, avatarUrl, authProvider } = req.body;

    const user = await prisma.user.upsert({
      where: { authProviderId: sub },
      update: {
        email: email ?? undefined,
        name: name ?? undefined,
        avatarUrl: avatarUrl ?? undefined,
      },
      create: {
        email: email ?? null,
        name: name ?? null,
        avatarUrl: avatarUrl ?? null,
        authProvider: authProvider ?? "email",
        authProviderId: sub,
        segment: "seeker",
      },
    });

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me - get current user profile
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: { authProviderId: req.user!.sub },
    });

    if (!user) {
      res.status(404).json({ error: "User not found. Please call /api/auth/sync first." });
      return;
    }

    res.json(user);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/auth/me - update profile
router.patch("/me", requireAuth, async (req, res, next) => {
  try {
    const { segment, pushChannels, timezone, language } = req.body;

    const user = await prisma.user.findFirst({
      where: { authProviderId: req.user!.sub },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(segment !== undefined && { segment }),
        ...(pushChannels !== undefined && { pushChannels }),
        ...(timezone !== undefined && { timezone }),
        ...(language !== undefined && { language }),
      },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
