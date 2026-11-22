#!/usr/bin/env python3
"""The DAN logo's "D" and "A" have opaque white counters (the holes), while the gap in the "N" is transparent, so the logo only looked right on white.
This makes the counters transparent too (smooth edges), leaving the flag (its white stripe and cross) alone. Reads design/dan-logo-original.png and
writes public/dan-logo.png.   python3 scripts/fix-dan-logo.py   (needs Pillow + numpy)"""
from PIL import Image
import numpy as np, os
here = os.path.dirname(__file__); src = os.path.join(here, "..", "design", "dan-logo-original.png"); dst = os.path.join(here, "..", "public", "dan-logo.png")
im = Image.open(src).convert("RGBA"); a = np.array(im).astype(float)
TEXT_FROM = 83                                                                  # rows below the flag: only the letters D A N live here
red = np.array([207.0, 52.0, 63.0]); reg = a[TEXT_FROM:]
solid = reg[..., 3] > 0
t = np.clip((reg[..., 1] - red[1]) / (255.0 - red[1]), 0, 1)                    # 0 = the letters' red, 1 = white counter (green channel tells them apart)
t = np.where(solid, t, 0)
reg[..., 3] = reg[..., 3] * (1 - t)
mix = t < 0.999
for c in range(3): reg[..., c] = np.where(solid & mix, red[c], reg[..., c])      # edge pixels keep the letters' red, only their opacity changes
a[TEXT_FROM:] = reg
Image.fromarray(a.round().astype("uint8"), "RGBA").save(dst, optimize=True); print("wrote", dst, os.path.getsize(dst), "bytes")
