# /// script
# requires-python = ">=3.12,<3.15"
# dependencies = ["playwright>=1.50", "pillow>=11"]
# ///
"""
claude-acc's own screenshots (its repo's docs/, demo data), framed on the
studio's black stage for the README's claude-acc section.

    uv run .github/assets/src/acc_shots.py [path to a claude-acc checkout]

They are rasters, so they're drawn by Chromium from HTML with the studio's
fonts and saved as WebP: pixels only, no font file leaves this machine. The
claude-acc checkout defaults to ~/Documents/claude-acc; the images are read
from its origin/main with git, so local edits there don't leak in.
"""

from __future__ import annotations

import asyncio
import base64
import subprocess
import sys
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from house import _FONT_FILES, _find_font

OUT = Path(__file__).resolve().parent.parent
SHOTS = ("panel.png",)


def _data(raw: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def _fonts_css() -> str:
    faces = [
        ("Neue", "neue", 400),
        ("Neue", "neue-medium", 500),
        ("Suisse", "suisse", 400),
    ]
    return "".join(
        f"@font-face{{font-family:{fam};font-weight:{w};src:url({_data(_find_font(k).read_bytes(), 'font/woff2')})}}"
        for fam, k, w in faces
    )


STAGE_CSS = """
*{box-sizing:border-box;margin:0}
body{background:transparent;font-family:Suisse,system-ui;-webkit-font-smoothing:antialiased}
.stage{position:relative;overflow:hidden;border-radius:48px;background:#000;color:#f1f0eb;corner-shape:squircle}
.stage::before{content:"";position:absolute;inset:0;background:
 radial-gradient(70% 60% at 82% 6%,oklch(.46 .06 205/.55),oklch(.34 .06 205/.32) 34%,oklch(.24 .06 205/.12) 58%,transparent 82%),
 radial-gradient(60% 40% at 10% 100%,oklch(.24 .06 205/.4),transparent 70%)}
.stage::after{content:"";position:absolute;inset:0;background-image:radial-gradient(circle,oklch(.8 .05 205/.5) .9px,transparent 1.3px);background-size:16px 16px;
 mask-image:radial-gradient(60% 55% at 82% 8%,#000,rgba(0,0,0,.5) 40%,transparent 75%)}
.stage>*{position:absolute;z-index:1}
h2{font-family:Neue;font-weight:400;letter-spacing:-.0227em;line-height:1.08}
h2 span{display:block;color:rgba(241,240,235,.54)}
.lead{font-size:17px;line-height:1.42;color:rgba(241,240,235,.64)}
.chip{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 12px;border-radius:14px;background:rgba(255,255,255,.08);
 font-family:Neue;font-weight:500;font-size:13px;color:rgba(241,240,235,.8)}
.chip i{width:7px;height:7px;border-radius:50%;background:oklch(.8 .1 205)}
.card{border-radius:22px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 30px 90px -20px oklch(.46 .06 205/.5),0 12px 40px -4px rgba(0,0,0,.6);corner-shape:squircle}
.card img{display:block;width:100%}
.fade{mask-image:linear-gradient(#000 78%,transparent)}
.call{display:flex;align-items:center;gap:12px;font-size:15px;color:rgba(241,240,235,.72);white-space:nowrap}
.call b{font-family:Neue;font-weight:500;color:#f1f0eb}
.call::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,rgba(255,255,255,.28),oklch(.8 .1 205/.7))}
.call em{order:2;width:7px;height:7px;border-radius:50%;background:oklch(.8 .1 205);font-style:normal}
.cap{font-size:13px;color:rgba(241,240,235,.45)}
"""


def menu_html(img: dict[str, str], narrow: bool) -> tuple[str, int, int]:
    """
    The menu bar helper's panel (Claude Acc.app today, Pod Menu planned), cropped to its first three
    columns: the fourth, Ultra, shows demo before/after figures, and the README carries no demo
    numbers. The foot fades out before the builds summary for the same reason.
    """
    # panel.png is 2768 x 1567 px at 2x; the crop keeps x < 2125 and fades out by y = 1384.
    crop_w, crop_h, full_w = 2125 / 2, 1384 / 2, 2768 / 2
    if narrow:
        w = 720
        card_w = 640
    else:
        w = 1280
        card_w = crop_w
    k = card_w / crop_w
    card_h = crop_h * k
    top = 262 if narrow else 228
    h = top + card_h + 70
    head = (
        '<div style="left:40px;top:44px"><span class="chip"><i></i>In the menu bar</span></div>'
        '<h2 style="left:40px;top:96px;font-size:46px">In the menu bar.<span>The whole Mac, in one panel.</span></h2>'
        if narrow
        else '<div style="left:64px;top:56px"><span class="chip"><i></i>In the menu bar</span></div>'
        '<h2 style="left:64px;top:104px;font-size:44px">In the menu bar.<span>The whole Mac, in one panel.</span></h2>'
    )
    left = 40 if narrow else (w - card_w) / 2
    body = f"""
<div class="stage" style="width:{w}px;height:{h:.0f}px">
 {head}
 <div class="card" style="left:{left:.0f}px;top:{top}px;width:{card_w:.0f}px;height:{card_h:.0f}px;background:#1c1c1e;mask-image:linear-gradient(#000 68%,transparent 90%)">
  <img src="{img['panel.png']}" style="width:{full_w * k:.0f}px;max-width:none"></div>
 <div class="cap" style="left:{40 if narrow else 64}px;top:{top + card_h + 22:.0f}px">The menu bar helper: accounts, dev servers and builds, Stay Awake, load and heat. Demo data.</div>
</div>"""
    return body, w, int(h)


def _shots(repo: Path) -> dict[str, str]:
    out = {}
    for name in SHOTS:
        raw = subprocess.run(
            ["git", "-C", str(repo), "show", f"origin/main:docs/{name}"],
            check=True,
            capture_output=True,
        ).stdout
        out[name] = _data(raw, "image/png")
    return out


async def render(repo: Path) -> None:
    from PIL import Image
    from playwright.async_api import async_playwright

    img = _shots(repo)
    fonts = _fonts_css()
    jobs = [("acc-menu", menu_html)]
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        for name, make in jobs:
            for narrow in (False, True):
                body, w, h = make(img, narrow)
                page = await browser.new_page(
                    viewport={"width": w, "height": h}, device_scale_factor=2
                )
                await page.set_content(f"<style>{fonts}{STAGE_CSS}</style>{body}")
                await page.evaluate("document.fonts.ready")
                await page.wait_for_timeout(300)
                png = await page.locator(".stage").screenshot(omit_background=True)
                await page.close()
                target = OUT / f"{name}{'-narrow' if narrow else ''}.webp"
                Image.open(BytesIO(png)).save(target, "WEBP", quality=90, method=6)
                print(f"{target.name:40s} {target.stat().st_size / 1024:7.1f} KB")
        await browser.close()


if __name__ == "__main__":
    assert set(_FONT_FILES)  # fonts resolve through house.py's search path
    asyncio.run(
        render(
            Path(
                sys.argv[1] if len(sys.argv) > 1 else "~/Documents/claude-acc"
            ).expanduser()
        )
    )
