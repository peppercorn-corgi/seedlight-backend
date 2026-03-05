import { prisma } from "../lib/db.js";

export async function findByMoodTags(tags: string[]) {
  return prisma.scriptureIndex.findMany({
    where: {
      moodTags: { hasSome: tags },
    },
    orderBy: { importance: "desc" },
  });
}

export async function findByReference(ref: string) {
  // Parse reference like "Philippians 4:6-7" or "诗篇 23:1"
  const match = ref.match(/^(.+?)\s+(\d+):(\d+)(?:-(\d+))?$/);
  if (!match) return null;

  const [, bookRaw, chapterStr, verseStartStr, verseEndStr] = match;
  const chapter = parseInt(chapterStr, 10);
  const verseStart = parseInt(verseStartStr, 10);
  const verseEnd = verseEndStr ? parseInt(verseEndStr, 10) : undefined;

  return prisma.scriptureIndex.findFirst({
    where: {
      OR: [{ book: bookRaw }, { bookZh: bookRaw }],
      chapter,
      verseStart,
      ...(verseEnd !== undefined ? { verseEnd } : {}),
    },
  });
}

export async function verifyReference(
  book: string,
  chapter: number,
  verseStart: number,
) {
  const record = await prisma.scriptureIndex.findFirst({
    where: {
      OR: [{ book }, { bookZh: book }],
      chapter,
      verseStart,
    },
  });
  return record !== null;
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
