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
const hasCredentials = !!(process.env.GOOGLE_TTS_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS);
const ttsClient = process.env.GOOGLE_TTS_CREDENTIALS
  ? new TextToSpeechClient({ credentials: JSON.parse(process.env.GOOGLE_TTS_CREDENTIALS) })
  : new TextToSpeechClient();
console.log(`[audio] TTS provider: Google Cloud WaveNet (credentials: ${hasCredentials ? "configured" : "missing"})`);

function buildTtsText(card: {
  scriptureZh: string;
  scriptureEn: string;
  scriptureRef: string;
  exegesis: string;
  secularLink: string;
  covenant: string;
  language: string;
}): string {
  const scripture = card.language === "en"
    ? `${card.scriptureRef}. ${card.scriptureEn}`
    : `${card.scriptureRef}。${card.scriptureZh}`;
  const separator = card.language === "en" ? ". . " : "。。";
  return [scripture, card.exegesis, card.secularLink, card.covenant].join(separator);
}

const TTS_VOICES: Record<string, { languageCode: string; name: string; speakingRate: number }> = {
  zh: { languageCode: "cmn-CN", name: "cmn-CN-Wavenet-A", speakingRate: 0.95 },
  en: { languageCode: "en-US", name: "en-US-Wavenet-F", speakingRate: 1.0 },
};

async function synthesize(text: string, language: string): Promise<Buffer> {
  const voice = TTS_VOICES[language] || TTS_VOICES.zh;

  const request: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
    input: { text },
    voice: {
      languageCode: voice.languageCode,
      name: voice.name,
    },
    audioConfig: {
      audioEncoding: "MP3" as unknown as protos.google.cloud.texttospeech.v1.AudioEncoding,
      speakingRate: voice.speakingRate,
    },
  };

  const [response] = await ttsClient.synthesizeSpeech(request);

  if (!response.audioContent) {
    throw new Error("Google TTS returned empty audio content");
  }

  return response.audioContent as Buffer;
}

/**
 * Generate TTS audio for a ContentCard and save as MP3.
 * Returns the audio URL path, or null if generation fails.
 */
export async function generateAudio(contentCardId: string): Promise<string | null> {
  if (generating.has(contentCardId)) return null;

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
    let buf: Buffer | null = null;
    for (let attempt = 1; attempt <= TTS_MAX_RETRIES; attempt++) {
      try {
        buf = await synthesize(text, card.language);
        break;
      } catch (err) {
        console.error(`[audio] TTS attempt ${attempt}/${TTS_MAX_RETRIES} failed:`, (err as Error).message);
        if (attempt === TTS_MAX_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    if (buf) {
      fs.writeFileSync(audioPath, buf);
    }

    const audioUrl = `/api/audio/${contentCardId}`;
    await prisma.contentCard.update({
      where: { id: contentCardId },
      data: { audioUrl },
    });

    console.log(`[audio] Generated audio for ${contentCardId}`);
    return audioUrl;
  } catch (err) {
    console.error(`[audio] TTS generation failed for ${contentCardId}:`, (err as Error).message);
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
