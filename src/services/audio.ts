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
export async function generateAudio(contentCardId: string, lang?: string): Promise<string | null> {
  const cacheKey = lang === "en" ? `${contentCardId}_en` : contentCardId;
  if (generating.has(cacheKey)) return null;

  const card = await prisma.contentCard.findUnique({
    where: { id: contentCardId },
  });

  if (!card) {
    throw new Error(`ContentCard not found: ${contentCardId}`);
  }

  let text: string;
  let ttsLang: string;

  if (lang === "en") {
    // Use translated content for English audio
    const translation = await prisma.contentCardTranslation.findUnique({
      where: { contentCardId_language: { contentCardId, language: "en" } },
    });
    if (!translation) {
      throw new Error(`No English translation found for ${contentCardId}. Translate first.`);
    }
    text = buildTtsText({
      scriptureRef: translation.scriptureRef,
      scriptureZh: card.scriptureZh,
      scriptureEn: card.scriptureEn,
      exegesis: translation.exegesis,
      secularLink: translation.secularLink,
      covenant: translation.covenant,
      language: "en",
    });
    ttsLang = "en";
  } else {
    text = buildTtsText(card);
    ttsLang = card.language;
  }

  const audioPath = path.join(AUDIO_DIR, `${cacheKey}.mp3`);

  generating.add(cacheKey);
  try {
    let buf: Buffer | null = null;
    for (let attempt = 1; attempt <= TTS_MAX_RETRIES; attempt++) {
      try {
        buf = await synthesize(text, ttsLang);
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

    // Only update card audioUrl for original language
    if (lang !== "en") {
      const audioUrl = `/api/audio/${contentCardId}`;
      await prisma.contentCard.update({
        where: { id: contentCardId },
        data: { audioUrl },
      });
    }

    console.log(`[audio] Generated ${ttsLang} audio for ${cacheKey}`);
    return `/api/audio/${contentCardId}${lang === "en" ? "?lang=en" : ""}`;
  } catch (err) {
    console.error(`[audio] TTS generation failed for ${cacheKey}:`, (err as Error).message);
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
    return null;
  } finally {
    generating.delete(cacheKey);
  }
}

/**
 * Check whether audio is currently being generated for a card.
 */
export function isAudioGenerating(contentCardId: string, lang?: string): boolean {
  const cacheKey = lang === "en" ? `${contentCardId}_en` : contentCardId;
  return generating.has(cacheKey);
}

/**
 * Get the file path for a content card's audio, or null if not generated.
 */
export function getAudioFilePath(contentCardId: string, lang?: string): string | null {
  const cacheKey = lang === "en" ? `${contentCardId}_en` : contentCardId;
  const audioPath = path.join(AUDIO_DIR, `${cacheKey}.mp3`);
  return fs.existsSync(audioPath) ? audioPath : null;
}
