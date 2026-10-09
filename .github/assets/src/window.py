"""
The screenshot slot: until Pod ships, an illustration of its window (pod-site
components/home/WindowMock.tsx): four agents in their own worktrees and
claude-acc at the foot. The README captions it as an illustration.
"""

from __future__ import annotations

from dataclasses import dataclass

from icons import icon

from house import (
    EASE_IN_OUT,
    Doc,
    Ink,
    Theme,
    Type,
    cap_middle,
    oklch,
    ring,
    sea,
    squircle,
)


@dataclass(frozen=True)
class Pane:
    branch: str
    agent: str
    status: str  # working | review | done
    lines: tuple[tuple[str, str], ...]  # (tone, text): prompt | ok | dim | ""
    active: bool = False


PANES = (
    Pane(
        "feat/search-index",
        "claude",
        "working",
        (
            ("prompt", "> Add a trigram index to the search panel"),
            ("dim", "Read src/search/index.ts"),
            ("", "Edit src/search/trigram.ts"),
            ("dim", "Run pnpm test search"),
            ("ok", "✓ tests passed"),
        ),
    ),
    Pane(
        "fix/checkout-retry",
        "codex",
        "review",
        (
            ("prompt", "> Stop the double charge on a retry"),
            ("dim", "The webhook and the retry both confirm it."),
            ("", "Guard the transition on the payment's state."),
            ("ok", "Ready for your review."),
        ),
    ),
    Pane(
        "chore/next-upgrade",
        "claude",
        "done",
        (
            ("prompt", "> Upgrade Next and fix the build"),
            ("dim", "pnpm build"),
            ("ok", "✓ Compiled"),
            ("", "Opened a pull request."),
        ),
    ),
    Pane(
        "feat/pl-pricing",
        "claude",
        "working",
        (
            ("prompt", "> Translate the pricing page into Polish"),
            ("", "Edit messages/pl.json"),
            ("dim", "Check the non-breaking spaces"),
        ),
        active=True,
    ),
)

LABELS = {"working": "working", "review": "needs review", "done": "done"}

CSS = f"""
.caret{{animation:caret 1.1s steps(1) infinite}}
@keyframes caret{{50%{{opacity:0}}}}
.pulse{{transform-box:fill-box;transform-origin:center;animation:pulse 1.6s {EASE_IN_OUT} infinite}}
@keyframes pulse{{50%{{opacity:.35}}}}
"""


def window(theme: Theme, narrow: bool = False) -> Doc:
    W = 720 if narrow else 1280
    k = 1.3 if narrow else 1.0  # type scale for the phone layout
    mono = Type("mono", 15.5 * k, 1.62)
    cap_t = Type("suisse", 14 * k, 1.3)
    side_t = Type("mono", 14.5 * k)
    title_t = Type("suisse", 14 * k)
    bar_h, foot_h = 44 * k, 36 * k
    panes = PANES[:2] if narrow else PANES
    pane_h = (196 if narrow else 216) * k
    # Room for the shadow to fade out inside the image: a cut shadow reads as a grey box.
    mx, mt, mb = (28, 16, 56) if narrow else (56, 24, 96)
    win_x, win_y, win_w = mx, mt, W - 2 * mx
    side_w = 0 if narrow else 248
    gap = 8
    cols = 1 if narrow else 2
    rows = (len(panes) + cols - 1) // cols
    body_h = rows * pane_h + (rows + 1) * gap
    win_h = bar_h + body_h + foot_h
    H = win_y + win_h + mb
    doc = Doc(
        W,
        H,
        "Illustration of the Pod window: four agents at work in their own worktrees, with claude-acc's status at the foot",
    )
    doc.style(CSS)
    dark_ink = Ink(oklch(0.958, 0.004, 91))
    ink2, ink3 = dark_ink.with_a(0.64), dark_ink.with_a(0.42)
    ok, busy, glyph = (
        Ink(oklch(0.72, 0.15, 150)),
        Ink(oklch(0.8, 0.14, 80)),
        Ink(oklch(0.8, 0.1, 205)),
    )
    dot = {"working": glyph, "review": busy, "done": ok}
    tone = {"prompt": dark_ink, "ok": ok, "dim": ink3, "": ink2}
    r = 22 if narrow else 28

    layers = [(0, 4, 12, -2, Ink("#000000", 0.4 if theme.dark else 0.08))]
    layers.append((0, 28, 64, -12, sea(0.46, 0.06, 0.4)) if theme.dark else (0, 24, 56, -16, Ink(oklch(0.173, 0.013, 264), 0.22)))
    shadow = doc.shadow("win", layers, pad=0.25)
    frame = squircle(win_x, win_y, win_w, win_h, r)
    doc.define("win-clip", f'<clipPath id="win-clip"><path d="{frame}"/></clipPath>')
    doc.add(
        f'<path d="{frame}" fill="{oklch(0.14, 0.006, 205)}" filter="url(#{shadow})"/>'
    )
    doc.add('<g clip-path="url(#win-clip)">')
    # Title bar
    doc.add(
        f'<rect x="{win_x}" y="{win_y}" width="{win_w}" height="{bar_h}" fill="{oklch(0.17, 0.006, 205)}"/>'
    )
    doc.add(
        f'<path d="M{win_x} {win_y + bar_h - 0.5}h{win_w}" stroke="#fff" stroke-opacity=".06"/>'
    )
    for i, c in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        doc.add(
            f'<circle cx="{win_x + 20 * k + i * 20 * k:.1f}" cy="{win_y + bar_h / 2:.1f}" r="{6 * k:.1f}" fill="{c}"/>'
        )
    doc.text(
        win_x + win_w / 2,
        win_y + bar_h / 2 + cap_middle(title_t),
        "Pod · portivo-app",
        title_t,
        ink3,
        anchor="middle",
    )
    top = win_y + bar_h
    # Worktrees
    if side_w:
        doc.add(
            f'<rect x="{win_x}" y="{top}" width="{side_w}" height="{body_h}" fill="{oklch(0.12, 0.006, 205)}"/>'
        )
        doc.add(
            f'<path d="M{win_x + side_w - 0.5} {top}v{body_h}" stroke="#fff" stroke-opacity=".06"/>'
        )
        doc.text(win_x + 20, top + 32, "Worktrees", cap_t, ink3)
        for i, p in enumerate(PANES):
            iy = top + 52 + i * 62
            if p.active:
                doc.add(
                    f'<path d="{squircle(win_x + 10, iy, side_w - 20, 54, 13)}" fill="#fff" fill-opacity=".07"/>'
                )
            cls = "pulse" if p.status == "working" else ""
            doc.add(
                f'<circle class="{cls}" cx="{win_x + 26}" cy="{iy + 20}" r="3.5" {dot[p.status].fill()}/>'
            )
            doc.text(
                win_x + 38, iy + 20 + cap_middle(side_t), p.branch, side_t, dark_ink
            )
            doc.text(
                win_x + 38, iy + 42, f"{p.agent} · {LABELS[p.status]}", cap_t, ink3
            )
    # Panes
    grid_x = win_x + side_w + gap
    pane_w = (win_w - side_w - gap * (cols + 1)) / cols
    for i, p in enumerate(panes):
        c, rr = i % cols, i // cols
        px, py = grid_x + c * (pane_w + gap), top + gap + rr * (pane_h + gap)
        pd = squircle(px, py, pane_w, pane_h, 13)
        doc.add(f'<path d="{pd}" fill="{oklch(0.115, 0.006, 205)}"/>')
        doc.add(
            ring(
                squircle(px + 0.5, py + 0.5, pane_w - 1, pane_h - 1, 12.5),
                Ink(oklch(0.8, 0.1, 205), 0.5) if p.active else Ink("#ffffff", 0.06),
            )
        )
        cls = "pulse" if p.status == "working" else ""
        hy = py + 26 * k
        doc.add(
            f'<circle class="{cls}" cx="{px + 22 * k:.1f}" cy="{hy - cap_middle(mono):.1f}" r="{3.5 * k:.1f}" {dot[p.status].fill()}/>'
        )
        doc.text(px + 34 * k, hy, f"{p.branch} · {p.agent}", mono, ink3)
        ly = hy + 38 * k
        lines = p.lines if not narrow else p.lines[:4]
        for j, (t, s) in enumerate(lines):
            lx, by = px + 22 * k, ly + j * mono.size * mono.leading
            if s.startswith("✓ "):
                # The mono subset has no check mark: the icon set's, at the cell's size.
                icon(doc, "Check", lx - mono.size * 0.12, by - mono.size * 0.92, mono.size * 1.1, tone[t])
                lx, s = lx + mono.size * 1.2, s[2:]
            doc.text(lx, by, s, mono, tone[t])
        if p.active or (narrow and i == len(panes) - 1):
            cy = ly + len(lines) * mono.size * mono.leading
            doc.add(
                f'<rect class="caret" x="{px + 22 * k:.1f}" y="{cy - mono.size * 0.82:.1f}" width="{mono.size * 0.6:.1f}" height="{mono.size * 1.05:.1f}" {dark_ink.fill()}/>'
            )
    # claude-acc in the status bar
    fy = top + body_h
    doc.add(
        f'<rect x="{win_x}" y="{fy}" width="{win_w}" height="{foot_h}" fill="{oklch(0.17, 0.006, 205)}"/>'
    )
    doc.add(
        f'<path d="M{win_x} {fy + 0.5}h{win_w}" stroke="#fff" stroke-opacity=".06"/>'
    )
    base = fy + foot_h / 2 + cap_middle(cap_t)
    x = win_x + 20 * k
    doc.add(
        f'<circle cx="{x + 3 * k:.1f}" cy="{fy + foot_h / 2:.1f}" r="{3.5 * k:.1f}" {ok.fill()}/>'
    )
    x += 14 * k
    items = (
        ["Account 2 of 3", "Memory guard on", "1 build queued"]
        if not narrow
        else ["Account 2 of 3", "Memory guard on"]
    )
    for s in items:
        x += doc.text(x, base, s, cap_t, ink3) + 26 * k
    if not narrow:
        doc.text(win_x + win_w - 20, base, "Awake", cap_t, ink3, anchor="end")
    doc.add("</g>")
    doc.add(
        ring(
            squircle(win_x + 0.5, win_y + 0.5, win_w - 1, win_h - 1, r - 0.5),
            Ink("#ffffff", 0.1),
        )
    )
    return doc
