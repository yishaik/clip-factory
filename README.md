> [!IMPORTANT]
> **FROZEN (2026-07-05).** This repo was absorbed into the ai-pulse monorepo (D:/Projects/ai-pulse) at Phase 4 cutover.
> All automation, state, and future work live there. This copy is a read-only archive.

# Clip Factory

**Live:** https://clip-factory-sooty.vercel.app

**Turn one long video into many short, vertical, captioned clips — ready for TikTok / Reels / Shorts.** Local + free engine (ffmpeg + Whisper), built in an AI-hustle Speedrun.

## The engine (`clip.mjs`)

```bash
node clip.mjs <video.mp4> [n]      # -> clips/<name>/clip-1.mp4 ...
```

1. **Transcribe** the video with local **Whisper** (free) → timed cues.
2. **Find highlights** — group cues into ~15-30s windows, score by hook words + length, pick the top N.
3. **Render** each: ffmpeg cuts the window, reframes to **1080×1920** with a blurred background, and **burns TikTok-style captions** from the transcript.

Tunables (env): `WHISPER_MODEL` (tiny/base/small), `CLIP_TARGET` (sec/clip), `CLIP_GAP`, `CLIP_AI=1` (Gemma writes a hook caption per clip, CPU by default).

Needs `ffmpeg`, `ffprobe`, `whisper` on PATH. Zero npm deps.

### Kling scene-video mode

`generate.mjs` defaults to generated stills with Ken-Burns motion. To render each planned scene as a Kling video instead, set:

```powershell
$env:GEN_VISUALS = 'kling'
$env:KLING_MCP_ACCESS_TOKEN = '...'
node generate.mjs
```

The pipeline calls Kling's remote MCP endpoint, polls each generation, normalizes the result to 9:16, and falls back to its existing image renderer if a scene cannot be generated. Optional knobs: `KLING_MCP_URL` (defaults to `https://kling.ai/mcp`), `KLING_VIDEO_MODEL`, `KLING_ASPECT_RATIO` (defaults to `9:16`), `GEN_KLING_DURATION` (defaults to `5`), `KLING_POLL_MS`, and `KLING_TIMEOUT_MS`.

Codex's MCP OAuth credential is intentionally not readable by arbitrary Node programs; use a dedicated short-lived access token for unattended pipeline runs and keep it only in the local `.env` file (which is ignored by Git).

## The product

- `public/index.html` — landing page (the offer): one video → 10 clips. Pricing tiers (free / $29 per video / $149-mo), checkout links from `/api/config` ← env `PAY_FREE`/`PAY_SINGLE`/`PAY_SUB` (Gumroad).
- Delivery model (MVP): **done-for-you** — customer sends a video/link, the local engine produces the clips, you deliver the folder. Self-serve upload + worker is the next step.

## How it makes money

- **Done-for-you clips:** $29 per video (10 clips) / $149-mo for creators & coaches who hate editing.
- The work is automated (whisper + ffmpeg), so margins are high once the pipeline runs.
