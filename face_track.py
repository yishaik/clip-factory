#!/usr/bin/env python
# face_track.py <video> <start> <dur>
# Samples frames in [start, start+dur], detects the main speaker's face, and prints JSON:
#   {"x": <normalized 0..1 horizontal centre to crop around>, "conf": <#frames with a face>, "std": <spread>}
# Used by clip.mjs for smart vertical framing (crop around the speaker, not the blind centre).
import sys, json
try:
    import cv2, numpy as np
except Exception as e:
    print(json.dumps({"x": 0.5, "conf": 0, "std": 1.0, "err": str(e)})); sys.exit(0)

video, start, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
cap = cv2.VideoCapture(video)
cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
centers, sizes = [], []
samples = 0
t, step = start, 0.5
while t < start + dur:
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, frame = cap.read()
    if not ok:
        break
    samples += 1
    h, w = frame.shape[:2]
    sw = 480
    small = cv2.resize(frame, (sw, max(1, int(h * sw / w))))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(gray, 1.1, 5, minSize=(36, 36))
    if len(faces):
        fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])  # the largest (closest) face
        centers.append((fx + fw / 2.0) / sw)
        sizes.append(fw / sw)
    t += step
cap.release()

frac = round(len(centers) / samples, 3) if samples else 0.0
if len(centers) >= 3:
    arr = np.array(centers)
    # trimmed median so a few stray B-roll faces don't drag the crop
    print(json.dumps({"x": round(float(np.median(arr)), 4), "conf": len(centers), "frac": frac,
                      "std": round(float(np.std(arr)), 4), "size": round(float(np.median(sizes)), 4)}))
else:
    print(json.dumps({"x": 0.5, "conf": len(centers), "frac": frac, "std": 1.0}))
