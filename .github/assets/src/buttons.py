"""
The install calls under the hero, as images (a README can't style a link).
release.json says what can be installed today, like pod-site content/release.ts:
flip a channel to "live" the day it ships and rebuild; the README keeps its links.
"""

from __future__ import annotations

import json
from pathlib import Path

from house import Doc, Ink, Theme, Type, cap_middle, face, squircle
from icons import icon

RELEASE = json.loads((Path(__file__).parent / "release.json").read_text())
BREW = "brew install --cask outof-place/tap/pod"

H = 48
LABEL = Type("neue-medium", 16)
MONO = Type("mono", 14.5)
CHIP = Type("neue-medium", 12.5, tracking=-0.01)


def _chip(doc: Doc, x: float, label: str, bg: Ink, ink: Ink) -> float:
    h = 24
    w = face(CHIP.face).width(label, CHIP.size, CHIP.tracking) + 20
    doc.add(f'<path d="{squircle(x, (H - h) / 2, w, h, h / 2)}" {bg.fill()}/>')
    doc.text(x + 10, H / 2 + cap_middle(CHIP), label, CHIP, ink)
    return w


def _button(
    theme: Theme,
    title: str,
    label: str,
    t: Type,
    glyph: str | None,
    primary: bool,
    coming: bool,
    trail: str | None = None,
    prompt: str = "",
) -> Doc:
    f = face(t.face)
    pad = 22
    glyph_w = 20 if glyph else 0
    gap = 10
    prompt_w = face(MONO.face).width(prompt + " ", MONO.size) if prompt else 0
    label_w = f.width(label, t.size, t.tracking)
    chip_w = (
        face(CHIP.face).width("Coming", CHIP.size, CHIP.tracking) + 20 if coming else 0
    )
    trail_w = 16 if trail else 0
    w = (
        pad
        + (glyph_w + gap if glyph else 0)
        + prompt_w
        + label_w
        + (12 + chip_w if coming else 0)
        + (8 + trail_w if trail else 0)
        + pad
        - (4 if coming else 0)
    )
    doc = Doc(w, H, title + (" (coming with the first release)" if coming else ""))
    d = squircle(0.5, 0.5, w - 1, H - 1, (H - 1) / 2)
    if primary:
        fill = theme.ink
        text = theme.inv
        chip_bg, chip_ink = (
            (Ink("#000000", 0.1), theme.inv.with_a(0.72))
            if theme.dark
            else (Ink("#ffffff", 0.16), theme.inv.with_a(0.8))
        )
        doc.add(f'<path d="{d}" {fill.fill()}/>')
    else:
        text = theme.ink
        chip_bg, chip_ink = (
            theme.pod_glyph.with_a(0.16 if theme.dark else 0.12),
            theme.pod_ink,
        )
        doc.add(f'<path d="{d}" {theme.fill.fill()}/>')
        doc.add(f'<path d="{d}" fill="none" {theme.hairline_strong.stroke()}/>')
    x = pad
    if glyph:
        icon(doc, glyph, x, (H - 20) / 2, 20, text)
        x += glyph_w + gap
    if prompt:
        doc.text(x, H / 2 + cap_middle(MONO), prompt, MONO, text.with_a(0.45))
        x += prompt_w
    doc.text(x, H / 2 + cap_middle(t), label, t, text)
    x += label_w
    if coming:
        x += 12
        x += _chip(doc, x, "Coming", chip_bg, chip_ink)
    if trail:
        icon(doc, trail, x + 8, (H - 16) / 2, 16, text.with_a(0.64))
    return doc


def buttons(theme: Theme) -> dict[str, Doc]:
    return {
        "button-download": _button(
            theme,
            "Download Pod for macOS",
            "Download for macOS",
            LABEL,
            "Download",
            primary=True,
            coming=RELEASE["dmg"] != "live",
        ),
        "button-brew": _button(
            theme, "Install with Homebrew", "Install with Homebrew", LABEL, "Cup", primary=False, coming=RELEASE["cask"] != "live"
        ),
        "button-site": _button(
            theme,
            "pod.codes",
            "pod.codes",
            LABEL,
            "Globe",
            primary=False,
            coming=RELEASE["site"] != "live",
            trail="ArrowUpRightGlyph",
        ),
    }

