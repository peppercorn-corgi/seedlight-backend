import path from "node:path";
import fs from "node:fs";
import { EdgeTTS } from "node-edge-tts";
import { prisma } from "../lib/db.js";

const AUDIO_DIR = path.resolve("public/audio");

// Ensure audio directory exists
fs.mkdirSync(AUDIO_DIR, { recursive: true });

function buildTtsText(card: {
  scriptureZh: string;
  scriptureRef: string;
  exegesis: string;
  secularLink: string;
  covenant: string;
}): string {
  // Build a natural reading flow with pauses (SSML-style periods for natural breaks)
  const sections = [
    `${card.scriptureRef}。${card.scriptureZh}`,
    card.exegesis,
    card.secularLink,
    card.covenant,
  ];
  // Join sections with a longer pause (double period creates a natural pause in TTS)
  return sections.join("。。");
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

  try {
    const tts = new EdgeTTS({ voice: "zh-CN-XiaoxiaoNeural" });
    await tts.ttsPromise(text, audioPath);

    const audioUrl = `/api/audio/${contentCardId}`;
    await prisma.contentCard.update({
      where: { id: contentCardId },
      data: { audioUrl },
    });

    return audioUrl;
  } catch (err) {
    console.error(`[audio] TTS generation failed for ${contentCardId}:`, err);
    // Clean up partial file if it exists
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
    return null;
  }
}

/**
 * Get the file path for a content card's audio, or null if not generated.
 */
export function getAudioFilePath(contentCardId: string): string | null {
  const audioPath = path.join(AUDIO_DIR, `${contentCardId}.mp3`);
  return fs.existsSync(audioPath) ? audioPath : null;
}
