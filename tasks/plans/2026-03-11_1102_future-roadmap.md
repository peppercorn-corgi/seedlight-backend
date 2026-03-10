# SeedLight Future Roadmap
Date: 2026-03-11 11:02
Status: planning

## Infrastructure Migration

### Audio Storage → S3
- Move audio files from App Runner local filesystem to S3
- App Runner filesystem is ephemeral — audio lost on every deploy, causing TTS re-generation costs
- Add CloudFront CDN for audio delivery (low latency, browser caching)
- Update `audio.ts`: upload to S3 after generation, serve via S3/CloudFront URL
- Update `audioUrl` in DB to point to S3 URL instead of local API path

### Auth & Database → Self-hosted AWS
- Migrate off Supabase to self-managed AWS infrastructure
- PostgreSQL → RDS (or Aurora Serverless)
- Auth → Cognito (Google + Apple + Email sign-in)
  - Replace Supabase JWT verification with Cognito JWT
  - Update frontend `createClient()` to use Cognito SDK
- Benefits: lower cost at scale, full control, no vendor lock-in
- Risk: significant migration effort, need to handle data migration carefully

## Content & Internationalization

### Scripture Version Upgrade
- Current: CUV 和合本 (1919)
- Target: 和合本修订版 RCUV (2010)
  - More modern Chinese, easier to understand
  - Need to verify copyright/licensing for RCUV
  - Update ScriptureIndex and DevotionalPassage tables
  - Re-run pre-generated exegesis for updated text

### English Language Support
- Add full English content generation flow
- English scripture: continue using WEB (public domain) or consider ESV/NIV (licensing needed)
- LLM prompts: English versions of system prompts for exegesis, secularLink, covenant
- secularLink (cultural connection): connect to Western secular culture, philosophy, modern life
  - Western literary references, philosophical traditions, contemporary culture
  - Instead of Chinese classical wisdom → Western classical wisdom, pop culture, shared human experiences
- User language preference: `user.language` field already exists, use it to branch content generation
- UI: full English frontend translation (i18n)

## Priority Order (suggested)
1. S3 audio storage (quick win, saves TTS costs)
2. English language support (expands user base)
3. Scripture version upgrade to RCUV 2010
4. Infrastructure migration to self-hosted AWS (largest effort, do when scale justifies)
