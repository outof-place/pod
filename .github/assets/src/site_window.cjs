// The README's window pictures: pod.codes' replica of the Pod window (the hero's [data-mac]),
// light and dark, wide and narrow, @2x, headless. Usage: node site_window.cjs <pod-site checkout> https://pod.codes/ <outDir>
// then round the corners (alpha, 56 px) and cwebp -q 88 -m 6 -alpha_q 100 -exact.
const path = require("node:path");
const { createRequire } = require("node:module");
const [siteDir, url, out] = process.argv.slice(2);
const { chromium } = createRequire(path.join(siteDir, "package.json"))("playwright-core");
(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const scheme of ["light", "dark"]) {
    for (const [name, w] of [["window", 1280], ["window-narrow", 600]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 1200 }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForTimeout(600);
      const fig = await page.$("[data-mac]");
      await fig.screenshot({ path: path.join(out, `${name}-${scheme}.png`) });
      await ctx.close();
    }
  }
  await browser.close();
})();
