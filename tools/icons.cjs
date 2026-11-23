// Draws the Hub's icons and link-preview image in the Fridge Door look, from one design.
//   node tools/icons.cjs [out-dir]     (default: icons)
// A note stuck to the fridge door, marked with an H, held by Maggie's magnet, with Jon's
// and Heidi's beside it. Every size the app uses is drawn from the same SVG with Playwright.
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const OUT = path.resolve(process.argv[2] || path.join(__dirname, "..", "icons"));
const C = { door: "#1f7a52", doorDeep: "#17603f", note: "#f3f0e8", ink: "#1b1b1f", jon: "#2f5fcc", maggie: "#c8461f", heidi: "#f0b429" };

/* A magnet: a shadow, the disc, and a soft shine. */
const magnet = (x, y, r, fill) => `
  <circle cx="${x + r * 0.08}" cy="${y + r * 0.22}" r="${r}" fill="#000" opacity=".22"/>
  <circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>
  <circle cx="${x - r * 0.32}" cy="${y - r * 0.34}" r="${r * 0.34}" fill="#fff" opacity=".32"/>`;

/* The picture on a 512 square. `round`: rounded corners (a favicon); `inset`: how far in it's drawn (the maskable icon's safe zone). */
function art({ round = 0, inset = 1, small = false } = {}) {
  const s = inset, t = (1 - s) * 256;
  const extra = small ? "" : magnet(388, 382, 30, C.jon) + magnet(118, 136, 24, C.heidi);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs><linearGradient id="door" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.door}"/><stop offset="1" stop-color="${C.doorDeep}"/></linearGradient></defs>
  <rect width="512" height="512" rx="${round}" fill="url(#door)"/>
  <g transform="translate(${t} ${t}) scale(${s})">
    <g transform="rotate(-6 256 270)">
      <rect x="140" y="138" width="232" height="262" rx="20" fill="#000" opacity=".2" transform="translate(4 12)"/>
      <rect x="140" y="138" width="232" height="262" rx="20" fill="${C.note}"/>
      <rect x="190" y="208" width="44" height="146" rx="6" fill="${C.ink}"/>
      <rect x="278" y="208" width="44" height="146" rx="6" fill="${C.ink}"/>
      <rect x="190" y="262" width="132" height="38" fill="${C.ink}"/>
    </g>
    ${magnet(252, 150, small ? 40 : 34, C.maggie)}
    ${extra}
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
    <div class="dots"><span style="background:${C.jon}"></span><span style="background:${C.maggie}"></span><span style="background:${C.door}"></span><span style="background:${C.heidi}"></span></div></div>
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
