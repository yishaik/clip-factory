#!/usr/bin/env python
# transcribe_fw.py <audio> <lang> <model> <out.json>
# faster-whisper backend (CTranslate2) — used for Hebrew via the ivrit-ai fine-tune, which is far more
# accurate on Hebrew than vanilla whisper. Writes whisper-CLI-compatible JSON (segments[].words[]) so
# clip.mjs can parse it with the same code path.
import sys, json
from faster_whisper import WhisperModel

audio, lang, model, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
m = WhisperModel(model, device="cpu", compute_type="int8")
segs, info = m.transcribe(audio, language=lang, word_timestamps=True, vad_filter=True)
result = {"language": info.language, "segments": []}
for s in segs:
    result["segments"].append({
        "start": s.start, "end": s.end, "text": s.text,
        "words": [{"start": w.start, "end": w.end, "word": w.word} for w in (s.words or [])],
    })
with open(out, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False)
print(f"ok {len(result['segments'])} segments")
