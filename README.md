# TheClipBar — Phase 1

Paste a YouTube or Twitch channel handle, see recent videos/streams (title, thumbnail, duration, date).  n

## Stack
- Node.js + Express backend (`src/server.js`)
- Vanilla HTML/CSS/JS frontend (`public/`), served as static files by Express
- YouTube Data API v3 (API key auth)
- Twitch Helix API (Client Credentials OAuth — app access token, cached in memory)

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `YOUTUBE_API_KEY`
   - `TWITCH_CLIENT_ID`
   - `TWITCH_CLIENT_SECRET`
3. `npm start` (or `npm run dev` for auto-reload)
4. Open `http://localhost:3000`

## API
`GET /api/lookup?platform=youtube|twitch&handle=<handle>`
Returns `{ channel: {...}, videos: [{ id, title, thumbnail, publishedAt, durationSeconds, url, platform }] }`.

`GET /api/health` — reports whether YouTube/Twitch env vars are configured.

## Status
Phase 1 only (channel lookup). Phases 2 (manual clipping via yt-dlp/ffmpeg) and 3 (Whisper transcription + LLM highlight detection, BullMQ/Redis job queue) are not yet built.

## Notes
- Code was written and syntax-checked in a network-restricted sandbox; it has not yet been run against the live YouTube/Twitch APIs. First real test happens on deploy.
