import path from "node:path";
import fs from "node:fs";
import { TextToSpeechClient, protos } from "@google-cloud/text-to-speech";
import { prisma } from "../lib/db.js";

const AUDIO_DIR = path.resolve("public/audio");
const TTS_MAX_RETRIES = 2;

// Track IDs currently being generated so the route can return 202
const generating = new Set<string>();

// Ensure audio directory exists
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Google Cloud TTS client
// Supports: GOOGLE_APPLICATION_CREDENTIALS (file path) or GOOGLE_TTS_CREDENTIALS (JSON string)
const hasCredentials = !!(process.env.GOOGLE_TTS_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS);
const ttsClient = process.env.GOOGLE_TTS_CREDENTIALS
  ? new TextToSpeechClient({ credentials: JSON.parse(process.env.GOOGLE_TTS_CREDENTIALS) })
  : new TextToSpeechClient();
console.log(`[audio] TTS provider: Google Cloud (credentials: ${hasCredentials ? "configured" : "missing"})`);

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

async function synthesize(text: string, audioPath: string): Promise<void> {
  const request: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
    input: { text },
    voice: {
      languageCode: "cmn-CN",
      name: "cmn-CN-Standard-A", // Female standard voice
    },
    audioConfig: {
      audioEncoding: "MP3" as unknown as protos.google.cloud.texttospeech.v1.AudioEncoding,
      speakingRate: 0.95,
    },
  };

  const [response] = await ttsClient.synthesizeSpeech(request);

  if (!response.audioContent) {
    throw new Error("Google TTS returned empty audio content");
  }

  fs.writeFileSync(audioPath, response.audioContent as Buffer);
}

async function ttsWithRetry(text: string, audioPath: string): Promise<void> {
  for (let attempt = 1; attempt <= TTS_MAX_RETRIES; attempt++) {
    try {
      await synthesize(text, audioPath);
      return;
    } catch (err) {
      console.error(`[audio] TTS attempt ${attempt}/${TTS_MAX_RETRIES} failed:`, err);
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }
      if (attempt === TTS_MAX_RETRIES) throw err;
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
