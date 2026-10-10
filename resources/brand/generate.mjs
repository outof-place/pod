#!/usr/bin/env node
/**
 * Pod's brand assets from one geometry: the mark (a pod holding three peas,
 * the agents of one fleet), drawn as
 *
 * - the app icon, an Icon Composer document (resources/icon-source/icon.icon):
 *   a sea background, the pod as a white Liquid Glass shell, and the peas as a
 *   second glass group lying on it;
 * - the menu bar template image (resources/tray/pod-menu-barTemplate*.png);
 * - the logo SVG the renderer shows (resources/logo.svg);
 * - a custom SF Symbol template (resources/brand/pod.mark.svg), and for the
 *   native SwiftUI shell an asset catalog plus the icon document
 *   (resources/brand/native/{Assets.xcassets,Pod.icon}).
 *
 * Colours are the outofplace studio's OKLCH tokens (pod.codes styles/theme.css):
 * Pod's sea hue 205 at the studio's field lightness and chroma, the warm ink
 * (hue 91) for the shell. No Orca mark is used anywhere.
 *
 * Usage: node resources/brand/generate.mjs [--preview]
 *   Writes the sources. `resources/icon-source/generate.sh` then compiles the
 *   .icns/.png/.ico fallbacks, and `--preview` renders review PNGs into
 *   resources/brand/preview/ with Icon Composer's own renderer (ictool).
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const BRAND = path.dirname(new URL(import.meta.url).pathname);
const RESOURCES = path.dirname(BRAND);
const ICON_DOC = path.join(RESOURCES, "icon-source", "icon.icon");

/* ── Colour: OKLCH → Display P3 (for Icon Composer) and sRGB hex (for SVG) ── */

function oklchToLinearSrgb(l, c, h) {
  const r = (h * Math.PI) / 180;
  const a = c * Math.cos(r);
  const b = c * Math.sin(r);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
}
const gamma = (x) => {
  const v = Math.abs(x) <= 0.0031308 ? 12.92 * x : Math.sign(x) * (1.055 * Math.abs(x) ** (1 / 2.4) - 0.055);
  return Math.min(1, Math.max(0, v));
};
/** Linear sRGB → linear Display P3 (both D65). */
function linearSrgbToP3([r, g, b]) {
  return [
    0.8224621 * r + 0.177538 * g + 0.0000001 * b,
    0.0331941 * r + 0.9668058 * g + 0.0000001 * b,
    0.0170827 * r + 0.0723974 * g + 0.9105199 * b,
  ];
}
const fmt = (n) => n.toFixed(5);
/** An Icon Composer colour string in Display P3. */
const p3 = (l, c, h, alpha = 1) =>
  `display-p3:${[...linearSrgbToP3(oklchToLinearSrgb(l, c, h)).map(gamma), alpha].map(fmt).join(",")}`;
const hex = (l, c, h) =>
  `#${oklchToLinearSrgb(l, c, h)
    .map(gamma)
    .map((v) => Math.round(v * 255).toString(16).padStart(2, "0"))
    .join("")}`;

const HUE = 205;
const INK = [0.958, 0.004, 91];
const COLORS = {
  // Light (default) appearance: the studio's field, lit from the top.
  bgTop: [0.5, 0.075, HUE],
  bgBottom: [0.27, 0.06, HUE],
  peas: [0.62, 0.1, HUE],
  // Dark appearance: the black canvas with the sea's light.
  darkBgTop: [0.26, 0.045, HUE],
  darkBgBottom: [0.11, 0.02, HUE],
  darkPeas: [0.8, 0.1, HUE],
};

/* ── Geometry ─────────────────────────────────────────────────────────────── */

/**
 * The pod in unit space: a lens one unit long on the x axis, its back (−y)
 * bulging more than its seam, three peas along it, lifted toward the back.
 * Every asset bakes this through an affine matrix, so paths carry no transforms.
 */
const POD = {
  top: 0.36,
  bottom: 0.25,
  inset: 0.42,
  peas: { r: 0.078, spacing: 0.205, rise: 0.03 },
  rotate: -35,
};

const podCubics = ({ top, bottom, inset }) => [
  [[-0.5, 0], [-0.5 + inset, -top], [0.5 - inset, -top], [0.5, 0]],
  [[0.5, 0], [0.5 - inset, bottom], [-0.5 + inset, bottom], [-0.5, 0]],
];
const peaCircles = ({ r, spacing, rise }) => [-spacing, 0, spacing].map((x) => ({ x, y: -rise, r }));

/** A 2×3 affine matrix [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];
const rotation = (deg, s = 1) => {
  const t = (deg * Math.PI) / 180;
  return [s * Math.cos(t), s * Math.sin(t), -s * Math.sin(t), s * Math.cos(t), 0, 0];
};
const n = (v) => +v.toFixed(3);

/** The pod's outline under `m`, sampled: its bounding box decides how it fits a box. */
function bounds(m) {
  const pts = [];
  for (const [p0, p1, p2, p3] of podCubics(POD))
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      const u = 1 - t;
      pts.push(
        apply(m, [
          u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
          u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1],
        ]),
      );
    }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** The matrix that turns the pod by POD.rotate and fits it, centred, into w × h less `pad`. */
function fit(w, h, pad = 0, rotate = POD.rotate) {
  const r = rotation(rotate);
  const b = bounds(r);
  const s = Math.min((w - 2 * pad) / (b.x1 - b.x0), (h - 2 * pad) / (b.y1 - b.y0));
  const m = rotation(rotate, s);
  const c = bounds(m);
  return [m[0], m[1], m[2], m[3], w / 2 - (c.x0 + c.x1) / 2, h / 2 - (c.y0 + c.y1) / 2];
}
const scaleOf = (m) => Math.hypot(m[0], m[1]);

function shellPath(m) {
  const [[p0, ...a], [, ...b]] = podCubics(POD).map((cubic) => cubic.map((p) => apply(m, p)));
  const pt = (p) => `${n(p[0])} ${n(p[1])}`;
  return `M${pt(p0)}C${a.map(pt).join(" ")} ${b.map(pt).join(" ")}Z`;
}
/** A circle as two arcs; counter-clockwise ones cut holes under either fill rule. */
function circlePath({ x, y, r }, clockwise = true) {
  const s = clockwise ? 1 : 0;
  return `M${n(x)} ${n(y - r)}A${n(r)} ${n(r)} 0 1 ${s} ${n(x)} ${n(y + r)}A${n(r)} ${n(r)} 0 1 ${s} ${n(x)} ${n(y - r)}Z`;
}
function peasUnder(m) {
  return peaCircles(POD.peas).map((p) => {
    const [x, y] = apply(m, [p.x, p.y]);
    return { x, y, r: p.r * scaleOf(m) };
  });
}
/** The mark: the shell with the peas cut out, one path. */
const markPath = (m) => `${shellPath(m)}${peasUnder(m).map((c) => circlePath(c, false)).join("")}`;

/* ── SVG helpers ──────────────────────────────────────────────────────────── */

const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="0 0 ${n(w)} ${n(h)}">${body}</svg>\n`;

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`brand: ${path.relative(path.dirname(RESOURCES), file)}`);
}

/* ── The app icon (Icon Composer document) ────────────────────────────────── */

/** 1024 canvas; the pod keeps the grid's margin all round. */
const ICON_CANVAS = 1024;
const ICON_PAD = 196;

/* The shell is whole and the peas sit on it as their own glass group, so they cast onto it. */
function iconLayers() {
  const m = fit(ICON_CANVAS, ICON_CANVAS, ICON_PAD);
  const shell = svg(ICON_CANVAS, ICON_CANVAS, `<path fill="${hex(...INK)}" d="${shellPath(m)}"/>`);
  const peaDots = svg(
    ICON_CANVAS,
    ICON_CANVAS,
    `<path fill="${hex(...COLORS.peas)}" d="${peasUnder(m)
      .map((c) => circlePath(c))
      .join("")}"/>`,
  );
  return { shell, peaDots };
}

function iconDocument() {
  const at = { scale: 1, "translation-in-points": [0, 0] };
  const vertical = { start: { x: 0.5, y: 0 }, stop: { x: 0.5, y: 1 } };
  return {
    fill: { "linear-gradient": [p3(...COLORS.bgTop), p3(...COLORS.bgBottom)], orientation: vertical },
    "fill-specializations": [
      {
        appearance: "dark",
        value: {
          "linear-gradient": [p3(...COLORS.darkBgTop), p3(...COLORS.darkBgBottom)],
          orientation: vertical,
        },
      },
    ],
    groups: [
      {
        name: "Peas",
        layers: [
          {
            name: "peas",
            "image-name": "peas.svg",
            glass: true,
            position: at,
            "fill-specializations": [{ appearance: "dark", value: { solid: p3(...COLORS.darkPeas) } }],
          },
        ],
        shadow: { kind: "neutral", opacity: 0.4 },
        translucency: { enabled: false, value: 0 },
        specular: true,
      },
      {
        name: "Pod",
        layers: [{ name: "shell", "image-name": "shell.svg", glass: true, position: at }],
        shadow: { kind: "neutral", opacity: 0.5 },
        translucency: { enabled: true, value: 0.3 },
        specular: true,
      },
    ],
    "supported-platforms": { squares: ["macOS"] },
  };
}

/* ── Menu bar template, logo, SF Symbol ───────────────────────────────────── */

/** The mark in a w × h box, black on clear: a template image. */
const markSvg = (w, h, { fill = "#000", pad = 0 } = {}) =>
  svg(w, h, `<path fill="${fill}" fill-rule="evenodd" d="${markPath(fit(w, h, pad))}"/>`);

/**
 * A custom SF Symbol template in the SF Symbols app's 3.0 layout: guides and a
 * Regular glyph per scale on SF Pro's 100 pt cap height. A filled mark has no
 * stroke to thicken, so every weight draws the Regular glyph.
 */
function symbolTemplate() {
  const capHeight = 70.459;
  const baseline = { S: 696, M: 1126, L: 1556 };
  // Filled SF symbols run a little past the caps, centred on them; small and large scale the glyph.
  const height = { S: capHeight * 0.86, M: capHeight * 1.08, L: capHeight * 1.36 };
  const margin = 4;
  const left = 1391;
  const glyph = (scale) => {
    const r = rotation(POD.rotate);
    const b = bounds(r);
    const s = height[scale] / (b.y1 - b.y0);
    const width = (b.x1 - b.x0) * s;
    const m0 = rotation(POD.rotate, s);
    const c = bounds(m0);
    // Glyph coordinates are relative to (left margin, baseline); y grows down.
    const m = [m0[0], m0[1], m0[2], m0[3], margin + width / 2 - (c.x0 + c.x1) / 2, -capHeight / 2 - (c.y0 + c.y1) / 2];
    return { right: left + width + margin * 2, d: markPath(m) };
  };
  const guide = (id, y) =>
    `<line id="${id}" style="fill:none;stroke:#27AAE1;opacity:1;stroke-width:0.5;" x1="263" x2="3036" y1="${n(y)}" y2="${n(y)}"/>`;
  const margins = (scale, right) => {
    const y = baseline[scale];
    const line = (id, x) =>
      `<line id="${id}" style="fill:none;stroke:#00AEEF;stroke-width:0.5;opacity:1.0;" x1="${n(x)}" x2="${n(x)}" y1="${n(y - 95.21)}" y2="${n(y + 24.12)}"/>`;
    return `${line(`left-margin-Regular-${scale}`, left)}\n  ${line(`right-margin-Regular-${scale}`, right)}`;
  };
  const scales = ["S", "M", "L"].map((scale) => ({ scale, ...glyph(scale) }));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<!--Generated by resources/brand/generate.mjs-->
<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="3300" height="2200">
 <!--glyph: "pod.mark", point size: 100.0, template writer version: "pod-brand 1"-->
 <g id="Notes">
  <rect height="2200" id="artboard" style="fill:white;opacity:1" width="3300" x="0" y="0"/>
  <line style="fill:none;stroke:black;opacity:1;stroke-width:0.5;" x1="263" x2="3036" y1="292" y2="292"/>
  <text style="stroke:none;fill:black;font-family:sans-serif;font-size:13;font-weight:bold;" transform="matrix(1 0 0 1 263 322)">Weight/Scale Variations</text>
  <text style="stroke:none;fill:black;font-family:sans-serif;font-size:13;" transform="matrix(1 0 0 1 1406 322)">Regular</text>
  <text id="template-version" style="stroke:none;fill:black;font-family:sans-serif;font-size:13;" transform="matrix(1 0 0 1 3036 1933)">Template v.3.0</text>
 </g>
 <g id="Guides">
  ${["S", "M", "L"].map((k) => `${guide(`Baseline-${k}`, baseline[k])}\n  ${guide(`Capline-${k}`, baseline[k] - capHeight)}`).join("\n  ")}
  ${scales.map((g) => margins(g.scale, g.right)).join("\n  ")}
 </g>
 <g id="Symbols">
${scales
  .map(
    (g) => `  <g id="Regular-${g.scale}" transform="matrix(1 0 0 1 ${left} ${baseline[g.scale]})">
   <path class="monochrome-0 multicolor-0:tintColor hierarchical-0:primary SFSymbolsPreviewWireframe" d="${g.d}"/>
  </g>`,
  )
  .join("\n")}
 </g>
</svg>
`;
}

/* ── Asset catalog for the SwiftUI shell ──────────────────────────────────── */

const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
const templateImage = { "preserves-vector-representation": true, "template-rendering-intent": "template" };

/** macOS app icon slots: points × scales, rendered by Icon Composer from the same document. */
const APP_ICON_SLOTS = [16, 32, 128, 256, 512].flatMap((pt) => [1, 2].map((scale) => ({ pt, scale })));
const ICTOOL = "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool";

function assetCatalog() {
  const root = path.join(BRAND, "native", "Assets.xcassets");
  rmSync(root, { recursive: true, force: true });
  write(path.join(root, "Contents.json"), json({ info: { author: "xcode", version: 1 } }));
  for (const [set, file, w, h] of [
    ["PodMark.imageset", "pod-mark.svg", 24, 24],
    ["MenuBarIcon.imageset", "menu-bar.svg", MENU_BAR.w, MENU_BAR.h],
  ]) {
    write(path.join(root, set, file), markSvg(w, h));
    write(
      path.join(root, set, "Contents.json"),
      json({ images: [{ filename: file, idiom: "universal" }], info: { author: "xcode", version: 1 }, properties: templateImage }),
    );
  }
  // AppIcon for builds without Icon Composer support; Xcode 26+ targets use native/Pod.icon instead.
  const images = APP_ICON_SLOTS.map(({ pt, scale }) => {
    const filename = `icon_${pt}x${pt}${scale > 1 ? `@${scale}x` : ""}.png`;
    mkdirSync(path.join(root, "AppIcon.appiconset"), { recursive: true });
    execFileSync(ICTOOL, [
      ICON_DOC,
      "--export-image",
      "--output-file",
      path.join(root, "AppIcon.appiconset", filename),
      "--platform",
      "macOS",
      "--rendition",
      "Default",
      "--width",
      String(pt),
      "--height",
      String(pt),
      "--scale",
      String(scale),
    ]);
    // ictool writes 16-bit PNGs; 8 bits per channel is what a catalog ships.
    const file = path.join(root, "AppIcon.appiconset", filename);
    execFileSync("magick", [file, "-depth", "8", "-strip", file]);
    return { filename, idiom: "mac", scale: `${scale}x`, size: `${pt}x${pt}` };
  });
  write(path.join(root, "AppIcon.appiconset", "Contents.json"), json({ images, info: { author: "xcode", version: 1 } }));
  cpSync(ICON_DOC, path.join(BRAND, "native", "Pod.icon"), { recursive: true });
  write(path.join(root, "pod.mark.symbolset", "pod.mark.svg"), symbolTemplate());
  write(
    path.join(root, "pod.mark.symbolset", "Contents.json"),
    json({ info: { author: "xcode", version: 1 }, symbols: [{ filename: "pod.mark.svg", idiom: "universal" }] }),
  );
  return root;
}

/** The menu bar extra: 18 pt square, the pod 16 pt across its diagonal (menu bar is 24 pt). */
const MENU_BAR = { w: 18, h: 18, pad: 1 };

/* ── Run ──────────────────────────────────────────────────────────────────── */

const { shell, peaDots } = iconLayers();
rmSync(ICON_DOC, { recursive: true, force: true });
write(path.join(ICON_DOC, "Assets", "shell.svg"), shell);
write(path.join(ICON_DOC, "Assets", "peas.svg"), peaDots);
write(path.join(ICON_DOC, "icon.json"), json(iconDocument()));

write(path.join(BRAND, "pod.mark.svg"), symbolTemplate());
write(path.join(BRAND, "pod-logo.svg"), markSvg(24, 24, { fill: "currentColor" }));
write(path.join(BRAND, "menu-barTemplate.svg"), markSvg(MENU_BAR.w, MENU_BAR.h, { pad: MENU_BAR.pad }));
for (const [suffix, zoom] of [
  ["", 1],
  ["@2x", 2],
]) {
  execFileSync("rsvg-convert", [
    "--zoom",
    String(zoom),
    "--output",
    path.join(BRAND, `pod-menu-barTemplate${suffix}.png`),
    path.join(BRAND, "menu-barTemplate.svg"),
  ]);
}
assetCatalog();

if (process.argv.includes("--preview")) {
  execFileSync("node", [path.join(BRAND, "preview.mjs")], { stdio: "inherit" });
}
