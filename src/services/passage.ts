/**
 * Passage selection service.
 *
 * Selects devotional passages based on mood tags, avoids recently used,
 * and fetches pre-generated exegesis when available.
 */

import { prisma } from "../lib/db.js";
import { MOOD_MAPPING } from "../constants/mood-tags.js";

// ---------------------------------------------------------------------------
// Expand UI mood to fine-grained tags
// ---------------------------------------------------------------------------
export function expandMoodTags(moodType: string): string[] {
  const mapped = MOOD_MAPPING[moodType];
  if (mapped) return [...mapped];
  // If moodType is already a fine-grained tag, use it directly
  return [moodType];
}

// ---------------------------------------------------------------------------
// Get recently used passage references for a user
// ---------------------------------------------------------------------------
export async function getRecentlyUsedRefs(userId: string, limit: number): Promise<string[]> {
  const recent = await prisma.contentCard.findMany({
    where: { moodEntry: { userId } },
    select: { scriptureRef: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return recent.map((c) => c.scriptureRef);
}

// ---------------------------------------------------------------------------
// Select a passage by mood tags with weighted random selection
// ---------------------------------------------------------------------------
export async function selectPassage(
  tags: string[],
  excludeRefs: string[],
): Promise<{
  id: string;
  reference: string;
  book: string;
  bookZh: string;
  chapter: number;
  verseStart: number;
  verseEnd: number | null;
  textZh: string;
  textEn: string;
  importance: number;
} | null> {
  // Query passages matching any of the expanded tags
  const candidates = await prisma.devotionalPassage.findMany({
    where: {
      moodTags: { hasSome: tags },
      ...(excludeRefs.length > 0 ? { reference: { notIn: excludeRefs } } : {}),
    },
    orderBy: { importance: "desc" },
    take: 50, // get top 50 candidates
  });

  if (candidates.length === 0) return null;

  // Weighted random selection by importance
  // importance 10 → weight 10, importance 1 → weight 1
  const totalWeight = candidates.reduce((sum, c) => sum + c.importance, 0);
  let roll = Math.random() * totalWeight;

  for (const c of candidates) {
    roll -= c.importance;
    if (roll <= 0) return c;
  }

  // Fallback to first
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Fetch pre-generated exegesis for a passage + segment
// ---------------------------------------------------------------------------
export async function getPreGeneratedExegesis(
  passageId: string,
  segment: string,
): Promise<string | null> {
  const record = await prisma.preGeneratedExegesis.findUnique({
    where: {
      passageId_segment: { passageId, segment },
    },
  });
  return record?.exegesis ?? null;
}
