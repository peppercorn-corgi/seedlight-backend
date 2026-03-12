# Share Content in English (On-demand Translation + Cache)
Date: 2026-03-12 17:47
Status: planning

## Objective
Allow Chinese-language users to share their content card in English with English-speaking friends. Translation is on-demand with caching.

## Approach
- New `ContentCardTranslation` table to cache translations
- New backend API: `POST /api/content/:id/translate`
- Frontend: "Share English" button → call translate API → generate English share image
- Use Gemini Flash for fast/cheap translation (not full LLM)

## DB Schema
```prisma
model ContentCardTranslation {
  id            String      @id @default(cuid())
  contentCardId String
  contentCard   ContentCard @relation(fields: [contentCardId], references: [id])
  language      String      // target language: "en" or "zh"
  scriptureRef  String      // translated reference (e.g. "Psalms 42:5")
  exegesis      String
  secularLink   String
  covenant      String
  createdAt     DateTime    @default(now())

  @@unique([contentCardId, language])
  @@map("content_card_translations")
}
```

## API Contract
```
POST /api/content/:id/translate?lang=en
Auth: required (must own the content card)

Response 200:
{
  scriptureRef: "Psalms 42:5",
  scriptureZh: "...",     // original
  scriptureEn: "...",     // original
  exegesis: "...",        // translated
  secularLink: "...",     // translated
  covenant: "..."         // translated
}

Response 200 (cached): same shape, returns instantly
```

## Tasks

### Backend
- [ ] Add ContentCardTranslation model to Prisma schema
- [ ] Run prisma migrate
- [ ] Add translation service (Gemini Flash, theological-aware prompt)
- [ ] Add POST /api/content/:id/translate route
- [ ] Verify compilation + test

### Frontend
- [ ] Add i18n keys: shareEnglish / shareTranslating
- [ ] Add "Share English Version" button in share dropdown
- [ ] Call translate API → build English share image → share/download
- [ ] Loading state while translating

## Progress Log
- [17:47] Plan created, user approved approach A
- [17:55] Backend: schema + migration + translate service + route done
- [18:05] Frontend: EN/中 toggle + translate API + bilingual display/share done
- [18:08] Both backend and frontend compile clean

## Results
Done. Changes:
- Backend: new ContentCardTranslation table, POST /api/content/:id/translate endpoint, Gemini Flash translation service
- Frontend: EN/中 toggle on ContentCard footer, on-demand translation with loading state, cached after first load, share image uses current language view
