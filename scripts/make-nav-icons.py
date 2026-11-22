#!/usr/bin/env python3
"""Draws the five tab icons (public/auth/icon-summary|log|import|cert|device.png): simple outline icons, one colour, drawn as a mask so the page can
paint them in the text colour of either theme (Overview = dashboard, Dive log = closed book, Import = tray with arrow, Certificates = ID card,
Device = watch).   python3 scripts/make-nav-icons.py   (needs Pillow)"""
from PIL import Image, ImageDraw
import os
S, C, SW = 8, 148, 7                                   # supersampling, canvas in px, stroke weight
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "auth")
px = lambda v: round(v * S)

def canvas():
    im = Image.new("L", (C * S, C * S), 0); return im, ImageDraw.Draw(im)
def dot(d, x, y, w=SW):
    r = w / 2; d.ellipse([px(x - r), px(y - r), px(x + r), px(y + r)], fill=255)
def line(d, pts, w=SW):
    d.line([(px(x), px(y)) for x, y in pts], fill=255, width=px(w), joint="curve")
    for x, y in (pts[0], pts[-1]): dot(d, x, y, w)
def box(d, x0, y0, x1, y1, r, w=SW):                   # outlined rounded rectangle
    d.rounded_rectangle([px(x0 - w / 2), px(y0 - w / 2), px(x1 + w / 2), px(y1 + w / 2)], radius=px(r + w / 2), fill=255)
    d.rounded_rectangle([px(x0 + w / 2), px(y0 + w / 2), px(x1 - w / 2), px(y1 - w / 2)], radius=px(max(r - w / 2, 0.5)), fill=0)
def ring(d, cx, cy, r, w=SW):
    d.ellipse([px(cx - r - w / 2), px(cy - r - w / 2), px(cx + r + w / 2), px(cy + r + w / 2)], fill=255)
    d.ellipse([px(cx - r + w / 2), px(cy - r + w / 2), px(cx + r - w / 2), px(cy + r - w / 2)], fill=0)
def save(im, name):
    a = im.resize((C, C), Image.LANCZOS); rgb = Image.new("RGB", (C, C), (255, 255, 255))
    p = os.path.join(OUT, name); Image.merge("RGBA", (*rgb.split(), a)).save(p, optimize=True); print(name, os.path.getsize(p), "bytes")

# Overview: one tall panel and two small ones
im, d = canvas(); box(d, 22, 24, 66, 124, 7); box(d, 82, 24, 126, 66, 7); box(d, 82, 82, 126, 124, 7); save(im, "icon-summary.png")
# Dive log: a closed book with its spine on the left and a few lines of text on the cover
im, d = canvas(); box(d, 34, 18, 116, 130, 9); line(d, [(54, 20), (54, 128)], 6); line(d, [(68, 52), (100, 52)], 6); line(d, [(74, 68), (94, 68)], 6); line(d, [(80, 84), (88, 84)], 6); save(im, "icon-log.png")
# Import: an open tray with an arrow going down into it
im, d = canvas(); line(d, [(22, 98), (22, 126), (126, 126), (126, 98)]); line(d, [(74, 20), (74, 100)]); line(d, [(48, 76), (74, 102), (100, 76)]); save(im, "icon-import.png")
# Certificates: an ID card with a person and two lines
im, d = canvas(); box(d, 16, 34, 132, 114, 13); ring(d, 48, 64, 9.5, 6); d.arc([px(30), px(80), px(66), px(116)], 180, 360, fill=255, width=px(6)); line(d, [(84, 62), (118, 62)], 6); line(d, [(84, 84), (106, 84)], 6); save(im, "icon-cert.png")
# Device: a watch, strap above and below the round face
im, d = canvas(); ring(d, 74, 74, 34); line(d, [(56, 49), (60, 18), (88, 18), (92, 49)]); line(d, [(56, 99), (60, 130), (88, 130), (92, 99)]); save(im, "icon-device.png")
