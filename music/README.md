# music/

Drop royalty-free background tracks here (`.mp3` / `.m4a` / `.wav` / `.ogg`).

`generate.mjs` auto-picks one per run and mixes it **under the voiceover** with
sidechain ducking (music dips while the narrator speaks). Controls:
- `GEN_MUSIC=/path/to/track`  — force a specific track
- `GEN_MUSIC_VOL=0.20`        — music level (0 = off-ish, ~0.2 default)

No track here = voiceover only (the feature is optional and skips gracefully).
Use CC0 / royalty-free sources (e.g. Pixabay Music, YouTube Audio Library — "no attribution").
