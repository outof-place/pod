"""
How it works: the three architecture diagrams. Orca's own parts are drawn
neutral and what Pod adds is lit in Pod's hue, so each diagram also answers
"what does Pod change". Packets run along the data edges (transform only).
Every node and edge is sourced from the code; see the README's notes under
each diagram.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from house import (
    EASE_IN_OUT,
    Doc,
    Ink,
    Theme,
    Type,
    cap_middle,
    card_shadow,
    face,
    n,
    oklch,
    ring,
    squircle,
    wrap,
)

# The type roles at the wide images' scale; a phone layout draws them larger (use_scale).
_ROLES = {
    "EYEBROW": Type("suisse", 15.5, 1.3),
    "TITLE": Type("neue-medium", 22, 1.25),
    "BODY": Type("suisse", 17, 1.42),
    "MONO": Type("mono", 15, 1.45),
    "LABEL": Type("mono", 14, 1.3),
    "TAG": Type("neue-medium", 13, tracking=-0.01),
}
EYEBROW, TITLE, BODY, MONO, LABEL, TAG = _ROLES.values()
K = 1.0


def use_scale(k: float) -> None:
    """Set the type and chrome scale every drawing call below reads."""
    global EYEBROW, TITLE, BODY, MONO, LABEL, TAG, K
    K = k
    EYEBROW, TITLE, BODY, MONO, LABEL, TAG = (Type(t.face, t.size * k, t.leading, t.tracking) for t in _ROLES.values())

HEAD = Type("neue", 34, 1.15, -0.02)
HEAD_SUB = Type("suisse", 18, 1.42)


@dataclass
class Node:
    id: str
    x: float
    y: float
    w: float
    h: float
    eyebrow: str
    title: str
    body: str = ""
    mono: str = ""
    pod: bool = False  # what Pod adds
    tag: str = ""
    planned: bool = False  # not built yet: a dashed outline, no fill


@dataclass
class Edge:
    a: str
    b: str
    label: str = ""
    sides: str = "rl"  # exit side of a, entry side of b: r l t b
    via: list[tuple[float, float]] = field(default_factory=list)
    label_at: float = 0.5
    label_dy: float = 0.0
    packet: float = 0.0  # seconds per trip; 0 = no packet
    delay: float = 0.0
    quiet: bool = False
    fa: float = 0.5  # where along a's side the edge leaves
    fb: float = 0.5
    label_side: str = "on"  # on | above | below | left | right of the line


@dataclass
class Diagram:
    name: str
    title: str
    w: float
    h: float
    nodes: list[Node]
    edges: list[Edge]
    head: tuple[str, str] = ("", "")
    legend: tuple[str, str] = ("Orca, unchanged", "What Pod adds")
    notes: list[tuple[float, float, str]] = field(default_factory=list)
    k: float = 1.0
    bands: list[tuple[float, float, float, float, str]] = field(default_factory=list)  # x, y, w, h, label


def _anchor(nd: Node, side: str, frac: float = 0.5) -> tuple[float, float]:
    return {
        "r": (nd.x + nd.w, nd.y + nd.h * frac),
        "l": (nd.x, nd.y + nd.h * frac),
        "t": (nd.x + nd.w * frac, nd.y),
        "b": (nd.x + nd.w * frac, nd.y + nd.h),
    }[side]


def _route(e: Edge, nodes: dict[str, Node]) -> list[tuple[float, float]]:
    a, b = nodes[e.a], nodes[e.b]
    p0 = _anchor(a, e.sides[0], e.fa)
    p1 = _anchor(b, e.sides[1], e.fb)
    if e.via:
        pts = [p0, *e.via, p1]
    elif e.sides[0] in "rl" and e.sides[1] in "rl":
        if abs(p0[1] - p1[1]) < 1:
            pts = [p0, (p1[0], p0[1])]
        else:
            mx = (p0[0] + p1[0]) / 2
            pts = [p0, (mx, p0[1]), (mx, p1[1]), p1]
    elif e.sides[0] in "tb" and e.sides[1] in "tb":
        if abs(p0[0] - p1[0]) < 1:
            pts = [p0, (p0[0], p1[1])]
        else:
            my = (p0[1] + p1[1]) / 2
            pts = [p0, (p0[0], my), (p1[0], my), p1]
    elif e.sides[0] in "rl":
        pts = [p0, (p1[0], p0[1]), p1]
    else:
        pts = [p0, (p0[0], p1[1]), p1]
    return pts


def _rounded(pts: list[tuple[float, float]], r: float = 14) -> str:
    """A polyline with rounded elbows."""
    d = f"M{n(pts[0][0])} {n(pts[0][1])}"
    for i in range(1, len(pts) - 1):
        (x0, y0), (x1, y1), (x2, y2) = pts[i - 1], pts[i], pts[i + 1]
        l1, l2 = math.hypot(x1 - x0, y1 - y0), math.hypot(x2 - x1, y2 - y1)
        rr = min(r, l1 / 2, l2 / 2)
        ax, ay = x1 - (x1 - x0) / l1 * rr, y1 - (y1 - y0) / l1 * rr
        bx, by = x1 + (x2 - x1) / l2 * rr, y1 + (y2 - y1) / l2 * rr
        d += f"L{n(ax)} {n(ay)}Q{n(x1)} {n(y1)} {n(bx)} {n(by)}"
    d += f"L{n(pts[-1][0])} {n(pts[-1][1])}"
    return d


def _point_at(pts: list[tuple[float, float]], t: float) -> tuple[float, float, float]:
    """The point a fraction t along the polyline, and the segment's angle."""
    segs = [
        (
            pts[i],
            pts[i + 1],
            math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]),
        )
        for i in range(len(pts) - 1)
    ]
    total = sum(s[2] for s in segs)
    goal = total * t
    for (x0, y0), (x1, y1), length in segs:
        if goal <= length or (x1, y1) == pts[-1]:
            f = goal / length if length else 0
            return x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, math.atan2(y1 - y0, x1 - x0)
        goal -= length
    return pts[-1][0], pts[-1][1], 0.0


def _ground(theme: Theme) -> Ink:
    return Ink("#000000") if theme.dark else Ink(oklch(0.985, 0.002, 91))


def _node(doc: Doc, theme: Theme, nd: Node) -> None:
    r = 22
    d = squircle(nd.x, nd.y, nd.w, nd.h, r)
    if nd.planned:
        dash = f'stroke-dasharray="{5 * K:g} {5 * K:g}" stroke-linecap="round"'
        doc.add(f'<path d="{squircle(nd.x + 0.75, nd.y + 0.75, nd.w - 1.5, nd.h - 1.5, r - 0.75)}" fill="none" {theme.pod_glyph.with_a(0.7).stroke()} stroke-width="{1.5 * K:g}" {dash}/>')
    elif nd.pod:
        tint = Ink(
            oklch(0.3 if theme.dark else 0.97, 0.05 if theme.dark else 0.02, 205)
        )
        if not theme.dark:
            sh = card_shadow(doc, theme)
            doc.add(f'<path d="{d}" {tint.fill()} filter="url(#{sh})"/>')
        doc.define(
            "pod-node",
            '<linearGradient id="pod-node" x1="0" y1="0" x2="0" y2="1">'
            + (
                Ink(oklch(0.27, 0.05, 205)).stop(0)
                + Ink(oklch(0.19, 0.035, 205)).stop(1)
                if theme.dark
                else Ink(oklch(0.978, 0.012, 205)).stop(0)
                + Ink(oklch(0.962, 0.018, 205)).stop(1)
            )
            + "</linearGradient>",
        )
        doc.add(f'<path d="{d}" fill="url(#pod-node)"/>')
        doc.add(
            ring(
                squircle(nd.x + 0.5, nd.y + 0.5, nd.w - 1, nd.h - 1, r - 0.5),
                theme.pod_glyph.with_a(0.55 if theme.dark else 0.45),
            )
        )
    else:
        if theme.dark:
            doc.add(f'<path d="{d}" fill="{oklch(0.165, 0.008, 205)}"/>')
            doc.add(
                ring(
                    squircle(nd.x + 0.5, nd.y + 0.5, nd.w - 1, nd.h - 1, r - 0.5),
                    Ink("#ffffff", 0.1),
                )
            )
        else:
            sh = card_shadow(doc, theme)
            doc.add(f'<path d="{d}" fill="#fff" filter="url(#{sh})"/>')
            doc.add(
                ring(
                    squircle(nd.x + 0.5, nd.y + 0.5, nd.w - 1, nd.h - 1, r - 0.5),
                    theme.hairline_strong,
                )
            )
    pad = 20 * K
    y = nd.y + pad + EYEBROW.size * 0.78
    doc.text(
        nd.x + pad, y, nd.eyebrow, EYEBROW, theme.pod_ink if nd.pod else theme.ink3
    )
    if nd.tag:
        f = face(TAG.face)
        h = 24 * K
        w = f.width(nd.tag, TAG.size, TAG.tracking) + 18 * K
        tx = nd.x + nd.w - pad + 6 * K - w
        bg = (
            theme.pod_glyph.with_a(0.16 if theme.dark else 0.12)
            if nd.pod
            else theme.fill_strong
        )
        doc.add(f'<path d="{squircle(tx, nd.y + pad - 7 * K, w, h, h / 2)}" {bg.fill()}/>')
        doc.text(
            tx + 9 * K,
            nd.y + pad - 7 * K + h / 2 + cap_middle(TAG),
            nd.tag,
            TAG,
            theme.pod_ink if nd.pod else theme.ink2,
        )
    y += TITLE.size * 1.45
    for row in wrap(nd.title, TITLE, nd.w - 2 * pad):
        doc.text(nd.x + pad, y, row, TITLE, theme.ink)
        y += TITLE.size * TITLE.leading
    if nd.mono:
        y += 2
        for row in nd.mono.split("\n"):
            doc.text(nd.x + pad, y, row, MONO, theme.ink2)
            y += MONO.size * MONO.leading
    if nd.body:
        y += 4
        for row in wrap(nd.body, BODY, nd.w - 2 * pad):
            doc.text(nd.x + pad, y, row, BODY, theme.ink2)
            y += BODY.size * BODY.leading


def _edge(doc: Doc, theme: Theme, e: Edge, nodes: dict[str, Node], idx: int) -> None:
    pts = _route(e, nodes)
    stroke = (
        theme.ink3.with_a(0.3 if theme.dark else 0.32)
        if e.quiet
        else theme.ink3.with_a(0.62 if theme.dark else 0.55)
    )
    d = _rounded(pts)
    dash = ' stroke-dasharray="2 6" stroke-linecap="round"' if e.quiet else ""
    doc.add(f'<path d="{d}" fill="none" {stroke.stroke()} stroke-width="{1.5 * K:g}"{dash}/>')
    # Arrowhead: an open chevron at the end, along the last segment.
    (x0, y0), (x1, y1) = pts[-2], pts[-1]
    ang = math.atan2(y1 - y0, x1 - x0)
    s = 7 * K
    ax, ay = x1 - math.cos(ang) * 1.5, y1 - math.sin(ang) * 1.5
    p_l = (ax - s * math.cos(ang - 0.6), ay - s * math.sin(ang - 0.6))
    p_r = (ax - s * math.cos(ang + 0.6), ay - s * math.sin(ang + 0.6))
    doc.add(
        f'<path d="M{n(p_l[0])} {n(p_l[1])}L{n(ax)} {n(ay)}L{n(p_r[0])} {n(p_r[1])}" fill="none" {stroke.with_a(min(1, stroke.a + 0.2)).stroke()} '
        f'stroke-width="{1.5 * K:g}" stroke-linecap="round" stroke-linejoin="round"/>'
    )
    if e.packet:
        segs = [
            math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
            for i in range(len(pts) - 1)
        ]
        total = sum(segs)
        frames, acc = [], 0.0
        x_start, y_start = pts[0]
        for i, p in enumerate(pts):
            pct = 8 + 80 * acc / total
            frames.append(
                f"{pct:.1f}%{{transform:translate({n(p[0] - x_start)}px,{n(p[1] - y_start)}px)}}"
            )
            if i < len(segs):
                acc += segs[i]
        name = f"pk{idx}"
        doc.style(
            f"@keyframes {name}{{0%{{opacity:0;transform:translate(0,0)}}8%{{opacity:1}}84%{{opacity:1}}"
            + "".join(frames[1:])
            + f"92%,100%{{opacity:0;transform:translate({n(pts[-1][0] - x_start)}px,{n(pts[-1][1] - y_start)}px)}}}}"
            f".{name}{{opacity:0;animation:{name} {e.packet:g}s {EASE_IN_OUT} {e.delay:g}s infinite}}"
        )
        doc.add(
            f'<circle class="{name}" cx="{n(x_start)}" cy="{n(y_start)}" r="{4 * K:g}" {theme.pod_glyph.fill()}/>'
        )
    if e.label:
        lx, ly, _ = _point_at(pts, e.label_at)
        ly += e.label_dy
        rows = e.label.split("\n")
        f = face(LABEL.face)
        w = max(f.width(r_, LABEL.size) for r_ in rows) + 16 * K
        h = len(rows) * LABEL.size * LABEL.leading + 10 * K
        off = 6 * K
        if e.label_side == "above":
            ly -= h / 2 + off
        elif e.label_side == "below":
            ly += h / 2 + off
        elif e.label_side == "right":
            lx += w / 2 + off
        elif e.label_side == "left":
            lx -= w / 2 + off
        bg = _ground(theme)
        doc.add(f'<path d="{squircle(lx - w / 2, ly - h / 2, w, h, 9)}" {bg.fill()}/>')
        base = ly - h / 2 + 5 * K + LABEL.size * 0.92
        for i, r_ in enumerate(rows):
            doc.text(
                lx,
                base + i * LABEL.size * LABEL.leading,
                r_,
                LABEL,
                theme.ink2,
                anchor="middle",
            )


def _legend(
    doc: Doc, theme: Theme, x: float, y: float, labels: tuple[str, str], planned: bool = False, max_x: float = 1e9
) -> None:
    t = Type("suisse", 15 * K)
    x0 = x
    items = [(False, labels[0]), (True, labels[1])] + ([("planned", "Planned")] if planned else [])
    for pod, label in items:
        d = squircle(x, y - 12 * K, 16 * K, 16 * K, 5 * K)
        if pod == "planned":
            doc.add(f'<path d="{d}" fill="none" {theme.pod_glyph.with_a(0.7).stroke()} stroke-width="{1.5 * K:g}" stroke-dasharray="{3 * K:g} {3 * K:g}"/>')
        elif pod:
            doc.add(
                f'<path d="{d}" fill="{oklch(0.27 if theme.dark else 0.965, 0.05 if theme.dark else 0.018, 205)}"/>'
            )
            doc.add(ring(d, theme.pod_glyph.with_a(0.6)))
        else:
            doc.add(
                f'<path d="{d}" fill="{oklch(0.165, 0.008, 205) if theme.dark else "#ffffff"}"/>'
            )
            doc.add(
                ring(
                    d,
                    Ink("#ffffff", 0.18)
                    if theme.dark
                    else theme.hairline_strong.with_a(0.16),
                )
            )
        x += 26 * K
        x += doc.text(x, y, label, t, theme.ink2) + 28 * K
    if x + 16 * K + face(t.face).width("Data in flight", t.size) > max_x:
        x, y = x0, y + 30 * K
    # The packet's key.
    doc.add(f'<circle cx="{n(x + 4 * K)}" cy="{n(y - 4 * K)}" r="{4 * K:g}" {theme.pod_glyph.fill()}/>')
    doc.text(x + 16 * K, y, "Data in flight", t, theme.ink2)


def render(dg: Diagram, theme: Theme) -> Doc:
    use_scale(dg.k)
    doc = Doc(dg.w, dg.h, dg.title)
    # Its own canvas, so label chips match the ground whatever GitHub theme is around it.
    panel = squircle(0.5, 0.5, dg.w - 1, dg.h - 1, 28)
    doc.add(f'<path d="{panel}" {_ground(theme).fill()}/>')
    doc.add(ring(panel, Ink("#ffffff", 0.09) if theme.dark else theme.hairline_strong))
    nodes = {nd.id: nd for nd in dg.nodes}
    if dg.head[0]:
        doc.text(24, 24 + HEAD.size * 0.8, dg.head[0], HEAD, theme.ink)
        if dg.head[1]:
            doc.text(
                24,
                24 + HEAD.size * 0.8 + HEAD.size * HEAD.leading,
                dg.head[1],
                HEAD,
                theme.ink3,
            )
    for bx, by, bw, bh, label in dg.bands:
        # A layer that doesn't exist yet: a faint dashed field with its name on the edge.
        band = squircle(bx, by, bw, bh, 26)
        doc.add(f'<path d="{band}" {theme.fill.fill()}/>')
        doc.add(f'<path d="{band}" fill="none" {theme.ink3.with_a(0.35).stroke()} stroke-width="{1.2 * K:g}" stroke-dasharray="{2 * K:g} {6 * K:g}" stroke-linecap="round"/>')
        doc.text(bx + bw - 20 * K, by + 20 * K + EYEBROW.size * 0.78, label, EYEBROW, theme.pod_ink, anchor="end")
    for i, e in enumerate(dg.edges):
        _edge(doc, theme, e, nodes, i) if e.quiet else None
    for nd in dg.nodes:
        _node(doc, theme, nd)
    for i, e in enumerate(dg.edges):
        _edge(doc, theme, e, nodes, i) if not e.quiet else None
    for x, y, s in dg.notes:
        for j, row in enumerate(s.split("\n")):
            doc.text(x, y + j * BODY.size * BODY.leading, row, BODY, theme.ink3)
    if dg.legend:
        two = any(nd.planned for nd in dg.nodes) and dg.k > 1
        _legend(doc, theme, 40, dg.h - (60 if two else 30) * K, dg.legend, planned=any(nd.planned for nd in dg.nodes), max_x=dg.w - 40)
    return doc


PHONE = 1.45


def _phone(
    name: str,
    title: str,
    specs: list[tuple[str, dict]],
    flow: list[tuple[str, str, str]],
    note: str,
    legend: tuple[str, str],
    loop: tuple[str, str] | None = None,
    planned: list[tuple[str, dict]] | None = None,
) -> Diagram:
    """The phone layout: one node per row, the flow straight down, larger type; `loop` runs back up on the right."""
    use_scale(PHONE)
    W, x0 = 720, 40
    nw = W - 2 * x0 - (48 if loop else 0)
    gap = 76
    nodes, y = [], 40.0
    for id_, sp in specs:
        nd = fit(Node(id_, x0, y, nw, 0, **sp))
        nodes.append(nd)
        y += nd.h + gap
    edges = [
        Edge(a, b, label, sides="bt", fa=0.3, fb=0.3, packet=2.8, delay=i * 0.5, label_side="right")
        for i, (a, b, label) in enumerate(flow)
    ]
    if loop:
        by_id = {nd.id: nd for nd in nodes}
        lx = x0 + nw + 30
        a, b = by_id[loop[0]], by_id[loop[1]]
        edges.append(Edge(loop[0], loop[1], "", sides="rr", via=[(lx, a.y + a.h / 2), (lx, b.y + b.h / 2)], quiet=True))
    rows = wrap(note, BODY, W - 2 * x0)
    first = y - gap + 44 + BODY.size
    last = first + (len(rows) - 1) * BODY.size * BODY.leading
    bands = []
    if planned:
        band_y = last + 48 * PHONE
        py = band_y + 58 * PHONE
        for id_, sp in planned:
            nd = fit(Node(id_, x0 + 16, py, W - 2 * x0 - 32, 0, **sp))
            nodes.append(nd)
            py += nd.h + 20
        bands.append((24, band_y, W - 48, py - band_y + 4, "Planned, after the first release"))
        last = py + 30 * PHONE
    H = last + 56 * PHONE + 30 * PHONE
    return Diagram(name, title, W, H, nodes, edges, legend=legend, notes=[(x0, first, "\n".join(rows))], k=PHONE, bands=bands)


# ── 1. The native terminal ─────────────────────────────────────────────


def terminal(narrow: bool = False) -> Diagram:
    """
    feat/native-ghostty-terminal: daemon-client-ndjson-readers.ts, ipc/pty/delivery/payload.ts,
    native-terminal-mirror.ts, native-terminal-frames.ts, ghostty-native-terminal-host.ts,
    native/ghostty-terminal-macos/src/ghostty_terminal.mm.
    """
    title = "Pod's native terminal: PTY output runs from the daemon through xterm.js, kept as the hidden model, to a Ghostty view drawn with Metal"
    if not narrow:
        use_scale(1.0)
        W, H = 1280, 640
        top, nh, nw, gap = 48, 176, 240, 80
        xs = [40 + i * (nw + gap) for i in range(4)]
        nodes = [
            Node(
                "daemon",
                xs[0],
                top,
                nw,
                nh,
                "pty daemon",
                "node-pty",
                body="Owns every PTY, outside the window's processes.",
            ),
            Node(
                "client",
                xs[1],
                top,
                nw,
                nh,
                "Electron main",
                "Daemon client",
                body="Reads PTY output from the daemon's stream socket.",
            ),
            Node(
                "host",
                xs[2],
                top,
                nw,
                nh,
                "Electron main",
                "Native host",
                mono="ghostty_terminal.node",
                body="N-API addon in ObjC++ on libghostty.",
                pod=True,
            ),
            Node(
                "view",
                xs[3],
                top,
                nw,
                nh,
                "AppKit",
                "Ghostty surface",
                body="An NSView per pane over Chromium's view, drawn with Metal.",
                pod=True,
            ),
        ]
        nh = max(fit(nd).h for nd in nodes)
        for nd in nodes:
            nd.h = nh
        xw = 300
        xx, xy = (xs[1] + xs[2] + nw) / 2 - xw / 2, top + nh + 104
        nodes.append(
            Node(
                "xterm",
                xx,
                xy,
                xw,
                150,
                "Renderer",
                "xterm.js, the hidden model",
                body="Parses every byte and answers terminal queries; replay and search stay its job.",
            )
        )
        ky = xy + fit(nodes[-1]).h + 70
        edges = [
            Edge("daemon", "client", "NDJSON", packet=2.6, label_side="above"),
            Edge(
                "client",
                "xterm",
                "pty:data",
                sides="bt",
                fa=0.5,
                fb=0.2,
                packet=2.6,
                delay=0.5,
                label_at=0.5,
                label_side="left",
            ),
            Edge(
                "xterm",
                "host",
                "parsed bytes",
                sides="tb",
                fa=0.8,
                fb=0.5,
                packet=2.6,
                delay=1.0,
                label_at=0.5,
                label_side="right",
            ),
            Edge(
                "host",
                "view",
                "replay\nwrite",
                packet=2.6,
                delay=1.5,
                label_side="above",
            ),
            Edge(
                "xterm",
                "view",
                "setFrames: pane rects, overlay holes",
                sides="rb",
                fb=0.3,
                quiet=True,
                label_at=0.42,
                label_side="above",
            ),
            Edge(
                "view",
                "daemon",
                "keys: Ghostty encodes them, main and the renderer send them on as pty:write",
                sides="bb",
                fa=0.8,
                via=[(xs[3] + nw * 0.8, ky), (xs[0] + nw / 2, ky)],
                quiet=True,
                label_side="on",
            ),
        ]
        return Diagram("arch-terminal", title, W, ky + 84, nodes, edges)
    specs = [
        ("daemon", dict(eyebrow="pty daemon", title="node-pty", body="Owns every PTY, outside the window's processes.")),
        ("client", dict(eyebrow="Electron main", title="Daemon client", body="Reads PTY output from the daemon's socket.")),
        ("xterm", dict(eyebrow="Renderer", title="xterm.js, the hidden model", body="Parses every byte and answers terminal queries.")),
        ("host", dict(eyebrow="Electron main", title="Native host", mono="ghostty_terminal.node", pod=True)),
        ("view", dict(eyebrow="AppKit", title="Ghostty surface", body="An NSView per pane, drawn with Metal.", pod=True)),
    ]
    flow = [("daemon", "client", "NDJSON"), ("client", "xterm", "pty:data"), ("xterm", "host", "parsed bytes"), ("host", "view", "replay write")]
    note = "Keys run back up the dotted line: Ghostty encodes them, and main and the renderer pass them on as pty:write."
    return _phone("arch-terminal", title, specs, flow, note, ("Orca, unchanged", "What Pod adds"), loop=("view", "daemon"))


# ── 2. Code search for agents ──────────────────────────────────────────


def search(narrow: bool = False) -> Diagram:
    """
    ~/Documents/pod-search (og, ogd, proto) and pod/search-client: og.rs, daemon main.rs,
    fsevents.rs, store.rs, proto wire.rs, src/main/pod/search/ogd-connection.ts.
    """
    title = "Pod's code search for agents: og answers ripgrep queries from ogd's index of each worktree, kept current by FSEvents"
    legend = ("macOS and ripgrep", "What Pod adds")
    agents = dict(
        eyebrow="Agents",
        title="Claude Code, Codex, …",
        body="Search with ripgrep's flags, as they always have.",
    )
    og = dict(
        eyebrow="CLI",
        title="og",
        mono="ripgrep 15.2 fork",
        body="Answers from the index, else runs the real rg with the same argv.",
        pod=True,
    )
    ogd = dict(
        eyebrow="Daemon",
        title="ogd",
        body="One per user. Indexes a worktree on its first query, then keeps it current.",
        pod=True,
        tag="In development",
    )
    fse = dict(
        eyebrow="macOS",
        title="FSEvents",
        body="File changes, with a barrier on every query, so answers are never stale.",
    )
    store = dict(
        eyebrow="Per git common dir",
        title="Pack + trigram index",
        body="Each blob stored once across worktrees; og reads it in place.",
        pod=True,
    )
    rg = dict(
        eyebrow="Fallback",
        title="ripgrep",
        body="Runs whenever the index can't answer, or after 2 s.",
    )
    main = dict(
        eyebrow="Electron main",
        title="Pod's search",
        mono="OgdClient",
        body="Quick open and text search ask ogd too.",
        pod=True,
    )
    if not narrow:
        use_scale(1.0)
        W = 1280
        nw = 220
        nh = max(fit(Node("", 0, 0, nw, 0, **sp)).h for sp in (agents, og, ogd, fse, rg, store, main))
        gap = (W - 80 - 4 * nw) / 3
        xs = [40 + i * (nw + gap) for i in range(4)]
        y1, y2 = 48, 48 + nh + 120
        nodes = [
            Node("agents", xs[0], y1, nw, nh, **agents),
            Node("og", xs[1], y1, nw, nh, **og),
            Node("ogd", xs[2], y1, nw, nh, **ogd),
            Node("fse", xs[3], y1, nw, nh, **fse),
            Node("rg", xs[0], y2, nw, nh, **rg),
            Node("store", xs[1], y2, nw, nh, **store),
            Node("main", xs[2], y2, nw, nh, **main),
        ]
        edges = [
            Edge("agents", "og", "rg argv", fa=0.42, fb=0.42, packet=2.8, label_side="above"),
            Edge("og", "ogd", "candidates\nunix socket", fa=0.42, fb=0.42, packet=2.8, delay=0.5, label_side="above"),
            Edge("fse", "ogd", "events", sides="lr", fa=0.42, fb=0.42, packet=2.8, delay=1.4, label_side="above"),
            Edge("og", "store", "mmap", sides="bt", fa=0.4, fb=0.4, packet=2.8, delay=1.6, label_side="right", label_at=0.4),
            Edge("ogd", "store", "append", sides="bt", fa=0.22, fb=0.86, packet=2.8, delay=1.0, label_side="above"),
            Edge("og", "rg", "on a miss", sides="bt", fa=0.14, fb=0.72, quiet=True, label_side="above"),
            Edge("main", "ogd", "files, fuzzy,\nsearch", sides="tb", fa=0.72, fb=0.72, packet=2.8, delay=2.0, label_side="right"),
        ]
        return Diagram(
            "arch-search", title, W, y2 + nh + 96, nodes, edges, legend=legend
        )
    specs = [("agents", agents), ("og", og), ("ogd", ogd), ("store", store), ("fse", fse)]
    flow = [("agents", "og", "rg argv"), ("og", "ogd", "candidates"), ("ogd", "store", "append")]
    note = "FSEvents keeps the index current (dotted line). og reads the pack in place, and runs the real rg on a miss."
    return _phone("arch-search", title, specs, flow, note, legend, loop=("fse", "ogd"))


def fit(nd: Node) -> Node:
    """Grow a node to its content: for the phone layouts, where each node has a row to itself."""
    pad = 20 * K
    h = pad + EYEBROW.size * 0.78 + TITLE.size * 1.45
    h += len(wrap(nd.title, TITLE, nd.w - 2 * pad)) * TITLE.size * TITLE.leading
    if nd.mono:
        h += 2 + len(nd.mono.split("\n")) * MONO.size * MONO.leading
    if nd.body:
        h += 4 + len(wrap(nd.body, BODY, nd.w - 2 * pad)) * BODY.size * BODY.leading
    nd.h = max(nd.h, h - BODY.size * 0.4 + pad)
    return nd


# ── 3. claude-acc inside Pod ───────────────────────────────────────────


def acc(narrow: bool = False) -> Diagram:
    """
    Today, from pod/acc: src/main/pod/acc/acc-lifecycle.ts, acc-menu-helper.ts, acc-supervisor.ts,
    config/claude-acc-payload.json, resources/plugins/distro/outof-place.pod-acc; claude-acc v1.28:
    setup.sh, app/Sources (Awake.swift, fanctl/Lid.swift, hook/main.swift), sched.py.
    Planned, from the merge plan (scratchpad brand/acc-merge-plan.md, sections 1 and 7).
    """
    title = "claude-acc inside Pod: Pod installs its bundled claude-acc, supervises it and shows its state in the window; a planned layer moves the helpers into Pod.app"
    legend = ("claude-acc", "What Pod adds")
    spec = {
        "supervisor": dict(eyebrow="Pod main", title="acc supervisor", body="Runs the bundled setup when its version, owner or app path changes.", pod=True, tag="In progress"),
        "payload": dict(eyebrow="Inside Pod.app", title="claude-acc", mono="sha256-pinned release", body="setup.sh --owner pod installs it for the user."),
        "agents": dict(eyebrow="LaunchAgents", title="Background jobs", mono="com.filip.claude-acc.*", body="Rotation, the memory guard, cleanup, perf."),
        "state": dict(eyebrow="~/.local/share/claude-acc", title="State files", body="What every job last did, as JSON."),
        "helper": dict(eyebrow="Menu bar helper", title="Claude Acc.app", body="Stay awake and dictation. Pod hides its own tray icon while it runs."),
        "root": dict(eyebrow="LaunchDaemons, root", title="Fans and lid", body="Installed apart with Touch ID, never by Pod's setup."),
        "hook": dict(eyebrow="Agents' commands", title="Hook and sched", body="Dev servers go to the memory guard, builds to the memory-aware scheduler."),
        "plugin": dict(eyebrow="Pod plugin", title="Status bar and panel", body="Account, memory and awake at the window's foot.", pod=True),
    }
    planned = {
        "menu": dict(eyebrow="Login item in Pod.app", title="Pod Menu.app", body="Claude Acc.app moved inside Pod; same bundle id, so its grants carry over.", planned=True),
        "rootd": dict(eyebrow="One root helper", title="pod-rootd", body="An SMAppService daemon over XPC, with fixed verbs, replacing the root daemons.", planned=True),
        "pagents": dict(eyebrow="LaunchAgents in Pod.app", title="The same jobs", mono="codes.pod.app.acc.*", body="Registered by Pod, removed with it.", planned=True),
        "python": dict(eyebrow="Contents/Resources", title="Embedded Python", body="A pinned 3.14 runs the jobs, not uv's or the system's.", planned=True),
    }
    if not narrow:
        use_scale(1.0)
        W = 1280
        nw = 224
        nh = max(fit(Node("", 0, 0, nw, 0, **sp)).h for sp in spec.values())
        ph = max(fit(Node("", 0, 0, nw, 0, **sp)).h for sp in planned.values())
        gap = (W - 80 - 4 * nw) / 3
        xs = [40 + i * (nw + gap) for i in range(4)]
        y1, y2 = 48, 48 + nh + 116
        band_y = y2 + nh + 64
        y3 = band_y + 56
        place = {"supervisor": (0, y1), "payload": (1, y1), "agents": (2, y1), "state": (3, y1), "helper": (0, y2), "root": (1, y2), "hook": (2, y2), "plugin": (3, y2)}
        nodes = [Node(k, xs[c], y, nw, nh, **spec[k]) for k, (c, y) in place.items()]
        nodes += [Node(k, xs[c], y3, nw, ph, **planned[k]) for c, k in enumerate(("menu", "rootd", "pagents", "python"))]
        edges = [
            Edge("supervisor", "payload", "setup.sh", fa=0.42, fb=0.42, packet=3.0, label_side="above"),
            Edge("payload", "agents", "launchctl\nbootstrap", fa=0.42, fb=0.42, packet=3.0, delay=0.6, label_side="above"),
            Edge("agents", "state", "writes", fa=0.42, fb=0.42, packet=3.0, delay=1.2, label_side="above"),
            Edge("state", "plugin", "polls", sides="bt", packet=3.0, delay=1.8, label_side="right"),
            Edge("supervisor", "helper", "is it\nrunning?", sides="bt", fa=0.4, fb=0.4, quiet=True, label_side="right"),
            Edge("payload", "helper", "installs, opens", sides="bt", fa=0.3, fb=0.86, packet=3.0, delay=0.9, label_side="above"),
            Edge("helper", "root", "awake.json", fa=0.5, fb=0.5, quiet=True, label_side="above"),
            Edge("hook", "agents", "admit", sides="tb", fa=0.5, fb=0.5, packet=3.0, delay=2.2, label_side="right"),
            Edge("helper", "menu", "becomes", sides="bt", fa=0.5, fb=0.5, quiet=True, label_side="right", label_at=0.3),
            Edge("root", "rootd", "replaced by", sides="bt", fa=0.5, fb=0.5, quiet=True, label_side="right", label_at=0.3),
        ]
        bands = [(24, band_y, W - 48, y3 + ph + 24 - band_y, "Planned, after the first release")]
        return Diagram("arch-acc", title, W, y3 + ph + 24 + 76, nodes, edges, legend=legend, bands=bands)
    specs = [(k_, spec[k_]) for k_ in ("supervisor", "payload", "agents", "state", "plugin")]
    flow = [("supervisor", "payload", "setup.sh"), ("payload", "agents", "launchctl bootstrap"), ("agents", "state", "writes"), ("state", "plugin", "polls")]
    note = "Setup also installs the menu helper, Claude Acc.app. Fans and the lid run as root daemons, installed apart with Touch ID."
    return _phone("arch-acc", title, specs, flow, note, legend, planned=[(k_, planned[k_]) for k_ in ("menu", "rootd", "pagents", "python")])


DIAGRAMS = {"terminal": terminal, "search": search, "acc": acc}
