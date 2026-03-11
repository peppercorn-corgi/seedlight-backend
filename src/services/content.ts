import { getLlmProvider } from "./llm/index.js";
import { findByReference, getRecentlyUsed } from "./scripture.js";
import {
  expandMoodTags,
  extractTagsFromText,
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

const TONE_GUIDE_EN: Record<string, string> = {
  seeker: `You are speaking with someone who is spiritually curious but not yet a Christian.
- Use plain, accessible language — avoid church jargon (words like "sanctification" or "justification" need unpacking before use)
- Build bridges from universal human experience and shared values toward biblical truth
- Never assume any prior knowledge of Christian concepts or the Bible`,
  new_believer: `You are speaking with a new believer who has recently come to faith.
- Use an encouraging, nurturing tone — they are still learning to walk
- Introduce faith concepts gradually, always explaining them simply
- Help them build a solid foundation in Scripture and practical faith`,
  growing: `You are speaking with a Christian who is actively growing in their faith.
- You may introduce theological background and spiritual disciplines
- Reference original Greek or Hebrew meanings when helpful, with a plain explanation alongside
- Encourage consistent devotional habits and a deepening knowledge of God's character
- Help them integrate faith into the practical realities of everyday life`,
  mature: `You are speaking with a mature, seasoned Christian.
- You may use theological terms and deeper exegetical insights
- Offer substantive spiritual reflection, not surface-level encouragement
- Reference Greek or Hebrew original meanings to illuminate the text's depth
- Encourage deeper commitment, discipleship, and service`,
};

// =========================================================================
// Segment-specific section guides (Chinese)
// =========================================================================

const PERSONAL_LINK_ZH: Record<string, string> = {
  seeker: `**个人连结 (personalLink)**（80-150字，一段话）：
- 从生活经验出发，将经文的智慧与用户描述的处境联系起来
- 不要用信仰术语，用"人生智慧"的角度让对方产生共鸣
- 像一位年长朋友听完倾诉后给出的真诚回应`,
  new_believer: `**个人连结 (personalLink)**（80-150字，一段话）：
- 将经文含义和用户的处境联系起来，鼓励他们在新的信仰中找到力量
- 帮助他们感受到神的话语是活的、与自己相关的
- 像牧者对刚信主的弟兄姐妹的温暖回应`,
  growing: `**个人连结 (personalLink)**（80-150字，一段话）：
- 将经文的属灵原则应用到用户描述的具体处境中
- 引导他们看到神在这个处境中的作工和心意
- 像属灵导师的陪伴和引导`,
  mature: `**个人连结 (personalLink)**（80-150字，一段话）：
- 从更深的神学视角将经文与用户的处境联系起来
- 挑战他们在困境中看到神更深的旨意和呼召
- 像同工之间坦诚而深入的属灵交流`,
};

const COVENANT_ZH: Record<string, string> = {
  seeker: `**圣约 (covenant)**（80-150字，一段话）：
- 温和地呈现一个"如果愿意尝试"的邀请，绝不施压
- 用"你可以试试看……"而不是"你应该……"的语气
- 诚实地分享接受这份邀请可能带来的美好，以及错过可能的遗憾——不是恐吓，而是真诚地说"这值得你考虑"
- 给出一个非常具体的、零门槛的行动建议（如"今晚睡前花一分钟安静想想这段话"）`,
  new_believer: `**圣约 (covenant)**（80-150字，一段话）：
- 温和地指出神在这段经文中的邀请，以及可以做出的简单回应
- 诚实地说明忽略这份邀请可能错过的成长——不是恐吓，而是真诚地分享"这对你的信仰根基很重要"
- 给出一个具体的、容易实践的行动建议（如一个简短的祷告、一个日常小习惯）`,
  growing: `**圣约 (covenant)**（80-150字，一段话）：
- 清晰地指出神的邀请和信徒当有的回应
- 坦诚地说明如果忽视这份呼召，属灵生命可能停滞在哪里
- 给出一个有深度的、可操作的属灵操练建议（如默想经文的方式、具体的顺服行动）`,
  mature: `**圣约 (covenant)**（80-150字，一段话）：
- 直接呈现神话语中的命令、应许与责任
- 坦诚地指出不回应可能错失的属灵果实和事奉机会
- 给出一个有挑战性的回应行动（如带领他人、在某个领域更深委身、为特定事项代祷）`,
};

const SECULAR_LINK_ZH: Record<string, string> = {
  seeker: `**文化连结 (secularLink)**（80-150字，一段话）：
- 完全从中华文化和日常生活的角度来呈现经文的智慧
- 引用古典哲学、俗语、或现代生活中人人能共鸣的场景
- 让人感到这不是外来的宗教说教，而是与自身文化深处相通的、关于人生的洞见
- 不要提及神、耶稣、信仰等词汇，只用"古人的智慧"、"人生道理"等中性表达`,
  new_believer: `**文化连结 (secularLink)**（80-150字，一段话）：
- 将经文的智慧与中华文化联系起来，帮助初信者看到信仰与自己文化根基并不冲突
- 可以引用古典智慧、俗语，搭建文化与信仰之间的桥梁
- 让人感到信仰不是割裂自己的文化身份，而是在更深层面上与之相通`,
  growing: `**文化连结 (secularLink)**（80-150字，一段话）：
- 将经文的属灵原则与中华文化中的相似智慧进行对话
- 可以引用经典文学、哲学思想，展现圣经真理的普世性
- 帮助信徒在文化处境中更好地理解和活出信仰`,
  mature: `**文化连结 (secularLink)**（80-150字，一段话）：
- 在圣经真理与中华文化之间展开有深度的对话，可以指出相似之处也可以指出本质差异
- 引用经典文学、哲学或神学家的文化反思
- 帮助成熟信徒在文化使命中找到着力点，更有智慧地在自己的文化语境中见证信仰`,
};

// =========================================================================
// Segment-specific section guides (English)
// =========================================================================

const PERSONAL_LINK_EN: Record<string, string> = {
  seeker: `**Personal Connection (personalLink)** (60-120 words, one paragraph):
- Connect the scripture's wisdom to the user's situation from a universal human experience perspective
- Do not use faith language — frame it as life wisdom that resonates with anyone
- Like a wise older friend responding sincerely after listening to someone share`,
  new_believer: `**Personal Connection (personalLink)** (60-120 words, one paragraph):
- Connect the scripture to the user's situation, encouraging them to find strength in their new faith
- Help them feel that God's word is alive and personally relevant
- Like a pastor warmly responding to a young believer seeking guidance`,
  growing: `**Personal Connection (personalLink)** (60-120 words, one paragraph):
- Apply the scripture's spiritual principles to the user's specific situation
- Help them see God's work and purpose in what they are going through
- Like a spiritual mentor walking alongside them`,
  mature: `**Personal Connection (personalLink)** (60-120 words, one paragraph):
- Connect the scripture to the user's situation from a deeper theological perspective
- Challenge them to see God's greater purpose and calling within their struggle
- Like a candid, substantive exchange between fellow workers in ministry`,
};

const COVENANT_EN: Record<string, string> = {
  seeker: `**Covenant (covenant)** (60-120 words, one paragraph):
- Present a gentle "what if you tried this" invitation — no pressure whatsoever
- Use "you might consider…" rather than "you should…"
- Honestly share what embracing this invitation could bring, and what might be missed by passing it by — not as a threat, but as a sincere "this is worth considering"
- Offer one very specific, zero-barrier action step (e.g., "spend one quiet minute tonight reflecting on these words")`,
  new_believer: `**Covenant (covenant)** (60-120 words, one paragraph):
- Gently name God's invitation in this passage and a simple response they can make
- Honestly share what they might miss by ignoring this — not as a threat, but as sincere pastoral care: "this matters for your growth"
- Offer one specific, easy-to-practice action step (e.g., a short prayer, a small daily habit)`,
  growing: `**Covenant (covenant)** (60-120 words, one paragraph):
- Clearly name God's invitation and the faithful response called for
- Honestly point out where spiritual growth may stall if this call is ignored
- Offer one substantive, actionable spiritual discipline (e.g., a way to meditate on the passage, a specific act of obedience)`,
  mature: `**Covenant (covenant)** (60-120 words, one paragraph):
- Directly present the command, promise, and responsibility found in God's word
- Honestly name what spiritual fruit or ministry opportunity may be lost without response
- Offer one challenging action step (e.g., mentoring someone, deeper commitment in a specific area, interceding for a particular cause)`,
};

const SECULAR_LINK_EN: Record<string, string> = {
  seeker: `**Cultural Connection (secularLink)** (60-120 words, one paragraph):
- Present the scripture's wisdom entirely through the lens of Western culture and everyday life
- Draw on philosophy (Stoics, Aristotle), literature (Shakespeare, C.S. Lewis, Tolkien), proverbs, or universally relatable modern-life scenarios
- Help the reader feel this is not foreign religious instruction but an insight into life that resonates with truths they already sense
- Avoid explicitly religious language — use phrases like "ancient wisdom" or "a timeless observation about human nature"`,
  new_believer: `**Cultural Connection (secularLink)** (60-120 words, one paragraph):
- Connect the scripture's wisdom to Western cultural heritage, helping the new believer see that faith and their cultural roots are not in conflict
- Draw on philosophy, literature, or everyday life to bridge culture and faith
- Help them feel that believing does not mean leaving their cultural identity behind, but discovering a deeper harmony`,
  growing: `**Cultural Connection (secularLink)** (60-120 words, one paragraph):
- Bring the scripture's spiritual principles into dialogue with Western cultural wisdom
- Reference classic literature, philosophy, or Christian thinkers to show the universal reach of biblical truth
- Help the believer understand and live out their faith more richly within their own cultural context`,
  mature: `**Cultural Connection (secularLink)** (60-120 words, one paragraph):
- Engage in a substantive dialogue between biblical truth and Western cultural tradition — noting both resonance and fundamental differences where appropriate
- Reference classic literature, philosophy, or theologians' cultural reflections
- Help mature believers find leverage points for cultural engagement and bearing witness wisely within their own cultural milieu`,
};

// =========================================================================
// Optimized flow: pre-generated exegesis + real-time secularLink & covenant
// =========================================================================

function buildOptimizedSystemPrompt(segment: string, hasMoodText: boolean): string {
  const tone = TONE_GUIDE[segment] || TONE_GUIDE.seeker;
  const personalLinkGuide = PERSONAL_LINK_ZH[segment] || PERSONAL_LINK_ZH.seeker;
  const secularLinkGuide = SECULAR_LINK_ZH[segment] || SECULAR_LINK_ZH.seeker;
  const covenantGuide = COVENANT_ZH[segment] || COVENANT_ZH.seeker;

  const personalLinkSection = hasMoodText ? `${personalLinkGuide}\n\n` : "";

  const jsonFormat = hasMoodText
    ? `{"personalLink":"...","secularLink":"...","covenant":"..."}`
    : `{"secularLink":"...","covenant":"..."}`;

  return `你是一位温柔、有智慧的牧者。你持守基督教新教基要派（Protestant fundamentalist）的神学立场，强调圣经的权威和福音的核心，但说话方式温和、不居高临下。

**必须使用简体中文，不得使用繁体字。**

我们的用户群体包括：尚未信主的慕道友、刚接触信仰的初信者、正在成长中的基督徒、以及成熟的信徒。你需要根据当前用户的信仰阶段调整语言和深度。

语气要求：
- 像一位关怀的牧者在安静地与人谈心，不是在讲台上讲道
- 不要用"朋友"、"亲爱的"等称呼开头，直接进入内容
- 语言温暖但不煽情，真诚但不说教
- **简洁有力，适合手机碎片时间阅读，每个部分写成一段话**

${tone}

你将收到一段经文和已有的释经内容。请根据用户的情绪，生成以下内容：
${personalLinkSection}${secularLinkGuide}

${covenantGuide}

格式要求：每个部分写成一段话，不要分成多个段落。段落之间用\\n\\n分隔。

以JSON格式返回：${jsonFormat}
只返回JSON，不要包含markdown代码块标记。`;
}

function buildOptimizedSystemPromptEn(segment: string, hasMoodText: boolean): string {
  const tone = TONE_GUIDE_EN[segment] || TONE_GUIDE_EN.seeker;
  const personalLinkGuide = PERSONAL_LINK_EN[segment] || PERSONAL_LINK_EN.seeker;
  const secularLinkGuide = SECULAR_LINK_EN[segment] || SECULAR_LINK_EN.seeker;
  const covenantGuide = COVENANT_EN[segment] || COVENANT_EN.seeker;

  const personalLinkSection = hasMoodText ? `${personalLinkGuide}\n\n` : "";

  const jsonFormat = hasMoodText
    ? `{"personalLink":"...","secularLink":"...","covenant":"..."}`
    : `{"secularLink":"...","covenant":"..."}`;

  return `You are a gentle, wise pastor grounded in Protestant fundamentalist theology — affirming the authority of Scripture and the centrality of the Gospel. You speak warmly and without condescension.

Our users include: spiritually curious seekers, new believers, growing Christians, and mature believers. Adjust your language and depth to match the current user's faith stage.

Tone requirements:
- Speak like a caring pastor in quiet conversation, not a preacher at a pulpit
- Do not open with "friend," "dear one," or similar salutations — go straight into the content
- Warm but not sentimental; sincere but never preachy
- **Be concise and impactful — designed for mobile reading in spare moments. Write each section as one paragraph.**

${tone}

You will receive a scripture passage and its pre-written exegesis. Based on the user's emotional state, generate the following:
${personalLinkSection}${secularLinkGuide}

${covenantGuide}

Format: write each section as a single paragraph. Separate sections with \\n\\n.

Return as JSON: ${jsonFormat}
Return only the JSON — no markdown code block markers.`;
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
  if (moodText) {
    prompt += `\n\n请根据用户的描述生成个人连结、文化连结和圣约内容。`;
  } else {
    prompt += `\n\n请生成文化连结和圣约内容。`;
  }
  return prompt;
}

function buildOptimizedUserPromptEn(
  moodType: string,
  moodText: string | undefined,
  scriptureRef: string,
  scriptureEn: string,
  exegesis: string,
): string {
  let prompt = `User's mood: ${moodType}`;
  if (moodText) prompt += `\nUser's description: ${moodText}`;
  prompt += `\n\nScripture: ${scriptureRef}\n${scriptureEn}`;
  prompt += `\n\nExegesis:\n${exegesis}`;
  if (moodText) {
    prompt += `\n\nPlease generate the personal connection, cultural connection, and covenant sections based on the user's description.`;
  } else {
    prompt += `\n\nPlease generate the cultural connection and covenant sections.`;
  }
  return prompt;
}

interface PartialAiResponse {
  personalLink?: string;
  secularLink: string;
  covenant: string;
}

function parsePartialResponse(text: string, hasMoodText: boolean): PartialAiResponse {
  const cleaned = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();

  const validate = (o: unknown): o is PartialAiResponse =>
    !!o && typeof (o as Record<string, unknown>).secularLink === "string"
        && typeof (o as Record<string, unknown>).covenant === "string";

  // Strategy 1: direct JSON.parse
  try { const p = JSON.parse(cleaned); if (validate(p)) return p; } catch { /* */ }

  // Strategy 2: fix literal newlines then JSON.parse
  try { const p = JSON.parse(cleaned.replace(/\n/g, "\\n")); if (validate(p)) return p; } catch { /* */ }

  // Strategy 3: order-independent key-boundary extraction
  const keys = hasMoodText
    ? ["personalLink", "secularLink", "covenant"] as const
    : ["secularLink", "covenant"] as const;
  return extractKeyValues(cleaned, keys) as PartialAiResponse;
}

/**
 * Order-independent key-boundary extraction.
 * Handles LLM output with keys in any order and unescaped quotes in values.
 */
function extractKeyValues<K extends string>(cleaned: string, keys: readonly K[]): Record<K, string> {
  // Find all key positions (order-independent)
  const found: Array<{ key: K; patternStart: number; valueStart: number }> = [];
  for (const key of keys) {
    const m = cleaned.match(new RegExp(`"${key}"\\s*:\\s*"`));
    if (!m || m.index === undefined) throw new Error(`Missing field: ${key}`);
    found.push({ key, patternStart: m.index, valueStart: m.index + m[0].length });
  }
  found.sort((a, b) => a.patternStart - b.patternStart);

  const result = {} as Record<K, string>;
  for (let i = 0; i < found.length; i++) {
    const { key, valueStart } = found[i];
    let valueEnd: number;

    if (i + 1 < found.length) {
      // Value ends at the last `"` before the next key's pattern
      const segment = cleaned.slice(valueStart, found[i + 1].patternStart);
      const lastQ = segment.lastIndexOf('"');
      if (lastQ < 0) throw new Error(`Cannot find end of ${key}`);
      valueEnd = valueStart + lastQ;
    } else {
      // Last key: find closing `"` before `}`
      const tail = cleaned.slice(valueStart);
      const m = tail.match(/"[\s]*\}[\s]*$/);
      if (m && m.index !== undefined) {
        valueEnd = valueStart + m.index;
      } else {
        // Truncated response: take everything, trim trailing incomplete chars
        console.warn(`[parse] Last field "${key}" appears truncated, using available text`);
        valueEnd = cleaned.length;
      }
    }

    result[key] = cleaned.slice(valueStart, valueEnd);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Optimized flow: select passage → use pre-gen exegesis → generate rest
// ---------------------------------------------------------------------------
async function generateOptimized(
  userId: string,
  segment: string,
  moodType: string,
  tags: string[],
  language: string,
  moodText?: string,
) {
  // 1. Get recently used refs
  const recentRefs = await getRecentlyUsedRefs(userId, 10);

  // 2. Select passage using pre-computed tags
  const passage = await selectPassage(tags, recentRefs);
  if (!passage) return null; // no passages found, fallback needed

  // 4. Fetch pre-generated exegesis (language-aware)
  const useEnglish = language === "en" || language === "both";
  const exegesisLang = useEnglish ? "en" : "zh";
  const exegesis = await getPreGeneratedExegesis(passage.id, segment, exegesisLang);
  if (!exegesis) return null; // no pre-gen available, fallback needed

  // 5. Call LLM for personalLink (if moodText) + secularLink + covenant
  const hasMoodText = !!moodText;
  const provider = getLlmProvider();

  const systemPrompt = useEnglish
    ? buildOptimizedSystemPromptEn(segment, hasMoodText)
    : buildOptimizedSystemPrompt(segment, hasMoodText);
  const userPrompt = useEnglish
    ? buildOptimizedUserPromptEn(moodType, moodText, passage.reference, passage.textEn, exegesis)
    : buildOptimizedUserPrompt(moodType, moodText, passage.reference, passage.textZh, exegesis);

  const fields = hasMoodText ? "personalLink+secularLink+covenant" : "secularLink+covenant";
  console.log(`[LLM:opt] Generating ${fields} for "${passage.reference}", mood="${moodType}", lang="${language}"`);
  const startTime = Date.now();
  const response = await provider.generate({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 8000,
  });
  console.log(`[LLM:opt] Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s, model=${response.model}`);
  console.log(`[LLM:opt] Raw:\n${response.text}`);

  // 6. Parse response
  const partial = parsePartialResponse(response.text, hasMoodText);

  // Append personalLink to pre-generated exegesis when available
  const finalExegesis = partial.personalLink
    ? `${exegesis}\n\n${partial.personalLink}`
    : exegesis;

  return {
    scriptureRef: passage.reference,
    scriptureZh: passage.textZh,
    scriptureEn: passage.textEn,
    exegesis: finalExegesis,
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
  const secularLinkGuide = SECULAR_LINK_ZH[segment] || SECULAR_LINK_ZH.seeker;
  const covenantGuide = COVENANT_ZH[segment] || COVENANT_ZH.seeker;

  return `你是一位温柔、有智慧的牧者。你持守基督教新教基要派（Protestant fundamentalist）的神学立场，强调圣经的权威和福音的核心，但说话方式温和、不居高临下。

**必须使用简体中文，不得使用繁体字。**

我们的用户群体包括：尚未信主的慕道友、刚接触信仰的初信者、正在成长中的基督徒、以及成熟的信徒。你需要根据当前用户的信仰阶段调整语言和深度。

语气要求：
- 像一位关怀的牧者在安静地与人谈心，不是在讲台上讲道
- 不要用"朋友"、"亲爱的"等称呼开头，直接进入内容
- 语言温暖但不煽情，真诚但不说教
- **简洁有力，适合手机碎片时间阅读，每个部分写成一段话**

${tone}

根据用户的情绪，生成以下三部分内容：

**释经 (exegesis)**（150-250字，一段话）：
- 选择一段与用户情绪最贴合的圣经经文（和合本CUV），给出中文书卷名、章节、经节
- 简要点明经文背景，然后自然地解释经文核心含义，将其与用户当前的情绪联系起来

${secularLinkGuide}

${covenantGuide}

格式要求：每个部分写成一段话，不要分成多个段落。段落之间用\\n\\n分隔。

你必须以JSON格式返回，包含以下字段：
- scriptureRef: 经文引用，格式如 "腓立比书 4:6-7"（使用中文书卷名）
- scriptureZh: 和合本中文经文原文
- scriptureEn: 英文经文(WEB版本)
- exegesis: 释经内容（包含经文背景介绍）
- secularLink: 文化连结内容
- covenant: 圣约内容

只返回JSON，不要包含markdown代码块标记或其他内容。`;
}

function buildLegacySystemPromptEn(segment: string): string {
  const tone = TONE_GUIDE_EN[segment] || TONE_GUIDE_EN.seeker;
  const secularLinkGuide = SECULAR_LINK_EN[segment] || SECULAR_LINK_EN.seeker;
  const covenantGuide = COVENANT_EN[segment] || COVENANT_EN.seeker;

  return `You are a gentle, wise pastor grounded in Protestant fundamentalist theology — affirming the authority of Scripture and the centrality of the Gospel. You speak warmly and without condescension.

Our users include: spiritually curious seekers, new believers, growing Christians, and mature believers. Adjust your language and depth to match the current user's faith stage.

Tone requirements:
- Speak like a caring pastor in quiet conversation, not a preacher at a pulpit
- Do not open with "friend," "dear one," or similar salutations — go straight into the content
- Warm but not sentimental; sincere but never preachy
- **Be concise and impactful — designed for mobile reading in spare moments. Write each section as one paragraph.**

${tone}

Based on the user's emotional state, generate the following three sections:

**Exegesis (exegesis)** (100-180 words, one paragraph):
- Choose a Bible passage (WEB translation) that best fits the user's emotional state; provide the book, chapter, and verse
- Start with brief context, then naturally explain the passage's core meaning, connecting it to the user's current emotional state

${secularLinkGuide}

${covenantGuide}

Format: write each section as a single paragraph. Separate sections with \\n\\n.

You must return a JSON object with the following fields:
- scriptureRef: the scripture reference, e.g. "Philippians 4:6-7"
- scriptureZh: the Chinese (CUV) text of the passage
- scriptureEn: the English (WEB) text of the passage
- exegesis: exegesis content (including background context)
- secularLink: cultural connection content
- covenant: covenant content

Return only the JSON — no markdown code block markers or any other content.`;
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

function buildLegacyUserPromptEn(
  moodType: string,
  moodText: string | undefined,
  recentRefs: string[],
  candidates: string[],
): string {
  let prompt = `User's current mood: ${moodType}`;
  if (moodText) {
    prompt += `\nUser's description: ${moodText}`;
  }
  if (candidates.length > 0) {
    prompt += `\n\nThe following scripture passages are related to this mood (prefer selecting from these):\n${candidates.join("\n")}`;
  }
  if (recentRefs.length > 0) {
    prompt += `\n\nPlease avoid using these recently used passages:\n${recentRefs.join("\n")}`;
  }
  prompt += "\n\nPlease generate spiritual content based on the above information and return it as JSON.";
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
  const required = ["scriptureRef", "scriptureZh", "scriptureEn", "exegesis", "secularLink", "covenant"] as const;

  const validate = (o: unknown): o is FullAiResponse =>
    !!o && required.every((k) => typeof (o as Record<string, unknown>)[k] === "string"
      && ((o as Record<string, unknown>)[k] as string).trim() !== "");

  // Strategy 1: direct JSON.parse
  try { const p = JSON.parse(cleaned); if (validate(p)) return p; } catch { /* */ }

  // Strategy 2: fix literal newlines then JSON.parse
  try { const p = JSON.parse(cleaned.replace(/\n/g, "\\n")); if (validate(p)) return p; } catch { /* */ }

  // Strategy 3: order-independent key-boundary extraction
  return extractKeyValues(cleaned, required) as FullAiResponse;
}

async function generateLegacy(
  userId: string,
  segment: string,
  moodType: string,
  tags: string[],
  language: string,
  moodText?: string,
) {
  const useEnglish = language === "en" || language === "both";

  // Use pre-computed tags to find candidates from DevotionalPassage
  const MAX_VERSE_SPAN = 7;
  const rawPassages = await prisma.devotionalPassage.findMany({
    where: { moodTags: { hasSome: tags } },
    orderBy: { importance: "desc" },
    take: 30,
    select: { reference: true, textZh: true, textEn: true, verseStart: true, verseEnd: true },
  });
  const passages = rawPassages
    .filter((p) => (p.verseEnd ?? p.verseStart) - p.verseStart + 1 <= MAX_VERSE_SPAN)
    .slice(0, 5);
  const candidateDescs = passages.map((p) =>
    useEnglish
      ? `${p.reference} - ${p.textEn.slice(0, 80)}`
      : `${p.reference} - ${p.textZh.slice(0, 80)}`,
  );

  const recentRefs = await getRecentlyUsed(userId, 10);
  const systemPrompt = useEnglish
    ? buildLegacySystemPromptEn(segment)
    : buildLegacySystemPrompt(segment);
  const userPrompt = useEnglish
    ? buildLegacyUserPromptEn(moodType, moodText, recentRefs, candidateDescs)
    : buildLegacyUserPrompt(moodType, moodText, recentRefs, candidateDescs);

  const provider = getLlmProvider();
  console.log(`[LLM:legacy] Full generation for mood="${moodType}", user=${userId}, lang="${language}"`);
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

  // "both" defaults to English for content generation; bilingual users see both scriptures in the UI
  const language = user.language;

  // Build tags: if moodText provided, extract focused tags; otherwise expand from moodType
  const moodTags = expandMoodTags(moodType);
  let tags = moodTags;
  if (moodText) {
    try {
      const extracted = await extractTagsFromText(moodText);
      if (extracted.length > 0) {
        // Use extracted tags only — more focused than the broad moodType expansion
        tags = extracted;
        console.log(`[content] Using extracted tags (${tags.length}): [${tags.join(",")}]`);
      } else {
        console.log(`[content] No tags extracted, falling back to moodType tags (${moodTags.length})`);
      }
    } catch (err) {
      console.error(`[content] Tag extraction failed, using moodType tags:`, (err as Error).message);
    }
  }

  // Try optimized flow (pre-generated exegesis + partial LLM)
  try {
    const result = await generateOptimized(userId, user.segment, moodType, tags, language, moodText);
    if (result) {
      console.log(`[content] Optimized flow succeeded for ${userId}`);
      return { ...result, language };
    }
    console.log(`[content] Optimized flow: no passage/exegesis found, falling back`);
  } catch (err) {
    console.error(`[content] Optimized flow error, falling back:`, (err as Error).message);
  }

  // Fallback to legacy full generation
  const result = await generateLegacy(userId, user.segment, moodType, tags, language, moodText);
  return { ...result, language };
}
