import { prisma } from "../lib/db.js";

export async function findByReference(ref: string) {
  // Parse reference like "Philippians 4:6-7" or "诗篇 23:1"
  const match = ref.match(/^(.+?)\s+(\d+):(\d+)(?:-(\d+))?$/);
  if (!match) return null;

  const [, bookRaw, chapterStr, verseStartStr, verseEndStr] = match;
  const chapter = parseInt(chapterStr, 10);
  const verseStart = parseInt(verseStartStr, 10);
  const verseEnd = verseEndStr ? parseInt(verseEndStr, 10) : verseStart;

  // Query all individual verses in the range
  const verses = await prisma.scriptureIndex.findMany({
    where: {
      OR: [{ book: bookRaw }, { bookZh: bookRaw }],
      chapter,
      verseStart: { gte: verseStart, lte: verseEnd },
    },
    orderBy: { verseStart: "asc" },
  });

  if (verses.length === 0) return null;

  // Combine text from all verses in the range
  return {
    ...verses[0],
    verseEnd: verseEnd > verseStart ? verseEnd : null,
    textZh: verses.map((v) => v.textZh).join(""),
    textEn: verses.map((v) => v.textEn).join(" "),
  };
}

export async function getRecentlyUsed(userId: string, limit: number) {
  const recentCards = await prisma.contentCard.findMany({
    where: {
      moodEntry: { userId },
    },
    select: { scriptureRef: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return recentCards.map((c) => c.scriptureRef);
}
