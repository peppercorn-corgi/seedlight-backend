/**
 * Bible data import script for SeedLight.
 *
 * Data sources:
 *   - CUV (Chinese Union Version, Traditional): thiagobodruk/bible → json/zh_cuv.json
 *     Format: Array of { abbrev, chapters: string[][] }
 *     Note: each verse string has spaces between characters — strip them.
 *
 *   - WEB (World English Bible): TehShrike/world-english-bible → json/<bookname>.json
 *     Format: Array of { type, chapterNumber, verseNumber, sectionNumber, value }
 *     Types: "paragraph text" | "line text" (poetry) | structural markers
 *     Multi-section verses (same chapterNumber+verseNumber, different sectionNumber)
 *     must be joined with a space.
 *
 * Output: scripts/bible-data.json  — array of VerseRecord
 * Then inserts into ScriptureIndex via Prisma createMany (batched).
 *
 * Usage:
 *   npx tsx scripts/import-bible.ts [--import]
 *   Without --import: generates bible-data.json only (safe, no DB writes).
 *   With --import:    also inserts into the database.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(BACKEND_ROOT, '.env') });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CuvBook {
  abbrev: string;
  chapters: string[][];
}

interface WebEntry {
  type: string;
  chapterNumber?: number;
  verseNumber?: number;
  sectionNumber?: number;
  value?: string;
}

interface VerseRecord {
  book: string;
  bookZh: string;
  chapter: number;
  verse: number;
  textZh: string;
  textEn: string;
}

// ---------------------------------------------------------------------------
// Book mapping: order matches CUV index (0-65)
// Each entry: [englishName, chineseNameTraditional, webFileName]
// ---------------------------------------------------------------------------

const BOOK_MAP: Array<{ en: string; zh: string; webFile: string }> = [
  // Old Testament
  { en: 'Genesis',          zh: '创世记',       webFile: 'genesis' },
  { en: 'Exodus',           zh: '出埃及记',     webFile: 'exodus' },
  { en: 'Leviticus',        zh: '利未记',       webFile: 'leviticus' },
  { en: 'Numbers',          zh: '民数记',       webFile: 'numbers' },
  { en: 'Deuteronomy',      zh: '申命记',       webFile: 'deuteronomy' },
  { en: 'Joshua',           zh: '约书亚记',     webFile: 'joshua' },
  { en: 'Judges',           zh: '士师记',       webFile: 'judges' },
  { en: 'Ruth',             zh: '路得记',       webFile: 'ruth' },
  { en: '1 Samuel',         zh: '撒母耳记上',   webFile: '1samuel' },
  { en: '2 Samuel',         zh: '撒母耳记下',   webFile: '2samuel' },
  { en: '1 Kings',          zh: '列王纪上',     webFile: '1kings' },
  { en: '2 Kings',          zh: '列王纪下',     webFile: '2kings' },
  { en: '1 Chronicles',     zh: '历代志上',     webFile: '1chronicles' },
  { en: '2 Chronicles',     zh: '历代志下',     webFile: '2chronicles' },
  { en: 'Ezra',             zh: '以斯拉记',     webFile: 'ezra' },
  { en: 'Nehemiah',         zh: '尼希米记',     webFile: 'nehemiah' },
  { en: 'Esther',           zh: '以斯帖记',     webFile: 'esther' },
  { en: 'Job',              zh: '约伯记',       webFile: 'job' },
  { en: 'Psalms',           zh: '诗篇',         webFile: 'psalms' },
  { en: 'Proverbs',         zh: '箴言',         webFile: 'proverbs' },
  { en: 'Ecclesiastes',     zh: '传道书',       webFile: 'ecclesiastes' },
  { en: 'Song of Solomon',  zh: '雅歌',         webFile: 'songofsolomon' },
  { en: 'Isaiah',           zh: '以赛亚书',     webFile: 'isaiah' },
  { en: 'Jeremiah',         zh: '耶利米书',     webFile: 'jeremiah' },
  { en: 'Lamentations',     zh: '耶利米哀歌',   webFile: 'lamentations' },
  { en: 'Ezekiel',          zh: '以西结书',     webFile: 'ezekiel' },
  { en: 'Daniel',           zh: '但以理书',     webFile: 'daniel' },
  { en: 'Hosea',            zh: '何西阿书',     webFile: 'hosea' },
  { en: 'Joel',             zh: '约珥书',       webFile: 'joel' },
  { en: 'Amos',             zh: '阿摩司书',     webFile: 'amos' },
  { en: 'Obadiah',          zh: '俄巴底亚书',   webFile: 'obadiah' },
  { en: 'Jonah',            zh: '约拿书',       webFile: 'jonah' },
  { en: 'Micah',            zh: '弥迦书',       webFile: 'micah' },
  { en: 'Nahum',            zh: '那鸿书',       webFile: 'nahum' },
  { en: 'Habakkuk',         zh: '哈巴谷书',     webFile: 'habakkuk' },
  { en: 'Zephaniah',        zh: '西番雅书',     webFile: 'zephaniah' },
  { en: 'Haggai',           zh: '哈该书',       webFile: 'haggai' },
  { en: 'Zechariah',        zh: '撒迦利亚书',   webFile: 'zechariah' },
  { en: 'Malachi',          zh: '玛拉基书',     webFile: 'malachi' },
  // New Testament
  { en: 'Matthew',          zh: '马太福音',     webFile: 'matthew' },
  { en: 'Mark',             zh: '马可福音',     webFile: 'mark' },
  { en: 'Luke',             zh: '路加福音',     webFile: 'luke' },
  { en: 'John',             zh: '约翰福音',     webFile: 'john' },
  { en: 'Acts',             zh: '使徒行传',     webFile: 'acts' },
  { en: 'Romans',           zh: '罗马书',       webFile: 'romans' },
  { en: '1 Corinthians',    zh: '哥林多前书',   webFile: '1corinthians' },
  { en: '2 Corinthians',    zh: '哥林多后书',   webFile: '2corinthians' },
  { en: 'Galatians',        zh: '加拉太书',     webFile: 'galatians' },
  { en: 'Ephesians',        zh: '以弗所书',     webFile: 'ephesians' },
  { en: 'Philippians',      zh: '腓立比书',     webFile: 'philippians' },
  { en: 'Colossians',       zh: '歌罗西书',     webFile: 'colossians' },
  { en: '1 Thessalonians',  zh: '帖撒罗尼迦前书', webFile: '1thessalonians' },
  { en: '2 Thessalonians',  zh: '帖撒罗尼迦后书', webFile: '2thessalonians' },
  { en: '1 Timothy',        zh: '提摩太前书',   webFile: '1timothy' },
  { en: '2 Timothy',        zh: '提摩太后书',   webFile: '2timothy' },
  { en: 'Titus',            zh: '提多书',       webFile: 'titus' },
  { en: 'Philemon',         zh: '腓利门书',     webFile: 'philemon' },
  { en: 'Hebrews',          zh: '希伯来书',     webFile: 'hebrews' },
  { en: 'James',            zh: '雅各书',       webFile: 'james' },
  { en: '1 Peter',          zh: '彼得前书',     webFile: '1peter' },
  { en: '2 Peter',          zh: '彼得后书',     webFile: '2peter' },
  { en: '1 John',           zh: '约翰一书',     webFile: '1john' },
  { en: '2 John',           zh: '约翰二书',     webFile: '2john' },
  { en: '3 John',           zh: '约翰三书',     webFile: '3john' },
  { en: 'Jude',             zh: '犹大书',       webFile: 'jude' },
  { en: 'Revelation',       zh: '启示录',       webFile: 'revelation' },
];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CUV_PATH = path.join(__dirname, 'raw/bible-thiago/json/zh_cuv.json');
const WEB_DIR  = path.join(__dirname, 'raw/web/json');
const OUT_PATH = path.join(__dirname, 'bible-data.json');

// ---------------------------------------------------------------------------
// Load CUV
// ---------------------------------------------------------------------------

function loadCuv(): CuvBook[] {
  const raw = fs.readFileSync(CUV_PATH, 'utf8').replace(/^\uFEFF/, ''); // strip BOM
  return JSON.parse(raw) as CuvBook[];
}

// ---------------------------------------------------------------------------
// Load and index a WEB book file
// Returns Map<"chapter:verse", string> with full verse text (sections joined).
// ---------------------------------------------------------------------------

function loadWebBook(bookName: string): Map<string, string> {
  const filePath = path.join(WEB_DIR, `${bookName}.json`);
  const raw = fs.readFileSync(filePath, 'utf8');
  // The file is serialized as an object with numeric string keys — parse as array values.
  const entries: WebEntry[] = Object.values(JSON.parse(raw));

  // Collect all text segments per verse (both "paragraph text" and "line text" carry verse data).
  const verseSegments = new Map<string, string[]>();

  for (const entry of entries) {
    if (
      (entry.type === 'paragraph text' || entry.type === 'line text') &&
      entry.chapterNumber !== undefined &&
      entry.verseNumber !== undefined &&
      entry.value !== undefined
    ) {
      const key = `${entry.chapterNumber}:${entry.verseNumber}`;
      if (!verseSegments.has(key)) {
        verseSegments.set(key, []);
      }
      verseSegments.get(key)!.push(entry.value.trim());
    }
  }

  // Join multi-section verses and clean up whitespace.
  const verseMap = new Map<string, string>();
  for (const [key, segments] of verseSegments) {
    verseMap.set(key, segments.join(' ').replace(/\s+/g, ' ').trim());
  }

  return verseMap;
}

// ---------------------------------------------------------------------------
// Process all books
// ---------------------------------------------------------------------------

function processBooks(cuvBooks: CuvBook[]): VerseRecord[] {
  const verses: VerseRecord[] = [];

  if (cuvBooks.length !== BOOK_MAP.length) {
    throw new Error(
      `CUV has ${cuvBooks.length} books but BOOK_MAP has ${BOOK_MAP.length} entries`
    );
  }

  for (let bookIdx = 0; bookIdx < BOOK_MAP.length; bookIdx++) {
    const { en, zh, webFile } = BOOK_MAP[bookIdx];
    const cuvBook = cuvBooks[bookIdx];

    const webVerses = loadWebBook(webFile);

    for (let chIdx = 0; chIdx < cuvBook.chapters.length; chIdx++) {
      const chapter = chIdx + 1;
      const chapterVerses = cuvBook.chapters[chIdx];

      for (let vIdx = 0; vIdx < chapterVerses.length; vIdx++) {
        const verseNum = vIdx + 1;

        // CUV text: strip inter-character spaces (the source uses "字 字 字" format).
        const textZh = chapterVerses[vIdx].replace(/ /g, '').trim();

        const webKey = `${chapter}:${verseNum}`;
        const textEn = webVerses.get(webKey);

        if (!textEn) {
          // Some books have verse count differences between CUV and WEB.
          // Log and skip rather than inserting an empty English text.
          console.warn(
            `  WARNING: No WEB text for ${en} ${chapter}:${verseNum} — skipping verse`
          );
          continue;
        }

        verses.push({
          book: en,
          bookZh: zh,
          chapter,
          verse: verseNum,
          textZh,
          textEn,
        });
      }
    }

    const bookVerseCount = verses.filter((v) => v.book === en).length;
    console.log(`  Processed: ${en} / ${zh} — ${bookVerseCount} verses`);
  }

  return verses;
}

// ---------------------------------------------------------------------------
// Database import (only when --import flag is passed)
// ---------------------------------------------------------------------------

async function importToDatabase(verses: VerseRecord[]): Promise<void> {
  // Dynamic import to avoid loading Prisma when just generating JSON.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const BATCH_SIZE = 500;
    const totalBooks = [...new Set(verses.map((v) => v.book))];

    console.log(`\nImporting ${verses.length} verses into ScriptureIndex...`);

    for (let i = 0; i < totalBooks.length; i++) {
      const bookName = totalBooks[i];
      const bookVerses = verses.filter((v) => v.book === bookName);

      console.log(`Importing book ${bookName}... (${i + 1}/${totalBooks.length})`);

      for (let batchStart = 0; batchStart < bookVerses.length; batchStart += BATCH_SIZE) {
        const batch = bookVerses.slice(batchStart, batchStart + BATCH_SIZE);
        await prisma.scriptureIndex.createMany({
          data: batch.map((v) => ({
            book:       v.book,
            bookZh:     v.bookZh,
            chapter:    v.chapter,
            verseStart: v.verse,
            verseEnd:   null,
            textZh:     v.textZh,
            textEn:     v.textEn,
            themes:     [],
            moodTags:   [],
            importance: 0,
          })),
          skipDuplicates: true,
        });
      }
    }

    console.log('\nImport complete.');
  } finally {
    await prisma.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const shouldImport = process.argv.includes('--import');

  console.log('Loading CUV data...');
  const cuvBooks = loadCuv();
  console.log(`  Loaded ${cuvBooks.length} books from CUV.\n`);

  console.log('Processing books (CUV + WEB)...');
  const verses = processBooks(cuvBooks);

  console.log(`\nTotal verses processed: ${verses.length}`);

  console.log(`\nWriting output to ${OUT_PATH}...`);
  fs.writeFileSync(OUT_PATH, JSON.stringify(verses, null, 2), 'utf8');
  console.log('bible-data.json written successfully.');

  if (shouldImport) {
    await importToDatabase(verses);
  } else {
    console.log('\nDry run complete. Run with --import to insert into the database.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
