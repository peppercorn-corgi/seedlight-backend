import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/db.js";

const router = Router();

const syncSchema = z.object({
  name: z.string().max(100).optional(),
  avatarUrl: z.string().url().max(500).optional(),
  authProvider: z.enum(["google", "apple", "email"]).optional(),
});

const updateSchema = z.object({
  segment: z.enum(["seeker", "new_believer", "mature"]).optional(),
  pushChannels: z.array(z.string().max(100)).max(10).optional(),
  timezone: z.string().max(50).optional(),
  language: z.enum(["zh", "en", "both"]).optional(),
});

const userSelect = {
  email: true,
  name: true,
  avatarUrl: true,
  authProvider: true,
  segment: true,
  pushChannels: true,
  timezone: true,
  language: true,
  createdAt: true,
} as const;

// POST /api/auth/sync - called after Supabase login, creates/updates User in our DB
router.post("/sync", requireAuth, async (req, res, next) => {
  try {
    const parsed = syncSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const { sub, email } = req.user!;
    const { name, avatarUrl, authProvider } = parsed.data;

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
      select: userSelect,
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
      select: userSelect,
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
    const parsed = updateSchema.safeParse(req.body);
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

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: parsed.data,
      select: userSelect,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
