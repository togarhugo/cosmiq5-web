#!/usr/bin/env python3
"""Draws the Certificates tab icon (public/auth/icon-cert.png): a certificate with text lines, the wave mark used on the Dive log icon and a
rosette with two ribbon tails. One-colour mask on the same 148 px canvas and stroke weight as the other three tab icons (see make-tab-icons.py),
so the app paints it with the text colour.   python3 scripts/make-cert-icon.py   (needs Pillow)"""
from PIL import Image, ImageDraw
import math, os
S, C, SW = 8, 148, 6                      # supersampling, canvas, stroke
im = Image.new("L", (C * S, C * S), 0); d = ImageDraw.Draw(im)
def px(v): return round(v * S)
def line(pts, w=SW):
    d.line([(px(x), px(y)) for x, y in pts], fill=255, width=px(w), joint="curve")
    for x, y in (pts[0], pts[-1]): r = w / 2; d.ellipse([px(x - r), px(y - r), px(x + r), px(y + r)], fill=255)
def rrect(x0, y0, x1, y1, r, w=SW):
    d.rounded_rectangle([px(x0), px(y0), px(x1), px(y1)], radius=px(r), outline=255, width=px(w))
def ring(cx, cy, r, w=SW): d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], outline=255, width=px(w))
# the sheet (landscape certificate)
rrect(12, 26, 136, 110, 9)
rrect(20, 34, 128, 102, 4, 2.2)                                   # thin inner border
# title and text lines
line([(38, 50), (92, 50)]); line([(38, 64), (78, 64)])
# waves (same mark as the dive log icon)
for y0 in (82, 91):
    pts = [(38 + i * 1.0, y0 + 3.2 * math.sin(i / 6.0 * math.pi)) for i in range(0, 25)]; line(pts, 3.6)
# rosette, overlapping the lower right corner, with ribbon tails (cleared behind it so it reads as sitting on top)
cx, cy = 106, 92
d.ellipse([px(cx - 21), px(cy - 21), px(cx + 21), px(cy + 21)], fill=0)
tails = [[(cx - 9, cy + 14), (cx - 15, cy + 36), (cx - 7, cy + 31), (cx - 1, cy + 38), (cx + 1, cy + 17)], [(cx + 9, cy + 14), (cx + 15, cy + 36), (cx + 7, cy + 31), (cx + 1, cy + 38), (cx - 1, cy + 17)]]
for t in tails: d.polygon([(px(x), px(y)) for x, y in t], fill=0)
for t in tails: line(t[:4] if False else [t[0], t[1], t[2], t[3]], SW * 0.85)
ring(cx, cy, 16); ring(cx, cy, 8.5, 3)
# the thin pieces above can cut through the sheet's border: keep the page border clear around the rosette only
a = im.resize((C, C), Image.LANCZOS)
out = Image.new("RGBA", (C, C), (255, 255, 255, 0)); out.putalpha(a); rgb = Image.new("RGB", (C, C), (255, 255, 255)); out = Image.merge("RGBA", (*rgb.split(), a))
path = os.path.join(os.path.dirname(__file__), "..", "public", "auth", "icon-cert.png"); out.save(path, optimize=True); print("icon-cert.png", os.path.getsize(path) // 1024, "KB")
