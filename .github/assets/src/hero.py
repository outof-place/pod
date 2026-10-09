"""The README's opening: the black stage with Pod's wordmark, the claim and the pod in the sea."""

from __future__ import annotations

import math

from house import (
    EASE_IN_OUT,
    EASE_OUT,
    MARK_PEAS,
    MARK_W,
    Doc,
    Ink,
    Theme,
    Type,
    cap_middle,
    face,
    mark,
    n,
    oklch,
    ring,
    sea,
    squircle,
    wrap,
)

CLAIM = ("The agent-fleet IDE", "for macOS.")
LEAD = (
    "Run a fleet of coding agents side by side in a native terminal, with your "
    "subscriptions, memory and builds looked after. Built on Orca, by the outofplace studio."
)

HERO_CSS = f"""
.rise{{animation:rise 1s {EASE_OUT} both}}
.d1{{animation-delay:.08s}}.d2{{animation-delay:.16s}}.d3{{animation-delay:.24s}}
@keyframes rise{{from{{opacity:0;transform:translateY(14px)}}}}
.drift{{animation:drift 18s {EASE_IN_OUT} infinite alternate}}
@keyframes drift{{from{{transform:translate(-300px,-60px)}}to{{transform:translate(240px,80px)}}}}
.pea{{transform-box:fill-box;transform-origin:center;animation:pea 3.6s {EASE_IN_OUT} infinite}}
.p2{{animation-delay:1.2s}}.p3{{animation-delay:2.4s}}
@keyframes pea{{0%,100%{{opacity:.7}}25%{{opacity:1}}}}
.ping{{transform-box:fill-box;transform-origin:center;opacity:0;animation:ping 3.6s {EASE_OUT} infinite}}
.q2{{animation-delay:1.2s}}.q3{{animation-delay:2.4s}}
@keyframes ping{{0%{{opacity:.5;transform:scale(1)}}80%,100%{{opacity:0;transform:scale(2.6)}}}}
.swim{{animation:swim 10s {EASE_IN_OUT} infinite alternate}}
@keyframes swim{{from{{transform:translate(-4px,5px)}}to{{transform:translate(5px,-6px)}}}}
.wk{{animation:wk 2.8s {EASE_IN_OUT} infinite}}
@keyframes wk{{0%,100%{{opacity:.35}}40%{{opacity:1}}}}
"""

_LIT = oklch(0.86, 0.06, 205)


def _cubic(p0, p1, p2, p3, t):
    u = 1 - t
    return (
        u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
        u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
    )


def _profile(p0, p1, p2, p3):
    pts = [_cubic(p0, p1, p2, p3, i / 400) for i in range(401)]
    pts.sort()

    def at(x):
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            if x0 <= x <= x1:
                return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
        return None

    return at


# The lens of lib/mark.ts as two curves, in mark units.
_TOP = _profile((1.5, 13), (7.6, 1.5), (32.4, 1.5), (38.5, 13))
_BOTTOM = _profile((38.5, 13), (32.4, 20), (7.6, 20), (1.5, 13))


def _stage_art(
    doc: Doc,
    x: float,
    y: float,
    w: float,
    h: float,
    r: float,
    light_at: tuple[float, float],
) -> None:
    """Black canvas, the sea's light from one corner and the dotted sea under it (pod-site sea-light, sea-dots)."""
    clip = doc.define(
        "stage",
        f'<clipPath id="stage"><path d="{squircle(x, y, w, h, r)}"/></clipPath>',
    )
    lx, ly = x + w * light_at[0], y + h * light_at[1]

    def radial(id_, cx, cy, rx, ry, stops):
        doc.define(
            id_,
            f'<radialGradient id="{id_}" gradientUnits="userSpaceOnUse" cx="{n(cx)}" cy="{n(cy)}" r="{n(rx)}" '
            f'gradientTransform="translate({n(cx)} {n(cy)}) scale(1 {ry / rx:.4f}) translate({n(-cx)} {n(-cy)})">'
            + stops
            + "</radialGradient>",
        )

    radial(
        "sea-light",
        lx,
        ly,
        w * 0.62,
        w * 0.48,
        sea(0.46).stop(0, 0.55)
        + sea(0.34).stop(0.34, 0.32)
        + sea(0.24).stop(0.58, 0.12)
        + Ink("#000000").stop(0.82, 0),
    )
    radial(
        "sea-low",
        x + w * 0.12,
        y + h,
        w * 0.5,
        w * 0.33,
        sea(0.24).stop(0, 0.4) + Ink("#000000").stop(0.7, 0),
    )
    doc.define(
        "dots",
        '<pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse">'
        f'<circle cx="8" cy="8" r="1.1" fill="{oklch(0.8, 0.05, 205)}"/></pattern>',
    )
    radial(
        "dots-fade",
        lx,
        ly,
        w * 0.56,
        w * 0.5,
        '<stop offset="0" stop-color="#fff" stop-opacity=".46"/><stop offset=".4" stop-color="#fff" stop-opacity=".22"/>'
        '<stop offset=".75" stop-color="#fff" stop-opacity="0"/>',
    )
    box = f'x="{n(x)}" y="{n(y)}" width="{n(w)}" height="{n(h)}"'
    doc.define(
        "dots-mask",
        f'<mask id="dots-mask" maskUnits="userSpaceOnUse" {box}><rect {box} fill="url(#dots-fade)"/></mask>',
    )
    # A slow swell of light moving over the sea: only the dots under it brighten.
    doc.define(
        "swell",
        '<radialGradient id="swell"><stop offset="0" stop-color="#fff" stop-opacity=".8"/>'
        '<stop offset=".55" stop-color="#fff" stop-opacity=".2"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>',
    )
    doc.define(
        "swell-mask",
        f'<mask id="swell-mask" maskUnits="userSpaceOnUse" {box}><g class="drift">'
        f'<ellipse cx="{n(lx - w * 0.1)}" cy="{n(ly + h * 0.42)}" rx="{n(w * 0.2)}" ry="{n(h * 0.32)}" fill="url(#swell)"/></g></mask>',
    )
    doc.add(
        f'<g clip-path="url(#{clip})">'
        f'<rect {box} fill="#000"/><rect {box} fill="url(#sea-light)"/><rect {box} fill="url(#sea-low)"/>'
        f'<rect {box} fill="url(#dots)" mask="url(#dots-mask)"/>'
        f'<rect {box} fill="url(#dots)" mask="url(#swell-mask)" opacity=".85"/>'
        "</g>"
    )


def _pod(
    doc: Doc,
    cx: float,
    cy: float,
    width: float,
    tilt: float = 9,
    wake: float = 320,
    clip: str = "stage",
) -> None:
    """
    The mark drawn by the sea: a halftone lens lit from above, three lit peas
    (the agents) pinging in turn, and a Kelvin wake (19.47 degrees) behind it,
    so it swims towards the headline.
    """
    k = width / (MARK_W - 3)
    ox, oy = -20 * k, -11.5 * k
    g = 10.0
    dots = []
    lx, ly = 14, 4.5  # the light, in mark units
    for j in range(int(24 * k / (g * 0.866)) + 2):
        py_ = j * g * 0.866
        for i in range(int(MARK_W * k / g) + 2):
            px_ = i * g + (g / 2 if j % 2 else 0)
            mx, my = (px_) / k, (py_) / k + 1.5
            top, bottom = _TOP(mx), _BOTTOM(mx)
            if top is None or bottom is None or not (top + 0.35 < my < bottom - 0.35):
                continue
            if any(math.hypot(mx - ex, my - ey) < 3 + 0.9 for ex, ey in MARK_PEAS):
                continue
            d = math.hypot((mx - lx) / 1.7, (my - ly) * 1.1)
            near = min(math.hypot(mx - ex, my - ey) for ex, ey in MARK_PEAS) - 3
            b = max(0.0, min(1.0, 1.12 - d / 17 + 0.42 * math.exp(-near / 1.6)))
            rr = 0.7 + 2.9 * b**1.2
            dots.append(
                f'<circle cx="{n(ox + px_)}" cy="{n(oy + py_ + 1.5 * k)}" r="{rr:.2f}" fill-opacity="{0.22 + 0.78 * b:.2f}"/>'
            )
    lens_k = f'transform="translate({n(ox)} {n(oy)}) scale({k:.4f})"'
    doc.define(
        "pea-glow",
        '<radialGradient id="pea-glow">'
        + sea(0.82, 0.1).stop(0, 0.5)
        + sea(0.6, 0.08).stop(0.42, 0.14)
        + sea(0.4).stop(1, 0)
        + "</radialGradient>",
    )
    parts = [
        f'<g clip-path="url(#{clip})"><g transform="translate({n(cx)} {n(cy)}) rotate({tilt:g})">'
    ]

    # Wake: two arms from the tail, a dot every 20 px, each lighting in turn.
    tail = (ox + 38.5 * k, oy + 13 * k)
    arms = []
    for sign in (-1, 1):
        ang = math.radians(sign * 19.47)
        steps = int(wake / 20)
        for s in range(1, steps + 1):
            dist = s * 20
            fade = (1 - s / (steps + 1)) ** 1.3
            wx, wy = tail[0] + math.cos(ang) * dist, tail[1] + math.sin(ang) * dist
            arms.append(
                f'<circle class="wk" style="animation-delay:{s * 0.11:.2f}s" cx="{n(wx)}" cy="{n(wy)}" r="{0.8 + 1.6 * fade:.2f}" fill-opacity="{0.15 + 0.55 * fade:.2f}"/>'
            )
    parts.append(f'<g fill="{_LIT}">{"".join(arms)}</g>')
    parts.append('<g class="swim">')
    parts.append(
        f'<path {lens_k} d="M1.5 13C7.6 1.5 32.4 1.5 38.5 13 32.4 20 7.6 20 1.5 13Z" fill="{oklch(0.3, 0.05, 205)}" fill-opacity=".28"/>'
    )
    parts.append(f'<g fill="{_LIT}">{"".join(dots)}</g>')
    parts.append(
        f'<path {lens_k} d="M1.5 13C7.6 1.5 32.4 1.5 38.5 13 32.4 20 7.6 20 1.5 13Z" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="{1 / k:.4f}"/>'
    )
    pr = 3 * k
    for i, (px, py) in enumerate(MARK_PEAS, start=1):
        gx, gy = ox + px * k, oy + (py + 1.5) * k
        parts.append(
            f'<circle class="pea p{i}" cx="{n(gx)}" cy="{n(gy)}" r="{n(pr * 2.4)}" fill="url(#pea-glow)"/>'
        )
        parts.append(
            f'<circle class="ping q{i}" cx="{n(gx)}" cy="{n(gy)}" r="{n(pr)}" fill="none" stroke="{_LIT}" stroke-width="1.2"/>'
        )
        parts.append(
            f'<circle class="pea p{i}" cx="{n(gx)}" cy="{n(gy)}" r="{n(pr)}" fill="{oklch(0.84, 0.09, 205)}"/>'
        )
    parts.append("</g></g></g>")
    doc.add("".join(parts))


def _badge(doc: Doc, x: float, y: float, scale: float = 1.0) -> None:
    """The hero pill (pod-site Hero): an ink chip and its text. No arrow: in an image it links nowhere."""
    h = 40 * scale
    chip_t = Type("neue-medium", 15 * scale, tracking=-0.01)
    text_t = Type("suisse", 17 * scale, tracking=-0.0167)
    chip_w = (
        face(chip_t.face).width("Open source", chip_t.size, chip_t.tracking)
        + 24 * scale
    )
    text_w = face(text_t.face).width("Free and MIT", text_t.size, text_t.tracking)
    w = 4 * scale + chip_w + 12 * scale + text_w + 16 * scale
    ink = Ink(oklch(0.958, 0.004, 91))
    doc.add('<g class="rise">')
    doc.add(f'<path d="{squircle(x, y, w, h, h / 2)}" fill="#fff" fill-opacity=".07"/>')
    doc.add(
        f'<path d="{squircle(x + 4 * scale, y + 4 * scale, chip_w, h - 8 * scale, (h - 8 * scale) / 2)}" {ink.fill()}/>'
    )
    doc.text(
        x + 16 * scale,
        y + h / 2 + cap_middle(chip_t),
        "Open source",
        chip_t,
        Ink("#000000"),
    )
    tx = x + 4 * scale + chip_w + 12 * scale
    doc.text(
        tx, y + h / 2 + cap_middle(text_t), "Free and MIT", text_t, ink.with_a(0.64)
    )
    doc.add("</g>")


def _wordmark(doc: Doc, left: float, base: float, size: float, ink: Ink) -> None:
    t = Type("neue-medium", size, tracking=-0.035)
    mh = size * 0.5
    cap = face(t.face).cap * size / face(t.face).upem
    mark(doc, left, base - cap / 2 - mh * 0.54, mh, ink, cls="rise d1")
    doc.text(left + MARK_W * mh / 24 + size * 0.14, base, "Pod", t, ink, cls="rise d1")


def hero(theme: Theme, narrow: bool = False) -> Doc:
    W, H = (800, 1120) if narrow else (1600, 800)
    doc = Doc(W, H, "Pod: the agent-fleet IDE for macOS", LEAD)
    doc.style(HERO_CSS)
    m = 16
    x, y, w, h = m, m, W - 2 * m, H - 2 * m
    r = 48 if narrow else 56
    _stage_art(doc, x, y, w, h, r, light_at=(0.7, 0.04) if narrow else (0.8, 0.06))
    ink = Ink(oklch(0.958, 0.004, 91))
    claim_t = Type("neue", 62 if narrow else 64, leading=1.04, tracking=-0.0219)
    lead_t = Type("suisse", 28 if narrow else 24, leading=1.42)

    if narrow:
        left = x + 56
        _badge(doc, left, y + 64, scale=1.25)
        _pod(doc, x + w * 0.46, y + 320, 520, tilt=9, wake=260)
        base = y + 640
        _wordmark(doc, left, base, 150, ink)
        cy = base + 108
        lead_w = w - 112
    else:
        left = x + 104
        _badge(doc, left, y + 96)
        _pod(doc, x + w * 0.7, y + h * 0.47, 600, tilt=9, wake=360)
        base = y + 372
        _wordmark(doc, left, base, 184, ink)
        cy = base + 116
        lead_w = 640

    doc.text(left, cy, CLAIM[0], claim_t, ink, cls="rise d2")
    doc.text(
        left,
        cy + claim_t.size * claim_t.leading,
        CLAIM[1],
        claim_t,
        ink.with_a(0.54),
        cls="rise d2",
    )
    rows = wrap(LEAD, lead_t, lead_w)
    doc.lines(
        left,
        cy + claim_t.size * claim_t.leading + 76,
        rows,
        lead_t,
        ink.with_a(0.64),
        cls="rise d3",
    )
    doc.add(
        ring(
            squircle(x + 0.5, y + 0.5, w - 1, h - 1, r - 0.5),
            Ink("#ffffff", 0.1) if theme.dark else Ink("#000000", 0.08),
        )
    )
    return doc
