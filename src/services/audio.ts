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

// Max chars per TTS request (Chirp3:HD has sentence length limits)
const TTS_CHUNK_MAX = 500;

function buildTtsChunks(card: {
  scriptureZh: string;
  scriptureRef: string;
  exegesis: string;
  secularLink: string;
  covenant: string;
}): string[] {
  const raw = [
    `${card.scriptureRef}。${card.scriptureZh}`,
    card.exegesis,
    card.secularLink,
    card.covenant,
  ].join("。");

  // Split on sentence-ending punctuation, keep delimiter attached
  const sentences = raw.split(/(?<=[。！？；\n])/g).filter((s) => s.trim());

  // Merge short sentences into chunks under the limit
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf.length + s.length > TTS_CHUNK_MAX && buf) {
      chunks.push(buf);
      buf = "";
    }
    buf += s;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function synthesizeChunk(text: string): Promise<Buffer> {
  const request: protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest = {
    input: { text },
    voice: {
      languageCode: "cmn-CN",
      name: "cmn-CN-Chirp3-HD-Leda",
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

  return response.audioContent as Buffer;
}

async function synthesize(chunks: string[], audioPath: string): Promise<void> {
  const buffers: Buffer[] = [];
  for (const chunk of chunks) {
    buffers.push(await synthesizeChunk(chunk));
  }
  fs.writeFileSync(audioPath, Buffer.concat(buffers));
}

async function ttsWithRetry(chunks: string[], audioPath: string): Promise<void> {
  for (let attempt = 1; attempt <= TTS_MAX_RETRIES; attempt++) {
    try {
      await synthesize(chunks, audioPath);
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

  const chunks = buildTtsChunks(card);
  const audioPath = path.join(AUDIO_DIR, `${contentCardId}.mp3`);

  generating.add(contentCardId);
  try {
    await ttsWithRetry(chunks, audioPath);

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
