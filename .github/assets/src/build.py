# /// script
# requires-python = ">=3.12,<3.15"
# dependencies = ["fonttools>=4.55", "brotli>=1.1", "uharfbuzz>=0.45"]
# ///
"""
Builds the README's images into .github/assets/.

    uv run .github/assets/src/build.py            # everything
    uv run .github/assets/src/build.py hero why   # some of it

Needs the studio's Neue Montreal and Suisse Intl files and JetBrains Mono
(OFL) on this machine, found through POD_README_FONTS (see house.py). Only
outlines of the words drawn are written; no font file is copied.
Benchmark charts come from bench.py, which reads pod-bench's results.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from house import THEMES

OUT = Path(__file__).resolve().parent.parent
LIMIT = 300_000


def _write(name: str, doc) -> None:
    size = doc.save(OUT / name)
    flag = "  OVER BUDGET" if size > LIMIT else ""
    print(f"{name:40s} {size / 1024:7.1f} KB{flag}")


def build_hero() -> None:
    from hero import hero

    for t in THEMES:
        _write(f"hero-{t.name}.svg", hero(t))
        _write(f"hero-narrow-{t.name}.svg", hero(t, narrow=True))


def build_why() -> None:
    from cards import why

    for t in THEMES:
        _write(f"why-{t.name}.svg", why(t))
        _write(f"why-narrow-{t.name}.svg", why(t, narrow=True))


def build_buttons() -> None:
    from buttons import buttons

    for t in THEMES:
        for name, doc in buttons(t).items():
            _write(f"{name}-{t.name}.svg", doc)


def build_acc() -> None:
    from cards import acc_grid

    for t in THEMES:
        _write(f"acc-features-{t.name}.svg", acc_grid(t))
        _write(f"acc-features-narrow-{t.name}.svg", acc_grid(t, narrow=True))


def build_window() -> None:
    from window import window

    for t in THEMES:
        _write(f"window-{t.name}.svg", window(t))
        _write(f"window-narrow-{t.name}.svg", window(t, narrow=True))


def build_arch() -> None:
    from arch import DIAGRAMS, render

    for name, make in DIAGRAMS.items():
        for t in THEMES:
            _write(f"arch-{name}-{t.name}.svg", render(make(), t))
            _write(f"arch-{name}-narrow-{t.name}.svg", render(make(narrow=True), t))


TARGETS = {
    "hero": build_hero,
    "buttons": build_buttons,
    "window": build_window,
    "why": build_why,
    "acc": build_acc,
    "arch": build_arch,
}


def main(argv: list[str]) -> None:
    names = argv or list(TARGETS)
    for name in names:
        if name not in TARGETS:
            raise SystemExit(f"unknown target {name}; one of {', '.join(TARGETS)}")
        TARGETS[name]()


if __name__ == "__main__":
    main(sys.argv[1:])
