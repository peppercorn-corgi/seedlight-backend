import path from "node:path";
import fs from "node:fs";
import { EdgeTTS } from "node-edge-tts";
import { prisma } from "../lib/db.js";

const AUDIO_DIR = path.resolve("public/audio");
const TTS_MAX_RETRIES = 2;

// Track IDs currently being generated so the route can return 202
const generating = new Set<string>();

// Ensure audio directory exists
fs.mkdirSync(AUDIO_DIR, { recursive: true });

function buildTtsText(card: {
  scriptureZh: string;
  scriptureRef: string;
  exegesis: string;
  secularLink: string;
  covenant: string;
}): string {
  const sections = [
    `${card.scriptureRef}。${card.scriptureZh}`,
    card.exegesis,
    card.secularLink,
    card.covenant,
  ];
  return sections.join("。。");
}

async function ttsWithRetry(text: string, audioPath: string): Promise<void> {
  for (let attempt = 1; attempt <= TTS_MAX_RETRIES; attempt++) {
    try {
      const tts = new EdgeTTS({ voice: "zh-CN-XiaoxiaoNeural" });
      await tts.ttsPromise(text, audioPath);
      return;
    } catch (err) {
      console.error(`[audio] TTS attempt ${attempt}/${TTS_MAX_RETRIES} failed:`, err);
      // Clean up partial file
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }
      if (attempt === TTS_MAX_RETRIES) throw err;
      // Brief pause before retry
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Generate TTS audio for a ContentCard and save as MP3.
 * Returns the audio URL path, or null if generation fails.
 */
export async function generateAudio(contentCardId: string): Promise<string | null> {
  const card = await prisma.contentCard.findUnique({
    where: { id: contentCardId },
  });

  if (!card) {
    throw new Error(`ContentCard not found: ${contentCardId}`);
  }

  const text = buildTtsText(card);
  const audioPath = path.join(AUDIO_DIR, `${contentCardId}.mp3`);

  generating.add(contentCardId);
  try {
    await ttsWithRetry(text, audioPath);

    const audioUrl = `/api/audio/${contentCardId}`;
    await prisma.contentCard.update({
      where: { id: contentCardId },
      data: { audioUrl },
    });

    console.log(`[audio] Generated audio for ${contentCardId}`);
    return audioUrl;
  } catch (err) {
    console.error(`[audio] TTS generation failed for ${contentCardId}:`, err);
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
    return null;
  } finally {
    generating.delete(contentCardId);
  }
}

/**
 * Check whether audio is currently being generated for a card.
 */
export function isAudioGenerating(contentCardId: string): boolean {
  return generating.has(contentCardId);
}

/**
 * Get the file path for a content card's audio, or null if not generated.
 */
export function getAudioFilePath(contentCardId: string): string | null {
  const audioPath = path.join(AUDIO_DIR, `${contentCardId}.mp3`);
  return fs.existsSync(audioPath) ? audioPath : null;
}
