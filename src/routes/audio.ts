import { Router } from "express";
import fs from "node:fs";
import { requireAuth } from "../middleware/auth.js";
import { generateAudio, getAudioFilePath, isAudioGenerating } from "../services/audio.js";

const router = Router();

// Validate contentCardId is a safe CUID (no path traversal)
const CUID_RE = /^[a-z0-9]{20,30}$/;

// GET /api/audio/:contentCardId - serve audio file
router.get("/:contentCardId", requireAuth, (req, res, next) => {
  try {
    const contentCardId = req.params.contentCardId as string;

    if (!CUID_RE.test(contentCardId)) {
      res.status(400).json({ error: "Invalid content card ID" });
      return;
    }

    const filePath = getAudioFilePath(contentCardId);

    if (!filePath) {
      // Tell the client whether audio is still being generated or truly missing
      if (isAudioGenerating(contentCardId)) {
        res.status(202).json({ status: "generating" });
      } else {
        res.status(404).json({ error: "Audio not found" });
      }
      return;
    }

    const stat = fs.statSync(filePath);
    const range = req.headers.range;

    if (range) {
      // Support Range requests for seeking
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "audio/mpeg",
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": "audio/mpeg",
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/audio/:contentCardId/generate - trigger audio generation
router.post("/:contentCardId/generate", requireAuth, async (req, res, next) => {
  try {
    const contentCardId = req.params.contentCardId as string;

    if (!CUID_RE.test(contentCardId)) {
      res.status(400).json({ error: "Invalid content card ID" });
      return;
    }

    const audioUrl = await generateAudio(contentCardId);

    if (!audioUrl) {
      res.status(500).json({ error: "Audio generation failed" });
      return;
    }

    res.json({ audioUrl });
  } catch (err) {
    next(err);
  }
});

export default router;
