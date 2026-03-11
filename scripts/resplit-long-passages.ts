/**
 * Re-split devotional passages that span too many verses (>MAX_SPAN).
 *
 * For each long passage:
 * 1. Fetch original verses from ScriptureIndex
 * 2. Ask Claude to re-split into shorter passages (≤MAX_SPAN verses)
 * 3. Save new shorter passages with fresh tags
 * 4. Delete old passage and its pre-generated exegeses
 *
 * Logs to: logs/resplit-long-passages.log
 *
 * Usage:
 *   npx tsx scripts/resplit-long-passages.ts              # process all long passages
 *   npx tsx scripts/resplit-long-passages.ts --dry-run    # preview only
 *   npx tsx scripts/resplit-long-passages.ts --limit 50   # process N passages
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { TAG_TAXONOMY_PROMPT, ALL_TAGS } from "../src/constants/mood-tags.js";

const MAX_SPAN = 6;

// ---------------------------------------------------------------------------
// Log setup
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(import.meta.dirname, "..", "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "resplit-long-passages.log");
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logStream.write(line + "\n");
  console.log(line);
}

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT = args.includes("--limit")
  ? parseInt(args[args.indexOf("--limit") + 1], 10)
  : 0;

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
    if (systemPrompt) cliArgs.push("--system-prompt", systemPrompt);

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

    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

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
const SYSTEM_PROMPT = `你是一位圣经学者和灵修专家。给定的经文段落跨度太长（超过${MAX_SPAN}节），需要拆分为更短的段落。

规则：
1. 将经文拆分为多个段落，每段不超过${MAX_SPAN}节。
2. 按主题分组——主题相关的经文放在一起。
3. 每个段落需要：
   - verseStart, verseEnd（在原章节中的节号）
   - moodTags: 3-8个标签
   - themes: 1-3个核心灵性主题
   - importance: 1-10分
4. **严格要求：拆分后的段落合并起来必须覆盖原经文从 verseStart 到 verseEnd 的每一节，不遗漏任何经文。**
   - 描述苦难、争战、审判、受难、十字架的经文有极高的灵修价值，绝不能跳过（例如诗篇22:12-18描述弥赛亚受难，是最经典的预言经文之一）
   - 叙事性内容（历史事件、人物行动）同样必须包含
   - 如果你遗漏了任何一节经文，系统会报错并要求重新处理
5. 只有纯粹的地名列表（如"从XX到XX到XX"的行程记录）、纯家谱列表才可以跳过。

${TAG_TAXONOMY_PROMPT}

返回JSON数组：
[
  {"verseStart": 1, "verseEnd": 4, "moodTags": ["peaceful","trust"], "themes": ["trust"], "importance": 8},
  {"verseStart": 5, "verseEnd": 8, "moodTags": ["grateful","worship"], "themes": ["worship"], "importance": 7}
]

只返回JSON数组，不要解释。`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface PassageResult {
  verseStart: number;
  verseEnd: number;
  moodTags: string[];
  themes: string[];
  importance: number;
}

// ---------------------------------------------------------------------------
// Process one long passage
// ---------------------------------------------------------------------------
async function processPassage(
  passage: {
    id: string;
    book: string;
    bookZh: string;
    chapter: number;
    verseStart: number;
    verseEnd: number;
    reference: string;
  },
): Promise<PassageResult[] | null> {
  // Fetch original verses from ScriptureIndex
  const verses = await prisma.scriptureIndex.findMany({
    where: {
      book: passage.book,
      chapter: passage.chapter,
      verseStart: { gte: passage.verseStart, lte: passage.verseEnd },
    },
    select: { verseStart: true, textZh: true, textEn: true },
    orderBy: { verseStart: "asc" },
  });

  if (verses.length === 0) {
    log(`  ✗ No verses found in ScriptureIndex for ${passage.reference}`);
    return null;
  }

  const verseList = verses.map((v) => `${v.verseStart}. ${v.textZh}`).join("\n");
  const span = passage.verseEnd - passage.verseStart + 1;
  const prompt = `${passage.bookZh} ${passage.chapter}章，第${passage.verseStart}-${passage.verseEnd}节（共${span}节）：\n\n${verseList}\n\n请拆分为每段不超过${MAX_SPAN}节的灵修段落。`;

  const raw = await callClaude(prompt, SYSTEM_PROMPT);

  // Parse response
  let parsed: PassageResult[];
  try {
    const stripped = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
    parsed = JSON.parse(stripped);
  } catch {
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (!arrMatch) {
      log(`  ✗ No JSON array found for ${passage.reference}. Raw: ${raw.slice(0, 200)}`);
      return null;
    }
    try {
      parsed = JSON.parse(arrMatch[0]);
    } catch {
      log(`  ✗ JSON parse failed for ${passage.reference}. Raw: ${raw.slice(0, 200)}`);
      return null;
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    log(`  ✗ Empty result for ${passage.reference}`);
    return null;
  }

  // Validate tags and spans
  const validTags = new Set(ALL_TAGS as readonly string[]);
  const cleaned = parsed
    .map((p) => ({
      verseStart: p.verseStart,
      verseEnd: p.verseEnd,
      moodTags: (p.moodTags || []).filter((t: string) => validTags.has(t)),
      themes: (p.themes || []).filter((t: string) => validTags.has(t)),
      importance: Math.max(1, Math.min(10, Math.round(p.importance || 5))),
    }))
    .filter((p) => {
      const span = (p.verseEnd ?? p.verseStart) - p.verseStart + 1;
      return p.moodTags.length > 0 && span <= MAX_SPAN && span > 0;
    });

  if (cleaned.length === 0) {
    // Fallback: Claude returned the passage without splitting (e.g. 7-verse narrative).
    // Mechanically split into ≤MAX_SPAN chunks, reuse tags from Claude's response.
    if (parsed.length > 0) {
      const srcTags = (parsed[0].moodTags || []).filter((t: string) => validTags.has(t));
      const srcThemes = (parsed[0].themes || []).filter((t: string) => validTags.has(t));
      const imp = Math.max(1, Math.min(10, Math.round(parsed[0].importance || 5)));
      const fallbackTags = srcTags.length > 0 ? srcTags : ["hopeful", "peaceful", "faith"];
      const fallbackThemes = srcThemes.length > 0 ? srcThemes : ["faith"];

      const allNums = verses.map((v) => v.verseStart);
      const mid = Math.ceil(allNums.length / 2);
      cleaned.push(
        { verseStart: allNums[0], verseEnd: allNums[mid - 1], moodTags: fallbackTags, themes: fallbackThemes, importance: imp },
        { verseStart: allNums[mid], verseEnd: allNums[allNums.length - 1], moodTags: fallbackTags, themes: fallbackThemes, importance: imp },
      );
      log(`  ⚠ ${passage.reference}: force-split at midpoint (Claude did not split)`);
    }
  }

  if (cleaned.length === 0) {
    log(`  ✗ No valid passages after cleaning for ${passage.reference}`);
    return null;
  }

  // Coverage check: verify all verses are covered, auto-fill gaps
  const coveredVerses = new Set<number>();
  for (const p of cleaned) {
    for (let v = p.verseStart; v <= p.verseEnd; v++) coveredVerses.add(v);
  }
  const allVerseNums = verses.map((v) => v.verseStart);
  const missing = allVerseNums.filter((v) => !coveredVerses.has(v));

  if (missing.length > 0) {
    // Group consecutive missing verses into ranges, then create passages for them
    const gaps: { start: number; end: number }[] = [];
    let gapStart = missing[0];
    let gapEnd = missing[0];
    for (let i = 1; i < missing.length; i++) {
      if (missing[i] === gapEnd + 1) {
        gapEnd = missing[i];
      } else {
        gaps.push({ start: gapStart, end: gapEnd });
        gapStart = missing[i];
        gapEnd = missing[i];
      }
    }
    gaps.push({ start: gapStart, end: gapEnd });

    // Split large gaps into ≤MAX_SPAN chunks and add as new passages
    for (const gap of gaps) {
      for (let s = gap.start; s <= gap.end; s += MAX_SPAN) {
        const e = Math.min(s + MAX_SPAN - 1, gap.end);
        cleaned.push({
          verseStart: s,
          verseEnd: e,
          moodTags: ["suffering", "sorrowful", "hopeful", "faith"],
          themes: ["faith"],
          importance: 7,
        });
      }
    }
    cleaned.sort((a, b) => a.verseStart - b.verseStart);
    log(`  ⚠ ${passage.reference}: auto-filled missing verses [${missing.join(",")}]`);
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log(`=== resplit-long-passages started ===`);
  log(`  Max verse span: ${MAX_SPAN}`);
  log(`  Dry run: ${DRY_RUN}`);
  log(`  Limit: ${LIMIT || "none"}`);

  // Find all passages with span > MAX_SPAN
  const allPassages = await prisma.devotionalPassage.findMany({
    where: { verseEnd: { not: null } },
    select: {
      id: true, book: true, bookZh: true, chapter: true,
      verseStart: true, verseEnd: true, reference: true,
    },
    orderBy: { importance: "desc" },
  });

  let longPassages = allPassages.filter(
    (p) => p.verseEnd !== null && p.verseEnd - p.verseStart + 1 > MAX_SPAN,
  ) as (typeof allPassages[0] & { verseEnd: number })[];

  if (LIMIT > 0) {
    longPassages = longPassages.slice(0, LIMIT);
  }

  log(`  Found ${longPassages.length} passages with span > ${MAX_SPAN}`);

  let processed = 0;
  let created = 0;
  let deleted = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < longPassages.length; i++) {
    const p = longPassages[i];
    const span = p.verseEnd - p.verseStart + 1;
    const progress = `[${i + 1}/${longPassages.length}]`;

    try {
      const pStart = Date.now();
      const results = await processPassage(p);
      const elapsed = ((Date.now() - pStart) / 1000).toFixed(1);

      if (!results) {
        errors++;
        continue;
      }

      if (!DRY_RUN) {
        // Fetch verses for building text
        const verses = await prisma.scriptureIndex.findMany({
          where: {
            book: p.book,
            chapter: p.chapter,
            verseStart: { gte: p.verseStart, lte: p.verseEnd },
          },
          select: { verseStart: true, textZh: true, textEn: true },
          orderBy: { verseStart: "asc" },
        });

        // Create new shorter passages
        for (const r of results) {
          const rangeVerses = verses.filter(
            (v) => v.verseStart >= r.verseStart && v.verseStart <= r.verseEnd,
          );
          const textZh = rangeVerses.map((v) => v.textZh).join("");
          const textEn = rangeVerses.map((v) => v.textEn).join(" ");
          const verseEnd = r.verseEnd > r.verseStart ? r.verseEnd : null;
          const reference = verseEnd
            ? `${p.bookZh} ${p.chapter}:${r.verseStart}-${r.verseEnd}`
            : `${p.bookZh} ${p.chapter}:${r.verseStart}`;

          await prisma.devotionalPassage.upsert({
            where: {
              book_chapter_verseStart: {
                book: p.book,
                chapter: p.chapter,
                verseStart: r.verseStart,
              },
            },
            create: {
              book: p.book, bookZh: p.bookZh, chapter: p.chapter,
              verseStart: r.verseStart, verseEnd, reference,
              textZh, textEn,
              moodTags: r.moodTags, themes: r.themes, importance: r.importance,
            },
            update: {
              verseEnd, reference, textZh, textEn,
              moodTags: r.moodTags, themes: r.themes, importance: r.importance,
            },
          });
          created++;
        }

        // Delete old long passage's exegeses first (FK constraint)
        await prisma.preGeneratedExegesis.deleteMany({
          where: { passageId: p.id },
        });

        // Delete old long passage (only if verseStart changed — if first sub-passage
        // starts at the same verseStart, the upsert above already updated it)
        const firstNewStart = results[0].verseStart;
        if (firstNewStart !== p.verseStart) {
          await prisma.devotionalPassage.delete({ where: { id: p.id } });
          deleted++;
        } else {
          deleted++; // the upsert overwrote it
        }
      }

      processed++;
      const splitDetail = results.map((r) => {
        const s = r.verseEnd > r.verseStart ? `${r.verseStart}-${r.verseEnd}` : `${r.verseStart}`;
        return `v${s}(${r.moodTags.join(",")})`;
      }).join(" | ");
      log(`${progress} ${p.reference} (${span}v) → ${results.length} passages (${elapsed}s)`);
      log(`  拆分: ${splitDetail}`);
    } catch (err) {
      errors++;
      log(`${progress} ${p.reference} ✗ ${(err as Error).message.slice(0, 150)}`);
    }
  }

  const totalMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log(`=== resplit-long-passages done (${totalMin} min) ===`);
  log(`  Processed: ${processed}, Created: ${created}, Deleted: ${deleted}, Errors: ${errors}`);

  if (!DRY_RUN) {
    const dbCount = await prisma.devotionalPassage.count();
    const longCount = (await prisma.devotionalPassage.findMany({
      where: { verseEnd: { not: null } },
      select: { verseStart: true, verseEnd: true },
    })).filter((p) => p.verseEnd! - p.verseStart + 1 > MAX_SPAN).length;
    log(`  DB total: ${dbCount} passages, ${longCount} still > ${MAX_SPAN} verses`);
  }

  await prisma.$disconnect();
  logStream.end();
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
