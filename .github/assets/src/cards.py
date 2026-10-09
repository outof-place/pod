"""Why Pod: the bento of pod-site's Features, as one image (paper cards, the claude-acc field tile)."""

from __future__ import annotations

from dataclasses import dataclass

from house import (
    Doc,
    Ink,
    Theme,
    Type,
    cap_middle,
    card_shadow,
    face,
    oklch,
    pill,
    ring,
    sea,
    squircle,
    wrap,
)
from icons import icon

TITLE = ("Agents got fast.", "The tools around them didn't.")
LEAD = (
    "A fleet of agents works a Mac hard: terminals flood, subscriptions run dry, dev servers eat "
    "memory and builds pile up. Pod is made for that load."
)


@dataclass(frozen=True)
class Card:
    glyph: str
    title: str
    body: str
    tag: str = ""


TERMINAL = Card(
    "Console",
    "Native terminal",
    "Each pane runs Ghostty's engine in a native macOS view, drawn with Metal, while xterm.js "
    "stays behind as the model.",
    "0.1",
)
SEARCH = Card(
    "Search",
    "Indexed code search",
    "A native trigram index that agents query instead of walking the disk. Their grep answers "
    "from the index, with ripgrep as the fallback.",
    "Coming",
)
WORKSPACE = Card(
    "Branch",
    "Pod Workspace",
    "A managed ~/pod root for your repositories, with git tuned for many worktrees and the "
    "worktrees kept tidy.",
    "Coming",
)
VMS = Card(
    "Server",
    "OrbStack VMs",
    "Give an agent a clean Linux machine in OrbStack when a task should not touch your Mac.",
    "Coming",
)
PRIVACY = Card(
    "EyeSlash",
    "Zero telemetry",
    "Pod sends no telemetry and makes no calls to Stably's servers.",
    "0.1",
)
LEGEND = "0.1 marks what the first release brings; Coming, what follows it. Per-worktree setup via orca.yaml is inherited from Orca."
ACC_TITLE = "claude-acc, built in"
ACC_BODY = "The studio's toolkit for running many Claude Code agents on one Mac, now part of the IDE."
ACC_TAG = "0.1"
ACC_ITEMS = (
    (
        "Rotate",
        "Subscription rotation",
        "Moves to the next Claude subscription before one hits its limit.",
    ),
    (
        "Shield",
        "Dev-server memory guard",
        "Keeps the agents' dev servers from eating your memory.",
    ),
    (
        "Chip",
        "Memory-aware builds",
        "Holds heavy builds until there is memory free for them.",
    ),
    (
        "Broom",
        "Cleanup",
        "Clears what builds and installs leave behind, while nobody is using it.",
    ),
    ("Cup", "Stay awake", "Keeps the Mac awake until you say so, lid closed included."),
    ("Wind", "Fan control", "Spins the fans up before the chip gets hot."),
)


def _paper(
    doc: Doc, theme: Theme, x: float, y: float, w: float, h: float, r: float
) -> None:
    d = squircle(x, y, w, h, r)
    if theme.dark:
        doc.define(
            "tile",
            '<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">'
            + Ink(oklch(0.2, 0.014, 205)).stop(0)
            + Ink(oklch(0.135, 0.008, 205)).stop(1)
            + "</linearGradient>",
        )
        doc.add(f'<path d="{d}" fill="url(#tile)"/>')
        # A lit top edge: the tile's ring, brighter where the light falls.
        doc.define(
            "tile-rim",
            '<linearGradient id="tile-rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/>'
            '<stop offset=".35" stop-color="#fff" stop-opacity=".07"/><stop offset="1" stop-color="#fff" stop-opacity=".05"/></linearGradient>',
        )
        doc.add(
            f'<path d="{squircle(x + 0.5, y + 0.5, w - 1, h - 1, r - 0.5)}" fill="none" stroke="url(#tile-rim)"/>'
        )
    else:
        sh = card_shadow(doc, theme)
        doc.add(f'<path d="{d}" fill="#fff" filter="url(#{sh})"/>')
        doc.add(ring(squircle(x + 0.5, y + 0.5, w - 1, h - 1, r - 0.5), theme.hairline))


@dataclass(frozen=True)
class Scale:
    pad: float
    r: float
    glyph: float
    title: Type
    body: Type
    tag: Type
    h2: Type
    lead: Type
    acc_title: Type
    item_title: Type
    item_body: Type


WIDE = Scale(
    pad=32,
    r=28,
    glyph=30,
    title=Type("neue", 30, 1.2, -0.012),
    body=Type("suisse", 20, 1.45, -0.005),
    tag=Type("neue-medium", 15, tracking=-0.01),
    h2=Type("neue", 58, 1.1, -0.0227),
    lead=Type("suisse", 22, 1.42),
    acc_title=Type("neue", 40, 1.16, -0.022),
    item_title=Type("neue-medium", 20, 1.3),
    item_body=Type("suisse", 18, 1.45, -0.005),
)
NARROW = Scale(
    pad=36,
    r=28,
    glyph=36,
    title=Type("neue", 36, 1.2, -0.012),
    body=Type("suisse", 25, 1.45, -0.005),
    tag=Type("neue-medium", 19, tracking=-0.01),
    h2=Type("neue", 56, 1.1, -0.0227),
    lead=Type("suisse", 27, 1.42),
    acc_title=Type("neue", 44, 1.16, -0.022),
    item_title=Type("neue-medium", 25, 1.3),
    item_body=Type("suisse", 23, 1.45, -0.005),
)


def _tag(
    doc: Doc,
    theme: Theme,
    right: float,
    top: float,
    label: str,
    s: Scale,
    on_field: bool = False,
) -> None:
    f = face(s.tag.face)
    h = s.tag.size * 1.75
    w = f.width(label, s.tag.size, s.tag.tracking) + h * 0.9
    if on_field:
        doc.add(
            f'<path d="{squircle(right - w, top, w, h, h / 2)}" fill="#fff" fill-opacity=".14"/>'
        )
        doc.text(
            right - w + h * 0.45,
            top + h / 2 + cap_middle(s.tag),
            label,
            s.tag,
            Ink(oklch(0.958, 0.004, 91)),
        )
    else:
        pill(doc, right - w, top, label, s.tag, theme, kind="pod" if label == "Coming" else "neutral", pad_x=h * 0.45, h=h)


def _card(doc: Doc, theme: Theme, c: Card, x: float, y: float, w: float, h: float, s: Scale, lines: int = 0) -> None:
    """A paper card: glyph and tag at the top, title and body at the foot. `lines` aligns titles across a row."""
    _paper(doc, theme, x, y, w, h, s.r)
    icon(doc, c.glyph, x + s.pad, y + s.pad, s.glyph, theme.pod_glyph)
    if c.tag:
        _tag(doc, theme, x + w - s.pad, y + s.pad + (s.glyph - s.tag.size * 1.75) / 2, c.tag, s)
    rows = wrap(c.body, s.body, w - 2 * s.pad)
    step = s.body.size * s.body.leading
    first = y + h - s.pad - s.body.size * 0.28 - (max(lines, len(rows)) - 1) * step
    doc.lines(x + s.pad, first, rows, s.body, theme.ink2)
    doc.text(x + s.pad, first - step - s.title.size * 0.42, c.title, s.title, theme.ink)


def _row_lines(cards: tuple[Card, ...], w: float, s: Scale) -> int:
    return max(len(wrap(c.body, s.body, w - 2 * s.pad)) for c in cards)


def _acc(
    doc: Doc, theme: Theme, x: float, y: float, w: float, h: float, s: Scale, cols: int
) -> None:
    field = sea(0.34, 0.06)
    doc.define(
        "field",
        '<linearGradient id="field" x1="0" y1="0" x2=".6" y2="1">'
        + sea(0.38, 0.065).stop(0)
        + sea(0.34, 0.06).stop(0.45)
        + sea(0.27, 0.05).stop(1)
        + "</linearGradient>",
    )
    d = squircle(x, y, w, h, s.r)
    if not theme.dark:
        sh = card_shadow(doc, theme)
        doc.add(f'<path d="{d}" {field.fill()} filter="url(#{sh})"/>')
    doc.add(f'<path d="{d}" fill="url(#field)"/>')
    doc.add(
        ring(squircle(x + 0.5, y + 0.5, w - 1, h - 1, s.r - 0.5), Ink("#ffffff", 0.12))
    )
    ink = Ink(oklch(0.958, 0.004, 91))
    pad = s.pad * 1.25
    _tag(doc, theme, x + w - pad, y + pad + 4, ACC_TAG, s, on_field=True)
    doc.text(x + pad, y + pad + s.acc_title.size * 0.8, ACC_TITLE, s.acc_title, ink)
    rows = wrap(ACC_BODY, s.body, min(w - 2 * pad, s.body.size * 26))
    doc.lines(
        x + pad,
        y + pad + s.acc_title.size * 0.8 + s.body.size * 2.1,
        rows,
        s.body,
        ink.with_a(0.64),
    )
    gap = s.pad
    col_w = (w - 2 * pad - gap * (cols - 1)) / cols
    item_rows = (len(ACC_ITEMS) + cols - 1) // cols
    glyph = s.item_title.size * 1.15
    text_x = glyph + s.item_title.size * 0.7
    # Size each row by its tallest item, then stack the list from the tile's foot.
    heights = []
    for r in range(item_rows):
        tallest = 0
        for c in range(cols):
            i = r * cols + c
            if i >= len(ACC_ITEMS):
                continue
            lines = wrap(ACC_ITEMS[i][2], s.item_body, col_w - text_x)
            tallest = max(
                tallest,
                s.item_title.size * 1.9
                + len(lines) * s.item_body.size * s.item_body.leading,
            )
        heights.append(tallest + s.pad * 0.9)
    top = y + h - pad - sum(heights)
    for r in range(item_rows):
        for c in range(cols):
            i = r * cols + c
            if i >= len(ACC_ITEMS):
                continue
            glyph_name, title, body = ACC_ITEMS[i]
            ix = x + pad + c * (col_w + gap)
            iy = top + sum(heights[:r])
            doc.add(
                f'<path d="M{ix:.1f} {iy:.1f}h{col_w:.1f}" stroke="#fff" stroke-opacity=".14"/>'
            )
            icon(doc, glyph_name, ix, iy + s.item_title.size * 0.85, glyph, ink)
            base = iy + s.item_title.size * 0.85 + s.item_title.size * 0.92
            doc.text(ix + text_x, base, title, s.item_title, ink)
            lines = wrap(body, s.item_body, col_w - text_x)
            doc.lines(
                ix + text_x,
                base + s.item_body.size * 1.5,
                lines,
                s.item_body,
                ink.with_a(0.64),
            )


def _header(
    doc: Doc, theme: Theme, x: float, y: float, w: float, s: Scale, stacked: bool
) -> float:
    """The section's two-line headline, its second line receding, and the lead. Returns the bottom."""
    base = y + s.h2.size * 0.8
    doc.text(x, base, TITLE[0], s.h2, theme.ink)
    doc.text(x, base + s.h2.size * s.h2.leading, TITLE[1], s.h2, theme.ink3)
    bottom = base + s.h2.size * s.h2.leading
    if stacked:
        rows = wrap(LEAD, s.lead, w)
        first = bottom + s.lead.size * 2.2
        return doc.lines(x, first, rows, s.lead, theme.ink2) + s.lead.size * 0.5
    lead_w = s.lead.size * 21
    rows = wrap(LEAD, s.lead, lead_w)
    last = bottom
    doc.lines(
        x + w - lead_w,
        last - (len(rows) - 1) * s.lead.size * s.lead.leading,
        rows,
        s.lead,
        theme.ink2,
    )
    return bottom + s.h2.size * 0.25


def why(theme: Theme, narrow: bool = False) -> Doc:
    s = NARROW if narrow else WIDE
    m = 24
    if not narrow:
        W = 1280
        gap = 16
        col = (W - 2 * m - 2 * gap) / 3
        row = 300
        top = 0
        doc = Doc(W, 10, "Why Pod: agents got fast, the tools around them didn't", LEAD)
        hb = _header(doc, theme, m, m + 8, W - 2 * m, s, stacked=False)
        top = hb + 48
        _card(doc, theme, TERMINAL, m, top, col, row, s)
        _acc(doc, theme, m + col + gap, top, 2 * col + gap, 2 * row + gap, s, cols=2)
        _card(doc, theme, SEARCH, m, top + row + gap, col, row, s)
        y3 = top + 2 * (row + gap)
        last_row = (WORKSPACE, VMS, PRIVACY)
        for i, c in enumerate(last_row):
            _card(doc, theme, c, m + i * (col + gap), y3, col, row, s, lines=_row_lines(last_row, col, s))
        doc.text(m, y3 + row + 44, LEGEND, s.item_body, theme.ink3)
        doc.h = y3 + row + 44 + m
    else:
        W = 720
        cw = W - 2 * m
        gap = 20
        doc = Doc(W, 10, "Why Pod: agents got fast, the tools around them didn't", LEAD)
        y = _header(doc, theme, m, m + 8, cw, s, stacked=True) + 52
        row = 330
        _card(doc, theme, TERMINAL, m, y, cw, row, s)
        y += row + gap
        acc_h = 1150
        _acc(doc, theme, m, y, cw, acc_h, s, cols=1)
        y += acc_h + gap
        for c in (SEARCH, WORKSPACE, VMS, PRIVACY):
            _card(doc, theme, c, m, y, cw, row, s)
            y += row + gap
        y = doc.lines(m, y + s.item_body.size * 1.4, wrap(LEGEND, s.item_body, cw), s.item_body, theme.ink3)
        doc.h = y + m
    return doc


# ── claude-acc, its own section ────────────────────────────────────────

ACC_HEAD = ("The machine, looked after.", "claude-acc is part of Pod.")
ACC_LEAD = (
    "claude-acc began as the studio's toolkit for running many Claude Code agents on one Mac. "
    "Pod now carries it inside the app and sets it up for you."
)
ACC_FEATURES = (
    Card("Rotate", "Subscription rotation", "Moves running Claude Code sessions to the account with the most headroom before one hits its limit, with no restart and no /login."),
    Card("Shield", "Dev-server memory cap", "Watches each dev server's real memory against a budget, restarts a bloated one in its own terminal and turns away a duplicate."),
    Card("Chip", "Memory-aware builds", "Holds a heavy build until there is memory for it, lets small jobs overtake, and pauses the youngest when swap grows."),
    Card("Bolt", "Ultra", "One switch that tunes the Mac for agent work, measures each change before and after, and puts it all back when off."),
    Card("Broom", "Janitor", "Clears what builds and installs bring back, like .next, .turbo and stale node_modules, while nobody is using it."),
    Card("Cup", "Stay awake", "Awake until you say so or for a few hours, lid closed included, and on by itself on an iPhone hotspot."),
    Card("Wind", "Fans", "Auto, 50 %, 75 % or Max, full speed when a chip runs hot, and never fighting another fan app."),
    Card("MenuBar", "Menu bar helper", "Every account, dev server, build and switch in one panel, a click away from the menu bar."),
)


def _feature(doc: Doc, theme: Theme, c: Card, x: float, y: float, w: float, h: float, s: Scale) -> None:
    """A compact card read top down: glyph, title, body."""
    _paper(doc, theme, x, y, w, h, s.r)
    icon(doc, c.glyph, x + s.pad, y + s.pad, s.glyph, theme.pod_glyph)
    ty = y + s.pad + s.glyph + s.title.size * 1.25
    t_title, t_body = _feature_types(s)
    doc.text(x + s.pad, ty, c.title, t_title, theme.ink)
    doc.lines(x + s.pad, ty + t_body.size * 1.6, wrap(c.body, t_body, w - 2 * s.pad), t_body, theme.ink2)


def _feature_types(s: Scale) -> tuple[Type, Type]:
    return Type("neue-medium", s.item_title.size * 1.1, 1.3), Type("suisse", s.item_body.size * 1.06, 1.45, -0.005)


def acc_grid(theme: Theme, narrow: bool = False) -> Doc:
    s = NARROW if narrow else WIDE
    m = 24
    W = 720 if narrow else 1280
    doc = Doc(W, 10, "claude-acc is part of Pod: subscription rotation, dev-server memory cap, memory-aware builds, Ultra, janitor, stay awake, fans and the menu bar helper", ACC_LEAD)
    base = m + 8 + s.h2.size * 0.8
    doc.text(m, base, ACC_HEAD[0], s.h2, theme.ink)
    doc.text(m, base + s.h2.size * s.h2.leading, ACC_HEAD[1], s.h2, theme.ink3)
    bottom = base + s.h2.size * s.h2.leading
    if narrow:
        y = doc.lines(m, bottom + s.lead.size * 2.2, wrap(ACC_LEAD, s.lead, W - 2 * m), s.lead, theme.ink2) + 52
        cols, gap = 1, 20
    else:
        lead_w = s.lead.size * 21
        rows = wrap(ACC_LEAD, s.lead, lead_w)
        doc.lines(W - m - lead_w, bottom - (len(rows) - 1) * s.lead.size * s.lead.leading, rows, s.lead, theme.ink2)
        y = bottom + s.h2.size * 0.25 + 48
        cols, gap = 4, 16
    cw = (W - 2 * m - gap * (cols - 1)) / cols
    t_title, t_body = _feature_types(s)
    need = max(len(wrap(c.body, t_body, cw - 2 * s.pad)) for c in ACC_FEATURES)
    ch = s.pad * 2 + s.glyph + s.title.size * 1.25 + t_body.size * 1.6 + (need - 1) * t_body.size * t_body.leading + t_body.size * 0.4
    for i, c in enumerate(ACC_FEATURES):
        _feature(doc, theme, c, m + (i % cols) * (cw + gap), y + (i // cols) * (ch + gap), cw, ch, s)
    doc.h = y + ((len(ACC_FEATURES) + cols - 1) // cols) * (ch + gap) - gap + m
    return doc
