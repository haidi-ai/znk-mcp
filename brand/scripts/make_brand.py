# -*- coding: utf-8 -*-
"""
ZNK brand mark generator (T-0805).

100% original vector geometry: no external images, no bundled fonts, no third-party
artwork. Everything is drawn from analytic polygons, so the raster and the SVG are
generated from the same source coordinates.

Outputs (E:\\ai-crew-assets\\znk-mcp\\brand):
  logo-400x400.png       full logo, exactly 400x400
  logo-1024.png          full logo, exactly 1024x1024
  apple-touch-icon-180.png  full logo, exactly 180x180
  favicon-32.png         mark-only optical variant, exactly 32x32
  logo.svg               editable vector, viewBox 0 0 400 400
  README.md              colours / usage / forbidden usage

Run: python make_brand.py [--out DIR]
"""
import argparse
import hashlib
import json
import math
import os
from PIL import Image, ImageDraw

BG = (11, 15, 20)          # #0B0F14
WHITE = (255, 255, 255)    # #FFFFFF
CYAN = (34, 211, 238)      # #22D3EE

# --- master geometry in a 400 x 400 coordinate system -----------------------
CANVAS = 400
CUBE_CX, CUBE_CY, CUBE_R = 200.0, 154.0, 98.0
CUBE_STROKE = 6.0
LETTER_W, LETTER_H, LETTER_T, LETTER_GAP = 42.0, 52.0, 11.0, 16.0
WORD_TOP = 292.0
WORD_W = 3 * LETTER_W + 2 * LETTER_GAP
WORD_X0 = (CANVAS - WORD_W) / 2.0


def hexagon(cx, cy, r):
    """Isometric cube silhouette: pointy top/bottom, vertical left/right sides."""
    return [(cx + r * math.cos(math.radians(deg)),
             cy + r * math.sin(math.radians(deg)))
            for deg in (-90, -30, 30, 90, 150, 210)]


# hexagon index: 0 top, 1 upper-right, 2 lower-right, 3 bottom, 4 lower-left, 5 upper-left
# visible top face is T/UR/C/UL, so the three visible inner edges are C->UL, C->UR, C->B
SPOKE_INDEX = (1, 3, 5)


def _clamp_letter_box(pts, w, h):
    return [(min(w, max(0.0, x)), min(h, max(0.0, y))) for x, y in pts]


def letter_polys(ch, x0, y0, w=LETTER_W, h=LETTER_H, t=LETTER_T):
    """Geometric letterforms as filled polygons (no font files involved)."""
    X = lambda v: x0 + v
    Y = lambda v: y0 + v
    if ch == "Z":
        return [
            [(X(0), Y(0)), (X(w), Y(0)), (X(w), Y(t)), (X(0), Y(t))],
            [(X(0), Y(h - t)), (X(w), Y(h - t)), (X(w), Y(h)), (X(0), Y(h))],
            [(X(w), Y(t)), (X(w - t), Y(t)), (X(0), Y(h - t)), (X(t), Y(h - t))],
        ]
    if ch == "N":
        return [
            [(X(0), Y(0)), (X(t), Y(0)), (X(t), Y(h)), (X(0), Y(h))],
            [(X(w - t), Y(0)), (X(w), Y(0)), (X(w), Y(h)), (X(w - t), Y(h))],
            [(X(0), Y(0)), (X(t), Y(0)), (X(w), Y(h)), (X(w - t), Y(h))],
        ]
    if ch == "K":
        polys = [[(X(0), Y(0)), (X(t), Y(0)), (X(t), Y(h)), (X(0), Y(h))]]
        half = t / 2.0
        for bx, by in ((w, 0.0), (w, h)):
            ax, ay = t, h / 2.0
            dx, dy = bx - ax, by - ay
            length = math.hypot(dx, dy)
            ux, uy = dx / length, dy / length
            px, py = -uy * half, ux * half
            pts = [(ax + px, ay + py), (bx + px, by + py),
                   (bx - px, by - py), (ax - px, ay - py)]
            polys.append([(X(a), Y(b)) for a, b in _clamp_letter_box(pts, w, h)])
        return polys
    raise ValueError(ch)


def wordmark_polys():
    out = []
    for i, ch in enumerate("ZNK"):
        out += letter_polys(ch, WORD_X0 + i * (LETTER_W + LETTER_GAP), WORD_TOP)
    return out


CUBE = hexagon(CUBE_CX, CUBE_CY, CUBE_R)
SPOKES = [(CUBE_CX, CUBE_CY, CUBE[i][0], CUBE[i][1]) for i in SPOKE_INDEX]
LETTERS = wordmark_polys()


# --- raster -----------------------------------------------------------------
def _draw(img, k):
    """Draw the full logo into img; k = pixels per master unit."""
    d = ImageDraw.Draw(img)
    sw = max(1, int(round(CUBE_STROKE * k)))
    # spokes first, silhouette last: the cyan rim then caps the white spoke tips
    for x1, y1, x2, y2 in SPOKES:
        d.line([(x1 * k, y1 * k), (x2 * k, y2 * k)], fill=WHITE, width=sw)
    d.line([(x * k, y * k) for x, y in CUBE] + [(CUBE[0][0] * k, CUBE[0][1] * k)],
           fill=CYAN, width=sw, joint="curve")
    for poly in LETTERS:
        d.polygon([(x * k, y * k) for x, y in poly], fill=WHITE)
    return img


def _draw_mark(img):
    """Mark-only optical variant: same cube construction, enlarged and thickened."""
    d = ImageDraw.Draw(img)
    s = float(img.width)
    r = 0.355 * s
    stroke = max(1, int(round(0.052 * s)))
    pts = hexagon(s / 2.0, s / 2.0, r)
    for i in SPOKE_INDEX:
        d.line([(s / 2.0, s / 2.0), pts[i]], fill=WHITE, width=stroke)
    d.line(pts + [pts[0]], fill=CYAN, width=stroke, joint="curve")
    return img


def render_png(size, mode="full", ss=None):
    if ss is None:
        ss = max(2, min(16, int(round(4096.0 / size))))
    big = Image.new("RGB", (size * ss, size * ss), BG)
    if mode == "full":
        _draw(big, (size * ss) / float(CANVAS))
    else:
        _draw_mark(big)
    img = big.resize((size, size), Image.LANCZOS)
    assert img.mode == "RGB" and img.size == (size, size)
    return img


# --- vector -----------------------------------------------------------------
def _num(v):
    return ("%.3f" % v).rstrip("0").rstrip(".")


def _poly_path(polys):
    parts = []
    for poly in polys:
        parts.append("M" + " L".join("%s %s" % (_num(x), _num(y)) for x, y in poly) + " Z")
    return " ".join(parts)


def svg_text():
    hex_pts = " ".join("%s,%s" % (_num(x), _num(y)) for x, y in CUBE)
    spoke_d = " ".join("M%s %s L%s %s" % (_num(CUBE_CX), _num(CUBE_CY), _num(x2), _num(y2))
                       for _, _, x2, y2 in SPOKES)
    letters = ""
    ids = ("letter-Z", "letter-N", "letter-K")
    group = [[], [], []]
    for idx, poly in enumerate(LETTERS):
        group[idx // 3].append(poly)
    for gid, polys in zip(ids, group):
        letters += '    <path id="%s" d="%s"/>\n' % (gid, _poly_path(polys))
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!-- ZNK brand mark (T-0805). Original geometry only: no external assets,\n'
        '     no embedded fonts, no third-party artwork. Colours: #0B0F14 / #FFFFFF / #22D3EE.\n'
        '     Editable: background rect, cube silhouette polygon, cube spokes path and\n'
        '     three wordmark paths. Generated by scripts/make_brand.py. -->\n'
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"\n'
        '     role="img" aria-labelledby="znk-title znk-desc">\n'
        '  <title id="znk-title">ZNK</title>\n'
        '  <desc id="znk-desc">White and cyan isometric cube wireframe on a dark background,'
        ' with the ZNK wordmark below.</desc>\n'
        '  <rect id="background" x="0" y="0" width="400" height="400" fill="#0B0F14"/>\n'
        '  <g id="cube" fill="none" stroke-linejoin="round" stroke-linecap="butt"'
        ' stroke-width="%s">\n' % _num(CUBE_STROKE) +
        '    <path id="cube-edges" d="%s" stroke="#FFFFFF"/>\n' % spoke_d +
        '    <polygon id="cube-silhouette" points="%s" stroke="#22D3EE"/>\n' % hex_pts +
        '  </g>\n'
        '  <g id="wordmark" fill="#FFFFFF">\n' + letters + '  </g>\n'
        '</svg>\n'
    )


# --- checks -----------------------------------------------------------------
def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest().upper()


def verify_manifest(out_dir, names, limit=200 * 1024):
    rows = []
    for name in names:
        path = os.path.join(out_dir, name)
        im = Image.open(path)
        im.load()
        size = im.size
        mode = im.mode
        nbytes = os.path.getsize(path)
        has_alpha = ("A" in mode) or ("transparency" in im.info)
        colors = len(im.getcolors(maxcolors=1 << 20) or [])
        corner = im.getpixel((0, 0))
        ok = (mode == "RGB" and not has_alpha and nbytes < limit
              and corner == BG and colors < 4096)
        rows.append(dict(name=name, size=list(size), mode=mode, bytes=nbytes,
                         alpha=has_alpha, unique_colors=colors,
                         corner=corner, sha256=sha256(path), ok=ok))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=r"E:\ai-crew-assets\znk-mcp\brand")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    jobs = [
        ("logo-400x400.png", 400, "full"),
        ("logo-1024.png", 1024, "full"),
        ("apple-touch-icon-180.png", 180, "full"),
        ("favicon-32.png", 32, "mark"),
    ]
    for name, size, mode in jobs:
        render_png(size, mode).save(os.path.join(args.out, name), format="PNG",
                                    compress_level=9)

    with open(os.path.join(args.out, "logo.svg"), "w", encoding="utf-8",
              newline="\n") as f:
        f.write(svg_text())

    rows = verify_manifest(args.out, [n for n, _, _ in jobs])
    svg_path = os.path.join(args.out, "logo.svg")
    rows.append(dict(name="logo.svg", bytes=os.path.getsize(svg_path),
                     sha256=sha256(svg_path), ok=os.path.getsize(svg_path) < 200 * 1024))
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    if not all(r["ok"] for r in rows):
        raise SystemExit("verification FAILED")


if __name__ == "__main__":
    main()
