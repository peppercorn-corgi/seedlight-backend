/**
 * Phase 2: Pre-generate exegesis for devotional passages.
 *
 * For each DevotionalPassage, generates exegesis for all 4 faith segments
 * in a single Claude CLI call. Stores results in PreGeneratedExegesis.
 *
 * Logs to: logs/pregenerate-exegesis.log
 *
 * Usage:
 *   npx tsx scripts/pregenerate-exegesis.ts                      # all passages
 *   npx tsx scripts/pregenerate-exegesis.ts --min-importance 7   # high priority first
 *   npx tsx scripts/pregenerate-exegesis.ts --resume             # skip completed
 *   npx tsx scripts/pregenerate-exegesis.ts --limit 100          # process N passages
 *   npx tsx scripts/pregenerate-exegesis.ts --dry-run            # preview only
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// Log setup
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(import.meta.dirname, "..", "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "pregenerate-exegesis.log");
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logStream.write(line + "\n");
}

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const RESUME = !FORCE && args.includes("--resume");
const MIN_IMPORTANCE = args.includes("--min-importance")
  ? parseInt(args[args.indexOf("--min-importance") + 1], 10)
  : 1;
const LIMIT = args.includes("--limit")
  ? parseInt(args[args.indexOf("--limit") + 1], 10)
  : 0;

const SEGMENTS = ["seeker", "new_believer", "growing", "mature"] as const;

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
const SYSTEM_PROMPT = `你是一位温柔、有智慧的牧者，持守基督教基要派神学立场，说话温和、不居高临下。

任务：为一段圣经经文生成4个版本的"释经"内容，分别面向不同信仰阶段的读者。

**必须使用简体中文，不得使用繁体字。**

共同要求：写成一段话，适合手机碎片时间阅读。语气像关怀的牧者在安静地与人谈心，不要写成论文。

四个版本的区别（经文背景的篇幅随信仰程度递减）：
- **seeker** (慕道友, 150-250字): 用2-3句话介绍经文背景（谁写的、写给谁、当时处境），帮助完全不了解圣经的读者建立上下文。通俗易懂，避免教会术语，从生活经验出发解释经文含义。
- **new_believer** (初信者, 150-220字): 用1-2句话简述经文背景，鼓励引导，逐步引入信仰概念并简明解释，帮助建立信仰根基。
- **growing** (成长中, 120-200字): 用1句话点明背景即可（读者已有基本圣经知识），将篇幅留给神学背景、原文含义（附通俗解释），鼓励灵修习惯。
- **mature** (成熟信徒, 100-180字): 无需介绍背景（读者熟悉圣经），直接进入深层属灵洞见，可用神学术语，引用原文帮助理解。

返回JSON对象，key为segment名，value为释经文本：
{"seeker":"...","new_believer":"...","growing":"...","mature":"..."}

只返回JSON，不要解释。`;

// ---------------------------------------------------------------------------
// Fix literal newlines inside JSON string values
// ---------------------------------------------------------------------------
function fixJsonNewlines(str: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === "\\") { result += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString && ch === "\n") { result += "\\n"; continue; }
    if (inString && ch === "\r") { result += "\\r"; continue; }
    result += ch;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Extract segment values by key boundaries (avoids JSON.parse issues with
// unescaped quotes in LLM output)
// ---------------------------------------------------------------------------
function extractSegments(rawInput: string): Record<string, string> | null {
  // Strip markdown code block wrappers if present
  const raw = rawInput.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
  const result: Record<string, string> = {};

  for (let i = 0; i < SEGMENTS.length; i++) {
    const key = SEGMENTS[i];
    // Find "key": " pattern
    const keyPattern = new RegExp(`"${key}"\\s*:\\s*"`);
    const keyMatch = raw.match(keyPattern);
    if (!keyMatch || keyMatch.index === undefined) return null;

    const valueStart = keyMatch.index + keyMatch[0].length;

    // Find end boundary: next segment key or closing brace
    let valueEnd = -1;
    const nextKey = SEGMENTS[i + 1];
    if (nextKey) {
      // Look for ",\s*\n\s*"nextKey" pattern (the comma + next key)
      const endPattern = new RegExp(`",\\s*\\n\\s*"${nextKey}"\\s*:`);
      const endMatch = raw.slice(valueStart).match(endPattern);
      if (!endMatch || endMatch.index === undefined) return null;
      valueEnd = valueStart + endMatch.index;
    } else {
      // Last key: find closing "\n} (possibly with trailing whitespace/backticks)
      const endMatch = raw.slice(valueStart).match(/"\s*\n\s*\}/);
      if (!endMatch || endMatch.index === undefined) return null;
      valueEnd = valueStart + endMatch.index;
    }

    const value = raw.slice(valueStart, valueEnd)
      .replace(/\n/g, "")        // remove literal newlines
      .replace(/\\n/g, "\n");    // convert escaped \n to real newlines
    result[key] = value;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Process one passage → 4 segments
// ---------------------------------------------------------------------------
async function processPassage(
  passage: { id: string; reference: string; textZh: string },
): Promise<Record<string, string> | null> {
  const prompt = `经文：${passage.reference}\n\n${passage.textZh}\n\n请为4个信仰阶段生成释经。`;

  const raw = await callClaude(prompt, SYSTEM_PROMPT);

  const parsed = extractSegments(raw);
  if (!parsed) {
    log(`  ✗ Extract failed for ${passage.reference}`);
    log(`  Raw (first 300): ${raw.slice(0, 300).replace(/\n/g, "\\n")}`);
    return null;
  }

  // Validate all 4 segments present and non-trivial
  for (const seg of SEGMENTS) {
    if (typeof parsed[seg] !== "string" || parsed[seg].length < 50) {
      log(`  ✗ Missing/short segment "${seg}" for ${passage.reference}`);
      return null;
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log(`=== pregenerate-exegesis started ===`);
  log(`  Dry run: ${DRY_RUN}, Force: ${FORCE}, Resume: ${RESUME}`);
  log(`  Min importance: ${MIN_IMPORTANCE}, Limit: ${LIMIT || "none"}`);
  log(`  Log file: ${LOG_FILE}`);

  // Get passages to process
  const where: Record<string, unknown> = {};
  if (MIN_IMPORTANCE > 1) {
    where.importance = { gte: MIN_IMPORTANCE };
  }

  let passages = await prisma.devotionalPassage.findMany({
    where,
    select: { id: true, reference: true, textZh: true, importance: true },
    orderBy: { importance: "desc" },
  });

  // If resuming, filter out passages that already have all 4 segments
  if (RESUME) {
    const completed = await prisma.preGeneratedExegesis.groupBy({
      by: ["passageId"],
      where: { language: "zh" },
      _count: true,
      having: { passageId: { _count: { gte: 4 } } },
    });
    const completedSet = new Set(completed.map((c) => c.passageId));
    const before = passages.length;
    passages = passages.filter((p) => !completedSet.has(p.id));
    log(`  Resume: ${completedSet.size} complete, ${passages.length}/${before} remaining`);
  }

  if (LIMIT > 0) {
    passages = passages.slice(0, LIMIT);
    log(`  Limited to ${passages.length} passages`);
  }

  log(`  Processing ${passages.length} passages (×4 segments = ${passages.length * 4} exegeses)`);

  let processed = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < passages.length; i++) {
    const p = passages[i];
    const progress = `[${i + 1}/${passages.length}]`;

    try {
      const pStart = Date.now();
      const result = await processPassage(p);
      const elapsed = ((Date.now() - pStart) / 1000).toFixed(1);

      if (!result) {
        errors++;
        continue;
      }

      if (!DRY_RUN) {
        for (const seg of SEGMENTS) {
          await prisma.preGeneratedExegesis.upsert({
            where: {
              passageId_segment_language: { passageId: p.id, segment: seg, language: "zh" },
            },
            create: {
              passageId: p.id,
              segment: seg,
              language: "zh",
              exegesis: result[seg],
            },
            update: {
              exegesis: result[seg],
            },
          });
        }
      }

      processed++;
      log(`${progress} ${p.reference} (imp=${p.importance}) → 4 segments (${elapsed}s)`);
    } catch (err) {
      errors++;
      log(`${progress} ${p.reference} ✗ ${(err as Error).message.slice(0, 150)}`);
    }
  }

  const totalMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log(`=== pregenerate-exegesis done (${totalMin} min) ===`);
  log(`  Processed: ${processed}, Errors: ${errors}`);

  if (!DRY_RUN) {
    const dbCount = await prisma.preGeneratedExegesis.count();
    log(`  DB total: ${dbCount} exegeses`);
  }

  await prisma.$disconnect();
  logStream.end();
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
