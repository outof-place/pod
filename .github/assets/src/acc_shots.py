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
SHOTS = ("orca-plugin-panel.png", "orca-plugin-statusbar.png", "panel.png")


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


def window_html(img: dict[str, str], narrow: bool) -> tuple[str, int, int]:
    """The plugin's panel and status bar: Pod's window, where the agents are."""
    if narrow:
        w, h = 720, 1160
        body = f"""
<div class="stage" style="width:{w}px;height:{h}px">
 <div style="left:40px;top:44px"><span class="chip"><i></i>In the Pod window</span></div>
 <h2 style="left:40px;top:96px;font-size:46px">In the window.<span>Next to the agents.</span></h2>
 <div class="card fade" style="left:118px;top:262px;width:484px;height:700px"><img src="{img["orca-plugin-panel.png"]}"></div>
 <div class="card" style="left:40px;top:1004px;width:640px;padding:10px 14px;background:#fff"><img src="{img["orca-plugin-statusbar.png"]}"></div>
 <div class="cap" style="left:40px;top:1110px">claude-acc's panel and status bar in Pod. Demo data.</div>
</div>"""
        return body, w, h
    w, h = 1280, 760
    calls = [(150, "Account"), (300, "Other accounts"), (440, "Memory"), (610, "Builds")]
    call_html = "".join(f'<div class="call" style="left:600px;top:{48 + y}px;width:180px"><b>{t}</b><em></em></div>' for y, t in calls)
    body = f"""
<div class="stage" style="width:{w}px;height:{h}px">
 <div style="left:64px;top:56px"><span class="chip"><i></i>In the Pod window</span></div>
 <h2 style="left:64px;top:108px;font-size:52px">In the window.<span>Next to the agents.</span></h2>
 <p class="lead" style="left:64px;top:252px;width:440px">A Pod plugin puts claude-acc in the status bar and in a panel of its own: the account and its next switch, memory against the dev servers' budget, and builds waiting for memory.</p>
 <div style="left:64px;top:392px" class="cap">Status bar</div>
 <div class="card" style="left:64px;top:418px;width:480px;padding:8px 12px;background:#fff"><img src="{img['orca-plugin-statusbar.png']}"></div>
 {call_html}
 <div class="card fade" style="left:790px;top:48px;width:400px;height:712px"><img src="{img['orca-plugin-panel.png']}"></div>
 <div class="cap" style="left:64px;top:704px">claude-acc's panel and status bar in Pod. Demo data.</div>
</div>"""
    return body, w, h


def menu_html(img: dict[str, str], narrow: bool) -> tuple[str, int, int]:
    """The menu bar helper's panel (Claude Acc.app today, Pod Menu planned)."""
    if narrow:
        w, h = 720, 740
        body = f"""
<div class="stage" style="width:{w}px;height:{h}px">
 <div style="left:40px;top:44px"><span class="chip"><i></i>In the menu bar</span></div>
 <h2 style="left:40px;top:96px;font-size:46px">In the menu bar.<span>The whole Mac, in one panel.</span></h2>
 <div class="card" style="left:40px;top:262px;width:640px"><img src="{img['panel.png']}"></div>
 <div class="cap" style="left:40px;top:{262 + 362 + 18}px">The menu bar helper. Demo data.</div>
</div>"""
        return body, w, h
    w, h = 1280, 940
    body = f"""
<div class="stage" style="width:{w}px;height:{h}px">
 <div style="left:64px;top:56px"><span class="chip"><i></i>In the menu bar</span></div>
 <h2 style="left:64px;top:104px;font-size:44px">In the menu bar.<span>The whole Mac, in one panel.</span></h2>
 <div class="card" style="left:64px;top:228px;width:1152px"><img src="{img["panel.png"]}"></div>
 <div class="cap" style="left:64px;top:{228 + 652 + 18}px">The menu bar helper. Demo data.</div>
</div>"""
    return body, w, h


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
    jobs = [("acc-window", window_html), ("acc-menu", menu_html)]
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
