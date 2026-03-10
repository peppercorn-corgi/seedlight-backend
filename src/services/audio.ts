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

// Chirp3:HD sentence limit is ~200 chars; keep chunks well under that
const TTS_CHUNK_MAX = 150;

/**
 * Split text into chunks safe for Chirp3:HD.
 * 1. Split on sentence-ending punctuation (。！？；\n)
 * 2. If still too long, split on commas (，、)
 * 3. If STILL too long, hard-split at TTS_CHUNK_MAX
 */
function splitToSentences(text: string): string[] {
  // First pass: split on strong punctuation
  const parts = text.split(/(?<=[。！？；\n])/g).filter((s) => s.trim());

  const result: string[] = [];
  for (const part of parts) {
    if (part.length <= TTS_CHUNK_MAX) {
      result.push(part);
      continue;
    }
    // Second pass: split on commas
    const subParts = part.split(/(?<=[，、])/g).filter((s) => s.trim());
    for (const sub of subParts) {
      if (sub.length <= TTS_CHUNK_MAX) {
        result.push(sub);
        continue;
      }
      // Hard split at max length
      for (let i = 0; i < sub.length; i += TTS_CHUNK_MAX) {
        result.push(sub.slice(i, i + TTS_CHUNK_MAX));
      }
    }
  }
  return result;
}

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

  const sentences = splitToSentences(raw);

  // Merge very short sentences into chunks under the limit
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

/**
 * Generate TTS audio for a ContentCard and save as MP3.
 * Writes each chunk incrementally so the file can be played while generating.
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

  const chunks = buildTtsChunks(card);
  const audioPath = path.join(AUDIO_DIR, `${contentCardId}.mp3`);

  generating.add(contentCardId);
  try {
    // Remove any stale partial file
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

    // Generate and append each chunk incrementally
    for (let i = 0; i < chunks.length; i++) {
      let buf: Buffer | null = null;
      for (let attempt = 1; attempt <= TTS_MAX_RETRIES; attempt++) {
        try {
          buf = await synthesizeChunk(chunks[i]);
          break;
        } catch (err) {
          console.error(`[audio] Chunk ${i + 1}/${chunks.length} attempt ${attempt}/${TTS_MAX_RETRIES} failed:`, (err as Error).message);
          if (attempt === TTS_MAX_RETRIES) throw err;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (buf) {
        fs.appendFileSync(audioPath, buf);
      }
    }

    const audioUrl = `/api/audio/${contentCardId}`;
    await prisma.contentCard.update({
      where: { id: contentCardId },
      data: { audioUrl },
    });

    console.log(`[audio] Generated audio for ${contentCardId} (${chunks.length} chunks)`);
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
