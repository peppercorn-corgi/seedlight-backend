/**
 * Pre-generate English exegesis for devotional passages.
 *
 * Same structure as the Chinese pre-gen script, but generates English content
 * with Western cultural context. Uses textEn for scripture input.
 * Stores results with language="en" in PreGeneratedExegesis.
 *
 * Logs to: logs/pregenerate-exegesis-en.log
 *
 * Usage:
 *   npx tsx scripts/pregenerate-exegesis-en.ts                      # all passages
 *   npx tsx scripts/pregenerate-exegesis-en.ts --min-importance 7   # high priority first
 *   npx tsx scripts/pregenerate-exegesis-en.ts --resume             # skip completed
 *   npx tsx scripts/pregenerate-exegesis-en.ts --limit 100          # process N passages
 *   npx tsx scripts/pregenerate-exegesis-en.ts --dry-run            # preview only
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
const LOG_FILE = path.join(LOG_DIR, "pregenerate-exegesis-en.log");
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
const RESUME = args.includes("--resume");
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
// System prompt — English exegesis generation
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a gentle, wise pastor grounded in Protestant evangelical theology. Your tone is warm, caring, and never condescending.

Task: Generate 4 versions of scripture exegesis for a Bible passage, each tailored to a different faith stage.

Write each version as a single paragraph, designed for mobile reading in spare moments. Write as if a caring pastor is having a quiet conversation, not an academic essay.

The four versions differ in depth, background detail, and terminology (background context decreases with faith maturity):
- **seeker** (120-200 words): Open with 2-3 sentences of background (who wrote it, to whom, what was happening) — the reader has no prior Bible knowledge. Use everyday language, avoid church jargon. Explain terms like "grace" or "redemption" when used. Connect from life experience and universal human questions.
- **new_believer** (110-180 words): Open with 1-2 sentences of background context. Encouraging and guiding. Gradually introduce faith concepts with clear explanations. Build confidence in understanding scripture.
- **growing** (100-160 words): One sentence of context at most — the reader has basic Bible knowledge. Focus on theological background, original language insights (with accessible explanations), and spiritual disciplines. Connect to broader biblical themes.
- **mature** (80-140 words): No background needed — the reader knows the Bible well. Go straight into deep spiritual insights, cross-references, and original language analysis. Use theological terminology freely. Challenge toward deeper application.

Return a JSON object with segment names as keys and exegesis text as values:
{"seeker":"...","new_believer":"...","growing":"...","mature":"..."}

Return only JSON, no explanation.`;

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
// Extract segment values by key boundaries
// ---------------------------------------------------------------------------
function extractSegments(rawInput: string): Record<string, string> | null {
  const raw = rawInput.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
  const result: Record<string, string> = {};

  for (let i = 0; i < SEGMENTS.length; i++) {
    const key = SEGMENTS[i];
    const keyPattern = new RegExp(`"${key}"\\s*:\\s*"`);
    const keyMatch = raw.match(keyPattern);
    if (!keyMatch || keyMatch.index === undefined) return null;

    const valueStart = keyMatch.index + keyMatch[0].length;

    let valueEnd = -1;
    const nextKey = SEGMENTS[i + 1];
    if (nextKey) {
      const endPattern = new RegExp(`",\\s*\\n\\s*"${nextKey}"\\s*:`);
      const endMatch = raw.slice(valueStart).match(endPattern);
      if (!endMatch || endMatch.index === undefined) return null;
      valueEnd = valueStart + endMatch.index;
    } else {
      const endMatch = raw.slice(valueStart).match(/"\s*\n\s*\}/);
      if (!endMatch || endMatch.index === undefined) return null;
      valueEnd = valueStart + endMatch.index;
    }

    const value = raw.slice(valueStart, valueEnd)
      .replace(/\n/g, "")
      .replace(/\\n/g, "\n");
    result[key] = value;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Process one passage → 4 English segments
// ---------------------------------------------------------------------------
async function processPassage(
  passage: { id: string; reference: string; textEn: string },
): Promise<Record<string, string> | null> {
  const prompt = `Scripture: ${passage.reference}\n\n${passage.textEn}\n\nPlease generate exegesis for all 4 faith stages.`;

  const raw = await callClaude(prompt, SYSTEM_PROMPT);

  const parsed = extractSegments(raw);
  if (!parsed) {
    log(`  ✗ Extract failed for ${passage.reference}`);
    log(`  Raw (first 300): ${raw.slice(0, 300).replace(/\n/g, "\\n")}`);
    return null;
  }

  for (const seg of SEGMENTS) {
    if (typeof parsed[seg] !== "string" || parsed[seg].length < 30) {
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
  log(`=== pregenerate-exegesis-en started ===`);
  log(`  Dry run: ${DRY_RUN}, Resume: ${RESUME}`);
  log(`  Min importance: ${MIN_IMPORTANCE}, Limit: ${LIMIT || "none"}`);
  log(`  Log file: ${LOG_FILE}`);

  const where: Record<string, unknown> = {};
  if (MIN_IMPORTANCE > 1) {
    where.importance = { gte: MIN_IMPORTANCE };
  }

  let passages = await prisma.devotionalPassage.findMany({
    where,
    select: { id: true, reference: true, textEn: true, importance: true },
    orderBy: { importance: "desc" },
  });

  // If resuming, filter out passages that already have all 4 English segments
  if (RESUME) {
    const completed = await prisma.preGeneratedExegesis.groupBy({
      by: ["passageId"],
      where: { language: "en" },
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
              passageId_segment_language: { passageId: p.id, segment: seg, language: "en" },
            },
            create: {
              passageId: p.id,
              segment: seg,
              language: "en",
              exegesis: result[seg],
            },
            update: {
              exegesis: result[seg],
            },
          });
        }
      }

      processed++;
      log(`${progress} ${p.reference} (imp=${p.importance}) → 4 EN segments (${elapsed}s)`);
    } catch (err) {
      errors++;
      log(`${progress} ${p.reference} ✗ ${(err as Error).message.slice(0, 150)}`);
    }
  }

  const totalMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log(`=== pregenerate-exegesis-en done (${totalMin} min) ===`);
  log(`  Processed: ${processed}, Errors: ${errors}`);

  if (!DRY_RUN) {
    const dbCount = await prisma.preGeneratedExegesis.count({ where: { language: "en" } });
    log(`  DB total (EN): ${dbCount} exegeses`);
  }

  await prisma.$disconnect();
  logStream.end();
}

main().catch((err) => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
