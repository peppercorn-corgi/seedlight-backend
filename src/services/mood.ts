import { prisma } from "../lib/db.js";

const KEYWORD_MAP: Record<string, string[]> = {
  anxious: ["焦虑", "担心", "紧张", "不安", "anxious", "worried", "nervous"],
  sad: ["难过", "伤心", "悲伤", "哭", "sad", "upset", "cry"],
  grateful: ["感恩", "感谢", "感激", "grateful", "thankful"],
  confused: ["困惑", "迷茫", "不知道", "confused", "lost"],
  angry: ["生气", "愤怒", "烦", "angry", "frustrated"],
  hopeful: ["希望", "期待", "盼望", "hopeful", "looking forward"],
  lonely: ["孤独", "寂寞", "一个人", "lonely", "alone"],
  fearful: ["害怕", "恐惧", "担忧", "afraid", "scared"],
  guilty: ["内疚", "愧疚", "自责", "guilty", "ashamed"],
  overwhelmed: ["压力", "崩溃", "受不了", "overwhelmed", "stressed"],
  joyful: ["开心", "快乐", "高兴", "喜悦", "happy", "joyful", "excited"],
  peaceful: ["平安", "安静", "平静", "peaceful", "calm", "serene"],
  doubtful: ["怀疑", "质疑", "不确定", "doubt", "uncertain"],
  grieving: ["悲痛", "哀伤", "失去", "grief", "mourning", "loss"],
  exhausted: ["疲惫", "累", "疲倦", "精疲力尽", "exhausted", "tired", "worn out"],
};

export function classifyMood(text: string): string {
  const lower = text.toLowerCase();
  for (const [mood, keywords] of Object.entries(KEYWORD_MAP)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return mood;
    }
  }
  return "confused";
}

export interface MoodTrendResult {
  totalEntries: number;
  period: { from: Date; to: Date };
  moodDistribution: Record<string, number>;
  dominantMood: string;
  summary: string;
}

export async function analyzeMoodTrend(
  userId: string,
  days: number = 7,
): Promise<MoodTrendResult> {
  const from = new Date();
  from.setDate(from.getDate() - days);
  const to = new Date();

  const entries = await prisma.moodEntry.findMany({
    where: {
      userId,
      createdAt: { gte: from },
    },
    select: { moodType: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  // Build distribution
  const distribution: Record<string, number> = {};
  for (const entry of entries) {
    distribution[entry.moodType] = (distribution[entry.moodType] || 0) + 1;
  }

  // Find dominant mood
  let dominantMood = "none";
  let maxCount = 0;
  for (const [mood, count] of Object.entries(distribution)) {
    if (count > maxCount) {
      maxCount = count;
      dominantMood = mood;
    }
  }

  // Generate a simple text summary
  const summary = buildTrendSummary(entries.length, distribution, dominantMood, days);

  return {
    totalEntries: entries.length,
    period: { from, to },
    moodDistribution: distribution,
    dominantMood,
    summary,
  };
}

function buildTrendSummary(
  total: number,
  distribution: Record<string, number>,
  dominant: string,
  days: number,
): string {
  if (total === 0) {
    return `过去${days}天没有情绪记录。`;
  }

  const moodLabels: Record<string, string> = {
    anxious: "焦虑", sad: "难过", grateful: "感恩", confused: "困惑",
    angry: "愤怒", hopeful: "盼望", lonely: "孤独", joyful: "喜乐",
    fearful: "恐惧", guilty: "内疚", peaceful: "平安", overwhelmed: "压力",
    doubtful: "怀疑", grieving: "哀伤", exhausted: "疲惫",
  };

  const dominantLabel = moodLabels[dominant] || dominant;
  const sorted = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
  const top3 = sorted
    .slice(0, 3)
    .map(([m, c]) => `${moodLabels[m] || m}(${c}次)`)
    .join("、");

  return `过去${days}天共${total}次情绪记录。主要情绪是「${dominantLabel}」。分布：${top3}。`;
}
