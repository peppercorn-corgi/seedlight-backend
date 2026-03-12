# SeedLight Admin Commands

All commands run from the `seedlight-backend/` directory. Requires `DATABASE_URL` in `.env`.

## View Stats

```bash
# All-time stats (users, DAU/WAU/MAU, mood distribution, engagement, retention, etc.)
npx tsx scripts/stats.ts

# Last 7 days only
npx tsx scripts/stats.ts --days 7

# Last 30 days
npx tsx scripts/stats.ts --days 30
```

Includes: user overview, active users (DAU/WAU/MAU), mood distribution, hourly/weekly usage, content engagement (saves/likes/shares/audio), top scriptures, share funnel, analytics events, pre-generation progress, retention cohort.

## View User Feedback

```bash
# All feedback
npx tsx scripts/view-feedback.ts

# Last 7 days
npx tsx scripts/view-feedback.ts --days 7

# Latest 20 entries
npx tsx scripts/view-feedback.ts --limit 20

# Combine: last 14 days, max 50
npx tsx scripts/view-feedback.ts --days 14 --limit 50
```

## Pre-generate Exegesis

```bash
# Chinese exegesis (all unprocessed passages)
npx tsx scripts/pregenerate-exegesis.ts

# English exegesis
npx tsx scripts/pregenerate-exegesis-en.ts
```

## Other Scripts

```bash
# Import bible data
npx tsx scripts/import-bible.ts

# Tag passages with mood/theme tags
npx tsx scripts/tag-passages.ts

# Re-split long passages
npx tsx scripts/resplit-long-passages.ts
```
