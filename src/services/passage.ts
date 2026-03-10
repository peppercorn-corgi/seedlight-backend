/**
 * Passage selection service.
 *
 * Selects devotional passages based on mood tags, avoids recently used,
 * and fetches pre-generated exegesis when available.
 */

import { GoogleGenAI } from "@google/genai";
import { prisma } from "../lib/db.js";
import { config } from "../config/index.js";
import { MOOD_MAPPING, ALL_TAGS } from "../constants/mood-tags.js";

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

  if (candidates.length === 0) {
    console.log(`[passage] No candidates found for tags=[${tags.join(",")}], excludeRefs=${excludeRefs.length}`);
    return null;
  }

  // Weighted random selection by importance
  // importance 10 → weight 10, importance 1 → weight 1
  const totalWeight = candidates.reduce((sum, c) => sum + c.importance, 0);
  let roll = Math.random() * totalWeight;

  for (const c of candidates) {
    roll -= c.importance;
    if (roll <= 0) {
      console.log(`[passage] Selected "${c.reference}" (imp=${c.importance}) from ${candidates.length} candidates, query=[${tags.join(",")}], passage_tags=[${c.moodTags.join(",")}]`);
      return c;
    }
  }

  // Fallback to first
  console.log(`[passage] Fallback "${candidates[0].reference}" (imp=${candidates[0].importance}) from ${candidates.length} candidates`);
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Extract fine-grained tags from user's free-text description
// ---------------------------------------------------------------------------
const TAG_SET = new Set<string>(ALL_TAGS);

// Use a lightweight non-thinking model for tag extraction (fast + cheap)
const tagClient = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY! });
const TAG_MODEL = config.TAG_EXTRACTION_MODEL;

export async function extractTagsFromText(moodText: string): Promise<string[]> {
  const startTime = Date.now();

  const response = await tagClient.models.generateContent({
    model: TAG_MODEL,
    contents: moodText,
    config: {
      systemInstruction: `从用户描述中选出3-5个最匹配的标签。只输出英文标签名，逗号分隔，无其他内容。

可选标签：${ALL_TAGS.join(",")}`,
      maxOutputTokens: 100,
    },
  });

  const raw = (response.text ?? "").trim();
  const extracted = raw.split(/[,\s]+/)
    .map((t) => t.toLowerCase().trim())
    .filter((t) => TAG_SET.has(t));
  console.log(`[passage] Extracted tags from moodText in ${Date.now() - startTime}ms: [${extracted.join(",")}] (raw: "${raw}")`);
  return extracted;
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
