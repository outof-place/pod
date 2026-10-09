# /// script
# requires-python = ">=3.12,<3.15"
# dependencies = ["fonttools>=4.55", "brotli>=1.1", "uharfbuzz>=0.45"]
# ///
"""
Benchmark charts for the README, from pod-bench's summary.json (bench/summarize.mjs).

    uv run .github/assets/src/bench.py                       # latest bench/results/<date>/summary.json
    uv run .github/assets/src/bench.py --results path/to/summary.json
    uv run .github/assets/src/bench.py --fixture --out /tmp/charts   # layout test, FAKE data

Every figure drawn comes from summary.json as written: medians, p95s, n,
hardware, date, conditions and the comparisons' factors. Nothing is computed
here except the axis. With no results yet it draws a card that says so and
shows no number. A summary marked "fixture" is watermarked FAKE on every chart
and can't be written into .github/assets.

With --readme it also rewrites the blocks between <!-- bench:start --> and
<!-- bench:end -->, and <!-- bench:claude-acc:start --> and its end, in
.github/README.md: the charts and a table of every number. The claude-acc
suite goes to its own section; its historical rows (provenance.kind
"historical") are hatched and dated, apart from fresh measurements.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from house import (
    THEMES,
    Doc,
    Ink,
    Theme,
    Type,
    cap_middle,
    face,
    n,
    oklch,
    ring,
    squircle,
    wrap,
)

ASSETS = Path(__file__).resolve().parent.parent
REPO = ASSETS.parent.parent
FIXTURE = Path(__file__).parent / "fixtures" / "FAKE-summary.json"
METHODOLOGY = "../bench/README.md"
SUITE_NAMES = {
    "latency": "Latency",
    "throughput": "Terminal throughput",
    "search": "Code search",
    "startup": "Startup",
    "panes": "Many panes",
    "polling": "Idle polling",
    "git-status": "Git status",
    "memory": "Memory",
    "idle-cpu": "Idle CPU",
    "claude-acc": "claude-acc",
}


def fmt(v: float | None) -> str:
    """Three significant figures, thousands separated: presentation only; the table keeps every digit."""
    if v is None:
        return "–"
    if abs(v) >= 100:
        return f"{v:,.0f}"
    return f"{v:.3g}"


def nice_ticks(hi: float, count: int = 5) -> list[float]:
    if hi <= 0:
        return [0, 1]
    raw = hi / count
    mag = 10 ** math.floor(math.log10(raw))
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    return [i * step for i in range(int(math.ceil(hi / step)) + 1)]


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:48]


def groups(summary: dict) -> list[dict]:
    """One chart per suite and metric, its rows in summary order."""
    out: dict[tuple[str, str], dict] = {}
    for m in summary.get("metrics", []):
        if m.get("median") is None:
            continue
        key = (m["suite"], m["metric"])
        g = out.setdefault(
            key,
            {
                "suite": m["suite"],
                "metric": m["metric"],
                "unit": m["unit"],
                "better": m.get("better", "lower"),
                "rows": [],
            },
        )
        g["rows"].append(m)
    for g in out.values():
        g["comparisons"] = [
            c
            for c in summary.get("comparisons", [])
            if c["metric"] == g["metric"]
            and any(r["id"] == c["candidate"]["id"] for r in g["rows"])
        ]
        g["conditions"] = sorted(
            {r["conditions"] for r in g["rows"] if r.get("conditions")}
        )
        g["caveats"] = [c for r in g["rows"] for c in r.get("caveats", [])]
    return list(out.values())


def provenance(r: dict) -> dict | None:
    """A historical row's {date, source, note}: measured before this run (claude-acc's own numbers); None when fresh."""
    p = r.get("provenance")
    if isinstance(p, str):
        p = {"kind": p}
    if isinstance(p, dict) and p.get("kind") == "historical":
        return p
    return None


def is_pod(subject: str) -> bool:
    return "pod" in subject.lower()


def _ground(theme: Theme) -> Ink:
    return Ink("#000000") if theme.dark else Ink(oklch(0.985, 0.002, 91))


def chart(g: dict, summary: dict, theme: Theme, narrow: bool = False) -> Doc:
    k = 1.32 if narrow else 1.0
    W = 720 if narrow else 1280
    pad = 40 * (0.8 if narrow else 1)
    eyebrow_t = Type("suisse", 16 * k)
    title_t = Type("neue", 32 * k, 1.15, -0.02)
    sub_t = Type("suisse", 16 * k, 1.4)
    label_t = Type("suisse", 17 * k, 1.3)
    n_t = Type("suisse", 13.5 * k)
    value_t = Type("neue-medium", 17 * k)
    p95_t = Type("suisse", 14 * k)
    tick_t = Type("mono", 12.5 * k)
    foot_t = Type("suisse", 14 * k, 1.45)
    fig_t = Type("neue", 52 * k, 1.0, -0.02)
    fixture = "fixture" in summary

    rows = g["rows"]
    # On a phone the subject sits over its bar; wide, in a column to the left.
    label_w = 0 if narrow else 260
    row_h = (96 if narrow else 66) * k
    bar_h = min(22.0, 22 * k)
    head_h = pad + eyebrow_t.size + 14 + title_t.size * 1.2 + sub_t.size * 1.9
    comps = g["comparisons"]
    if narrow and comps:
        head_h += fig_t.size * 1.6
    plot_top = head_h + 18
    plot_h = len(rows) * row_h
    axis_h = 34 * k
    foot_lines: list[tuple[str, Ink]] = []
    meta = f"{summary.get('hardware', 'hardware not recorded')} · {summary.get('resultsDir', '').split('/')[-1] or summary.get('generatedAt', '')[:10]}"
    text_w = W - 2 * pad
    for line in wrap(meta, foot_t, text_w):
        foot_lines.append((line, theme.ink2))
    for c in g["conditions"]:
        for line in wrap(f"Conditions: {c}", foot_t, text_w):
            foot_lines.append((line, theme.ink3))
    for c in g["comparisons"][1:]:
        verdict = "ahead" if c.get("candidateAhead", c["factor"] > 1) else "behind"
        line = f"{c['candidate']['subject']} vs {c['baseline']['subject']}: {c['factor']:.3g}×, {verdict} (medians)"
        for part in wrap(line, foot_t, text_w):
            foot_lines.append((part, theme.ink2))
    for r in g["rows"]:
        p = provenance(r)
        if p:
            note = f"Historical: {r['subject']}, measured {p.get('date', 'on an earlier date')}" + (f", {p['source']}" if p.get("source") else "") + (f". {p['note']}" if p.get("note") else "")
            for part in wrap(note, foot_t, text_w):
                foot_lines.append((part, theme.ink2))
    for c in [*g["caveats"], *summary.get("caveats", [])]:
        for line in wrap(f"Caveat: {c}", foot_t, text_w):
            foot_lines.append((line, theme.ink2))
    foot_lines.append(("Methodology: bench/README.md", theme.ink3))
    H = (
        plot_top
        + plot_h
        + axis_h
        + 24
        + len(foot_lines) * foot_t.size * foot_t.leading
        + pad
    )
    title = f"{SUITE_NAMES.get(g['suite'], g['suite'])}: {g['metric']}" + (
        " (FAKE fixture data)" if fixture else ""
    )
    doc = Doc(W, H, title)
    panel = squircle(0.5, 0.5, W - 1, H - 1, 28)
    doc.add(f'<path d="{panel}" {_ground(theme).fill()}/>')
    doc.add(ring(panel, Ink("#ffffff", 0.09) if theme.dark else theme.hairline_strong))

    # Head
    y = pad + eyebrow_t.size * 0.8
    doc.text(pad, y, SUITE_NAMES.get(g["suite"], g["suite"]), eyebrow_t, theme.pod_ink)
    y += 14 + title_t.size
    doc.text(pad, y, g["metric"][:1].upper() + g["metric"][1:], title_t, theme.ink)
    y += sub_t.size * 1.6
    better = "lower is better" if g["better"] != "higher" else "higher is better"
    doc.text(
        pad, y, f"Median bar, p95 whisker, in {g['unit']} · {better}", sub_t, theme.ink3
    )
    if comps:
        # The first comparison leads; the others are listed in the foot.
        c = comps[0]
        ahead = c.get("candidateAhead", c["factor"] > 1)
        fig = f"{c['factor']:.3g}×"
        cap = f"{c['candidate']['subject']} vs {c['baseline']['subject']}, medians"
        verdict = "ahead" if ahead else "behind"
        if narrow:
            fy = y + fig_t.size * 1.25
            doc.text(pad, fy, fig, fig_t, theme.ink)
            fw = face(fig_t.face).width(fig, fig_t.size, fig_t.tracking)
            doc.text(pad + fw + 16, fy - fig_t.size * 0.45, verdict, sub_t, theme.ink2)
            doc.text(pad + fw + 16, fy, cap, Type("suisse", 13 * k), theme.ink3)
        else:
            doc.text(
                W - pad, pad + fig_t.size * 0.85, fig, fig_t, theme.ink, anchor="end"
            )
            doc.text(
                W - pad,
                pad + fig_t.size * 0.85 + sub_t.size * 1.7,
                f"{verdict}: {cap}",
                sub_t,
                theme.ink3,
                anchor="end",
            )

    # Plot
    x0, x1 = pad + label_w, W - pad - (150 if not narrow else 120) * k
    hi = max(max(r["p95"] or r["median"], r["median"]) for r in rows)
    ticks = nice_ticks(hi, 3 if narrow else 5)
    top_tick = ticks[-1]
    sx = lambda v: x0 + (x1 - x0) * v / top_tick
    for t in ticks:
        gx = sx(t)
        doc.add(
            f'<path d="M{n(gx)} {n(plot_top)}V{n(plot_top + plot_h)}" {theme.chart_grid.stroke()}/>'
        )
        doc.text(
            gx, plot_top + plot_h + 22 * k, fmt(t), tick_t, theme.ink3, anchor="middle"
        )
    lead_ids = {c["candidate"]["id"] for c in comps}
    for i, r in enumerate(rows):
        cy = plot_top + i * row_h + row_h / 2
        hist = provenance(r)
        meta_line = f"n = {r['n']:,}" + (f" · historical, {hist.get('date', 'earlier')}" if hist else "")
        if narrow:
            lw = doc.text(pad, cy - bar_h / 2 - 12 * k, r["subject"], label_t, theme.ink)
            doc.text(pad + lw + 10, cy - bar_h / 2 - 12 * k, meta_line, n_t, theme.ink3)
            cy += 8 * k
        else:
            doc.text(pad, cy - 2, r["subject"], label_t, theme.ink)
            doc.text(pad, cy + n_t.size * 1.3, meta_line, n_t, theme.ink3)
        w = max(2.0, sx(r["median"]) - x0)
        # Emphasis, not a palette: the comparison's candidate (else every Pod row) in Pod's hue, the rest grey.
        lit = r["id"] in lead_ids if lead_ids else is_pod(r["subject"])
        fill = theme.pod_glyph if lit else theme.chart_muted
        rr = 4
        bar = (
            f"M{n(x0)} {n(cy - bar_h / 2)}H{n(x0 + w - rr)}Q{n(x0 + w)} {n(cy - bar_h / 2)} {n(x0 + w)} {n(cy - bar_h / 2 + rr)}"
            f"V{n(cy + bar_h / 2 - rr)}Q{n(x0 + w)} {n(cy + bar_h / 2)} {n(x0 + w - rr)} {n(cy + bar_h / 2)}H{n(x0)}Z"
        )
        if hist:
            # Historical: the same hue, hatched at 45 degrees and outlined, never solid like a fresh number.
            pid = doc.define(
                f"hatch-{fill.hex[1:]}",
                f'<pattern id="hatch-{fill.hex[1:]}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
                f'<path d="M0 0V6" {fill.stroke()} stroke-width="2"/></pattern>',
            )
            doc.add(f'<path d="{bar}" fill="url(#{pid})" {fill.stroke()} stroke-width="1.5"/>')
        else:
            doc.add(f'<path d="{bar}" {fill.fill()}/>')
        end = x0 + w
        if r.get("p95") is not None and r["p95"] > r["median"]:
            px = sx(r["p95"])
            doc.add(
                f'<path d="M{n(end)} {n(cy)}H{n(px)}M{n(px)} {n(cy - 7)}V{n(cy + 7)}" fill="none" {theme.ink3.stroke()} stroke-width="1.5" stroke-linecap="round"/>'
            )
            end = px
        vx = end + 12
        vw = doc.text(
            vx,
            cy + cap_middle(value_t) - 6 * k,
            f"{fmt(r['median'])} {g['unit']}",
            value_t,
            theme.ink,
        )
        if r.get("p95") is not None:
            doc.text(
                vx,
                cy + cap_middle(value_t) + 14 * k,
                f"p95 {fmt(r['p95'])}",
                p95_t,
                theme.ink3,
            )
        del vw
    doc.add(
        f'<path d="M{n(x0)} {n(plot_top - 6)}V{n(plot_top + plot_h)}" {theme.hairline_strong.stroke()}/>'
    )

    # Foot
    fy = plot_top + plot_h + axis_h + 24 + foot_t.size
    for line, ink in foot_lines:
        doc.text(pad, fy, line, foot_t, ink)
        fy += foot_t.size * foot_t.leading

    if fixture:
        warn = Ink(oklch(0.66, 0.18, 28))
        doc.add(f'<g opacity=".9" transform="rotate(-14 {n(W / 2)} {n(H / 2)})">')
        words = "FAKE FIXTURE · NOT A MEASUREMENT"
        mark_t = Type("neue-medium", 64 * W * 0.9 / face("neue-medium").width(words, 64, 0.02), tracking=0.02)
        doc.text(
            W / 2,
            H / 2 + 20,
            "FAKE FIXTURE · NOT A MEASUREMENT",
            mark_t,
            warn.with_a(0.55),
            anchor="middle",
        )
        doc.add("</g>")
    return doc


def pending(theme: Theme, narrow: bool = False) -> Doc:
    """The card the README shows until pod-bench publishes: what is measured, and no number."""
    k = 1.3 if narrow else 1.0
    W = 720 if narrow else 1280
    pad = 40 * (0.8 if narrow else 1)
    eyebrow_t = Type("suisse", 16 * k)
    title_t = Type("neue", 40 * k, 1.12, -0.022)
    body_t = Type("suisse", 20 * k, 1.45)
    item_t = Type("neue-medium", 18 * k)
    suites = [
        "Keystroke to pixels",
        "Terminal throughput",
        "Code search vs ripgrep",
        "Startup",
        "Many panes",
        "Idle polling",
        "Git status",
    ]
    cols = 2 if narrow else 4
    rows_n = (len(suites) + cols - 1) // cols
    lead = (
        "Pod's numbers come from pod-bench: every run records n, the median and p95, the machine and the "
        "date. They appear here as soon as the first run is published, and not before."
    )
    lead_rows = wrap(lead, body_t, W - 2 * pad)
    H = (
        pad
        + eyebrow_t.size
        + 16
        + title_t.size * 2.3
        + len(lead_rows) * body_t.size * body_t.leading
        + 28
        + rows_n * 52 * k
        + pad
    )
    doc = Doc(
        W,
        H,
        "Benchmarks: being measured. No numbers until pod-bench publishes its first run.",
    )
    doc.style(
        "@keyframes blink{50%{opacity:.25}}.blink{animation:blink 1.6s cubic-bezier(0.65,0,0.35,1) infinite}"
    )
    panel = squircle(0.5, 0.5, W - 1, H - 1, 28)
    doc.add(f'<path d="{panel}" {_ground(theme).fill()}/>')
    doc.add(ring(panel, Ink("#ffffff", 0.09) if theme.dark else theme.hairline_strong))
    y = pad + eyebrow_t.size * 0.8
    doc.add(
        f'<circle class="blink" cx="{n(pad + 5)}" cy="{n(y - cap_middle(eyebrow_t))}" r="{4 * k:g}" {theme.pod_glyph.fill()}/>'
    )
    doc.text(pad + 18 * k, y, "Benchmarks", eyebrow_t, theme.pod_ink)
    y += 16 + title_t.size
    doc.text(pad, y, "Being measured.", title_t, theme.ink)
    y += title_t.size * title_t.leading
    doc.text(pad, y, "Numbers, not adjectives.", title_t, theme.ink3)
    y += title_t.size * 0.9 + body_t.size
    y = doc.lines(pad, y, lead_rows, body_t, theme.ink2) + 28
    cw = (W - 2 * pad) / cols
    for i, s in enumerate(suites):
        cx, cy = pad + (i % cols) * cw, y + (i // cols) * 52 * k
        doc.add(
            f'<path d="M{n(cx)} {n(cy)}h{n(cw - 20)}" {theme.hairline_strong.stroke()}/>'
        )
        doc.text(cx, cy + 32 * k, s, item_t, theme.ink)
    return doc


def find_summary(results: Path | None) -> Path | None:
    root = results or (REPO / "bench" / "results")
    if root.is_file():
        return root
    if not root.is_dir():
        return None
    dated = sorted(p for p in root.glob("*/summary.json"))
    return dated[-1] if dated else None


ACC_PENDING = (
    "<sub>claude-acc's numbers come from pod-bench's claude-acc group. Fresh runs are drawn solid; "
    "figures measured before Pod are hatched and carry their date and source. Being collected.</sub>\n"
)


def readme_block(
    charts: list[tuple[str, dict]], summary: dict | None, prefix: str
) -> str:
    if not summary:
        return (
            "<picture>\n"
            f'  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="{prefix}bench-pending-narrow-dark.svg">\n'
            f'  <source media="(max-width: 600px)" srcset="{prefix}bench-pending-narrow-light.svg">\n'
            f'  <source media="(prefers-color-scheme: dark)" srcset="{prefix}bench-pending-dark.svg">\n'
            f'  <img alt="Benchmarks are being measured. No numbers are shown until pod-bench publishes its first run." src="{prefix}bench-pending-light.svg" width="100%">\n'
            "</picture>\n"
        )
    out = []
    for name, g in charts:
        alt = f"{SUITE_NAMES.get(g['suite'], g['suite'])}: {g['metric']}. " + "; ".join(
            f"{r['subject']} median {fmt(r['median'])} {g['unit']}, p95 {fmt(r['p95'])}, n {r['n']}"
            for r in g["rows"]
        )
        out.append(
            "<picture>\n"
            f'  <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="{prefix}{name}-narrow-dark.svg">\n'
            f'  <source media="(max-width: 600px)" srcset="{prefix}{name}-narrow-light.svg">\n'
            f'  <source media="(prefers-color-scheme: dark)" srcset="{prefix}{name}-dark.svg">\n'
            f'  <img alt="{alt}" src="{prefix}{name}-light.svg" width="100%">\n'
            "</picture>\n"
        )
    rows = [
        "| Benchmark | Subject | Median | p95 | n | Min | Max | Measured |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for _, g in charts:
        for r in g["rows"]:
            p = provenance(r)
            when = "this run" if not p else f"historical, {p.get('date', 'earlier')}" + (f" ({p['source']})" if p.get("source") else "")
            rows.append(
                f"| {g['metric']} | {r['subject']} | {r['median']} {g['unit']} | {r['p95']} | {r['n']} | {r.get('min')} | {r.get('max')} | {when} |"
            )
    date = (
        summary.get("resultsDir", "").split("/")[-1]
        or summary.get("generatedAt", "")[:10]
    )
    out.append(
        "\n<details>\n<summary>Every number, as measured</summary>\n\n"
        + "\n".join(rows)
        + f"\n\nMeasured on {summary.get('hardware', 'unrecorded hardware')}, {date}. "
        + f"Source: `{summary.get('resultsDir', 'bench/results')}/summary.json`. "
        + f"How it is measured: [bench/README.md]({METHODOLOGY}).\n"
        + "".join(f"\n- Caveat: {c}" for c in summary.get("caveats", []))
        + "\n\n</details>\n"
    )
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--results",
        type=Path,
        help="a summary.json, or a results dir holding <date>/summary.json",
    )
    ap.add_argument(
        "--fixture",
        action="store_true",
        help="draw the FAKE fixture (layout test only)",
    )
    ap.add_argument("--out", type=Path, default=ASSETS)
    ap.add_argument(
        "--readme",
        action="store_true",
        help="rewrite the bench block in .github/README.md",
    )
    args = ap.parse_args()
    path = FIXTURE if args.fixture else find_summary(args.results)
    summary = json.loads(path.read_text()) if path else None
    out = args.out.resolve()
    if summary and "fixture" in summary and (out == ASSETS or ASSETS in out.parents):
        raise SystemExit(
            "refusing to write FAKE fixture charts into .github/assets; pass --out to a scratch dir"
        )
    out.mkdir(parents=True, exist_ok=True)
    charts: list[tuple[str, dict]] = []
    if summary:
        for g in groups(summary):
            name = f"bench-{g['suite']}-{slug(g['metric'])}"
            for t in THEMES:
                chart(g, summary, t).save(out / f"{name}-{t.name}.svg")
                chart(g, summary, t, narrow=True).save(
                    out / f"{name}-narrow-{t.name}.svg"
                )
            charts.append((name, g))
            print(f"{name}: {len(g['rows'])} rows")
    else:
        for t in THEMES:
            pending(t).save(out / f"bench-pending-{t.name}.svg")
            pending(t, narrow=True).save(out / f"bench-pending-narrow-{t.name}.svg")
        print("no summary.json yet: wrote the pending card")
    if args.readme:
        if summary and "fixture" in summary:
            raise SystemExit("refusing to put FAKE fixture data into the README")
        readme = REPO / ".github" / "README.md"
        text = readme.read_text()
        main_charts = [(nm, g) for nm, g in charts if g["suite"] != "claude-acc"]
        acc_charts = [(nm, g) for nm, g in charts if g["suite"] == "claude-acc"]
        block = readme_block(main_charts, summary, "assets/")
        acc_block = readme_block(acc_charts, summary, "assets/") if acc_charts else ACC_PENDING
        new = re.sub(
            r"(<!-- bench:start -->\n).*?(<!-- bench:end -->)",
            lambda m: m.group(1) + block + m.group(2),
            text,
            flags=re.DOTALL,
        )
        new = re.sub(
            r"(<!-- bench:claude-acc:start -->\n).*?(<!-- bench:claude-acc:end -->)",
            lambda m: m.group(1) + acc_block + m.group(2),
            new,
            flags=re.DOTALL,
        )
        readme.write_text(new)
        print("README bench blocks updated")


if __name__ == "__main__":
    main()
