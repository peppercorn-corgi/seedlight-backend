import { getLlmProvider } from "./llm/index.js";
import { findByMoodTags, findByReference, getRecentlyUsed } from "./scripture.js";
import { prisma } from "../lib/db.js";

function buildSystemPrompt(segment: string): string {
  const toneGuide: Record<string, string> = {
    seeker: `对方是一位尚未信主的慕道友。
- 用通俗易懂的语言，避免教会术语（如"称义"、"成圣"等需要解释后才能使用）
- 从生活经验和普世价值出发，搭建通往圣经真理的桥梁
- 不要假设对方了解任何基督教概念`,
    new_believer: `对方是一位初信者。
- 用鼓励和引导的语气
- 可以逐步引入信仰概念，但要简明解释
- 帮助建立信仰根基，指向圣经原则`,
    mature: `对方是一位成熟的基督徒。
- 可以使用神学术语和较深的释经
- 提供更深层的属灵洞见和反思
- 鼓励更深的委身和服事`,
  };

  const tone = toneGuide[segment] || toneGuide.seeker;

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

function buildUserPrompt(
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

interface AiResponse {
  scriptureRef: string;
  scriptureZh: string;
  scriptureEn: string;
  exegesis: string;
  secularLink: string;
  covenant: string;
}

function parseAiResponse(text: string): AiResponse {
  // Strip possible markdown code fences
  const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  const parsed = JSON.parse(cleaned);

  const required = ["scriptureRef", "scriptureZh", "scriptureEn", "exegesis", "secularLink", "covenant"] as const;
  for (const key of required) {
    if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
      throw new Error(`AI response missing or empty field: ${key}`);
    }
  }
  return parsed as AiResponse;
}

export async function generateContent(
  userId: string,
  moodType: string,
  moodText?: string,
) {
  // 1. Get user segment
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  // 2. Find candidate scriptures by mood tags
  const candidates = await findByMoodTags([moodType]);
  const candidateDescs = candidates
    .slice(0, 5)
    .map((s) => `${s.bookZh} ${s.chapter}:${s.verseStart}${s.verseEnd ? `-${s.verseEnd}` : ""} - ${s.textZh}`);

  // 3. Get recently used refs to avoid repeats
  const recentRefs = await getRecentlyUsed(userId, 10);

  // 4. Build prompts
  const systemPrompt = buildSystemPrompt(user.segment);
  const userPrompt = buildUserPrompt(moodType, moodText, recentRefs, candidateDescs);

  // 5. Call LLM
  const provider = getLlmProvider();
  console.log(`[LLM] Generating content for mood="${moodType}", user=${userId}`);
  const startTime = Date.now();
  const response = await provider.generate({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 4000,
  });
  console.log(`[LLM] Response received in ${((Date.now() - startTime) / 1000).toFixed(1)}s, model=${response.model}`);

  // 6. Parse structured response
  console.log("[LLM] Raw response:\n" + response.text);
  const aiResult = parseAiResponse(response.text);

  // 7. Verify scripture reference exists in DB
  const dbScripture = await findByReference(aiResult.scriptureRef);
  const verified = dbScripture !== null;

  // If found in DB, prefer the DB text for accuracy
  if (dbScripture) {
    aiResult.scriptureZh = dbScripture.textZh;
    aiResult.scriptureEn = dbScripture.textEn;
  }

  return {
    ...aiResult,
    verified,
    aiModel: response.model,
    language: user.language,
  };
}
