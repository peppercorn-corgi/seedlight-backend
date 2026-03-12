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
// Testament / book category weight multipliers
//   Gospels are the most devotionally resonant for evangelicals
//   Other NT epistles are practical and theology-rich
//   Psalms/Proverbs are emotionally strong OT books
// ---------------------------------------------------------------------------
const GOSPEL_BOOKS = new Set(["Matthew", "Mark", "Luke", "John"]);
const NT_BOOKS = new Set([
  "Matthew", "Mark", "Luke", "John", "Acts",
  "Romans", "1 Corinthians", "2 Corinthians", "Galatians", "Ephesians",
  "Philippians", "Colossians", "1 Thessalonians", "2 Thessalonians",
  "1 Timothy", "2 Timothy", "Titus", "Philemon",
  "Hebrews", "James", "1 Peter", "2 Peter",
  "1 John", "2 John", "3 John", "Jude", "Revelation",
]);
const DEVOTIONAL_OT = new Set(["Psalms", "Proverbs", "Isaiah"]);

function bookWeight(book: string): number {
  if (GOSPEL_BOOKS.has(book)) return 2.5;
  if (NT_BOOKS.has(book)) return 2.0;
  if (DEVOTIONAL_OT.has(book)) return 1.3;
  return 1.0;
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
  const MAX_VERSE_SPAN = 7;
  const rawCandidates = await prisma.devotionalPassage.findMany({
    where: {
      moodTags: { hasSome: tags },
      ...(excludeRefs.length > 0 ? { reference: { notIn: excludeRefs } } : {}),
    },
    orderBy: { importance: "desc" },
    take: 200,
  });

  // Filter out passages that span too many verses
  const candidates = rawCandidates
    .filter((c) => (c.verseEnd ?? c.verseStart) - c.verseStart + 1 <= MAX_VERSE_SPAN)
    .slice(0, 50);

  if (candidates.length === 0) {
    // Fallback: ignore tags, pick any passage by importance (avoid recently used)
    console.log(`[passage] No tag-matched candidates for tags=[${tags.join(",")}], trying untagged fallback`);
    const fallbackRaw = await prisma.devotionalPassage.findMany({
      where: excludeRefs.length > 0 ? { reference: { notIn: excludeRefs } } : {},
      orderBy: { importance: "desc" },
      take: 50,
    });
    const fallbackCandidates = fallbackRaw
      .filter((c) => (c.verseEnd ?? c.verseStart) - c.verseStart + 1 <= MAX_VERSE_SPAN)
      .slice(0, 20);
    if (fallbackCandidates.length === 0) {
      console.log(`[passage] No candidates at all (even untagged). excludeRefs=${excludeRefs.length}`);
      return null;
    }
    const fb = fallbackCandidates[Math.floor(Math.random() * fallbackCandidates.length)];
    console.log(`[passage] Untagged fallback: "${fb.reference}" (imp=${fb.importance}) from ${fallbackCandidates.length} candidates`);
    return fb;
  }

  // Weighted random selection: importance × book category weight
  const weights = candidates.map((c) => c.importance * bookWeight(c.book));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let roll = Math.random() * totalWeight;

  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) {
      const c = candidates[i];
      console.log(`[passage] Selected "${c.reference}" (imp=${c.importance}, bw=${bookWeight(c.book)}) from ${candidates.length} candidates, query=[${tags.join(",")}], passage_tags=[${c.moodTags.join(",")}]`);
      return c;
    }
  }

  // Fallback to first
  const c0 = candidates[0];
  console.log(`[passage] Fallback "${c0.reference}" (imp=${c0.importance}, bw=${bookWeight(c0.book)}) from ${candidates.length} candidates`);
  return c0;
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
  language: string = "zh",
): Promise<string | null> {
  const record = await prisma.preGeneratedExegesis.findUnique({
    where: {
      passageId_segment_language: { passageId, segment, language },
    },
  });
  return record?.exegesis ?? null;
}
