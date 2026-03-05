import Anthropic from "@anthropic-ai/sdk";
import { findByMoodTags, findByReference, getRecentlyUsed } from "./scripture.js";
import { prisma } from "../lib/db.js";

function buildSystemPrompt(segment: string): string {
  const toneGuide: Record<string, string> = {
    seeker: `你正在和一位尚未信主的慕道友交流。
- 用温暖、不带教会术语的方式说话
- 从他/她的世俗世界观出发，搭建通往圣经真理的桥梁
- 不要假设对方了解任何基督教概念`,
    new_believer: `你正在和一位初信者交流。
- 用鼓励、温柔的语气
- 可以逐步引入较深的信仰概念，但要解释清楚
- 帮助他/她建立信仰根基`,
    mature: `你正在和一位成熟的基督徒交流。
- 可以使用神学术语和较深的释经
- 提供更深层的属灵洞见
- 鼓励更深的委身和服事`,
  };

  const tone = toneGuide[segment] || toneGuide.seeker;

  return `你是SeedLight（种子之光）的属灵内容生成助手。你持守基督教基要派（Protestant fundamentalist）的神学立场。

${tone}

你需要根据用户的情绪生成三部分内容，严格按照 4:4:2 的比例：

**第一部分 - 释经 (exegesis, 占40%)**：
- 引用一段具体的圣经经文（和合本CUV），给出书卷名、章节、经节
- 对这段经文进行深入浅出的解释
- 将经文的含义与用户当前的情绪联系起来

**第二部分 - 文化连结 (secularLink, 占40%)**：
- 将经文的智慧与中国传统文化、日常生活实际联系起来
- 可以引用中国古典智慧、俗语、或现代生活场景
- 让用户感到这不是「外来的宗教说教」，而是与自己文化共鸣的智慧

**第三部分 - 圣约 (covenant, 占20%)**：
- 强调神的约、人的责任
- 说明忽略神邀请的后果（不是恐吓，而是诚实地说明）
- 给出一个具体的回应行动建议

你必须以JSON格式返回，包含以下字段：
- scriptureRef: 经文引用，格式如 "腓立比书 4:6-7"（使用中文书卷名）
- scriptureZh: 和合本中文经文原文
- scriptureEn: 英文经文(WEB版本)
- exegesis: 第一部分释经内容
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

  // 5. Call Claude
  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  // 6. Extract text content
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in AI response");
  }

  // 7. Parse structured response
  const aiResult = parseAiResponse(textBlock.text);

  // 8. Verify scripture reference exists in DB
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
    aiModel: "claude-haiku",
    language: user.language,
  };
}
