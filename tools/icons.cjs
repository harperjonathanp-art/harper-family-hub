// Draws the Hub's icons and link-preview image, from one design.
//   node tools/icons.cjs [out-dir]     (default: icons)
// The Evergreen icon from the redesign mock-ups: a home with a heart in it, cream on the Hub's
// green. Every size the app uses is drawn from the same SVG with Playwright.
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const OUT = path.resolve(process.argv[2] || path.join(__dirname, "..", "icons"));
const C = { green: "#2F5D46", cream: "#F2EFE4", ink: "#1b1b1f", jon: "#2f5fcc", maggie: "#c8461f", clayton: "#1f7a52", heidi: "#f0b429" };

/* The picture on a 512 square. `round`: rounded corners (a favicon); `inset`: how far in it's drawn
   (the maskable icon's safe zone); `small`: a heavier line, so it still reads at 32 px. */
function art({ round = 0, inset = 1, small = false } = {}) {
  // The mock-up: a 50 px drawing (24-unit grid, 1.6 lines) in an 84 px tile.
  const size = 512 * (small ? 56 : 50) / 84, k = (size / 24) * inset, o = (512 - 24 * k) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="${round}" fill="${C.green}"/>
  <g transform="translate(${o.toFixed(2)} ${o.toFixed(2)}) scale(${k.toFixed(4)})" stroke="${C.cream}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3.5 11L12 4l8.5 7M6 9.5V20h12V9.5" fill="none" stroke-width="${small ? 2.3 : 1.6}"/>
    <path d="M12 17.2s-3-1.8-3-3.7c0-1 .8-1.7 1.6-1.7.6 0 1.1.3 1.4.8.3-.5.8-.8 1.4-.8.8 0 1.6.7 1.6 1.7 0 1.9-3 3.7-3 3.7z" fill="${C.cream}" stroke-width="0.8"/>
  </g>
</svg>`;
}

const OG = svg => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&display=block" rel="stylesheet">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #f3f0e8; font-family: "Bricolage Grotesque", sans-serif; color: #1b1b1f; }
  .wrap { display: flex; align-items: center; gap: 72px; height: 100%; padding: 0 96px; box-sizing: border-box; }
  .icon { width: 300px; height: 300px; flex: none; border-radius: 68px; overflow: hidden; box-shadow: 0 24px 60px rgba(27,27,31,.18); }
  .icon svg { width: 100%; height: 100%; display: block; }
  h1 { margin: 0; font-size: 92px; line-height: .98; font-weight: 800; letter-spacing: -0.03em; }
  p { margin: 26px 0 0; font-size: 34px; line-height: 1.3; font-weight: 500; color: #50505a; }
  .dots { display: flex; gap: 14px; margin-top: 34px; }
  .dots span { width: 26px; height: 26px; border-radius: 50%; }
</style></head><body><div class="wrap">
  <div class="icon">${svg}</div>
  <div><h1>Harper<br>Family Hub</h1><p>What today asks of four people.</p>
    <div class="dots"><span style="background:${C.jon}"></span><span style="background:${C.maggie}"></span><span style="background:${C.clayton}"></span><span style="background:${C.heidi}"></span></div></div>
</div></body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "favicon.svg"), art({ round: 112 }) + "\n");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const png = async (svg, size, name) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`);
    await page.screenshot({ path: path.join(OUT, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };
  await png(art(), 512, "icon-512.png");
  await png(art(), 192, "icon-192.png");
  await png(art({ inset: 0.8 }), 512, "icon-512-maskable.png"); // Android trims to a circle or squircle: all of it inside
  await png(art(), 180, "apple-touch-icon.png");                 // iPhone rounds the corners itself
  await png(art({ round: 112, small: true }), 32, "favicon-32.png");
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(OG(art()), { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, "og-image.png") });
  await browser.close();
  console.log("Drew the icons in " + path.relative(process.cwd(), OUT));
})().catch(e => { console.error(e); process.exit(1); });
