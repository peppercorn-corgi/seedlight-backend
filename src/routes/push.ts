import { Router } from "express";
import { z } from "zod";
import webPush from "web-push";
import { requireAuth, resolveUser } from "../middleware/auth.js";
import { prisma } from "../lib/db.js";
import { config } from "../config/index.js";

const router = Router();

// Configure web-push with VAPID keys (if available)
if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(
    config.VAPID_EMAIL,
    config.VAPID_PUBLIC_KEY,
    config.VAPID_PRIVATE_KEY,
  );
}

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  }),
});

// GET /api/push/vapid-key — public VAPID key for frontend
router.get("/vapid-key", (_req, res) => {
  if (!config.VAPID_PUBLIC_KEY) {
    res.status(503).json({ error: "Push notifications not configured" });
    return;
  }
  res.json({ publicKey: config.VAPID_PUBLIC_KEY });
});

// GET /api/push/status — check if user has active subscription on this device
router.get("/status", requireAuth, async (req, res, next) => {
  try {
    if (!config.VAPID_PUBLIC_KEY) {
      res.json({ enabled: false });
      return;
    }

    const user = await resolveUser(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const count = await prisma.pushSubscription.count({
      where: { userId: user.id },
    });

    res.json({ enabled: count > 0 });
  } catch (err) {
    next(err);
  }
});

// POST /api/push/subscribe — save push subscription
router.post("/subscribe", requireAuth, async (req, res, next) => {
  try {
    if (!config.VAPID_PUBLIC_KEY) {
      res.status(503).json({ error: "Push notifications not configured" });
      return;
    }

    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }

    const user = await resolveUser(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { endpoint, keys } = parsed.data.subscription;

    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: {
        userId: user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
      update: {
        userId: user.id,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/push/subscribe — remove push subscription
router.delete("/subscribe", requireAuth, async (req, res, next) => {
  try {
    const { endpoint } = req.body ?? {};
    if (!endpoint || typeof endpoint !== "string") {
      res.status(400).json({ error: "endpoint is required" });
      return;
    }

    const user = await resolveUser(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await prisma.pushSubscription.deleteMany({
      where: { endpoint, userId: user.id },
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/push/test — send a test notification to current user
router.post("/test", requireAuth, async (req, res, next) => {
  try {
    if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) {
      res.status(503).json({ error: "Push notifications not configured" });
      return;
    }

    const user = await resolveUser(req.user!.sub);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const subs = await prisma.pushSubscription.findMany({
      where: { userId: user.id },
    });

    if (subs.length === 0) {
      res.status(404).json({ error: "No push subscriptions found. Enable notifications first." });
      return;
    }

    // Pick a random passage for the test
    const count = await prisma.devotionalPassage.count();
    const passage = count > 0
      ? await prisma.devotionalPassage.findFirst({
          skip: Math.floor(Math.random() * count),
          select: { reference: true, textZh: true, textEn: true },
        })
      : null;

    const isEn = user.language === "en";
    const payload = JSON.stringify({
      title: isEn ? "Today's Scripture" : "今日经文",
      body: passage
        ? `${passage.reference}\n${(isEn ? passage.textEn : passage.textZh).slice(0, 80)}`
        : isEn ? "Start your devotional today" : "开始今天的灵修吧",
      url: "/",
    });

    let sent = 0;
    for (const sub of subs) {
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent++;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
        }
      }
    }

    res.json({ ok: true, sent, total: subs.length });
  } catch (err) {
    next(err);
  }
});

export default router;
