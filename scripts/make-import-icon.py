#!/usr/bin/env python3
"""Draws the Import tab icon (public/auth/icon-import.png): a tray with a downward arrow and the wave mark of the Dive log icon. One-colour mask on
the same 148 px canvas and stroke weight as the other tab icons (see make-tab-icons.py, make-cert-icon.py).   python3 scripts/make-import-icon.py   (needs Pillow)"""
from PIL import Image, ImageDraw
import math, os
S, C, SW = 8, 148, 6
im = Image.new("L", (C * S, C * S), 0); d = ImageDraw.Draw(im)
px = lambda v: round(v * S)
def line(pts, w=SW):
    d.line([(px(x), px(y)) for x, y in pts], fill=255, width=px(w), joint="curve")
    for x, y in (pts[0], pts[-1]): r = w / 2; d.ellipse([px(x - r), px(y - r), px(x + r), px(y + r)], fill=255)
# the tray: open on top, rounded corners
line([(20, 78), (20, 118), (128, 118), (128, 78)]); d.arc([px(20), px(112), px(34), px(126)], 0, 0, fill=255)
# the arrow, going into the tray
line([(74, 20), (74, 84)]); line([(50, 62), (74, 88), (98, 62)])
# the wave inside the tray
pts = [(36 + i * 1.5, 104 + 3.4 * math.sin(i / 8.0 * math.pi)) for i in range(0, 49)]; line(pts, 3.6)
a = im.resize((C, C), Image.LANCZOS)
rgb = Image.new("RGB", (C, C), (255, 255, 255)); out = Image.merge("RGBA", (*rgb.split(), a))
path = os.path.join(os.path.dirname(__file__), "..", "public", "auth", "icon-import.png"); out.save(path, optimize=True); print("icon-import.png", os.path.getsize(path) // 1024, "KB")
