/**
 * Devotional route — generates a ContentCard from a specific passage.
 *
 * Called when a user taps a push notification. Unlike the mood flow, there is
 * no mood selection — we create a MoodEntry with moodType "devotional" to
 * maintain the existing ContentCard → MoodEntry → User ownership chain.
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth, resolveUser } from "../middleware/auth.js";
import { generateDevotionalContent } from "../services/content.js";
import { prisma } from "../lib/db.js";

const router = Router();

const devotionalSchema = z.object({
  passageId: z.string().min(1),
});

// POST /api/devotional — generate a devotional ContentCard for a specific passage
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

    const { passageId } = parsed.data;

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
        // Match by scripture reference from the passage
        // (passageId isn't stored on ContentCard, so we check via the passage's reference)
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

    // Generate devotional content for this specific passage
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
