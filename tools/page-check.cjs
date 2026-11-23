// Page check: run before each preview goes out (see the build plan).
//
//   node tools/page-check.cjs [page]      page: next/ (default) or ./ for the live Hub
//
// Serves this repo on a local port, answers the Hub's Worker with sample data, and for
// every theme in light and dark: opens each screen and Settings, saves a screenshot to
// tools/page-check/out/, fails on any script error, and checks text contrast (4.5:1).
// Needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "page-check", "out");
const PAGE = process.argv[2] || "next/";
const HUB = "https://family-hub-push.harper-jonathan-p.workers.dev";
const THEMES = ["fridge", "evergreen", "journal"];
const SCHEMES = ["light", "dark"];
const SCREENS = ["today", "calendar", "meals", "tasks", "checkins"];
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml" };

// ---- sample data: a believable Monday ----
function sample() {
  const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  return {
    ok: true,
    tasks: [
      { id: "1", title: "Make beds", assignee: "Clayton", recurrence: "repeat", repeat: "every 1 day", due: day(0) },
      { id: "2", title: "Feed the dog", assignee: "Heidi", recurrence: "repeat", repeat: "every 1 day", due: day(0), completed: true, completedBy: "Heidi" },
      { id: "3", title: "Unload dishwasher", assignee: "Jon", recurrence: "repeat", repeat: "every 1 day", due: day(0) },
      { id: "4", title: "Call about the furnace filter", assignee: "Maggie", recurrence: "once", due: day(0), time: "10:00" },
      { id: "5", title: "Sign field-trip form", assignee: "Jon", recurrence: "once", due: day(-1) },
      { id: "6", title: "Plan Heidi's birthday", assignee: "Maggie", recurrence: "once", due: day(5) },
      { id: "7", title: "Book the venue", assignee: "Maggie", recurrence: "once", parentId: "6", completed: true },
      { id: "8", title: "Clean out the fridge", assignee: "Family", recurrence: "weekly" },
      { id: "9", title: "Change HVAC filter", assignee: "Jon", recurrence: "monthly" },
    ],
    meals: {
      Mon: { meal: "Sheet Pan Chicken Fajitas | https://www.foodnetwork.com/recipes/sheet-pan-chicken-fajitas", note: "Jon cooks · Double the peppers" },
      Tue: { meal: "Turkey Meatballs | https://www.budgetbytes.com/turkey-meatballs/", note: "" },
      Wed: { meal: "Breakfast for dinner", note: "Heidi's pick" },
      Thu: { meal: "", note: "" },
      Fri: { meal: "Vegetarian Chili | https://www.budgetbytes.com/vegetarian-chili/", note: "" },
      Sat: { meal: "Chicken Pot Pie | https://www.americastestkitchen.com/recipes/6140", note: "Cooking together" },
      Sun: { meal: "Mustard-Maple Roasted Salmon", note: "" },
    },
    mealsFrom: { source: "notion", syncedAt: Date.now(), weekStarts: "Sat" },
    events: [
      { date: day(0), start: "7:30 AM", title: "School drop-off", cal: "Family", color: "#46647b" },
      { date: day(0), start: "4:15 PM", title: "Soccer practice", cal: "Clayton", color: "#2f5d46" },
      { date: day(0), start: "6:30 PM", title: "Small group", cal: "Jon & Maggie", color: "#856224" },
      { date: day(1), allDay: true, title: "Picture day", cal: "Heidi", color: "#b0452a" },
      { date: day(2), start: "5:00 PM", title: "Piano lesson", cal: "Heidi", color: "#b0452a" },
    ],
    checkins: [{ date: day(-1), type: "huddle", answers: { rose: "Clayton scored twice", fun: "Bike ride Saturday" } }],
    groceries: [{ id: "a", item: "Milk" }, { id: "b", item: "Tortillas" }, { id: "c", item: "Bell peppers" }, { id: "d", item: "Coffee", done: true }],
    reminders: { status: "fresh", syncedAt: Date.now(), items: [
      { key: "r1", title: "Renew car registration", list: "Home", due: day(4) },
      { key: "r2", title: "Email the coach", list: "Kids", due: day(0), time: "3:00 PM" },
    ] },
  };
}

// ---- a tiny static server for the repo ----
function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

// ---- contrast: every pair of text and the surface it sits on ----
const PAIRS = [
  ["ink", "bg"], ["ink", "card"], ["ink", "sunk"], ["muted", "bg"], ["muted", "card"], ["muted", "sunk"],
  ["faint", "bg"], ["faint", "card"], ["accent", "bg"], ["accent", "card"], ["accent", "accent-tint"],
  ["on-accent", "accent"], ["warm", "warm-tint"], ["cool", "cool-tint"], ["gold", "gold-tint"],
  ["crit", "bg"], ["crit", "card"], ["warn", "bg"], ["warn", "card"], ["ok", "bg"], ["ok", "card"],
  ["p-jon-ink", "p-jon"], ["p-maggie-ink", "p-maggie"], ["p-clayton-ink", "p-clayton"],
  ["p-heidi-ink", "p-heidi"], ["p-family-ink", "p-family"],
  ["nav-active-ink", "nav-active-bg"], ["nav-muted", "nav-bg", 3], // resting tab icons: 3:1, as for any icon
];
function contrast(a, b) {
  const lum = hex => {
    const v = hex.replace("#", "").match(/../g).map(x => parseInt(x, 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/${PAGE}`;
  const browser = await chromium.launch();
  const problems = [];

  for (const theme of THEMES) {
    for (const scheme of SCHEMES) {
      const tag = `${theme}-${scheme}`;
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      await ctx.addInitScript(([t, s]) => {
        localStorage.setItem("fd_token", "page-check"); localStorage.setItem("fd_user", "Jon");
        localStorage.setItem("fd_theme", t); localStorage.setItem("fd_scheme", s);
      }, [theme, scheme]);
      await ctx.route(HUB + "/**", r => r.fulfill({ contentType: "application/json", body: JSON.stringify(sample()) }));
      await ctx.route("https://fonts.googleapis.com/**", r => r.abort()); // no network needed; fallbacks are fine
      const page = await ctx.newPage();
      page.on("pageerror", e => problems.push(`${tag}: script error: ${e.message}`));
      page.on("console", m => { if (m.type() === "error" && !/fonts|Failed to load resource/.test(m.text())) problems.push(`${tag}: console: ${m.text()}`); });
      await page.goto(base);
      await page.waitForTimeout(400);

      const applied = await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.scheme]);
      if (!applied[0]) {
        // A page from before the themes (the live Hub until the redesign is promoted): only script errors count.
        await ctx.close();
        if (theme === THEMES[0] && scheme === SCHEMES[0]) continue;
        break;
      }
      if (applied.join() !== [theme, scheme].join()) problems.push(`${tag}: theme not applied (got ${applied.join("/")})`);

      // contrast, from the values the page actually uses
      const vars = await page.evaluate(names => {
        const cs = getComputedStyle(document.documentElement);
        return Object.fromEntries(names.map(n => [n, cs.getPropertyValue("--" + n).trim()]));
      }, [...new Set(PAIRS.flat())]);
      for (const [fg, bg, min = 4.5] of PAIRS) {
        if (!/^#[0-9a-f]{6}$/i.test(vars[fg]) || !/^#[0-9a-f]{6}$/i.test(vars[bg])) { problems.push(`${tag}: --${fg} or --${bg} missing`); continue; }
        const r = contrast(vars[fg], vars[bg]);
        if (r < min) problems.push(`${tag}: --${fg} on --${bg} is ${r.toFixed(2)}:1`);
      }

      {
        const shot = name => page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`), fullPage: true });
        for (const v of SCREENS) {
          await page.evaluate(v => go(v), v);
          await page.waitForTimeout(650); // past the slide between screens
          const blank = await page.evaluate(() => !document.getElementById("main").textContent.trim());
          if (blank) problems.push(`${tag}: ${v} drew nothing`);
          await shot(v);
        }
        // the tab bar: five tabs, the open one marked
        const tabs = await page.evaluate(() => [...document.querySelectorAll("#nav button")].map(b => [b.dataset.view, b.getAttribute("aria-current")]));
        if (tabs.length !== 5) problems.push(`${tag}: the tab bar has ${tabs.length} tabs`);
        if (!tabs.some(([v, cur]) => v === "checkins" && cur === "page")) problems.push(`${tag}: the open tab isn't marked`);
        // the panel: rises, closes with Escape, and is gone after its slide
        await page.evaluate(() => openSettings());
        await page.waitForTimeout(500);
        if (!(await page.evaluate(() => panelUp()))) problems.push(`${tag}: Settings panel didn't open`);
        await page.screenshot({ path: path.join(OUT, `${tag}-settings.png`) });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
        if (await page.evaluate(() => panelUp() || !document.getElementById("overlay").classList.contains("hidden")))
          problems.push(`${tag}: Escape didn't close the panel`);
      }
      await ctx.close();
    }
  }

  // switching tabs: the slide finishes on the new screen, and Reduce Motion switches at once
  if (PAGE.startsWith("next")) {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      const c = await browser.newContext({ reducedMotion });
      await c.addInitScript(() => { localStorage.setItem("fd_token", "page-check"); localStorage.setItem("fd_user", "Jon"); });
      await c.route(HUB + "/**", r => r.fulfill({ contentType: "application/json", body: JSON.stringify(sample()) }));
      const p = await c.newPage();
      p.on("pageerror", e => problems.push(`motion ${reducedMotion}: script error: ${e.message}`));
      await p.goto(base);
      await p.waitForTimeout(300);
      const now = await p.evaluate(() => { go("tasks"); return VIEW; });
      if (reducedMotion === "reduce" && now !== "tasks") problems.push("Reduce Motion: switching tabs wasn't instant");
      await p.waitForTimeout(700);
      const after = await p.evaluate(() => [VIEW, document.querySelector('#nav button[aria-current="page"]')?.dataset.view, document.getElementById("srAnnounce").textContent]);
      if (after.join() !== "tasks,tasks,Tasks") problems.push(`motion ${reducedMotion}: after switching to Tasks got ${after.join(" / ")}`);
      // a new device's sign-in can't be swiped or tapped away
      await p.evaluate(() => { showSetup(); });
      await p.waitForTimeout(450);
      await p.keyboard.press("Escape");
      await p.evaluate(() => panelBackTap());
      await p.waitForTimeout(450);
      if (!(await p.evaluate(() => panelUp()))) problems.push(`motion ${reducedMotion}: sign-in could be dismissed`);
      await c.close();
    }
  }

  // "Auto" follows the phone's setting
  const ctx = await browser.newContext({ colorScheme: "dark" });
  const page = await ctx.newPage();
  await ctx.route(HUB + "/**", r => r.fulfill({ contentType: "application/json", body: JSON.stringify(sample()) }));
  await page.goto(base);
  const scheme = await page.evaluate(() => document.documentElement.dataset.scheme);
  if (scheme && scheme !== "dark")
    problems.push("auto: a phone set to dark did not get the dark scheme");
  await ctx.close();

  await browser.close();
  server.close();
  if (problems.length) { console.log(problems.join("\n")); console.log(`\n${problems.length} problem(s).`); process.exit(1); }
  console.log(`All clear: ${THEMES.length * SCHEMES.length} theme combinations. Screenshots in ${path.relative(ROOT, OUT)}/`);
})().catch(e => { console.error(e); process.exit(1); });
