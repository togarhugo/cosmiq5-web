#!/usr/bin/env python3
"""Regenerates the app icons: the diver-down flag (red, white diagonal band). Needs Pillow.
   python3 scripts/make-icons.py   ->  public/icon-192.png, icon-512.png, apple-touch-icon.png (+ copy in public/auth/), favicon.svg (+ copy)."""
from PIL import Image, ImageDraw
import shutil, os
RED, WHITE = (217, 75, 60), (255, 255, 255)
SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#d94b3c"/><polygon points="0,0 15,0 64,49 64,64 49,64 0,15" fill="#fff"/><rect x="1" y="1" width="62" height="62" rx="11" fill="none" stroke="#a93226" stroke-width="2"/></svg>\n'''

def flag(size, radius=0.0):
    s = size * 4                                                     # draw large, then shrink: smooth edges
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    if radius: d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * radius), fill=RED + (255,))
    else: d.rectangle((0, 0, s, s), fill=RED + (255,))
    k = s / 64                                                       # same band as favicon.svg
    band = Image.new("L", (s, s), 0); ImageDraw.Draw(band).polygon([(x * k, y * k) for x, y in ((0, 0), (15, 0), (64, 49), (64, 64), (49, 64), (0, 15))], fill=255)
    white = Image.new("RGBA", (s, s), WHITE + (255,)); im.paste(white, (0, 0), Image.composite(band, Image.new("L", (s, s), 0), im.getchannel("A")))
    if radius: ImageDraw.Draw(im).rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * radius), outline=(169, 50, 38, 255), width=max(4, s // 32))
    return im.resize((size, size), Image.LANCZOS)

root = os.path.join(os.path.dirname(__file__), "..", "public")
flag(192, 0.22).save(os.path.join(root, "icon-192.png"), optimize=True)
flag(512).save(os.path.join(root, "icon-512.png"), optimize=True)            # full bleed: also used as a maskable icon
flag(180).save(os.path.join(root, "apple-touch-icon.png"), optimize=True)    # iOS rounds the corners itself
open(os.path.join(root, "favicon.svg"), "w").write(SVG)
for f in ("apple-touch-icon.png", "favicon.svg"):                            # the sign-in pages are public and need their own copies
    shutil.copy(os.path.join(root, f), os.path.join(root, "auth", f))
print("icons written")
