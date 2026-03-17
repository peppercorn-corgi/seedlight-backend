/**
 * Devotional route — generates a ContentCard for daily quiet-time.
 *
 * Two entry points:
 * 1. Push notification: passageId provided → generate card for that specific passage
 * 2. "每日灵修" button: no passageId → server picks a random passage
 *
 * Creates a MoodEntry with moodType "devotional" to maintain the existing
 * ContentCard → MoodEntry → User ownership chain without schema changes.
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth, resolveUser } from "../middleware/auth.js";
import { generateDevotionalContent } from "../services/content.js";
import { prisma } from "../lib/db.js";

const router = Router();

const devotionalSchema = z.object({
  // Optional: if omitted, server picks a random passage
  passageId: z.string().min(1).optional(),
});

/**
 * Pick a random passage for the devotional button (no specific passage requested).
 * Avoids passages the user has seen recently.
 */
async function pickRandomPassage(userId: string): Promise<string> {
  // Get recently used scripture refs to avoid repetition
  const recent = await prisma.contentCard.findMany({
    where: { moodEntry: { userId } },
    select: { scriptureRef: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const recentRefs = recent.map((c) => c.scriptureRef);

  // Pick from passages not recently used, weighted by importance
  const candidates = await prisma.devotionalPassage.findMany({
    where: recentRefs.length > 0 ? { reference: { notIn: recentRefs } } : {},
    orderBy: { importance: "desc" },
    take: 50,
    select: { id: true, importance: true },
  });

  if (candidates.length === 0) {
    // All passages used recently — just pick any
    const fallback = await prisma.devotionalPassage.findFirst({
      orderBy: { importance: "desc" },
      select: { id: true },
    });
    if (!fallback) throw new Error("No devotional passages in database");
    return fallback.id;
  }

  // Weighted random by importance
  const weights = candidates.map((c) => c.importance);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let roll = Math.random() * totalWeight;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i].id;
  }
  return candidates[0].id;
}

// POST /api/devotional — generate a devotional ContentCard
//
// Body: { passageId?: string }
// - With passageId: generate for that specific passage (push notification flow)
// - Without passageId: pick a random passage (每日灵修 button flow)
router.post("/", requireAuth, async (req, res, next) => {
  try {
    const parsed = devotionalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const user = await resolveUser(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "User not found. Please call /api/auth/sync first." });
      return;
    }

    // Resolve passageId: use provided or pick random
    const passageId = parsed.data.passageId || await pickRandomPassage(user.id);

    // Dedup: if user already has a devotional card for this passage today, return it
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const existing = await prisma.contentCard.findFirst({
      where: {
        moodEntry: {
          userId: user.id,
          moodType: "devotional",
          createdAt: { gte: todayStart },
        },
      },
      include: {
        moodEntry: {
          select: { moodType: true, moodText: true, createdAt: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // If we found a devotional card today, verify it's for the same passage
    if (existing) {
      const passage = await prisma.devotionalPassage.findUnique({
        where: { id: passageId },
        select: { reference: true },
      });
      if (passage && existing.scriptureRef === passage.reference) {
        res.json({
          moodEntry: existing.moodEntry,
          contentCard: existing,
          cached: true,
        });
        return;
      }
    }

    // Generate devotional content for this passage
    const content = await generateDevotionalContent(user.id, passageId);

    // Create a MoodEntry with moodType "devotional" to maintain the
    // existing ownership chain: ContentCard → MoodEntry → User
    const moodEntry = await prisma.moodEntry.create({
      data: {
        userId: user.id,
        moodType: "devotional",
        moodText: null,
      },
    });

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

export default router;
