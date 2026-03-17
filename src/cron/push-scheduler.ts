import cron from "node-cron";
import webPush from "web-push";
import { prisma } from "../lib/db.js";
import { config } from "../config/index.js";

/**
 * Send a push notification to a single subscription.
 * Returns false if the subscription is invalid (gone/expired) and should be removed.
 */
async function sendPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: object,
): Promise<boolean> {
  try {
    await webPush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
    return true;
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode;
    // 404 or 410 = subscription expired/invalid, remove it
    if (status === 404 || status === 410) {
      await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
      console.log(`[push] Removed expired subscription: ${sub.endpoint.slice(0, 60)}...`);
    } else {
      console.error(`[push] Failed to send to ${sub.endpoint.slice(0, 60)}:`, err);
    }
    return false;
  }
}

/**
 * Pick a random devotional passage for push notification content.
 * Returns the passage ID so the notification URL can deep-link to
 * devotional card generation (/?devotional={id}).
 */
async function pickPassage(language: string): Promise<{ id: string; ref: string; snippet: string } | null> {
  const count = await prisma.devotionalPassage.count();
  if (count === 0) return null;

  const skip = Math.floor(Math.random() * count);
  const passage = await prisma.devotionalPassage.findFirst({
    skip,
    select: { id: true, reference: true, textZh: true, textEn: true },
  });

  if (!passage) return null;

  const text = language === "en" ? passage.textEn : passage.textZh;
  // Truncate to ~80 chars for notification body
  const snippet = text.length > 80 ? text.slice(0, 77) + "..." : text;
  return { id: passage.id, ref: passage.reference, snippet };
}

let running = false;

/**
 * Run every minute: find users whose pushTime matches the current minute
 * in their timezone, and who have active push subscriptions.
 */
async function tick() {
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) return;
  if (running) return;
  running = true;
  try { await tickInner(); } finally { running = false; }
}

async function tickInner() {

  // Find users whose local time matches their pushTime right now
  const usersToNotify = await prisma.$queryRaw<
    Array<{ id: string; language: string; pushTime: string }>
  >`
    SELECT u.id, u.language, u."pushTime"
    FROM users u
    WHERE u."pushTime" = to_char(now() AT TIME ZONE u.timezone, 'HH24:MI')
      AND EXISTS (
        SELECT 1 FROM push_subscriptions ps WHERE ps."userId" = u.id
      )
  `;

  if (usersToNotify.length === 0) return;

  console.log(`[push] ${usersToNotify.length} users to notify at this minute`);

  for (const user of usersToNotify) {
    const lang = user.language === "en" ? "en" : "zh";
    const passage = await pickPassage(lang);

    // Deep-link to devotional card generation when a passage is available
    const url = passage ? `/?devotional=${passage.id}` : "/";

    const payload = {
      title: lang === "en" ? "Today's Scripture" : "今日经文",
      body: passage
        ? `${passage.ref}\n${passage.snippet}`
        : lang === "en"
          ? "Start your devotional today"
          : "开始今天的灵修吧",
      url,
    };

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: user.id },
    });

    for (const sub of subs) {
      await sendPush(sub, payload);
    }
  }
}

export function startPushScheduler() {
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) {
    console.log("[push] VAPID keys not configured, push scheduler disabled");
    return;
  }

  // Run every minute
  cron.schedule("* * * * *", () => {
    tick().catch((err) => console.error("[push] Scheduler error:", err));
  });

  console.log("[push] Push scheduler started (checking every minute)");
}
