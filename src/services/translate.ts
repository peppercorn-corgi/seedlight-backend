import { GoogleGenAI } from "@google/genai";
import { config } from "../config/index.js";
import { prisma } from "../lib/db.js";

const genai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY! });
const MODEL = "gemini-2.5-flash";

interface TranslateInput {
  contentCardId: string;
  scriptureRef: string;
  exegesis: string;
  secularLink: string;
  covenant: string;
}

export interface TranslateOutput {
  scriptureRef: string;
  exegesis: string;
  secularLink: string;
  covenant: string;
}

type TargetLang = "en" | "zh";

// ---------------------------------------------------------------------------
// Look up pre-generated exegesis in target language
// ---------------------------------------------------------------------------
async function findPreGenExegesis(
  scriptureRef: string,
  userSegment: string,
  lang: TargetLang,
): Promise<string | null> {
  // zh ref → find passage by reference field; en ref → find by book+chapter+verse
  const passage = await prisma.devotionalPassage.findFirst({
    where: { reference: scriptureRef },
    select: { id: true },
  });
  if (!passage) return null;

  const preGen = await prisma.preGeneratedExegesis.findUnique({
    where: {
      passageId_segment_language: {
        passageId: passage.id,
        segment: userSegment,
        language: lang,
      },
    },
    select: { exegesis: true },
  });
  return preGen?.exegesis ?? null;
}

// ---------------------------------------------------------------------------
// Look up scripture reference in target language from DB
// ---------------------------------------------------------------------------
async function lookupRef(currentRef: string, targetLang: TargetLang): Promise<string | null> {
  // Try matching by zh reference first, then by constructing from fields
  const passage = await prisma.devotionalPassage.findFirst({
    where: { reference: currentRef },
    select: { reference: true, book: true, bookZh: true, chapter: true, verseStart: true, verseEnd: true },
  });

  if (passage) {
    if (targetLang === "en") {
      const verses = passage.verseEnd && passage.verseEnd !== passage.verseStart
        ? `${passage.verseStart}-${passage.verseEnd}`
        : `${passage.verseStart}`;
      return `${passage.book} ${passage.chapter}:${verses}`;
    }
    return passage.reference; // already zh
  }

  // If currentRef is English format, try to find by book name
  // e.g. "Psalms 42:5" → find passage where book="Psalms", chapter=42, verseStart=5
  if (targetLang === "zh") {
    const match = currentRef.match(/^(.+?)\s+(\d+):(\d+)(?:-(\d+))?$/);
    if (match) {
      const [, book, chapter, verseStart] = match;
      const found = await prisma.devotionalPassage.findFirst({
        where: { book, chapter: parseInt(chapter, 10), verseStart: parseInt(verseStart, 10) },
        select: { reference: true },
      });
      if (found) return found.reference;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Robust JSON field extraction (handles unescaped quotes, literal newlines)
// ---------------------------------------------------------------------------
const TRANSLATE_FIELDS = ["exegesis", "secularLink", "covenant"] as const;

function extractFields(rawInput: string): Record<string, string> | null {
  const raw = rawInput.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
  const result: Record<string, string> = {};

  for (let i = 0; i < TRANSLATE_FIELDS.length; i++) {
    const key = TRANSLATE_FIELDS[i];
    const keyPattern = new RegExp(`"${key}"\\s*:\\s*"`);
    const keyMatch = raw.match(keyPattern);
    if (!keyMatch || keyMatch.index === undefined) return null;

    const valueStart = keyMatch.index + keyMatch[0].length;
    let valueEnd = -1;

    const nextKey = TRANSLATE_FIELDS[i + 1];
    if (nextKey) {
      const endPattern = new RegExp(`",\\s*"${nextKey}"\\s*:`);
      const endMatch = raw.slice(valueStart).match(endPattern);
      if (!endMatch || endMatch.index === undefined) return null;
      valueEnd = valueStart + endMatch.index;
    } else {
      const endMatch = raw.slice(valueStart).match(/"\s*\}/);
      if (!endMatch || endMatch.index === undefined) return null;
      valueEnd = valueStart + endMatch.index;
    }

    result[key] = raw.slice(valueStart, valueEnd)
      .replace(/\n/g, "")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------
function buildZhToEnPrompt(fields: Record<string, string>, needsExegesis: boolean): string {
  const exegesisLine = needsExegesis
    ? `- **exegesis**: Translate faithfully. Maintain warm pastoral tone and theological accuracy.\n`
    : "";

  return `You are adapting Chinese Christian devotional content for an English-speaking audience. This is cultural adaptation, not literal translation.

Content to adapt (JSON):
${JSON.stringify(fields)}

Instructions:
${exegesisLine}- **secularLink**: This section connects scripture to everyday culture. The Chinese version references Chinese cultural elements (idioms, philosophers, social norms, etc.). Do NOT literally translate these. REPLACE them with equivalent Western cultural references that English readers resonate with — Western literature, films, psychology, philosophy, common English sayings, etc. The spiritual insight must remain the same, but the cultural bridge must feel natural to an English reader.
- **covenant**: Translate faithfully. Keep the practical, actionable tone.
- Preserve any **bold markers** (**text**) exactly as they are.

Return JSON with these exact keys:
{"exegesis":"...","secularLink":"...","covenant":"..."}

Only return JSON. No explanation, no markdown fences.`;
}

function buildEnToZhPrompt(fields: Record<string, string>, needsExegesis: boolean): string {
  const exegesisLine = needsExegesis
    ? `- **exegesis**：忠实翻译，保持温暖的牧者语气和神学准确性。\n`
    : "";

  return `你正在将英文基督教灵修内容适配给中文读者。这是文化适配，不是逐字翻译。

**必须使用简体中文，不得使用繁体字。**

待适配内容（JSON）：
${JSON.stringify(fields)}

要求：
${exegesisLine}- **secularLink**：这部分将经文与日常文化联系起来。英文版引用了西方文化元素（英文谚语、西方哲学家、西方文学/电影等）。不要直译这些内容，而是替换为中文读者熟悉的文化类比——中国成语、古典文学、中国哲学家、日常俗语等。属灵洞见保持不变，但文化桥梁必须让中文读者感到自然。
- **covenant**：忠实翻译，保持实际可行的语气。
- 保留所有 **加粗标记**（**文字**）不变。

返回JSON，key如下：
{"exegesis":"...","secularLink":"...","covenant":"..."}

只返回JSON，不要解释。`;
}

// ---------------------------------------------------------------------------
// Main translation function — supports zh→en and en→zh
// ---------------------------------------------------------------------------
export async function translateContentCard(
  card: TranslateInput,
  userSegment: string,
  targetLang: TargetLang = "en",
): Promise<TranslateOutput> {
  // 1. Look up target-language reference from DB
  const targetRef = await lookupRef(card.scriptureRef, targetLang);

  // 2. Check for pre-generated exegesis in target language
  const preGenExegesis = await findPreGenExegesis(card.scriptureRef, userSegment, targetLang);

  // 3. Build fields to translate — skip exegesis if pre-gen available
  const needsExegesis = !preGenExegesis;
  const fieldsToTranslate: Record<string, string> = {
    secularLink: card.secularLink,
    covenant: card.covenant,
  };
  if (needsExegesis) {
    fieldsToTranslate.exegesis = card.exegesis;
  }

  // 4. Build prompt based on direction
  const prompt = targetLang === "en"
    ? buildZhToEnPrompt(fieldsToTranslate, needsExegesis)
    : buildEnToZhPrompt(fieldsToTranslate, needsExegesis);

  console.log(`[translate] ${targetLang === "en" ? "zh→en" : "en→zh"} card=${card.contentCardId}, preGenExegesis=${!!preGenExegesis}, ref=${targetRef ?? "fallback"}`);
  const startTime = Date.now();

  const response = await genai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: { maxOutputTokens: 8192 },
  });

  const text = response.text;
  if (!text) throw new Error("Empty response from Gemini translation");

  console.log(`[translate] Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s, len=${text.length}`);

  // 5. Parse with robust extraction, fallback to JSON.parse
  const parsed = extractFields(text);
  if (!parsed) {
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    try {
      const json = JSON.parse(cleaned);
      if (json.secularLink && json.covenant) {
        return {
          scriptureRef: targetRef ?? card.scriptureRef,
          exegesis: preGenExegesis ?? json.exegesis ?? card.exegesis,
          secularLink: json.secularLink,
          covenant: json.covenant,
        };
      }
    } catch { /* fall through */ }
    throw new Error(`Failed to extract translation fields. Raw (200): ${text.slice(0, 200)}`);
  }

  return {
    scriptureRef: targetRef ?? card.scriptureRef,
    exegesis: preGenExegesis ?? parsed.exegesis ?? card.exegesis,
    secularLink: parsed.secularLink,
    covenant: parsed.covenant,
  };
}
