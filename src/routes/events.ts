import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { optionalAuth, resolveUser } from "../middleware/auth.js";
import { prisma } from "../lib/db.js";

const router = Router();

const VALID_EVENTS = [
  "mood_submit", "content_view", "share_link", "share_image",
  "save", "unsave", "like", "unlike", "audio_play", "copy_verse",
  "page_view", "translate_card",
] as const;

const eventSchema = z.object({
  event: z.enum(VALID_EVENTS),
  data: z.record(z.unknown()).optional(),
});

const batchSchema = z.object({
  events: z.array(eventSchema).max(50),
});

// POST /api/events — batch event ingestion (auth optional)
router.post("/", optionalAuth, async (req, res) => {
  const isBatch = Array.isArray(req.body?.events);
  const parsed = isBatch
    ? batchSchema.safeParse(req.body)
    : eventSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: "Invalid event data" });
    return;
  }

  const events = isBatch
    ? (parsed.data as z.infer<typeof batchSchema>).events
    : [parsed.data as z.infer<typeof eventSchema>];

  // Resolve internal userId if authenticated
  let userId: string | null = null;
  if (req.user?.sub) {
    const user = await resolveUser(req.user.sub);
    userId = user?.id ?? null;
  }

  await prisma.analyticsEvent.createMany({
    data: events.map((e) => ({
      userId,
      event: e.event,
      data: (e.data ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    })),
  });

  res.status(204).end();
});

export default router;
