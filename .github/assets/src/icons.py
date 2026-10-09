"""
Central Icons (round, radius 2, stroke 1.5) as pod-site bakes them
(pod-site components/icons.generated.tsx), on a 24 x 24 grid in currentColor.
Only the glyphs the README draws are copied here.
"""

from __future__ import annotations

from house import Doc, Ink, n

GLYPHS = {
    "ArrowRight": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M14 5.75 20.25 12 14 18.25M19.5 12H3.75\"/>",
    "ArrowUpRightGlyph": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M18.25 15.25v-9.5m0 0h-9.5m9.5 0L6 18\"/>",
    "Copy": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M15.25 8.75V4c0-.69-.56-1.25-1.25-1.25H4c-.69 0-1.25.56-1.25 1.25v10c0 .69.56 1.25 1.25 1.25h4.75M10 8.75h10c.69 0 1.25.56 1.25 1.25v10c0 .69-.56 1.25-1.25 1.25H10c-.69 0-1.25-.56-1.25-1.25V10c0-.69.56-1.25 1.25-1.25\"/>",
    "Download": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M8.75 21.25h-2c-1.1 0-2-.9-2-2V4.75c0-1.1.9-2 2-2h5.17c.53 0 1.04.21 1.42.59l5.32 5.32c.38.38.59.89.59 1.42v9.17c0 1.1-.9 2-2 2h-2\"/><path stroke=\"currentColor\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M12.75 3.25v4c0 1.1.9 2 2 2h4\"/><path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M12 13.75V20l2.5-2.5M12 20l-2.5-2.5\"/>",
    "Console": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M7.25 7.75 9 9.5l-1.75 1.75m3.5 0h2m-7 9h12.5c1.1 0 2-.9 2-2V5.75c0-1.1-.9-2-2-2H5.75c-1.1 0-2 .9-2 2v12.5c0 1.1.9 2 2 2\"/>",
    "Search": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"m20.25 20.25-4.12-4.12m0 0c1.3-1.32 2.12-3.13 2.12-5.13 0-4-3.25-7.25-7.25-7.25S3.75 7 3.75 11 7 18.25 11 18.25c2 0 3.81-.81 5.13-2.12\"/>",
    "Branch": "<circle cx=\"6.5\" cy=\"6\" r=\"2.25\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"/><circle cx=\"6.5\" cy=\"18\" r=\"2.25\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"/><circle cx=\"17.5\" cy=\"6\" r=\"2.25\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"/><path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M6.5 8.25v7.5m11-7.5V10c0 1.1-.9 2-2 2h-7c-1.1 0-2 .9-2 2v1.75\"/>",
    "Server": "<path stroke=\"currentColor\" stroke-linecap=\"square\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M2.75 6.75c0-1.1.9-2 2-2h14.5c1.1 0 2 .9 2 2V12H2.75zm0 5.25h18.5v5.25c0 1.1-.9 2-2 2H4.75c-1.1 0-2-.9-2-2z\"/><path fill=\"currentColor\" stroke=\"currentColor\" stroke-width=\".5\" d=\"M6.5 14.88c.41 0 .75.33.75.74 0 .42-.34.76-.75.76s-.75-.34-.75-.75c0-.42.34-.76.75-.76Zm0-7.26c.41 0 .75.34.75.75 0 .42-.34.76-.75.76s-.75-.34-.75-.76c0-.4.34-.74.75-.74Z\"/>",
    "Rotate": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"m10.75 1.5 3.5 3.25L10.75 8m2.5 8-3.5 3.25 3.5 3.25\"/><path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-width=\"1.5\" d=\"M10.75 19.25H14c4 0 7.25-3.25 7.25-7.25 0-2.18-.97-4.14-2.5-5.47m-5.5-1.78H10C6 4.75 2.75 8 2.75 12c0 2.19.97 4.14 2.5 5.47\"/>",
    "Shield": "<path stroke=\"currentColor\" stroke-linecap=\"square\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M20.25 6.94c0-.86-.55-1.62-1.37-1.9l-6.25-2.08c-.4-.14-.85-.14-1.26 0L5.12 5.04c-.82.28-1.37 1.04-1.37 1.9v4.97c0 4.97 4.25 7.34 8.25 9.5 4-2.16 8.25-4.53 8.25-9.5z\"/>",
    "Chip": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M7.75 5.25v-1.5M12 5.25v-1.5m4.25 1.5v-1.5m-8.5 16.5v-1.5m4.25 1.5v-1.5m4.25 1.5v-1.5m-7.5-3.5h6.5c.55 0 1-.45 1-1v-4.5c0-.55-.45-1-1-1h-6.5c-.55 0-1 .45-1 1v4.5c0 .55.45 1 1 1m-3 5h12.5c1.1 0 2-.9 2-2V5.75c0-1.1-.9-2-2-2H5.75c-1.1 0-2 .9-2 2v12.5c0 1.1.9 2 2 2\"/>",
    "Broom": "<path stroke=\"currentColor\" stroke-linecap=\"square\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M11.38 8.76c-.96-.53-2.17-.18-2.71.78-.26.47-.52.93-.78 1.4l10.26 5.65c.26-.46.51-.92.77-1.38.54-.97.19-2.19-.78-2.72zm1.61.24 2.9-5.08c.63-1.1 2.04-1.5 3.16-.88s1.53 2.03.9 3.15l-2.86 5.14m-8.16.49c-1.7 1.99-3.62 2.59-6.18 2.05 1.03 6.82 12.87 11.26 13.9 2.56\"/>",
    "Cup": "<path stroke=\"currentColor\" stroke-width=\"1.5\" d=\"M4.75 8.75c0-.55.45-1 1-1h10.5c.55 0 1 .45 1 1v10.5c0 1.1-.9 2-2 2h-8.5c-1.1 0-2-.9-2-2zm12.5 1h1.25c1.52 0 2.75 1.23 2.75 2.75s-1.23 2.75-2.75 2.75h-1.25z\"/><path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-width=\"1.5\" d=\"M11 5.25v-2.5m-4 2.5v-2.5m8 2.5v-2.5\"/>",
    "Wind": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M2.75 12h16.5c1.1 0 2-.9 2-2s-.9-2-2-2c-.62 0-1.17.28-1.53.72M2.75 7.75h8.5c1.1 0 2-.9 2-2s-.9-2-2-2c-.62 0-1.16.28-1.53.72M2.75 16.25h12.5c1.1 0 2 .9 2 2s-.9 2-2 2c-.68 0-1.28-.34-1.64-.86\"/>",
    "EyeSlash": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M9.38 5.14c4.2-1.27 8.82.56 11.84 5.46.26.42.4.63.47.96.05.24.05.64 0 .88-.08.33-.2.54-.47.96-.47.76-.98 1.45-1.52 2.06M9.5 9.92c-.47.57-.75 1.29-.75 2.08 0 1.8 1.46 3.25 3.25 3.25.8 0 1.54-.3 2.1-.77\"/><path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M6.22 6.75c-1.27.95-2.44 2.23-3.44 3.85-.26.42-.4.63-.47.96-.05.24-.05.64 0 .88.08.33.2.54.47.96 3.65 5.92 9.61 7.35 14.38 4.28M2.75 2.75l18.5 18.5\"/>",
    "Book": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M19.25 12v2.75c0 1.1-.9 2-2 2H7c-1.24 0-2.25 1-2.25 2.25 0 1.24 1 2.25 2.25 2.25h3M8.75 7h6.5m-6.5 4h3.5m-5.5-8.25h10.5c1.1 0 2 .9 2 2v14.5c0 1.1-.9 2-2 2H6.75c-1.1 0-2-.9-2-2V4.75c0-1.1.9-2 2-2\"/>",
    "Github": "<path fill=\"currentColor\" d=\"M12 1.95c5.52 0 10 4.48 10 10 0 2.1-.66 4.14-1.88 5.84s-2.95 2.98-4.93 3.65c-.5.1-.69-.21-.69-.48 0-.33.01-1.4.01-2.75 0-.93-.31-1.53-.67-1.85 2.22-.25 4.56-1.1 4.56-4.93 0-1.1-.39-2-1.02-2.7.1-.24.45-1.27-.1-2.64 0 0-.84-.28-2.76 1.02-.8-.22-1.64-.33-2.5-.33-.84 0-1.7.1-2.5.33C7.63 5.83 6.79 6.1 6.79 6.1c-.56 1.37-.2 2.4-.1 2.65-.64.7-1.03 1.6-1.03 2.69 0 3.82 2.32 4.68 4.55 4.93-.29.25-.55.7-.64 1.34-.57.26-2.01.69-2.91-.82-.19-.3-.75-1.04-1.54-1.03-.83.01-.33.48.01.66.43.24.92 1.13 1.03 1.42.2.56.85 1.63 3.36 1.17 0 .84.02 1.63.02 1.86 0 .27-.2.57-.7.48-1.98-.66-3.72-1.94-4.94-3.64S1.99 14.05 2 11.95c0-5.52 4.47-10 10-10\"/>",
    "Globe": "<path stroke=\"currentColor\" stroke-linecap=\"square\" stroke-width=\"1.5\" d=\"M21.25 12c0 5.1-4.14 9.25-9.25 9.25-5.1 0-9.25-4.14-9.25-9.25 0-5.1 4.14-9.25 9.25-9.25 5.1 0 9.25 4.14 9.25 9.25Z\"/><path stroke=\"currentColor\" stroke-linecap=\"square\" stroke-width=\"1.5\" d=\"M12 21c-2.2 0-4-4.03-4-9s1.8-9 4-9 4 4.03 4 9-1.8 9-4 9Zm9-9H3\"/>",
    "Check": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"m7.75 13.06 3.19 3.19 5.31-8.5\"/>",
    # Not in pod-site's set: drawn here on the same grid, round, stroke 1.5.
    "Bolt": '<path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13.25 2.75 5.75 13.25h5.5l-.75 8 7.75-10.5H12.5z"/>',
    "MenuBar": '<rect x="2.75" y="3.75" width="18.5" height="16.5" rx="2.25" stroke="currentColor" stroke-width="1.5"/><path stroke="currentColor" stroke-linecap="round" stroke-width="1.5" d="M2.75 8.25h18.5M15.5 6h2.75M12.75 11.75h5.5v5.5h-5.5z"/>',
}


def icon(doc: Doc, name: str, x: float, y: float, size: float, ink: Ink) -> None:
    """A glyph with its top-left corner at (x, y), drawn at size px."""
    s = size / 24
    op = f' opacity="{ink.a:g}"' if ink.a < 1 else ""
    doc.add(f'<g transform="translate({n(x)} {n(y)}) scale({s:.4f})" color="{ink.hex}" fill="none"{op}>{GLYPHS[name]}</g>')
