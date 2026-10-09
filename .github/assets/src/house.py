"""
The outofplace house style, as plain SVG for a GitHub README.

GitHub shows README images through its camo proxy inside <img>, so an SVG can
carry CSS and its own animation but can load nothing: no webfonts, no
scripts. Text is therefore set here, outlined: harfbuzz shapes it (kerning,
ligatures) and fontTools draws each glyph once into <defs>, so a page reuses
glyphs instead of repeating outlines. The font files never leave this machine;
only the outlines of the words drawn end up in the repository.

Colour is OKLCH, as in outofplace-site styles/theme.css and pod-site, and is
converted to sRGB hex here, because SVG renderers outside the browser (and
older ones inside it) don't read oklch().
"""

from __future__ import annotations

import io
import math
import os
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from xml.sax.saxutils import escape

# ── Colour ──────────────────────────────────────────────────────────────


def _oklch_to_linear(l: float, c: float, h: float) -> tuple[float, float, float]:
    a = c * math.cos(math.radians(h))
    b = c * math.sin(math.radians(h))
    l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3
    return (
        4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
        -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
        -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
    )


def _in_gamut(rgb: Iterable[float]) -> bool:
    return all(-1e-4 <= v <= 1 + 1e-4 for v in rgb)


def _encode(v: float) -> int:
    v = min(1.0, max(0.0, v))
    v = 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055
    return round(v * 255)


def oklch(l: float, c: float = 0.0, h: float = 0.0) -> str:
    """OKLCH to an sRGB hex. Out of gamut, chroma drops until it fits (CSS Color 4 keeps hue and lightness)."""
    rgb = _oklch_to_linear(l, c, h)
    if not _in_gamut(rgb):
        lo, hi = 0.0, c
        for _ in range(24):
            mid = (lo + hi) / 2
            if _in_gamut(_oklch_to_linear(l, mid, h)):
                lo = mid
            else:
                hi = mid
        rgb = _oklch_to_linear(l, lo, h)
    return "#" + "".join(f"{_encode(v):02x}" for v in rgb)


@dataclass(frozen=True)
class Ink:
    """A colour with its alpha kept apart, since SVG takes opacity as its own attribute."""

    hex: str
    a: float = 1.0

    def fill(self) -> str:
        return f'fill="{self.hex}"' + (
            f' fill-opacity="{self.a:g}"' if self.a < 1 else ""
        )

    def stroke(self) -> str:
        return f'stroke="{self.hex}"' + (
            f' stroke-opacity="{self.a:g}"' if self.a < 1 else ""
        )

    def stop(self, offset: float, a: float | None = None) -> str:
        alpha = self.a if a is None else a
        return (
            f'<stop offset="{offset:g}" stop-color="{self.hex}"'
            + (f' stop-opacity="{alpha:g}"' if alpha < 1 else "")
            + "/>"
        )

    def with_a(self, a: float) -> Ink:
        return Ink(self.hex, a)


POD_HUE = 205


@dataclass(frozen=True)
class Theme:
    """One surface's tokens (outofplace-site theme.css, pod-site theme.css)."""

    name: str
    page: str  # GitHub's own page colour behind the image, for checks only
    bg: Ink
    ink: Ink
    ink2: Ink
    ink3: Ink
    inv: Ink
    hairline: Ink
    hairline_strong: Ink
    fill: Ink
    fill_strong: Ink
    surface: Ink
    raised: Ink
    pod: Ink
    pod_glyph: Ink
    pod_ink: Ink
    ok: Ink
    busy: Ink
    poor: Ink
    chart: tuple[Ink, ...]
    chart_muted: Ink
    chart_grid: Ink
    dark: bool = field(default=False)


_DARK_INK = oklch(0.958, 0.004, 91)
_LIGHT_INK = oklch(0.173, 0.013, 264)

DARK = Theme(
    name="dark",
    page="#0d1117",
    bg=Ink(oklch(0)),
    ink=Ink(_DARK_INK),
    ink2=Ink(_DARK_INK, 0.64),
    ink3=Ink(_DARK_INK, 0.54),
    inv=Ink(oklch(0)),
    hairline=Ink("#ffffff", 0.09),
    hairline_strong=Ink("#ffffff", 0.14),
    fill=Ink("#ffffff", 0.07),
    fill_strong=Ink("#ffffff", 0.12),
    surface=Ink("#ffffff", 0.05),
    raised=Ink(oklch(0.19, 0.004, 91)),
    pod=Ink(oklch(0.64, 0.06, POD_HUE)),
    pod_glyph=Ink(oklch(0.8, 0.1, POD_HUE)),
    pod_ink=Ink(oklch(0.86, 0.08, POD_HUE)),
    ok=Ink(oklch(0.72, 0.15, 150)),
    busy=Ink(oklch(0.8, 0.14, 80)),
    poor=Ink(oklch(0.66, 0.18, 28)),
    chart=tuple(
        Ink(oklch(l, 0.15, h))
        for l, h in (
            (0.64, 195),
            (0.67, 275),
            (0.58, 70),
            (0.52, 345),
            (0.67, 150),
            (0.58, 240),
        )
    ),
    chart_muted=Ink(oklch(0.42, 0.005, 91)),
    chart_grid=Ink("#ffffff", 0.08),
    dark=True,
)

LIGHT = Theme(
    name="light",
    page="#ffffff",
    bg=Ink(oklch(1)),
    ink=Ink(_LIGHT_INK),
    ink2=Ink(oklch(0.507, 0.012, 88)),
    ink3=Ink(_LIGHT_INK, 0.6),
    inv=Ink(oklch(1)),
    hairline=Ink("#000000", 0.06),
    hairline_strong=Ink("#000000", 0.1),
    fill=Ink("#000000", 0.04),
    fill_strong=Ink("#000000", 0.07),
    surface=Ink(oklch(0.967, 0.002, 91)),
    raised=Ink(oklch(1)),
    pod=Ink(oklch(0.64, 0.06, POD_HUE)),
    pod_glyph=Ink(oklch(0.58, 0.095, POD_HUE)),
    pod_ink=Ink(oklch(0.42, 0.075, POD_HUE)),
    ok=Ink(oklch(0.56, 0.14, 150)),
    busy=Ink(oklch(0.64, 0.14, 70)),
    poor=Ink(oklch(0.56, 0.19, 28)),
    chart=tuple(
        Ink(oklch(l, 0.15, h))
        for l, h in (
            (0.62, 195),
            (0.7, 275),
            (0.54, 70),
            (0.46, 345),
            (0.7, 150),
            (0.54, 240),
        )
    ),
    chart_muted=Ink(oklch(0.82, 0.004, 91)),
    chart_grid=Ink("#000000", 0.08),
)

THEMES = (DARK, LIGHT)


def sea(l: float, c: float = 0.06, a: float = 1.0) -> Ink:
    """Pod's hue at a given lightness: the sea field and its light."""
    return Ink(oklch(l, c, POD_HUE), a)


# ── Type ────────────────────────────────────────────────────────────────

# Font files are licensed to the studio for its own use; they stay on this
# machine. POD_README_FONTS points at a directory holding them; otherwise the
# studio's usual checkouts are tried.
_FONT_FILES = {
    "neue": "ppneuemontreal-regular.woff2",
    "neue-medium": "ppneuemontreal-medium.woff2",
    "suisse": "SuisseIntl-Regular.woff2",
    "suisse-medium": "SuisseIntl-Medium.woff2",
    "mono": "jetbrains-mono-latin-400-normal.woff2",
    "mono-medium": "jetbrains-mono-latin-500-normal.woff2",
}
_FONT_DIRS = [
    os.environ.get("POD_README_FONTS", ""),
    "~/Documents/outofplace-site/.raw/fonts/src",
    "~/Documents/pod-site/app/fonts",
    "~/Documents/outofplace-site/app/fonts",
]


def _find_font(key: str) -> Path:
    name = _FONT_FILES[key]
    for d in _FONT_DIRS:
        if not d:
            continue
        p = Path(d).expanduser() / name
        if p.exists():
            return p
    raise SystemExit(
        f"font {name} not found. Set POD_README_FONTS to a directory holding "
        f"{', '.join(sorted(set(_FONT_FILES.values())))}. JetBrains Mono (OFL) comes from "
        "npm @fontsource/jetbrains-mono; Neue Montreal and Suisse Intl are the studio's licensed files."
    )


class Face:
    def __init__(self, key: str):
        import uharfbuzz as hb
        from fontTools.ttLib import TTFont

        self.key = key
        self.font = TTFont(str(_find_font(key)))
        self.font.flavor = None
        buf = io.BytesIO()
        self.font.save(buf)
        self._hb = hb.Font(hb.Face(buf.getvalue()))
        self.upem = self.font["head"].unitsPerEm
        os2 = self.font["OS/2"]
        self.cap = getattr(os2, "sCapHeight", 0) or 700
        self.xh = getattr(os2, "sxHeight", 0) or 500
        hhea = self.font["hhea"]
        self.ascent, self.descent = hhea.ascent, hhea.descent
        self.glyphset = self.font.getGlyphSet()
        self.order = self.font.getGlyphOrder()
        self._paths: dict[int, str] = {}

    def shape(
        self, text: str, features: dict | None = None
    ) -> list[tuple[int, int, int, int]]:
        """(glyph id, x advance, x offset, y offset) in font units."""
        import uharfbuzz as hb

        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(self._hb, buf, {"kern": True, "liga": True, **(features or {})})
        return [
            (i.codepoint, p.x_advance, p.x_offset, p.y_offset)
            for i, p in zip(buf.glyph_infos, buf.glyph_positions)
        ]

    def width(self, text: str, size: float, tracking: float = 0.0) -> float:
        """Advance width in px, letter-spacing (em) between glyphs but not after the last."""
        glyphs = self.shape(text)
        units = sum(g[1] for g in glyphs) + tracking * self.upem * max(
            0, len(glyphs) - 1
        )
        return units * size / self.upem

    def path(self, gid: int) -> str:
        if gid not in self._paths:
            from fontTools.pens.svgPathPen import SVGPathPen

            pen = SVGPathPen(self.glyphset, ntos=lambda v: f"{round(v)}")
            self.glyphset[self.order[gid]].draw(pen)
            self._paths[gid] = pen.getCommands()
        return self._paths[gid]


_FACES: dict[str, Face] = {}


def face(key: str) -> Face:
    if key not in _FACES:
        _FACES[key] = Face(key)
    return _FACES[key]


@dataclass(frozen=True)
class Type:
    """A type role (pod-site styles/utilities.css type-*), sized for the image's own scale."""

    face: str
    size: float
    leading: float = 1.2
    tracking: float = 0.0  # em


def wrap(text: str, t: Type, max_w: float) -> list[str]:
    """Greedy word wrap by shaped width. A newline in the text forces a break."""
    f = face(t.face)
    lines: list[str] = []
    for para in text.split("\n"):
        words = para.split(" ")
        line = ""
        for w in words:
            trial = f"{line} {w}" if line else w
            if line and f.width(trial, t.size, t.tracking) > max_w:
                lines.append(line)
                line = w
            else:
                line = trial
        # text-wrap: pretty, roughly: never leave one word alone on the last line.
        if lines and " " not in line and " " in lines[-1]:
            head, _, moved = lines[-1].rpartition(" ")
            if f.width(f"{moved} {line}", t.size, t.tracking) <= max_w:
                lines[-1], line = head, f"{moved} {line}"
        lines.append(line)
    return lines


# ── Geometry ────────────────────────────────────────────────────────────


def n(v: float) -> str:
    """A compact number for path data."""
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def squircle(
    x: float, y: float, w: float, h: float, r: float, smoothing: float = 0.6
) -> str:
    """
    A rounded rectangle with continuous (Figma-style) corners: the studio's
    squircle radii (13/16/22/28/32/48) drawn the way they read on the site.
    Pills (r >= h/2) fall back to plain arcs.
    """
    r = max(0.0, min(r, w / 2, h / 2))
    if r == 0:
        return f"M{n(x)} {n(y)}h{n(w)}v{n(h)}h{n(-w)}Z"
    p = min((1 + smoothing) * r, min(w, h) / 2)
    s = max(0.0, min(smoothing, p / r - 1))
    arc_measure = 90 * (1 - s)
    arc = math.sin(math.radians(arc_measure / 2)) * r * math.sqrt(2)
    alpha = (90 - arc_measure) / 2
    p34 = r * math.tan(math.radians(alpha / 2))
    beta = 45 * s
    c = p34 * math.cos(math.radians(beta))
    d = c * math.tan(math.radians(beta))
    b = (p - arc - c - d) / 3
    a = 2 * b
    A, B, C, D, R, L = n(a), n(a + b), n(a + b + c), n(d), n(r), n(arc)
    bc = n(b + c)
    return (
        f"M{n(x + w - p)} {n(y)}"
        f"c{A} 0 {B} 0 {C} {D}a{R} {R} 0 0 1 {L} {L}c{D} {n(c)} {D} {bc} {D} {C}"
        f"L{n(x + w)} {n(y + h - p)}"
        f"c0 {A} 0 {B} {n(-d)} {C}a{R} {R} 0 0 1 {n(-arc)} {L}c{n(-c)} {D} -{bc} {D} -{C} {D}"
        f"L{n(x + p)} {n(y + h)}"
        f"c-{A} 0 -{B} 0 -{C} {n(-d)}a{R} {R} 0 0 1 {n(-arc)} {n(-arc)}c{n(-d)} {n(-c)} {n(-d)} -{bc} {n(-d)} -{C}"
        f"L{n(x)} {n(y + p)}"
        f"c0 -{A} 0 -{B} {D} -{C}a{R} {R} 0 0 1 {L} {n(-arc)}c{n(c)} {n(-d)} {bc} {n(-d)} {C} {n(-d)}Z"
    )


# Pod's mark (pod-site lib/mark.ts): a pod with three peas, the agents of one
# fleet, as a lens with the peas cut out (even-odd). 40 x 24 units.
MARK_W, MARK_H = 40, 24
MARK_PATH = (
    "M1.5 13C7.6 1.5 32.4 1.5 38.5 13 32.4 20 7.6 20 1.5 13ZM12 14.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
    "M20 14.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM28 14.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
)
MARK_LENS = "M1.5 13C7.6 1.5 32.4 1.5 38.5 13 32.4 20 7.6 20 1.5 13Z"
MARK_PEAS = ((12, 11.5), (20, 11.5), (28, 11.5))


# ── Document ────────────────────────────────────────────────────────────

# Motion (outofplace-site theme.css): ease-out for arrivals, in-out for loops,
# never ease-in; only transform and opacity animate; reduced motion stands still.
EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)"
EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)"
REDUCED_MOTION = "@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}"


class Doc:
    def __init__(self, w: float, h: float, title: str, desc: str = ""):
        self.w, self.h = w, h
        self.title, self.desc = title, desc
        self.defs: list[str] = []
        self.css: list[str] = []
        self.body: list[str] = []
        self._glyphs: dict[tuple[str, int], str] = {}
        self._ids: set[str] = set()

    # Elements
    def add(self, *parts: str) -> None:
        self.body.extend(parts)

    def define(self, id_: str, markup: str) -> str:
        if id_ not in self._ids:
            self._ids.add(id_)
            self.defs.append(markup)
        return id_

    def style(self, css: str) -> None:
        self.css.append(css)

    def glyph(self, f: Face, gid: int) -> str | None:
        key = (f.key, gid)
        if key not in self._glyphs:
            d = f.path(gid)
            if not d:
                self._glyphs[key] = ""
            else:
                gid_s = (
                    f"{f.key[0]}{f.key.split('-')[-1][0] if '-' in f.key else ''}{gid}"
                )
                self._glyphs[key] = gid_s
                self.defs.append(f'<path id="{gid_s}" d="{d}"/>')
        return self._glyphs[key] or None

    def text(
        self,
        x: float,
        y: float,
        s: str,
        t: Type,
        ink: Ink,
        anchor: str = "start",
        cls: str = "",
        extra: str = "",
    ) -> float:
        """Set one line with its baseline at y. Returns the line's width in px."""
        f = face(t.face)
        glyphs = f.shape(s)
        track = t.tracking * f.upem
        width_u = sum(g[1] for g in glyphs) + track * max(0, len(glyphs) - 1)
        scale = t.size / f.upem
        width = width_u * scale
        if anchor == "middle":
            x -= width / 2
        elif anchor == "end":
            x -= width
        uses = []
        pen = 0.0
        if any(g[0] == 0 for g in glyphs):
            raise SystemExit(f"{f.key} has no glyph for a character in {s!r}")
        for gid, adv, xo, yo in glyphs:
            ref = self.glyph(f, gid)
            if ref:
                gx, gy = pen + xo, yo
                uses.append(
                    f'<use href="#{ref}" x="{round(gx)}"'
                    + (f' y="{round(gy)}"' if gy else "")
                    + "/>"
                )
            pen += adv + track
        g = (
            f'<g transform="translate({n(x)} {n(y)}) scale({scale:.5f} {-scale:.5f})" {ink.fill()}{extra}>'
            + "".join(uses)
            + "</g>"
        )
        # CSS animates transform, which would replace the placement above: a class gets its own group.
        self.body.append(f'<g class="{cls}">{g}</g>' if cls else g)
        return width

    def lines(
        self,
        x: float,
        y: float,
        rows: list[str],
        t: Type,
        ink: Ink,
        anchor: str = "start",
        cls: str = "",
    ) -> float:
        """Set several lines from a first baseline. Returns the last baseline."""
        step = t.size * t.leading
        for i, row in enumerate(rows):
            self.text(x, y + i * step, row, t, ink, anchor=anchor, cls=cls)
        return y + (len(rows) - 1) * step

    # Effects
    def shadow(
        self,
        id_: str,
        layers: list[tuple[float, float, float, float, Ink]],
        pad: float = 0.3,
    ) -> str:
        """Layered drop shadows, each (dx, dy, blur, spread, ink), like CSS box-shadow lists."""
        parts, merge = [], []
        for i, (dx, dy, blur, spread, ink) in enumerate(layers):
            src = "SourceAlpha"
            if spread:
                op = "dilate" if spread > 0 else "erode"
                parts.append(
                    f'<feMorphology in="SourceAlpha" operator="{op}" radius="{abs(spread):g}" result="m{i}"/>'
                )
                src = f"m{i}"
            parts.append(
                f'<feGaussianBlur in="{src}" stdDeviation="{blur / 2:g}" result="b{i}"/>'
                f'<feOffset in="b{i}" dx="{dx:g}" dy="{dy:g}" result="o{i}"/>'
                f'<feFlood flood-color="{ink.hex}" flood-opacity="{ink.a:g}"/>'
                f'<feComposite in2="o{i}" operator="in" result="s{i}"/>'
            )
            merge.append(f'<feMergeNode in="s{i}"/>')
        markup = (
            f'<filter id="{id_}" x="-{pad:g}" y="-{pad:g}" width="{1 + 2 * pad:g}" height="{1 + 2 * pad:g}" '
            f'color-interpolation-filters="sRGB">'
            + "".join(parts)
            + "<feMerge>"
            + "".join(merge)
            + '<feMergeNode in="SourceGraphic"/></feMerge></filter>'
        )
        return self.define(id_, markup)

    def render(self) -> str:
        css = "".join(self.css)
        head = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n(self.w)} {n(self.h)}" '
            f'width="{n(self.w)}" height="{n(self.h)}" role="img" aria-labelledby="t">'
            f'<title id="t">{escape(self.title)}</title>'
            + (f"<desc>{escape(self.desc)}</desc>" if self.desc else "")
        )
        style = f"<style>{css}{REDUCED_MOTION}</style>" if css else ""
        defs = f"<defs>{''.join(self.defs)}</defs>" if self.defs else ""
        return head + style + defs + "".join(self.body) + "</svg>\n"

    def save(self, path: Path) -> int:
        data = self.render()
        path.write_text(data)
        return len(data.encode())


# ── Pieces every image shares ──────────────────────────────────────────


def ring(d: str, ink: Ink, width: float = 1.0) -> str:
    """A hairline ring instead of a border: drawn on the shape's own outline."""
    return f'<path d="{d}" fill="none" {ink.stroke()} stroke-width="{width:g}"/>'


def card_shadow(doc: Doc, theme: Theme, id_: str = "card") -> str:
    """--shadow-card (light) or the hero window's contact shadow (dark)."""
    if theme.dark:
        return doc.shadow(
            id_,
            [(0, 12, 40, -4, Ink("#000000", 0.5)), (0, 4, 12, -2, Ink("#000000", 0.3))],
        )
    tint = Ink(_LIGHT_INK)
    return doc.shadow(
        id_,
        [
            (0, 0.5, 1.2, 0, tint.with_a(0.04)),
            (0, 2, 8, 0, tint.with_a(0.05)),
            (0, 8, 40, 0, tint.with_a(0.03)),
        ],
    )


def pill(
    doc: Doc,
    x: float,
    y: float,
    label: str,
    t: Type,
    theme: Theme,
    kind: str = "pod",
    pad_x: float = 12,
    h: float = 26,
) -> float:
    """A small pill ("Coming", "In development"): the hue at 14 % with its own ink. Returns its width."""
    f = face(t.face)
    w = f.width(label, t.size, t.tracking) + pad_x * 2
    if kind == "pod":
        bg, ink = theme.pod_glyph.with_a(0.16 if theme.dark else 0.12), theme.pod_ink
    else:
        bg, ink = theme.fill_strong, theme.ink2
    doc.add(f'<path d="{squircle(x, y, w, h, h / 2)}" {bg.fill()}/>')
    base = y + h / 2 + f.cap * t.size / f.upem / 2
    doc.text(x + pad_x, base, label, t, ink)
    return w


def mark(doc: Doc, x: float, y: float, height: float, ink: Ink, cls: str = "") -> float:
    """Pod's mark at a given height. Returns its width."""
    s = height / MARK_H
    p = f'<path transform="translate({n(x)} {n(y)}) scale({s:.4f})" d="{MARK_PATH}" fill-rule="evenodd" {ink.fill()}/>'
    doc.add(f'<g class="{cls}">{p}</g>' if cls else p)
    return MARK_W * s


def cap_middle(t: Type) -> float:
    """Distance from the baseline up to the middle of the capitals: for centring text on a line."""
    f = face(t.face)
    return f.cap * t.size / f.upem / 2
