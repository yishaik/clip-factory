# Clip Factory — Pipeline

One long video → many short, vertical, captioned clips. Trigger: daily 09:30 (scheduled) or `node pipeline.mjs`.

```mermaid
flowchart TD
  sched["daily 09:30 / node pipeline.mjs"] --> A

  subgraph S1["1 · SOURCE (source.mjs)"]
    A["sources.json — YouTube channels (@handle / UC-id)"] --> B["resolveChannelId — @handle → UC-id"]
    B --> C["channelFeed — free RSS feed (no API key, not bot-blocked)"]
    C --> D["filter unseen + recent · scoreTitle by hook words"]
    D --> E[("queue.json — ranked candidates")]
  end

  E --> LOOP{"for each candidate until N clipped"}

  subgraph S2["2 · DOWNLOAD (pipeline.mjs)"]
    LOOP --> G["yt-dlp · player_client=android_vr,web_safari · 720p DASH (bypasses n-challenge)"]
    G -. "403 / blocked" .-> LOOP
    G --> H["trimHead → first 8 min (bounds Whisper memory)"]
  end

  subgraph S3["3 · CLIP ENGINE (clip.mjs · makeClips)"]
    H --> I["transcribe · Whisper (base + word timestamps) → cues + words"]
    I --> J["buildWindows · sentence-aware · 14–44s"]
    J --> K["scoreWindow (heuristic) → prefilter top 10"]
    K --> L["rankWindowsLLM ★ DECISION ENGINE · virality 0–100 + hook"]
    L --> L1{"local Gemma (Ollama, CPU)"}
    L1 -- ok --> M
    L1 -- "OOM / down" --> L2["Gemini cloud (gemini-flash-latest)"]
    L2 --> M["rank by viral score → pick top N"]
  end

  subgraph S4["4 · RENDER (renderClip · per clip)"]
    M --> N["buildAss · karaoke captions + hook title card"]
    M --> O["faceInfo · OpenCV face_track.py → frac, x"]
    O --> P{"face in >=15% of frames?"}
    P -- yes --> Q["crop around speaker (x = face centre)"]
    P -- "no (B-roll)" --> R["blur-fit — whole frame + blurred bg"]
    N --> FF
    Q --> FF["ffmpeg · cut → 1080x1920 → burn captions (libx264/aac)"]
    R --> FF
    FF --> T["clip-N.mp4 + clips.json (viral score · hook · dur)"]
  end

  T --> Z["markSeen → deliver clips"]
```

## Files
- `source.mjs` — channel RSS discovery + clip-worthiness title ranking → `queue.json`
- `pipeline.mjs` — orchestration: discover → download (yt-dlp) → trim → clip; resilient (skips blocked/failed candidates)
- `clip.mjs` — the engine: transcribe → window → rank (LLM) → render. Library + CLI (`node clip.mjs <file> [n]`)
- `face_track.py` — OpenCV face detection for smart framing (crop vs blur)
- `digest.mjs` — daily discovery digest (the "what to clip" list)

## Schedule
- 09:00 — `digest.mjs` (discovery list)
- 09:30 — `pipeline.mjs` (download + clip the top candidate)
