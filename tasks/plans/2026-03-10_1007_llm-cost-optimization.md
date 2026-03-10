# LLM Cost Optimization — Two-Step Architecture
Date: 2026-03-10
Status: in-progress

## Objective
Restructure from single full-generation LLM call (~2500 tokens, ~$38/month) to:
- Pre-generated exegesis (offline, via Claude CLI)
- Real-time secularLink + covenant only (via Gemini Flash, ~400 tokens, ~$6-8/month)

## Architecture Overview
```
User mood → Tag mapping (85+ tags) → Select DevotionalPassage (weighted random)
  → Fetch PreGeneratedExegesis (by segment)
  → Real-time: generate secularLink + covenant only (Gemini Flash)
  → Fallback: full generation if no pre-gen content available
```

## Data Models
- **DevotionalPassage**: Passage-based Bible groupings with moodTags, themes, importance
- **PreGeneratedExegesis**: Exegesis per passage × 4 faith segments (seeker, new_believer, growing, mature)
- **User.onboarded**: Boolean flag for onboarding flow

## Phase 1: Tag Passages — COMPLETE ✅
Tag all Bible chapters into devotional passages with mood tags.

### Script
```bash
npx tsx scripts/tag-passages.ts              # process all
npx tsx scripts/tag-passages.ts --resume     # skip processed chapters
npx tsx scripts/tag-passages.ts --book 诗篇   # one book only
```

### Config
- `BATCH_SIZE` env var (default 100 verses/batch, use 30 for retries)
- Model: `claude-sonnet-4-6`
- Log: `logs/tag-passages.log`

### Results
- **7,249 passages** created
- **1,189/1,189 chapters** covered (100%)
- Total runtime: ~7 hours (first run + 2 resume rounds)
- Resume with smaller batch (BATCH_SIZE=30) fixed persistent failures

## Phase 2: Pre-generate Exegesis — IN PROGRESS 🔄
Generate exegesis for each passage × 4 faith segments.

### Script
```bash
npx tsx scripts/pregenerate-exegesis.ts --min-importance 8 --resume   # high importance first
npx tsx scripts/pregenerate-exegesis.ts --resume                       # all remaining
npx tsx scripts/pregenerate-exegesis.ts --limit 5 --dry-run            # test run
```

### Flags
- `--resume`: Skip passages that already have all 4 segments in DB
- `--min-importance N`: Only process passages with importance >= N
- `--limit N`: Process at most N passages
- `--dry-run`: Preview only, no DB writes
- Model: `claude-sonnet-4-6`
- Log: `logs/pregenerate-exegesis.log`

### Current Progress
- DB total exegeses: 36 (9 passages × 4 segments)
- Target (importance >= 8): 3,602 passages → 14,408 exegeses
- Target (all): 7,249 passages → 28,996 exegeses
- Estimated time per passage: ~80s
- Estimated total for imp>=8: ~80 hours

### Importance Distribution
```
imp=10:  527 passages
imp=9:  1300 passages
imp=8:  1775 passages
imp=7:  1945 passages
imp=6:  1134 passages
imp=5:   458 passages
imp=4:    97 passages
imp=3:    13 passages
```

### How to Resume After Interruption
1. Check current DB count:
   ```bash
   npx tsx -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.preGeneratedExegesis.groupBy({by:['passageId'],_count:true,having:{passageId:{_count:{gte:4}}}}).then(r=>{console.log('Complete passages:',r.length);p.\$disconnect();})"
   ```
2. Resume with same flags (**must run in real terminal, not via Claude Code Bash tool**):
   ```bash
   cd ~/dev/fun/easybible/seedlight-backend
   nohup npx tsx scripts/pregenerate-exegesis.ts --min-importance 8 --resume &
   tail -f logs/pregenerate-exegesis.log
   ```
3. After imp>=8 done, run all remaining:
   ```bash
   nohup npx tsx scripts/pregenerate-exegesis.ts --resume &
   ```
4. Monitor: `tail -f logs/pregenerate-exegesis.log`
5. **Do NOT use** `nohup ... >> logs/pregenerate-exegesis.log 2>&1 &` — it doubles log output since `log()` already writes to the same file.

### Known Issues & Fixes

#### Phase 1 (tag-passages)
- **Empty CLI responses**: ~26/388 batches returned empty on first run. Transient network/timeout. Fixed by `--resume`.
- **Persistent failures with large batches**: 19 batches failed repeatedly at BATCH_SIZE=100. Fixed by setting `BATCH_SIZE=30` env var for retries.
- **Log duplication**: `log()` wrote both `console.log()` and `logStream`. Combined with `nohup >> logfile`, each line appeared twice. Fixed by removing `console.log()` from `log()`.
- **Model name**: Initially used `claude-sonnet-4-20250514` (outdated). Updated to `claude-sonnet-4-6`.

#### Phase 2 (pregenerate-exegesis)
- **JSON parse failures (root cause)**: LLM outputs Chinese quotation marks `"..."` which are sometimes ASCII `"` (U+0022) instead of Unicode `"` (U+201C/U+201D). This breaks JSON.parse because it prematurely terminates string values. **Fix**: Replaced JSON.parse with `extractSegments()` — a key-boundary extraction that splits by known segment keys (`"seeker":`, `"new_believer":`, etc.) instead of relying on quote matching.
- **Literal newlines in JSON strings**: CLI output contains `\n` as actual newline characters (0x0A) inside JSON string values, which is invalid JSON. **Fix**: `fixJsonNewlines()` function escapes them before parsing (still used in tag-passages script).
- **Balanced brace matching missed string-internal braces**: Original fallback used `raw.match(/\{[\s\S]*\}/)` which was greedy and didn't skip braces inside strings. Intermediate fix used brace-counting with string tracking, but still fragile. Final fix: abandoned JSON.parse entirely for key-boundary extraction.
- **Claude Code CLI sandbox limitations**: Background processes (`nohup ... &`) started via the Bash tool often fail to spawn the child node process. **Workaround**: Start long-running scripts manually in a real terminal, not via Claude Code's Bash tool.
- **Empty CLI responses**: Same transient issue as Phase 1. Use `--resume` to retry.
- **Log duplication**: Same fix as Phase 1 — remove `console.log()` from `log()`.
- **`nohup >> logfile 2>&1` doubles output**: Since `log()` already writes to logStream (same file), `nohup` stdout redirect to the same file creates duplicates. **Fix**: Use `nohup command &` without stdout redirect, or `nohup command > /dev/null 2>&1 &`.

## Phase 3: Real-time Integration — READY (code complete)
- `src/services/content.ts`: `generateOptimized()` uses pre-gen exegesis + real-time Gemini for secularLink/covenant
- `src/services/passage.ts`: Weighted random passage selection with recent-use avoidance
- Fallback to `generateLegacy()` (full LLM generation) when no pre-gen content available
- **Works now**: Even before pre-generation completes, system falls back to legacy flow

## Related Changes
- **Onboarding**: `/onboarding` page for faith level selection (frontend + backend)
- **Auth sync fix**: Handle email unique constraint when Supabase account re-created
- **Font size**: ContentCard body text increased from text-sm (14px) to text-base (16px)
- **Gemini provider**: LLM_PROVIDER=gemini supported, pending free tier resolution

## Key Files
### Backend
- `prisma/schema.prisma` — DevotionalPassage, PreGeneratedExegesis models
- `src/constants/mood-tags.ts` — 85+ tags, MOOD_MAPPING, TAG_TAXONOMY_PROMPT
- `src/services/passage.ts` — Passage selection logic
- `src/services/content.ts` — Optimized + legacy generation flows
- `scripts/tag-passages.ts` — Phase 1 batch tagging
- `scripts/pregenerate-exegesis.ts` — Phase 2 batch exegesis generation

### Frontend
- `src/app/onboarding/page.tsx` — Faith level onboarding
- `src/app/page.tsx` — Onboarding check + loading state
- `src/components/ContentCard.tsx` — Font size update
