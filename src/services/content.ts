import { getLlmProvider } from "./llm/index.js";
import { findByReference, getRecentlyUsed } from "./scripture.js";
import {
  expandMoodTags,
  selectPassage,
  getPreGeneratedExegesis,
  getRecentlyUsedRefs,
} from "./passage.js";
import { prisma } from "../lib/db.js";

// ---------------------------------------------------------------------------
// Tone guides (shared between optimized and legacy flows)
// ---------------------------------------------------------------------------
const TONE_GUIDE: Record<string, string> = {
  seeker: `对方是一位尚未信主的慕道友。
- 用通俗易懂的语言，避免教会术语（如"称义"、"成圣"等需要解释后才能使用）
- 从生活经验和普世价值出发，搭建通往圣经真理的桥梁
- 不要假设对方了解任何基督教概念`,
  new_believer: `对方是一位初信者。
- 用鼓励和引导的语气
- 可以逐步引入信仰概念，但要简明解释
- 帮助建立信仰根基，指向圣经原则`,
  growing: `对方是一位信仰正在成长中的基督徒。
- 适度引入神学背景知识和属灵操练的概念
- 可以提及原文含义（希腊文/希伯来文）但需附上通俗解释
- 鼓励建立规律的灵修习惯，引导更深地认识神的属性
- 帮助将信仰融入日常生活的各个层面`,
  mature: `对方是一位成熟的基督徒。
- 可以使用神学术语和较深的释经
- 提供更深层的属灵洞见和反思
- 适当引用希腊文/希伯来文原文帮助理解经文深层含义
- 鼓励更深的委身和服事`,
};

// =========================================================================
// Optimized flow: pre-generated exegesis + real-time secularLink & covenant
// =========================================================================

function buildOptimizedSystemPrompt(segment: string): string {
  const tone = TONE_GUIDE[segment] || TONE_GUIDE.seeker;

  return `你是一位温柔、有智慧的牧者。你持守基督教基要派（Protestant fundamentalist）的神学立场，但说话方式温和、不居高临下。

语气要求：
- 像一位关怀的牧者在安静地与人谈心，不是在讲台上讲道
- 不要用"朋友"、"亲爱的"等称呼开头，直接进入内容
- 语言温暖但不煽情，真诚但不说教

${tone}

你将收到一段经文和已有的释经内容。请根据用户的情绪，生成以下两部分内容：

**文化连结 (secularLink)**：
- 将经文的智慧与中华文化、日常生活实际联系起来
- 可以引用中国古典智慧、俗语、或现代生活中人人能共鸣的场景
- 让人感到这不是外来的宗教说教，而是与自身文化相通的智慧

**圣约 (covenant)**：
- 温和地指出神的邀请和人可以做出的回应
- 诚实地说明忽略这份邀请可能错过什么（不是恐吓，而是真诚地分享）
- 给出一个具体的、可操作的回应行动建议

以JSON格式返回：{"secularLink":"...","covenant":"..."}
只返回JSON，不要包含markdown代码块标记。`;
}

function buildOptimizedUserPrompt(
  moodType: string,
  moodText: string | undefined,
  scriptureRef: string,
  scriptureZh: string,
  exegesis: string,
): string {
  let prompt = `用户情绪: ${moodType}`;
  if (moodText) prompt += `\n用户描述: ${moodText}`;
  prompt += `\n\n经文: ${scriptureRef}\n${scriptureZh}`;
  prompt += `\n\n释经:\n${exegesis}`;
  prompt += `\n\n请生成文化连结和圣约内容。`;
  return prompt;
}

interface PartialAiResponse {
  secularLink: string;
  covenant: string;
}

function parsePartialResponse(text: string): PartialAiResponse {
  const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();

  // Try JSON.parse first
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.secularLink === "string" && typeof parsed.covenant === "string") {
      return parsed as PartialAiResponse;
    }
  } catch { /* fall through to key-boundary extraction */ }

  // Key-boundary extraction (handles unescaped quotes in LLM output)
  const keys = ["secularLink", "covenant"] as const;
  const result: Record<string, string> = {};

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const keyPattern = new RegExp(`"${key}"\\s*:\\s*"`);
    const keyMatch = cleaned.match(keyPattern);
    if (!keyMatch || keyMatch.index === undefined) {
      throw new Error(`Missing field: ${key}`);
    }
    const valueStart = keyMatch.index + keyMatch[0].length;

    let valueEnd: number;
    const nextKey = keys[i + 1];
    if (nextKey) {
      const endPattern = new RegExp(`",?\\s*"${nextKey}"\\s*:`);
      const endMatch = cleaned.slice(valueStart).match(endPattern);
      if (!endMatch || endMatch.index === undefined) {
        throw new Error(`Cannot find boundary for ${key}`);
      }
      valueEnd = valueStart + endMatch.index;
    } else {
      const endMatch = cleaned.slice(valueStart).match(/"\s*\}/);
      if (!endMatch || endMatch.index === undefined) {
        throw new Error(`Cannot find end of ${key}`);
      }
      valueEnd = valueStart + endMatch.index;
    }

    result[key] = cleaned.slice(valueStart, valueEnd).replace(/\n/g, "");
  }

  return result as unknown as PartialAiResponse;
}

// ---------------------------------------------------------------------------
// Optimized flow: select passage → use pre-gen exegesis → generate rest
// ---------------------------------------------------------------------------
async function generateOptimized(
  userId: string,
  segment: string,
  moodType: string,
  moodText?: string,
) {
  // 1. Expand mood to fine-grained tags
  const tags = expandMoodTags(moodType);

  // 2. Get recently used refs
  const recentRefs = await getRecentlyUsedRefs(userId, 10);

  // 3. Select passage
  const passage = await selectPassage(tags, recentRefs);
  if (!passage) return null; // no passages found, fallback needed

  // 4. Fetch pre-generated exegesis
  const exegesis = await getPreGeneratedExegesis(passage.id, segment);
  if (!exegesis) return null; // no pre-gen available, fallback needed

  // 5. Call LLM for secularLink + covenant only
  const provider = getLlmProvider();
  const systemPrompt = buildOptimizedSystemPrompt(segment);
  const userPrompt = buildOptimizedUserPrompt(
    moodType, moodText,
    passage.reference, passage.textZh, exegesis,
  );

  console.log(`[LLM:opt] Generating secularLink+covenant for "${passage.reference}", mood="${moodType}"`);
  const startTime = Date.now();
  const response = await provider.generate({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 2000,
  });
  console.log(`[LLM:opt] Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s, model=${response.model}`);

  // 6. Parse response
  const partial = parsePartialResponse(response.text);

  return {
    scriptureRef: passage.reference,
    scriptureZh: passage.textZh,
    scriptureEn: passage.textEn,
    exegesis,
    secularLink: partial.secularLink,
    covenant: partial.covenant,
    verified: true, // passages come from our DB
    aiModel: response.model,
  };
}

// =========================================================================
// Legacy flow: full LLM generation (fallback)
// =========================================================================

function buildLegacySystemPrompt(segment: string): string {
  const tone = TONE_GUIDE[segment] || TONE_GUIDE.seeker;

  return `你是一位温柔、有智慧的牧者。你持守基督教基要派（Protestant fundamentalist）的神学立场，但说话方式温和、不居高临下。

语气要求：
- 像一位关怀的牧者在安静地与人谈心，不是在讲台上讲道
- 不要用"朋友"、"亲爱的"等称呼开头，直接进入内容
- 语言温暖但不煽情，真诚但不说教

${tone}

根据用户的情绪，生成以下三部分内容（比例 4:4:2）：

**第一部分 - 释经 (exegesis, 占40%)**：
- 选择一段与用户情绪最贴合的圣经经文（和合本CUV），给出中文书卷名、章节、经节
- 先用1-2句话简要介绍这段经文的背景（谁写的、写给谁、当时的处境），帮助理解上下文
- 然后深入浅出地解释经文含义，将其与用户当前的情绪联系起来

**第二部分 - 文化连结 (secularLink, 占40%)**：
- 将经文的智慧与中华文化、日常生活实际联系起来
- 可以引用中国古典智慧、俗语、或现代生活中人人能共鸣的场景
- 让人感到这不是外来的宗教说教，而是与自身文化相通的智慧

**第三部分 - 圣约 (covenant, 占20%)**：
- 温和地指出神的邀请和人可以做出的回应
- 诚实地说明忽略这份邀请可能错过什么（不是恐吓，而是真诚地分享）
- 给出一个具体的、可操作的回应行动建议

你必须以JSON格式返回，包含以下字段：
- scriptureRef: 经文引用，格式如 "腓立比书 4:6-7"（使用中文书卷名）
- scriptureZh: 和合本中文经文原文
- scriptureEn: 英文经文(WEB版本)
- exegesis: 第一部分释经内容（包含经文背景介绍）
- secularLink: 第二部分文化连结内容
- covenant: 第三部分圣约内容

只返回JSON，不要包含markdown代码块标记或其他内容。`;
}

function buildLegacyUserPrompt(
  moodType: string,
  moodText: string | undefined,
  recentRefs: string[],
  candidates: string[],
): string {
  let prompt = `用户当前的情绪: ${moodType}`;
  if (moodText) {
    prompt += `\n用户的具体描述: ${moodText}`;
  }
  if (candidates.length > 0) {
    prompt += `\n\n以下是与该情绪相关的经文候选（优先从中选择）:\n${candidates.join("\n")}`;
  }
  if (recentRefs.length > 0) {
    prompt += `\n\n请避免使用以下最近已用过的经文:\n${recentRefs.join("\n")}`;
  }
  prompt += "\n\n请根据以上信息生成属灵内容，以JSON格式返回。";
  return prompt;
}

interface FullAiResponse {
  scriptureRef: string;
  scriptureZh: string;
  scriptureEn: string;
  exegesis: string;
  secularLink: string;
  covenant: string;
}

function parseFullResponse(text: string): FullAiResponse {
  const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();

  // Try JSON.parse first
  try {
    const parsed = JSON.parse(cleaned);
    const required = ["scriptureRef", "scriptureZh", "scriptureEn", "exegesis", "secularLink", "covenant"] as const;
    const allPresent = required.every((k) => typeof parsed[k] === "string" && parsed[k].trim() !== "");
    if (allPresent) return parsed as FullAiResponse;
  } catch { /* fall through to key-boundary extraction */ }

  // Key-boundary extraction
  const keys = ["scriptureRef", "scriptureZh", "scriptureEn", "exegesis", "secularLink", "covenant"] as const;
  const result: Record<string, string> = {};

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const keyPattern = new RegExp(`"${key}"\\s*:\\s*"`);
    const keyMatch = cleaned.match(keyPattern);
    if (!keyMatch || keyMatch.index === undefined) {
      throw new Error(`AI response missing field: ${key}`);
    }
    const valueStart = keyMatch.index + keyMatch[0].length;

    let valueEnd: number;
    const nextKey = keys[i + 1];
    if (nextKey) {
      const endPattern = new RegExp(`",?\\s*"${nextKey}"\\s*:`);
      const endMatch = cleaned.slice(valueStart).match(endPattern);
      if (!endMatch || endMatch.index === undefined) {
        throw new Error(`Cannot find boundary for ${key}`);
      }
      valueEnd = valueStart + endMatch.index;
    } else {
      const endMatch = cleaned.slice(valueStart).match(/"\s*\}/);
      if (!endMatch || endMatch.index === undefined) {
        throw new Error(`Cannot find end of ${key}`);
      }
      valueEnd = valueStart + endMatch.index;
    }

    result[key] = cleaned.slice(valueStart, valueEnd).replace(/\n/g, "");
  }

  return result as unknown as FullAiResponse;
}

async function generateLegacy(
  userId: string,
  segment: string,
  moodType: string,
  moodText?: string,
) {
  // Use expanded tags to find candidates from DevotionalPassage first
  const tags = expandMoodTags(moodType);
  const passages = await prisma.devotionalPassage.findMany({
    where: { moodTags: { hasSome: tags } },
    orderBy: { importance: "desc" },
    take: 5,
    select: { reference: true, textZh: true },
  });
  const candidateDescs = passages.map((p) => `${p.reference} - ${p.textZh.slice(0, 80)}`);

  const recentRefs = await getRecentlyUsed(userId, 10);
  const systemPrompt = buildLegacySystemPrompt(segment);
  const userPrompt = buildLegacyUserPrompt(moodType, moodText, recentRefs, candidateDescs);

  const provider = getLlmProvider();
  console.log(`[LLM:legacy] Full generation for mood="${moodType}", user=${userId}`);
  const startTime = Date.now();
  const response = await provider.generate({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 4000,
  });
  console.log(`[LLM:legacy] Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s, model=${response.model}`);

  console.log("[LLM:legacy] Raw:\n" + response.text);
  const aiResult = parseFullResponse(response.text);

  // Verify scripture reference in DB
  const dbScripture = await findByReference(aiResult.scriptureRef);
  const verified = dbScripture !== null;
  if (dbScripture) {
    aiResult.scriptureZh = dbScripture.textZh;
    aiResult.scriptureEn = dbScripture.textEn;
  }

  return {
    ...aiResult,
    verified,
    aiModel: response.model,
  };
}

// =========================================================================
// Public API — tries optimized flow first, falls back to legacy
// =========================================================================

export async function generateContent(
  userId: string,
  moodType: string,
  moodText?: string,
) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  // Try optimized flow (pre-generated exegesis + partial LLM)
  try {
    const result = await generateOptimized(userId, user.segment, moodType, moodText);
    if (result) {
      console.log(`[content] Optimized flow succeeded for ${userId}`);
      return { ...result, language: user.language };
    }
    console.log(`[content] Optimized flow: no passage/exegesis found, falling back`);
  } catch (err) {
    console.error(`[content] Optimized flow error, falling back:`, (err as Error).message);
  }

  // Fallback to legacy full generation
  const result = await generateLegacy(userId, user.segment, moodType, moodText);
  return { ...result, language: user.language };
}
