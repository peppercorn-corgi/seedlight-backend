/**
 * View user feedback locally.
 *
 * Usage:
 *   npx tsx scripts/view-feedback.ts              # all feedback
 *   npx tsx scripts/view-feedback.ts --days 7     # last 7 days
 *   npx tsx scripts/view-feedback.ts --limit 20   # latest 20
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const DAYS = args.includes("--days")
  ? parseInt(args[args.indexOf("--days") + 1], 10)
  : 0;
const LIMIT = args.includes("--limit")
  ? parseInt(args[args.indexOf("--limit") + 1], 10)
  : 100;

const since = DAYS > 0
  ? new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000)
  : new Date("2020-01-01");

async function main() {
  const total = await prisma.userFeedback.count({
    where: { createdAt: { gte: since } },
  });

  const feedbacks = await prisma.userFeedback.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: LIMIT,
  });

  console.log(`\n📬 User Feedback — ${DAYS > 0 ? `Last ${DAYS} days` : "All time"} (${total} total)\n`);
  console.log("=".repeat(70));

  if (feedbacks.length === 0) {
    console.log("  (no feedback yet)");
  }

  for (const fb of feedbacks) {
    const date = fb.createdAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    const user = fb.userId ? `user:${fb.userId.slice(0, 8)}…` : "anonymous";
    const contact = fb.contact ? ` | contact: ${fb.contact}` : "";
    const page = fb.page ? ` | page: ${fb.page}` : "";
    const card = fb.contentCardId ? ` | card:${fb.contentCardId.slice(0, 8)}…` : "";

    console.log(`\n  [${date}] ${user}${contact}${page}${card}`);
    console.log(`  ${"─".repeat(60)}`);
    // Indent message lines
    for (const line of fb.message.split("\n")) {
      console.log(`  ${line}`);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  Showing ${feedbacks.length}/${total}\n`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
