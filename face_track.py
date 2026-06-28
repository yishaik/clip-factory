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
xs, ys, sizes, tops, bots = [], [], [], [], []   # face centre x/y, height frac, and top/bottom edges
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
    sh = max(1, int(h * sw / w))
    small = cv2.resize(frame, (sw, sh))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(gray, 1.1, 5, minSize=(36, 36))
    if len(faces):
        fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])  # the largest (closest) face
        xs.append((fx + fw / 2.0) / sw)
        ys.append((fy + fh / 2.0) / sh)
        sizes.append(fh / sh)                                    # face height as a fraction of frame height
        tops.append(fy / sh)                                     # face top edge (highest = smallest)
        bots.append((fy + fh) / sh)                              # face bottom edge (chin)
    t += step
cap.release()

frac = round(len(xs) / samples, 3) if samples else 0.0
if len(xs) >= 3:
    ax = np.array(xs)
    # robust percentiles so a stray detection doesn't blow up the vertical extent; ylo/yhi bracket the
    # head's travel across the clip so clip.mjs can size the crop to keep the head in-frame the whole time.
    print(json.dumps({"x": round(float(np.median(ax)), 4), "y": round(float(np.median(ys)), 4),
                      "size": round(float(np.median(sizes)), 4),
                      "ylo": round(float(np.percentile(tops, 5)), 4), "yhi": round(float(np.percentile(bots, 95)), 4),
                      "conf": len(xs), "frac": frac, "std": round(float(np.std(ax)), 4)}))
else:
    print(json.dumps({"x": 0.5, "y": 0.42, "size": 0.0, "ylo": 0.15, "yhi": 0.7, "conf": len(xs), "frac": frac, "std": 1.0}))
