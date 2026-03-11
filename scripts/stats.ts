/**
 * Local analytics stats script.
 *
 * Usage:
 *   npx tsx scripts/stats.ts              # all stats
 *   npx tsx scripts/stats.ts --days 7     # last 7 days only
 *   npx tsx scripts/stats.ts --days 30    # last 30 days
 */

import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const DAYS = args.includes("--days")
  ? parseInt(args[args.indexOf("--days") + 1], 10)
  : 0; // 0 = all time

const since = DAYS > 0
  ? new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000)
  : new Date("2020-01-01");

function heading(title: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

function table(rows: Record<string, unknown>[]) {
  if (rows.length === 0) { console.log("  (no data)"); return; }
  console.table(rows);
}

// ---------------------------------------------------------------------------
// 1. User Overview
// ---------------------------------------------------------------------------
async function userOverview() {
  heading("User Overview");

  const total = await prisma.user.count();
  const recent7d = await prisma.user.count({
    where: { createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
  });
  const recent30d = await prisma.user.count({
    where: { createdAt: { gte: new Date(Date.now() - 30 * 86400000) } },
  });

  console.log(`  Total users: ${total}`);
  console.log(`  New (7d): ${recent7d}`);
  console.log(`  New (30d): ${recent30d}`);

  // Segment distribution
  const segments = await prisma.user.groupBy({
    by: ["segment"],
    _count: true,
    orderBy: { _count: { segment: "desc" } },
  });
  console.log("\n  Segment distribution:");
  for (const s of segments) {
    console.log(`    ${s.segment}: ${s._count} (${(s._count / total * 100).toFixed(1)}%)`);
  }

  // Language distribution
  const langs = await prisma.user.groupBy({
    by: ["language"],
    _count: true,
    orderBy: { _count: { language: "desc" } },
  });
  console.log("\n  Language distribution:");
  for (const l of langs) {
    console.log(`    ${l.language}: ${l._count} (${(l._count / total * 100).toFixed(1)}%)`);
  }
}

// ---------------------------------------------------------------------------
// 2. DAU / WAU / MAU
// ---------------------------------------------------------------------------
async function activeUsers() {
  heading("Active Users (based on mood submissions)");

  const now = new Date();
  const day1 = new Date(now.getTime() - 1 * 86400000);
  const day7 = new Date(now.getTime() - 7 * 86400000);
  const day30 = new Date(now.getTime() - 30 * 86400000);

  const dau = await prisma.moodEntry.findMany({
    where: { createdAt: { gte: day1 } },
    select: { userId: true },
    distinct: ["userId"],
  });
  const wau = await prisma.moodEntry.findMany({
    where: { createdAt: { gte: day7 } },
    select: { userId: true },
    distinct: ["userId"],
  });
  const mau = await prisma.moodEntry.findMany({
    where: { createdAt: { gte: day30 } },
    select: { userId: true },
    distinct: ["userId"],
  });

  console.log(`  DAU (24h): ${dau.length}`);
  console.log(`  WAU (7d):  ${wau.length}`);
  console.log(`  MAU (30d): ${mau.length}`);
  if (mau.length > 0) {
    console.log(`  DAU/MAU ratio: ${(dau.length / mau.length * 100).toFixed(1)}%`);
  }
}

// ---------------------------------------------------------------------------
// 3. Mood Distribution
// ---------------------------------------------------------------------------
async function moodDistribution() {
  heading("Mood Distribution");

  const moods = await prisma.$queryRaw<Array<{ mood: string; cnt: number }>>`
    SELECT "moodType" as mood, count(*)::int as cnt
    FROM mood_entries
    WHERE "createdAt" >= ${since}
    GROUP BY "moodType"
    ORDER BY cnt DESC
  `;

  const total = moods.reduce((s, m) => s + m.cnt, 0);
  for (const m of moods) {
    const pct = (m.cnt / total * 100).toFixed(1);
    const bar = "█".repeat(Math.round(m.cnt / total * 40));
    console.log(`  ${m.mood.padEnd(14)} ${String(m.cnt).padStart(5)} (${pct.padStart(5)}%) ${bar}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Content Engagement (save / like / share)
// ---------------------------------------------------------------------------
async function contentEngagement() {
  heading("Content Engagement");

  const totalCards = await prisma.contentCard.count({
    where: { createdAt: { gte: since } },
  });

  const saves = await prisma.feedback.count({
    where: { type: "save", createdAt: { gte: since } },
  });
  const likes = await prisma.feedback.count({
    where: { type: "like", createdAt: { gte: since } },
  });

  // Share events from analytics
  const shareLinks = await prisma.analyticsEvent.count({
    where: { event: "share_link", createdAt: { gte: since } },
  });
  const shareImages = await prisma.analyticsEvent.count({
    where: { event: "share_image", createdAt: { gte: since } },
  });
  const audioPlays = await prisma.analyticsEvent.count({
    where: { event: "audio_play", createdAt: { gte: since } },
  });
  const copyVerses = await prisma.analyticsEvent.count({
    where: { event: "copy_verse", createdAt: { gte: since } },
  });

  console.log(`  Total content cards: ${totalCards}`);
  console.log(`  Saves: ${saves} (${totalCards ? (saves / totalCards * 100).toFixed(1) : 0}%)`);
  console.log(`  Likes: ${likes} (${totalCards ? (likes / totalCards * 100).toFixed(1) : 0}%)`);
  console.log(`  Share (link): ${shareLinks}`);
  console.log(`  Share (image): ${shareImages}`);
  console.log(`  Audio plays: ${audioPlays}`);
  console.log(`  Copy verse: ${copyVerses}`);
}

// ---------------------------------------------------------------------------
// 5. Top Scriptures
// ---------------------------------------------------------------------------
async function topScriptures() {
  heading("Top 15 Most Engaged Scriptures");

  const top = await prisma.$queryRaw<Array<{ ref: string; views: number; saves: number; likes: number }>>`
    SELECT
      cc."scriptureRef" as ref,
      count(DISTINCT cc.id)::int as views,
      count(DISTINCT CASE WHEN f.type = 'save' THEN f.id END)::int as saves,
      count(DISTINCT CASE WHEN f.type = 'like' THEN f.id END)::int as likes
    FROM content_cards cc
    LEFT JOIN feedbacks f ON f."contentCardId" = cc.id
    WHERE cc."createdAt" >= ${since}
    GROUP BY cc."scriptureRef"
    ORDER BY views DESC
    LIMIT 15
  `;

  for (const r of top) {
    console.log(`  ${r.ref.padEnd(25)} views=${String(r.views).padStart(3)} saves=${String(r.saves).padStart(3)} likes=${String(r.likes).padStart(3)}`);
  }
}

// ---------------------------------------------------------------------------
// 6. Usage Time Distribution (hour of day)
// ---------------------------------------------------------------------------
async function usageTimeDistribution() {
  heading("Usage by Hour of Day (local time)");

  const hours = await prisma.$queryRaw<Array<{ hour: number; cnt: number }>>`
    SELECT
      extract(hour from "createdAt" AT TIME ZONE 'Asia/Shanghai')::int as hour,
      count(*)::int as cnt
    FROM mood_entries
    WHERE "createdAt" >= ${since}
    GROUP BY hour
    ORDER BY hour
  `;

  const maxCnt = Math.max(...hours.map(h => h.cnt), 1);
  for (let h = 0; h < 24; h++) {
    const found = hours.find(r => r.hour === h);
    const cnt = found?.cnt ?? 0;
    const bar = "█".repeat(Math.round(cnt / maxCnt * 30));
    console.log(`  ${String(h).padStart(2)}:00  ${String(cnt).padStart(5)}  ${bar}`);
  }
}

// ---------------------------------------------------------------------------
// 7. Usage by Day of Week
// ---------------------------------------------------------------------------
async function usageDayOfWeek() {
  heading("Usage by Day of Week");

  const days = await prisma.$queryRaw<Array<{ dow: number; cnt: number }>>`
    SELECT
      extract(dow from "createdAt" AT TIME ZONE 'Asia/Shanghai')::int as dow,
      count(*)::int as cnt
    FROM mood_entries
    WHERE "createdAt" >= ${since}
    GROUP BY dow
    ORDER BY dow
  `;

  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const maxCnt = Math.max(...days.map(d => d.cnt), 1);
  for (const d of days) {
    const bar = "█".repeat(Math.round(d.cnt / maxCnt * 30));
    console.log(`  ${names[d.dow]}  ${String(d.cnt).padStart(5)}  ${bar}`);
  }
}

// ---------------------------------------------------------------------------
// 8. Share Funnel
// ---------------------------------------------------------------------------
async function shareFunnel() {
  heading("Share Funnel");

  const contentViews = await prisma.analyticsEvent.count({
    where: { event: "content_view", createdAt: { gte: since } },
  });
  const shareClicks = await prisma.analyticsEvent.count({
    where: { event: { in: ["share_link", "share_image"] }, createdAt: { gte: since } },
  });
  // Count shared page views (if tracked)
  const sharedPageViews = await prisma.analyticsEvent.count({
    where: {
      event: "page_view",
      createdAt: { gte: since },
      data: { path: ["page"], equals: "shared" },
    },
  });

  console.log(`  Content generated: ${contentViews}`);
  console.log(`  Share actions: ${shareClicks} (${contentViews ? (shareClicks / contentViews * 100).toFixed(1) : 0}% of views)`);
  console.log(`  Shared page views: ${sharedPageViews}`);
  if (shareClicks > 0) {
    console.log(`  Share → View conversion: ${(sharedPageViews / shareClicks * 100).toFixed(1)}%`);
  }
}

// ---------------------------------------------------------------------------
// 9. Retention (Day 1 / Day 7 / Day 30)
// ---------------------------------------------------------------------------
async function retention() {
  heading("Retention (cohort-based)");

  // Get users created in the last 31-60 days (so we can measure 30-day retention)
  const cohortStart = new Date(Date.now() - 60 * 86400000);
  const cohortEnd = new Date(Date.now() - 31 * 86400000);

  const cohortUsers = await prisma.user.findMany({
    where: { createdAt: { gte: cohortStart, lt: cohortEnd } },
    select: { id: true, createdAt: true },
  });

  if (cohortUsers.length === 0) {
    console.log("  Not enough data for retention analysis (need users from 31-60 days ago)");
    return;
  }

  let d1 = 0, d7 = 0, d30 = 0;
  for (const u of cohortUsers) {
    const signup = u.createdAt.getTime();

    const hasD1 = await prisma.moodEntry.findFirst({
      where: {
        userId: u.id,
        createdAt: { gte: new Date(signup + 1 * 86400000), lt: new Date(signup + 2 * 86400000) },
      },
    });
    if (hasD1) d1++;

    const hasD7 = await prisma.moodEntry.findFirst({
      where: {
        userId: u.id,
        createdAt: { gte: new Date(signup + 6 * 86400000), lt: new Date(signup + 8 * 86400000) },
      },
    });
    if (hasD7) d7++;

    const hasD30 = await prisma.moodEntry.findFirst({
      where: {
        userId: u.id,
        createdAt: { gte: new Date(signup + 29 * 86400000), lt: new Date(signup + 31 * 86400000) },
      },
    });
    if (hasD30) d30++;
  }

  const total = cohortUsers.length;
  console.log(`  Cohort size (users from ${cohortStart.toLocaleDateString()} - ${cohortEnd.toLocaleDateString()}): ${total}`);
  console.log(`  Day 1 retention:  ${d1}/${total} (${(d1 / total * 100).toFixed(1)}%)`);
  console.log(`  Day 7 retention:  ${d7}/${total} (${(d7 / total * 100).toFixed(1)}%)`);
  console.log(`  Day 30 retention: ${d30}/${total} (${(d30 / total * 100).toFixed(1)}%)`);
}

// ---------------------------------------------------------------------------
// 10. Analytics Events Summary
// ---------------------------------------------------------------------------
async function eventsSummary() {
  heading("Analytics Events Summary");

  const events = await prisma.analyticsEvent.groupBy({
    by: ["event"],
    where: { createdAt: { gte: since } },
    _count: true,
    orderBy: { _count: { event: "desc" } },
  });

  for (const e of events) {
    console.log(`  ${e.event.padEnd(18)} ${e._count}`);
  }

  const total = await prisma.analyticsEvent.count({
    where: { createdAt: { gte: since } },
  });
  console.log(`\n  Total events: ${total}`);
}

// ---------------------------------------------------------------------------
// 11. Pre-generation Progress
// ---------------------------------------------------------------------------
async function pregenProgress() {
  heading("Pre-generation Progress");

  const totalPassages = await prisma.devotionalPassage.count();
  const zhComplete = await prisma.$queryRaw<[{ cnt: number }]>`
    SELECT count(DISTINCT "passageId")::int as cnt
    FROM pre_generated_exegeses
    WHERE language = 'zh'
  `;
  const enComplete = await prisma.$queryRaw<[{ cnt: number }]>`
    SELECT count(DISTINCT "passageId")::int as cnt
    FROM pre_generated_exegeses
    WHERE language = 'en'
  `;

  console.log(`  Total passages: ${totalPassages}`);
  console.log(`  ZH exegesis: ${zhComplete[0].cnt} (${(zhComplete[0].cnt / totalPassages * 100).toFixed(1)}%)`);
  console.log(`  EN exegesis: ${enComplete[0].cnt} (${(enComplete[0].cnt / totalPassages * 100).toFixed(1)}%)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n📊 SeedLight Stats — ${DAYS > 0 ? `Last ${DAYS} days` : "All time"}`);
  console.log(`   Generated at: ${new Date().toLocaleString()}`);

  await userOverview();
  await activeUsers();
  await moodDistribution();
  await usageTimeDistribution();
  await usageDayOfWeek();
  await contentEngagement();
  await topScriptures();
  await shareFunnel();
  await eventsSummary();
  await pregenProgress();
  await retention();

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Stats error:", err);
  process.exit(1);
});
