# English Language Support
Date: 2026-03-11 11:45
Status: in-progress

## Objective
Add full English content generation and UI support. English users get:
- English scripture (WEB, already stored)
- English exegesis, cultural connection (Western culture), covenant
- English TTS voice
- English UI

## Current State
- `user.language` field exists in DB: `"zh" | "en" | "both"` — but never used
- Both `textZh` and `textEn` already stored in ScriptureIndex & DevotionalPassage
- All LLM prompts, tone guides, UI strings hardcoded in Chinese
- No i18n framework installed

## Approach

### Phase 1: Backend — English Content Generation (no frontend changes yet)
The backend already returns `language` in the response. We branch content generation by language.

**1.1 English LLM Prompts** (`content.ts`)
- Add `TONE_GUIDE_EN` — English equivalents of the 4 segment tone guides
- Add `buildOptimizedSystemPromptEn()` — English system prompt
  - secularLink: connect to Western culture, philosophy, literature, modern life (not Chinese culture)
  - covenant: same structure but in English
  - personalLink: English version when moodText provided
- Add `buildLegacySystemPromptEn()` — English full generation prompt
- Branch in `generateOptimized()` and `generateLegacy()` based on language param

**1.2 English TTS** (`audio.ts`)
- Add English voice: `en-US-Wavenet-D` (male) or `en-US-Wavenet-F` (female)
- Branch `synthesize()` based on content card language
- Store language on ContentCard (already exists as field)

**1.3 Pre-generated Exegesis** (`pregenerate-exegesis.ts`)
- Add English exegesis generation for DevotionalPassages
- Store with segment key like `"seeker"` but language-aware (or separate field)
- Can run as batch job after Chinese pre-gen completes

**1.4 Tag Extraction** (`passage.ts`)
- `extractTagsFromText()` — tags are already English, works for both languages
- Mood taxonomy prompt: add bilingual version or English-only version based on input language

### Phase 2: Frontend — i18n & Language Switching

**2.1 i18n Setup**
- Use simple approach: React Context + translation object (no heavy i18n library needed)
- Create `src/lib/i18n.ts` with `zh` and `en` string maps
- Create `LanguageProvider` context that reads from user profile

**2.2 Language Selector**
- Add to Settings page: language preference (中文 / English / Both)
- Call `PATCH /api/auth/me` with `{ language }` to save
- Add to Onboarding flow (optional, can default to browser locale)

**2.3 UI String Translation**
Pages to translate:
- Home page: mood buttons, greeting, text input placeholder
- ContentCard: section headers (经文解析→Scripture Exegesis, 文化连结→Cultural Connection, 约与责任→Covenant & Response)
- AudioPlayer: status labels (生成中→Generating, 播放→Play, etc.)
- FeedbackButtons: save/unsave labels
- History page: title, empty state
- Saved page: title, empty state
- Settings page: labels
- Shared page: header text, CTA
- Login page: already mostly English, add Chinese option
- UserMenu: labels

**2.4 Content Display Logic**
- `language === "zh"`: show Chinese scripture + Chinese content (current behavior)
- `language === "en"`: show English scripture + English content, hide Chinese scripture
- `language === "both"`: show both scriptures + content in user's primary language

**2.5 Share Image**
- English version of share image: English section headers, English slogan
- Branch `buildShareNode()` based on card language

### Phase 3: "Both" Language Mode (lower priority)
- Show bilingual scripture
- Content generated in one language (user's primary)
- Can be deferred

## Tasks

### Phase 1 — Backend
- [x] 1.1 Add English tone guides (`TONE_GUIDE_EN`)
- [x] 1.2 Add English optimized system prompt (`buildOptimizedSystemPromptEn`)
- [x] 1.3 Add English legacy system prompt (`buildLegacySystemPromptEn`)
- [x] 1.4 Branch `generateOptimized()` by language
- [x] 1.5 Branch `generateLegacy()` by language
- [x] 1.6 Pass language through `generateContent()` → generation functions
- [x] 1.7 English TTS voice in `audio.ts`
- [x] 1.8 Update tag extraction prompt for English moodText (tags already English, works for both)
- [ ] 1.9 Test English content generation end-to-end
- [x] 1.10 Add `language` field to `PreGeneratedExegesis` schema (default "zh", backward compat)
- [x] 1.11 Language-aware pre-gen lookup in `getPreGeneratedExegesis()` / `generateOptimized()`
- [x] 1.12 Update Chinese pre-gen script for new unique constraint (`passageId_segment_language`)
- [x] 1.13 Create English pre-gen script (`scripts/pregenerate-exegesis-en.ts`)

### Phase 2 — Frontend
- [x] 2.1 Create `src/lib/i18n.ts` with translation maps (82 strings, zh + en)
- [x] 2.2 Create `LanguageProvider` context (localStorage + API sync)
- [x] 2.3 Add language selector to Settings page
- [x] 2.4 Translate Home page
- [x] 2.5 Translate ContentCard component (+ share image)
- [x] 2.6 Translate AudioPlayer component
- [x] 2.7 Translate History/Saved pages
- [x] 2.8 Translate Shared page
- [x] 2.9 Update share image for English
- [x] 2.10 Hide Chinese scripture when locale is "en" (ContentCard display + share image)
- [ ] 2.11 Test full English UI flow

### Backend API fix
- [x] 2.12 Update `/user/preferences` GET to return `language` field
- [x] 2.13 Update `/user/preferences` PUT to accept `language` field

## API Contract
- GET `/user/preferences` → `{ faithLevel, language, onboarded }`
- PUT `/user/preferences` → accepts `{ faithLevel, language? }`
ContentCard response includes `language` field.
Frontend reads user profile to determine display language.

## Progress Log
- [11:45] Started Phase 1 backend work on `content.ts`
- [11:50] Added `TONE_GUIDE_EN` (4 segments: seeker, new_believer, growing, mature) in English
- [11:50] Added `buildOptimizedSystemPromptEn()` — Western culture secularLink, personalLink when hasMoodText, same JSON format
- [11:50] Added `buildOptimizedUserPromptEn()` — uses `passage.textEn` as scripture
- [11:50] Added `buildLegacySystemPromptEn()` — full generation prompt in English with Western cultural references
- [11:50] Added `buildLegacyUserPromptEn()` — English user prompt with candidates and recent refs
- [11:50] Modified `generateOptimized()` — added `language` param; branches to EN prompts when `language === "en" || "both"`; uses `passage.textEn` for scripture in EN path
- [11:50] Modified `generateLegacy()` — added `language` param; branches prompts and candidate descriptions; added `textEn` to Prisma select
- [11:50] Modified `generateContent()` — reads `user.language`, passes as `language` to both generation functions; added comment explaining "both" defaults to English
- [11:51] `npx tsc --noEmit` — clean compile, zero errors
- [12:00] English TTS: added `en-US-Wavenet-F` voice, `buildTtsText` branches by card language
- [12:00] Backend `/user/preferences` updated: GET returns `language`, PUT accepts `language`
- [12:00] Frontend: i18n.ts (82 strings), LanguageProvider, all pages translated, language selector in Settings
- [12:00] Both repos compile clean
- [12:21] Added `language` field to `PreGeneratedExegesis` (default "zh"), unique constraint → `[passageId, segment, language]`
- [12:21] `prisma db push` applied successfully, existing Chinese rows auto-set to "zh"
- [12:21] `getPreGeneratedExegesis()` now takes `language` param, optimized flow passes `exegesisLang` based on user language
- [12:21] Updated Chinese pre-gen script: upsert uses new `passageId_segment_language` key, resume query filters `language: "zh"`
- [12:21] Created English pre-gen script `scripts/pregenerate-exegesis-en.ts` — English system prompt, uses `textEn`, stores with `language: "en"`
- [12:21] Frontend: English locale hides secondary (Chinese) scripture in ContentCard display + share image
- [12:21] All compiles clean (backend + frontend)

## Results
