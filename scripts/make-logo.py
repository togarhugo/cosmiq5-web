#!/usr/bin/env python3
"""Cuts the Dive Manager logo out of design/logo-source.png (dark version on the left half, light version on the right half)
and writes public/auth/logo-dark.png (for dark pages) and public/auth/logo-light.png (for light pages), with a transparent
background so they sit on any page colour. Needs Pillow + numpy.   python3 scripts/make-logo.py"""
from PIL import Image
import numpy as np, os
here = os.path.dirname(__file__); src = Image.open(os.path.join(here, "..", "design", "logo-source.png")).convert("RGB"); a = np.array(src).astype(float)
H, W = a.shape[:2]; SCALE = 2; PAD = 8
def cut(x0, x1, bgxy, outname):
    bg = a[bgxy[1], bgxy[0]]; sub = a[:, x0:x1]
    d = np.abs(sub - bg).sum(axis=2) > 60; d[:80, :] = False                                   # the small "DARK THEME" label is not part of the logo
    ys, xs = np.where(d); box = (xs.min() + x0 - PAD, ys.min() - PAD, xs.max() + x0 + PAD + 1, ys.max() + PAD + 1)
    px = a[box[1]:box[3], box[0]:box[2]]
    up = np.where(px > bg, (px - bg) / np.maximum(255 - bg, 1), (bg - px) / np.maximum(bg, 1))   # colour-to-alpha: the least opacity that explains each pixel
    alpha = np.clip(up.max(axis=2) / 0.9, 0, 1); alpha = np.clip((alpha - 0.18) / 0.82, 0, 1)           # levels: the faint JPEG noise around the artwork (below ~18 %) is removed, solid parts stay solid                                                  # solid parts of the logo are ~0.9 of the way: make them fully opaque
    safe = np.maximum(alpha, 1e-3)[..., None]; rgb = np.clip(bg + (px - bg) / safe, 0, 255)
    h, w = alpha.shape; prem = np.dstack([rgb * alpha[..., None], alpha * 255])                  # resize premultiplied so edges do not get a halo
    chans = [Image.fromarray(np.clip(prem[..., i], 0, 255).round().astype("uint8")).resize((w * SCALE, h * SCALE), Image.LANCZOS) for i in range(4)]
    A = np.array(chans[3]).astype(float) / 255; R = np.stack([np.array(c).astype(float) for c in chans[:3]], axis=2)
    out = np.dstack([np.where(A[..., None] > 0.004, R / np.maximum(A[..., None], 1e-3), R), A * 255]); out = np.clip(out, 0, 255).round().astype("uint8")
    q = Image.fromarray(out, "RGBA").quantize(colors=47, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)   # a 47-colour palette with transparency: ~10x smaller, no visible difference for flat artwork
    pal = q.getpalette(rawmode="RGBA"); pal[47 * 4:47 * 4 + 4] = [0, 0, 0, 0]                  # one entry that is fully transparent: the quantiser would otherwise turn the background into a faint dark box
    idx = np.array(q); idx[out[..., 3] == 0] = 47; img = Image.fromarray(idx, "P"); img.putpalette(pal, rawmode="RGBA")
    path = os.path.join(here, "..", "public", "auth", outname); img.save(path, optimize=True); print(outname, out.shape[1], "x", out.shape[0], os.path.getsize(path) // 1024, "KB")
cut(0, 505, (20, 300), "logo-dark.png"); cut(520, W, (1000, 300), "logo-light.png")
