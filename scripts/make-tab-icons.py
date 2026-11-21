#!/usr/bin/env python3
"""Cuts the three tab icons (Summary, Dive log, Device) out of design/tab-icons-source.png (dark version on the left half) and writes them as
one-colour masks: public/auth/icon-summary.png, icon-log.png, icon-device.png. The app paints them with the text colour (CSS mask), so one file
serves light and dark themes and the active / inactive tab states.   python3 scripts/make-tab-icons.py   (needs Pillow + numpy)"""
from PIL import Image
import numpy as np, os
here = os.path.dirname(__file__); a = np.array(Image.open(os.path.join(here, "..", "design", "tab-icons-source.png")).convert("RGB")).astype(float)
H, W = a.shape[:2]; half = W // 2 - 6; bg = a[120, 5]
d = np.abs(a[:, :half] - bg).sum(axis=2) > 90; d[:42, :] = False; d[205:, :] = False                  # no caption (top) and no text labels (bottom)
cols = np.where(d.any(axis=0))[0]; groups = []; s = p = cols[0]
for c in cols[1:]:
    if c - p > 25: groups.append((s, p)); s = c
    p = c
groups.append((s, p)); assert len(groups) == 3, groups
lum = a.mean(axis=2); lbg = lum[120, 5]; lfg = np.percentile(lum[:, :half][d], 98)
CANVAS = 148
for (x0, x1), name in zip(groups, ("icon-summary.png", "icon-log.png", "icon-device.png")):
    ys = np.where(d[:, x0:x1 + 1].any(axis=1))[0]; y0, y1 = ys.min(), ys.max()
    alpha = np.clip((lum[y0 - 3:y1 + 4, x0 - 3:x1 + 4] - lbg) / (lfg - lbg), 0, 1); alpha = np.clip((alpha - 0.10) / 0.9, 0, 1)   # faint JPEG noise is removed
    h, w = alpha.shape; canvas = np.zeros((CANVAS, CANVAS)); oy, ox = (CANVAS - h) // 2, (CANVAS - w) // 2; canvas[oy:oy + h, ox:ox + w] = alpha          # same square canvas, centred: the three icons line up
    out = np.zeros((CANVAS, CANVAS, 4), dtype="uint8"); out[..., :3] = 255; out[..., 3] = (canvas * 255).round()
    path = os.path.join(here, "..", "public", "auth", name); Image.fromarray(out, "RGBA").save(path, optimize=True); print(name, w, "x", h, "->", CANVAS, os.path.getsize(path) // 1024, "KB")
