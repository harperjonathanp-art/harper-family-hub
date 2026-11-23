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
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
  const t12 = d => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "AM" : "PM"}`;
  // an event starting `from` minutes from now and lasting `len` minutes (so Up next always has something)
  const ev = (from, len, title, cal, color) => {
    const a = new Date(Date.now() + from * 60000), b = new Date(a.getTime() + len * 60000);
    return { date: iso(a), start: t12(a), end: t12(b), title, cal, color };
  };
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
      { id: "10", title: "Take out the recycling", assignee: "Clayton", recurrence: "repeat", repeat: "every 2 weeks on mon,thu", due: day(2) },
      { id: "11", title: "Book club", assignee: "Maggie", recurrence: "repeat", repeat: "every 1 month on 3rd sat", due: day(12), time: "19:30" },
      { id: "12", title: "Fix the squeaky door", assignee: "Jon", recurrence: "once" },
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
    mealsFrom: { source: "notion", syncedAt: Date.now(), weekStarts: "Sat",
      recipes: { [["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date().getDay()]]: ["potpie"], Fri: ["chili"] } },
    events: [
      ev(-180, 30, "School drop-off", "Family", "#46647b"),
      ev(35, 75, "Soccer practice", "MCHS", "#2f5d46"),
      ev(165, 120, "Small group", "Jon", "#856224"),
      { date: day(1), allDay: true, title: "Picture day", cal: "Maggie", color: "#009688" },
      { date: day(2), start: "5:00 PM", title: "Piano lesson", cal: "Maggie", color: "#009688" },
      // over several days: all day Tue–Thu, and an overnight from 4 PM to 11 AM the next day
      { date: day(1), endDate: day(3), allDay: true, title: "Grandma visits", cal: "Family", color: "#F6BF26" },
      { date: day(5), endDate: day(6), start: "4:00 PM", end: "11:00 AM", title: "Camping trip", cal: "MCHS", color: "#C5B783" },
    ],
    checkins: [{ date: day(-1), type: "huddle", answers: { rose: "Clayton scored twice", fun: "Bike ride Saturday" } }],
    groceries: [{ id: "a", item: "Milk" }, { id: "b", item: "Tortillas" }, { id: "c", item: "Bell peppers" }, { id: "d", item: "Coffee", done: true }],
    reminders: { status: "fresh", syncedAt: Date.now(), items: [
      { key: "r1", title: "Renew car registration", list: "Home", due: day(4) },
      { key: "r2", title: "Email the coach", list: "Kids", due: day(0), time: "3:00 PM" },
    ] },
  };
}

// ---- recipes, as the Worker reads them from Notion ----
const PHOTO = HUB + "/recipe-photo?id=";
const recipe = (id, name, more) => Object.assign({ id, name, emoji: "🍲", category: "Dinner", cuisine: ["American"], protein: "Chicken",
  method: ["Weeknight"], status: "Tried", rating: 4, time: 40, servings: 6, cost: null, costTotal: null, kid: false, lastMade: "",
  source: "https://www.budgetbytes.com/" + id + "/", notes: "", edited: "2026-11-10T00:00:00.000Z", url: "https://www.notion.so/" + id, words: "" }, more);
function recipes() {
  const ago = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  return [
    recipe("chili", "Vegetarian Chili", { emoji: "🌶️", protein: "Vegetarian", kid: true, cost: 1.65, lastMade: ago(16), img: PHOTO + "chili",
      words: "olive oil onion garlic bell pepper tomato paste kidney black pinto beans corn chili powder cumin" }),
    recipe("divan", "Chicken Divan", { emoji: "🍗", status: "To Try", rating: 0, time: 75, method: [], source: "", notes: "Susan's recipe from the family cookbook.",
      img: PHOTO + "divan", words: "frozen broccoli chicken breasts lemon juice mayo cream soup water sharp cheese ritz crackers butter" }),
    recipe("potpie", "Chicken Pot Pie with Savory Crumble Topping", { emoji: "🥧", method: ["Weekend"], time: 105, lastMade: ago(9), img: PHOTO + "potpie",
      words: "chicken breasts broth vegetable oil onion carrots celery cremini mushrooms soy sauce tomato paste butter flour milk lemon parsley peas" }),
    recipe("salmon", "Mustard-Maple Roasted Salmon", { emoji: "🐟", protein: "Fish", time: 25, status: "Family Favorite", rating: 5, kid: true, lastMade: ago(3),
      words: "salmon mustard maple syrup" }),
    recipe("salad", "Grandma's Mystery Salad", { emoji: "🥗", category: "Side", protein: "Vegetarian", source: "", words: "" }),
    recipe("tacos", "Sheet Pan Chicken Tacos", { emoji: "🌮", time: 30, method: ["Weeknight", "Sheet pan"], status: "To Try", rating: 0, words: "chicken tortillas peppers" }),
  ];
}
const BODIES = {
  potpie: { about: ["Classic chicken pot pie filling under a crumbly Parmesan-biscuit topping that you pre-bake so it stays crisp."],
    facts: "Time: 105 min · Serves: 6 · From: America's Test Kitchen",
    ingredients: [{ h: "Filling" }, { t: "1½ lb boneless, skinless chicken breasts and/or thighs" }, { t: "3 cups low-sodium chicken broth" },
      { t: "2 Tbsp vegetable oil, divided" }, { t: "10 oz cremini mushrooms, trimmed and sliced thin" }, { t: "Table salt and ground black pepper" },
      { h: "Crumble topping" }, { t: "2 cups (10 oz) all-purpose flour" }, { t: "1 oz Parmesan cheese, finely grated (about ½ cup)" }],
    steps: [{ lead: "Poach the chicken.", t: "Put the chicken and broth in a Dutch oven, cover, and bring to a simmer. Cook until just done, 8–12 minutes." },
      { t: "Move the chicken to a large bowl and strain the broth." }, { lead: "Make the topping.", t: "Whisk together the flour, baking powder and salt." },
      { t: "Bake until the filling bubbles and the topping is deeply browned, 12–15 minutes." }],
    notes: [{ t: "Pre-baking the crumble is what keeps it crunchy." }] },
  divan: { about: ["Broccoli and chicken casserole."], facts: "Time: about 1¼ hours · From: Susan (family cookbook, 02/15/10)",
    ingredients: [{ t: "2 boxes frozen chopped broccoli" }, { t: "4 boneless, skinless chicken breasts" }],
    steps: [{ t: "Thaw the broccoli and cover the bottom of a Pyrex dish." }, { t: "Bake at 350°F for 45 minutes." }], notes: [] },
  salad: { about: [], facts: "", ingredients: [], steps: [], notes: [], raw: [{ t: "Mix it all up." }, { t: "A handful of this", list: "bulleted_list_item" }] },
};
const PHOTO_SVG = c => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><linearGradient id="g" x2="1" y2="1">
  <stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="#3b2a1a"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/></svg>`;
/* The pretend Worker: the Hub's data, the recipes, one recipe, a photo. */
function worker(r) {
  const u = new URL(r.request().url()), a = u.searchParams.get("action");
  if (u.pathname === "/recipe-photo") return r.fulfill({ contentType: "image/svg+xml", body: PHOTO_SVG({ chili: "#b5522c", divan: "#7a8a3a", potpie: "#c08a3e" }[u.searchParams.get("id")] || "#888") });
  if (a === "recipes") return r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, on: true, recipes: recipes(), pagesLeft: 0 }) });
  if (a === "recipe") {
    const info = recipes().find(x => x.id === u.searchParams.get("id"));
    const body = BODIES[info && info.id] || { about: [], facts: "", ingredients: [], steps: [], notes: [], raw: [{ t: "Just a note." }] };
    return r.fulfill({ contentType: "application/json", body: JSON.stringify(info ? { ok: true, recipe: Object.assign({}, info, { body }) } : { ok: false, error: "not_found" }) });
  }
  return r.fulfill({ contentType: "application/json", body: JSON.stringify(sample()) });
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
  ["warm", "bg"], ["warm", "card"], ["cool", "card"], ["gold", "card"], ["gold", "bg"], ["card", "crit"], // the swipe's Delete; stars
  ["ink", "warm-tint"], ["ink", "cool-tint"], ["ink", "gold-tint"], ["ink", "accent-tint"], // check-in cards
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
      await ctx.route(HUB + "/**", worker);
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
        // a check-in, one question per card
        await page.evaluate(() => openCheckin("couples"));
        await page.waitForTimeout(650);
        const ck = await page.evaluate(() => [document.querySelectorAll(".ck-card").length, document.querySelector(".ck-count").textContent,
          document.querySelectorAll(".ck-card:not([inert])").length]);
        if (ck.join() !== "8,1 of 7,1") problems.push(`${tag}: check-in cards: ${ck.join(" / ")}`);
        await shot("checkin-card");
        await page.evaluate(() => { CHECKIN_OPEN = null; render(); });
        // Calendar: the week strip, a dot per calendar, events over several days on each of their days
        if (await page.evaluate(() => typeof calPaint === "function")) {
          await page.evaluate(() => go("calendar"));
          await page.waitForTimeout(650);
          const D = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
          const cal = await page.evaluate(D => {
            const day = d => document.querySelector(`.wkday[data-day="${d}"]`);
            const dots = d => (day(d) ? day(d).querySelectorAll(".dots i").length : -1);
            const text = () => document.getElementById("calDay").textContent.replace(/\s+/g, " ");
            const out = {
              days: document.querySelectorAll(".wkday").length, weeks: calWeeks().length,
              picked: [...document.querySelectorAll('.wkday[aria-pressed="true"]')].map(b => b.dataset.day),
              title: document.getElementById("wkTitle").textContent, todayBtn: document.getElementById("wkToday").hidden,
              dots: [dots(D[0]), dots(D[1]), dots(D[2]), dots(D[3]), dots(D[4])], key: document.querySelectorAll(".cal-key span").length,
            };
            calPick(D[2]); out.mid = text(); out.todayBtn2 = document.getElementById("wkToday").hidden;
            calPick(D[3]); out.end = text();
            calPick(D[6]); out.camp = text();
            calToday(); calWeek(1);
            out.next = [document.getElementById("wkTitle").textContent, document.getElementById("wkTrack").style.transform, CAL.day];
            calToday();
            out.back = [document.getElementById("wkTitle").textContent, CAL.day];
            return out;
          }, [0, 1, 2, 3, 4, 5, 6].map(D));
          const want = (ok, what) => { if (!ok) problems.push(`${tag}: calendar: ${what}`); };
          want(cal.days === cal.weeks * 7 && cal.weeks >= 2, `${cal.days} days in ${cal.weeks} weeks`);
          want(cal.picked.join() === D(0), `the day picked is ${cal.picked.join()}`);
          want(/^This week/.test(cal.title) && cal.todayBtn, `opens on "${cal.title}" (Today button hidden: ${cal.todayBtn})`);
          want(cal.dots[0] >= 2 && cal.dots[1] >= 2 && cal.dots[2] >= 2 && cal.dots[3] === 1 && cal.dots[4] === 0, `dots ${cal.dots.join()}`);
          want(cal.key === 4, `the key has ${cal.key} calendars`);
          want(/Grandma visits.*through/.test(cal.mid) && !cal.todayBtn2, `the middle day reads "${cal.mid.slice(0, 120)}"`);
          want(/Grandma visits.*last day/.test(cal.end), `the last day reads "${cal.end.slice(0, 120)}"`);
          want(/11:00 AM Camping trip.*ends/.test(cal.camp), `the overnight's second day reads "${cal.camp.slice(0, 120)}"`);
          want(/^Next week/.test(cal.next[0]) && cal.next[1] === "translateX(-100%)", `next week shows "${cal.next.join(" / ")}"`);
          want(/^This week/.test(cal.back[0]) && cal.back[1] === D(0), `Today goes back to "${cal.back.join(" / ")}"`);
          await page.evaluate(D => calPick(D), D(2));
          await page.waitForTimeout(450);
          await shot("calendar-day");
          await page.evaluate(() => calToday());
        }
        // Recipes: under Dinner; search, filters, a recipe page, groceries, cooking
        if (await page.evaluate(() => typeof renderRecipes === "function")) {
          const want = (ok, what) => { if (!ok) problems.push(`${tag}: recipes: ${what}`); };
          await page.evaluate(() => { go("meals"); });
          await page.waitForTimeout(650);
          want(await page.evaluate(() => !!document.querySelector(".dinner-switch") && !!document.querySelector(".weekcard .open-recipe")), "no switch, or no Recipe button on This week");
          await page.evaluate(() => dinnerTab("recipes"));
          await page.waitForTimeout(900);
          const list = await page.evaluate(() => ({
            title: document.getElementById("viewTitle").textContent,
            rows: [...document.querySelectorAll(".rrow .rr-name")].map(x => x.textContent),
            lately: document.querySelectorAll(".rcard").length,
          }));
          want(list.title === "Recipes", `title "${list.title}"`);
          want(list.rows.length === 5 && list.lately === 3, `${list.rows.length} dinners, ${list.lately} cooked lately`);
          await shot("recipes");
          const found = await page.evaluate(() => {
            const names = () => [...document.querySelectorAll(".rrow .rr-name")].map(x => x.textContent);
            const out = {};
            recipeSearch("mushrooms"); out.mushrooms = names();
            recipeSearch("chicken"); out.chicken = names();
            recipeSearch(""); recipeToggle("family"); out.family = names(); recipeToggle("family");
            recipeToggle("quick"); out.quick = names(); recipeToggle("quick");
            recipeCat("Side"); out.sides = names(); recipeCat("Dinner");
            return out;
          });
          want(found.mushrooms.join() === "Chicken Pot Pie with Savory Crumble Topping", `"mushrooms" finds ${found.mushrooms.join(" / ")}`);
          want(found.chicken.length === 3 && /^Chicken/.test(found.chicken[0]), `"chicken" finds ${found.chicken.join(" / ")}`);
          want(found.family.join() === "Chicken Divan", `Family cookbook finds ${found.family.join(" / ")}`);
          want(found.quick.join() === "Mustard-Maple Roasted Salmon,Sheet Pan Chicken Tacos", `Under 30 min finds ${found.quick.join(" / ")}`);
          want(found.sides.join() === "Grandma's Mystery Salad", `Sides finds ${found.sides.join(" / ")}`);

          await page.evaluate(() => openRecipe("potpie"));
          await page.waitForTimeout(900);
          const pie = await page.evaluate(() => ({
            name: (document.querySelector(".rtitle") || {}).textContent,
            ing: document.querySelectorAll(".ringr .task").length, groups: document.querySelectorAll(".ringr .rsub").length,
            steps: document.querySelectorAll(".rsteps li").length, lead: (document.querySelector(".rsteps li b") || {}).textContent,
            notes: document.querySelectorAll(".rnotes li").length, img: !!document.querySelector(".rhero img"),
          }));
          want(pie.name === "Chicken Pot Pie with Savory Crumble Topping" && pie.ing === 7 && pie.groups === 2 && pie.steps === 4 &&
            pie.lead === "Poach the chicken." && pie.notes === 1 && pie.img, `the pot pie shows ${JSON.stringify(pie)}`);
          await shot("recipe");
          await page.evaluate(() => openGroceryPick("potpie"));
          await page.waitForTimeout(500);
          const pick = await page.evaluate(() => [[...document.querySelectorAll("#gpList input")].map(x => (x.checked ? "✓" : "·")).join(""),
            [...document.querySelectorAll("#gpList span")].map(x => x.textContent)[3], document.getElementById("gpAdd").textContent]);
          want(pick.join(" | ") === "✓✓·✓·✓✓ | 10 oz cremini mushrooms | Add 5 to the list", `groceries ${pick.join(" | ")}`);
          await page.screenshot({ path: path.join(OUT, `${tag}-recipe-groceries.png`) });
          await page.evaluate(() => closeOverlay());
          await page.waitForTimeout(450);
          await page.evaluate(() => startCooking("potpie"));
          await page.waitForTimeout(500);
          const cook = await page.evaluate(() => {
            const out = [document.querySelectorAll(".cook-card").length, document.getElementById("cookCount").textContent,
              (document.querySelector(".cook-card .ck-timer") || {}).textContent];
            cookGo(3); out.push(document.getElementById("cookCount").textContent, document.getElementById("cookNext").textContent);
            cookGo(4); out.push(document.getElementById("cookCount").textContent, document.getElementById("cookNext").hidden);
            cookGo(0);
            return out.map(x => String(x).replace(/\s+/g, " ").trim());
          });
          want(cook.join(" | ") === "5 | 1 of 4 | Timer · 8 min | 4 of 4 | Finish | Done | true", `cooking ${cook.join(" | ")}`);
          await page.waitForTimeout(450);
          await page.screenshot({ path: path.join(OUT, `${tag}-cooking.png`) });
          await page.evaluate(() => stopCooking());
          await page.waitForTimeout(400);
          await page.evaluate(() => openRecipe("salad"));
          await page.waitForTimeout(900);
          want(await page.evaluate(() => document.querySelectorAll(".rraw p").length === 2), "a page off the layout isn't shown as written");
          await page.evaluate(() => { RECIPE_OPEN = null; DINNER_TAB = "week"; go("today"); });
          await page.waitForTimeout(650);
          want(await page.evaluate(() => !!document.querySelector(".tonight .open-recipe, .open-recipe")), "Tonight has no Recipe button");
        }
        // Today: a greeting, the day in a sentence, Up next, and the pill once synced
        await page.evaluate(() => go("today"));
        await page.waitForTimeout(650);
        const today = await page.evaluate(() => ({
          title: document.getElementById("viewTitle").textContent,
          sentence: (document.querySelector(".daysentence") || {}).textContent || "",
          upnext: !!document.querySelector("#main .upnext"),
          pill: [document.getElementById("syncNote").dataset.state, document.querySelector("#syncNote .txt").textContent],
        }));
        if (!/^(Good (morning|afternoon|evening)|Still up), Jon[.?]$/.test(today.title)) problems.push(`${tag}: greeting is "${today.title}"`);
        if (!/Soccer practice at /.test(today.sentence)) problems.push(`${tag}: day sentence is "${today.sentence}"`);
        if (!today.upnext) problems.push(`${tag}: no Up next card`);
        if (today.pill.join() !== "ok,Up to date") problems.push(`${tag}: sync pill shows ${today.pill.join(" / ")}`);
        // the tab bar: five tabs, the open one marked
        const tabs = await page.evaluate(() => [...document.querySelectorAll("#nav button")].map(b => [b.dataset.view, b.getAttribute("aria-current")]));
        if (tabs.length !== 5) problems.push(`${tag}: the tab bar has ${tabs.length} tabs`);
        if (!tabs.some(([v, cur]) => v === "today" && cur === "page")) problems.push(`${tag}: the open tab isn't marked`);
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
      await c.route(HUB + "/**", worker);
      const p = await c.newPage();
      p.on("pageerror", e => problems.push(`motion ${reducedMotion}: script error: ${e.message}`));
      await p.goto(base);
      await p.waitForTimeout(300);
      const now = await p.evaluate(() => { go("tasks"); return VIEW; });
      if (reducedMotion === "reduce" && now !== "tasks") problems.push("Reduce Motion: switching tabs wasn't instant");
      await p.waitForTimeout(700);
      const after = await p.evaluate(() => [VIEW, document.querySelector('#nav button[aria-current="page"]')?.dataset.view, document.getElementById("srAnnounce").textContent]);
      if (after.join() !== "tasks,tasks,Tasks") problems.push(`motion ${reducedMotion}: after switching to Tasks got ${after.join(" / ")}`);
      if (reducedMotion === "no-preference") {
        // Tasks: the + button and the filter show; every repeat opens in the panel and reads back unchanged
        const ui = await p.evaluate(() => [getComputedStyle(document.getElementById("fab")).opacity, !!document.querySelector(".tfilter"),
          [...document.querySelectorAll("#main h2")].map(h => h.firstChild.textContent.trim())]);
        if (ui[0] !== "1") problems.push("Tasks: the + button isn't showing");
        if (!ui[1]) problems.push("Tasks: no filter");
        for (const want of ["Overdue", "Today", "This week", "Anytime", "Routines"])
          if (!ui[2].includes(want)) problems.push(`Tasks: no ${want} section (has ${ui[2].join(", ")})`);
        const trips = await p.evaluate(() => DATA.tasks.filter(t => t.repeat || t.due).map(t => {
          openTaskPanel(t.id);
          const back = { repeat: currentRepeat("tp"), ...formWhen("tp", currentRepeat("tp")), who: val("tpWho"), title: val("tpTitle") };
          closeOverlay();
          return [t.title, [t.repeat || "", t.due || "", t.time || "", t.assignee || "", t.title].join("|"), [back.repeat, back.due, back.time, back.who, back.title].join("|")];
        }));
        trips.forEach(([title, was, now]) => { if (was !== now) problems.push(`Task panel changes "${title}": ${was} → ${now}`); });
        // the + button opens an empty New task panel, title ready for typing
        await p.waitForTimeout(500);
        await p.click("#fab");
        await p.waitForTimeout(500);
        const fresh = await p.evaluate(() => [panelUp(), document.querySelector(".tp-title").textContent, document.activeElement.id, val("tpTitle")]);
        if (fresh.join() !== "true,New task,tpTitle,") problems.push(`+ button: got ${fresh.join(" / ")}`);
        await p.keyboard.press("Escape");
        await p.waitForTimeout(500);
      }
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
  await ctx.route(HUB + "/**", worker);
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
