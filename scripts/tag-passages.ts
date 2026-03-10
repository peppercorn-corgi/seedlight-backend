/**
 * Phase 1: Tag Bible chapters into devotional passages with mood tags.
 *
 * Batches multiple chapters per Claude CLI call (~100 verses/batch) to
 * reduce CLI spawn overhead. Logs to logs/tag-passages.log.
 *
 * Usage:
 *   npx tsx scripts/tag-passages.ts                  # process all
 *   npx tsx scripts/tag-passages.ts --book 诗篇       # one book
 *   npx tsx scripts/tag-passages.ts --resume          # skip processed
 *   npx tsx scripts/tag-passages.ts --dry-run         # preview only
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { TAG_TAXONOMY_PROMPT, ALL_TAGS } from "../src/constants/mood-tags.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BATCH_TARGET_VERSES = parseInt(process.env.BATCH_SIZE ?? "100", 10); // target verses per CLI call
const MAX_CHAPTER_FOR_BATCH = 60; // chapters with more verses go solo

// ---------------------------------------------------------------------------
// Log file setup
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(import.meta.dirname, "..", "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "tag-passages.log");
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logStream.write(line + "\n");
}

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const RESUME = args.includes("--resume");
const bookFilter = args.includes("--book")
  ? args[args.indexOf("--book") + 1]
  : null;

// ---------------------------------------------------------------------------
// Claude CLI wrapper
// ---------------------------------------------------------------------------
async function callClaude(prompt: string, systemPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cliArgs = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--model", "claude-sonnet-4-6",
    ];
    if (systemPrompt) {
      cliArgs.push("--system-prompt", systemPrompt);
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn("claude", cliArgs, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let fullText = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === "text") fullText = block.text;
            }
          } else if (event.type === "result" && event.result) {
            fullText = event.result as string;
          }
        } catch { /* skip */ }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`CLI exit ${code}: ${stderr.slice(0, 500)}`));
      else if (!fullText.trim()) reject(new Error("Empty CLI response"));
      else resolve(fullText.trim());
    });

    child.on("error", (err) => reject(new Error(`CLI spawn: ${err.message}`)));
  });
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `你是一位圣经学者和灵修专家。分析给出的圣经章节，识别适合灵修的经文段落并标注。

规则：
1. 将连续的、主题相关的经文分组为"段落"。一个段落可以是1节到整章。
2. 跳过纯家谱、地名列表、建筑尺寸等纯记录性内容。但历史叙事中蕴含的信心功课仍应标注。
3. 尽量多标注，宁多勿少——目标是覆盖尽可能多的灵修经文。
4. 每个段落需要：
   - verseStart, verseEnd（单节则 verseEnd = verseStart）
   - moodTags: 3-8个标签（情绪+处境+灵性主题）
   - themes: 1-3个最核心的灵性主题
   - importance: 1-10分（10=经典灵修经文如诗23、腓4:6-7）

${TAG_TAXONOMY_PROMPT}

输入可能包含多个章节。按章节返回JSON对象，key为章节号：
{
  "1": [
    {"verseStart": 1, "verseEnd": 6, "moodTags": ["peaceful","trust","faith"], "themes": ["trust"], "importance": 9}
  ],
  "2": [
    {"verseStart": 1, "verseEnd": 3, "moodTags": ["angry","sovereignty"], "themes": ["sovereignty"], "importance": 7}
  ]
}

只返回JSON，不要解释。如果某章不适合灵修，该章的值为空数组。`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ChapterInfo {
  book: string;
  bookZh: string;
  chapter: number;
  verseCount: number;
}

interface PassageResult {
  verseStart: number;
  verseEnd: number;
  moodTags: string[];
  themes: string[];
  importance: number;
}

interface ChapterVerses {
  chapter: number;
  verses: { verseStart: number; textZh: string; textEn: string }[];
}

// ---------------------------------------------------------------------------
// Process a batch of chapters (one CLI call)
// ---------------------------------------------------------------------------
async function processBatch(
  book: string,
  bookZh: string,
  chapterData: ChapterVerses[],
): Promise<Map<number, PassageResult[]>> {
  // Build prompt with all chapters
  const sections = chapterData.map((cd) => {
    const verseList = cd.verses.map((v) => `${v.verseStart}. ${v.textZh}`).join("\n");
    return `### ${bookZh} ${cd.chapter}章 (${cd.verses.length}节)\n${verseList}`;
  });

  const chapterNums = chapterData.map((c) => c.chapter).join(", ");
  const prompt = `分析 ${bookZh} 第${chapterNums}章：\n\n${sections.join("\n\n")}`;

  const raw = await callClaude(prompt, SYSTEM_PROMPT);

  // Parse JSON response
  let parsed: Record<string, PassageResult[]>;
  try {
    const stripped = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
    parsed = JSON.parse(stripped);
  } catch {
    const objMatch = raw.match(/\{[\s\S]*\}/);
    if (!objMatch) {
      log(`  ✗ No JSON found for ${bookZh} ch${chapterNums}. Raw: ${raw.slice(0, 200)}`);
      return new Map();
    }
    try {
      parsed = JSON.parse(objMatch[0]);
    } catch {
      log(`  ✗ JSON parse failed for ${bookZh} ch${chapterNums}. Raw: ${raw.slice(0, 200)}`);
      return new Map();
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    log(`  ✗ Expected object for ${bookZh} ch${chapterNums}`);
    return new Map();
  }

  // Validate and sanitize
  const validTags = new Set(ALL_TAGS as readonly string[]);
  const result = new Map<number, PassageResult[]>();

  for (const [chapStr, passages] of Object.entries(parsed)) {
    const chap = parseInt(chapStr, 10);
    if (!Array.isArray(passages)) continue;

    const cleaned = passages
      .map((p) => ({
        ...p,
        moodTags: (p.moodTags || []).filter((t: string) => validTags.has(t)),
        themes: (p.themes || []).filter((t: string) => validTags.has(t)),
        importance: Math.max(1, Math.min(10, Math.round(p.importance || 5))),
      }))
      .filter((p) => p.moodTags.length > 0);

    if (cleaned.length > 0) {
      result.set(chap, cleaned);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Save passages to DB
// ---------------------------------------------------------------------------
async function savePassages(
  book: string,
  bookZh: string,
  chapter: number,
  passages: PassageResult[],
  allVerses: { verseStart: number; textZh: string; textEn: string }[],
) {
  for (const p of passages) {
    const rangeVerses = allVerses.filter(
      (v) => v.verseStart >= p.verseStart && v.verseStart <= p.verseEnd,
    );
    const textZh = rangeVerses.map((v) => v.textZh).join("");
    const textEn = rangeVerses.map((v) => v.textEn).join(" ");
    const verseEnd = p.verseEnd > p.verseStart ? p.verseEnd : null;
    const reference = verseEnd
      ? `${bookZh} ${chapter}:${p.verseStart}-${p.verseEnd}`
      : `${bookZh} ${chapter}:${p.verseStart}`;

    await prisma.devotionalPassage.upsert({
      where: {
        book_chapter_verseStart: { book, chapter, verseStart: p.verseStart },
      },
      create: {
        book, bookZh, chapter,
        verseStart: p.verseStart, verseEnd, reference,
        textZh, textEn,
        moodTags: p.moodTags, themes: p.themes, importance: p.importance,
      },
      update: {
        verseEnd, reference, textZh, textEn,
        moodTags: p.moodTags, themes: p.themes, importance: p.importance,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Group chapters into batches
// ---------------------------------------------------------------------------
function buildBatches(chapters: ChapterInfo[]): ChapterInfo[][] {
  const batches: ChapterInfo[][] = [];
  let currentBatch: ChapterInfo[] = [];
  let currentVerses = 0;

  for (const ch of chapters) {
    // Large chapters go solo
    if (ch.verseCount > MAX_CHAPTER_FOR_BATCH) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentVerses = 0;
      }
      batches.push([ch]);
      continue;
    }

    // Would this chapter overflow the batch?
    if (currentVerses + ch.verseCount > BATCH_TARGET_VERSES && currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentVerses = 0;
    }

    currentBatch.push(ch);
    currentVerses += ch.verseCount;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log(`=== tag-passages started (batch mode) ===`);
  log(`  Dry run: ${DRY_RUN}`);
  log(`  Resume: ${RESUME}`);
  log(`  Batch target: ~${BATCH_TARGET_VERSES} verses/call`);
  log(`  Log file: ${LOG_FILE}`);
  if (bookFilter) log(`  Book filter: ${bookFilter}`);

  // Get all chapters with verse counts
  const chapterGroups = await prisma.scriptureIndex.groupBy({
    by: ["book", "bookZh", "chapter"],
    _count: true,
    orderBy: [{ bookZh: "asc" }, { chapter: "asc" }],
  });

  let chapters: ChapterInfo[] = chapterGroups.map((c) => ({
    book: c.book,
    bookZh: c.bookZh,
    chapter: c.chapter,
    verseCount: c._count,
  }));

  if (bookFilter) {
    chapters = chapters.filter(
      (c) => c.bookZh === bookFilter || c.book === bookFilter,
    );
    if (chapters.length === 0) {
      log(`No chapters found for book: ${bookFilter}`);
      process.exit(1);
    }
  }

  // If resuming, filter out processed chapters
  if (RESUME) {
    const existing = await prisma.devotionalPassage.findMany({
      select: { book: true, chapter: true },
      distinct: ["book", "chapter"],
    });
    const processedSet = new Set(existing.map((e) => `${e.book}:${e.chapter}`));
    const before = chapters.length;
    chapters = chapters.filter((c) => !processedSet.has(`${c.book}:${c.chapter}`));
    log(`  Resume: ${processedSet.size} chapters done, ${chapters.length}/${before} remaining`);
  }

  // Group into batches
  // Group by book first, then batch within each book
  const bookGroups = new Map<string, ChapterInfo[]>();
  for (const ch of chapters) {
    const key = ch.book;
    if (!bookGroups.has(key)) bookGroups.set(key, []);
    bookGroups.get(key)!.push(ch);
  }

  const allBatches: { book: string; bookZh: string; chapters: ChapterInfo[] }[] = [];
  for (const [book, bookChapters] of bookGroups) {
    const batches = buildBatches(bookChapters);
    for (const batch of batches) {
      allBatches.push({ book, bookZh: batch[0].bookZh, chapters: batch });
    }
  }

  log(`  Total: ${chapters.length} chapters → ${allBatches.length} batches`);

  let totalPassages = 0;
  let processedBatches = 0;
  let errorBatches = 0;
  const startTime = Date.now();

  for (let i = 0; i < allBatches.length; i++) {
    const batch = allBatches[i];
    const chapterNums = batch.chapters.map((c) => c.chapter).join(",");
    const totalVerses = batch.chapters.reduce((s, c) => s + c.verseCount, 0);
    const progress = `[${i + 1}/${allBatches.length}]`;

    try {
      const batchStart = Date.now();

      // Fetch all verses for chapters in this batch
      const chapterData: ChapterVerses[] = [];
      for (const ch of batch.chapters) {
        const verses = await prisma.scriptureIndex.findMany({
          where: { book: ch.book, chapter: ch.chapter },
          select: { verseStart: true, textZh: true, textEn: true },
          orderBy: { verseStart: "asc" },
        });
        chapterData.push({ chapter: ch.chapter, verses });
      }

      // Process batch
      const results = await processBatch(batch.book, batch.bookZh, chapterData);
      const elapsed = ((Date.now() - batchStart) / 1000).toFixed(1);

      let batchPassages = 0;
      for (const [chap, passages] of results) {
        batchPassages += passages.length;
        if (!DRY_RUN) {
          const cd = chapterData.find((c) => c.chapter === chap);
          if (cd) {
            await savePassages(batch.book, batch.bookZh, chap, passages, cd.verses);
          }
        }
      }

      totalPassages += batchPassages;
      processedBatches++;
      log(`${progress} ${batch.bookZh} ch${chapterNums} (${totalVerses}v) → ${batchPassages} passages (${elapsed}s)`);
    } catch (err) {
      errorBatches++;
      log(`${progress} ${batch.bookZh} ch${chapterNums} ✗ ${(err as Error).message.slice(0, 150)}`);
    }
  }

  const totalMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log(`=== tag-passages done (${totalMin} min) ===`);
  log(`  Batches: ${processedBatches} ok, ${errorBatches} errors`);
  log(`  Total passages: ${totalPassages}`);

  if (!DRY_RUN) {
    const dbCount = await prisma.devotionalPassage.count();
    log(`  DB total: ${dbCount}`);
  }

  await prisma.$disconnect();
  logStream.end();
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
