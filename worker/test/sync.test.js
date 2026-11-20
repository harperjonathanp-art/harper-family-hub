// Todoist and Notion: the Worker's versions (hub/todoist.js, hub/notion.js) against
// the real Todoist.gs, Notion.gs and NotionCheckins.gs, talking to the same pretend sites.
process.env.TZ = "America/New_York";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appsScriptSim } from "./appsscript-sim.js";
import * as core from "../hub/core.js";
import * as todoist from "../hub/todoist.js";
import * as notion from "../hub/notion.js";
import { local } from "../hub/time.js";

const plain = x => JSON.parse(JSON.stringify(x === undefined ? null : x));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function rng(seed) {
  return n => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
}
/** The Worker's fetch, answered by the same pretend site the script talks to. */
const useSite = http => { globalThis.fetch = async (url, init) => {
  init = init || {};
  const r = http(String(init.method || "GET").toUpperCase(), String(url), init.headers || {}, init.body);
  return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
}; };
const ENV = { TODOIST_TOKEN: " tok ", NOTION_TOKEN: "ntok", NOTION_MEALS_SOURCE: "meals-src", NOTION_CHECKINS_SOURCE: "checkins-src" };
const PROPS = { TODOIST_TOKEN: " tok ", NOTION_TOKEN: "ntok", NOTION_MEALS_SOURCE: "meals-src", NOTION_CHECKINS_SOURCE: "checkins-src" };
const newC = clock => ({ tabs: { Tasks: [], Completions: [], Meals: [], CheckIns: [] }, props: {}, get now() { return new Date(clock.now); }, newId: () => "x" });

test("Todoist: the same tasks, ticks, staleness and summary line as Todoist.gs", async () => {
  const rnd = rng(5), pick = a => a[rnd(a.length)], maybe = n => rnd(n) === 0;
  const clock = { now: Date.parse("2026-11-01T03:00:00Z") };
  const site = { status: 200, projects: [], sections: [], tasks: [], calls: 0 };
  const http = (method, url, headers) => {
    site.calls++;
    assert.equal(headers.Authorization, "Bearer tok");
    if (site.status !== 200) return { status: site.status, body: { error: "secret task text must not be kept" } };
    const u = new URL(url), all = site[u.pathname.split("/").pop()];
    const from = Number(u.searchParams.get("cursor") || 0), size = 7; // small pages, so paging is really used
    const overlap = from ? 1 : 0; // a task can show up on two pages if it moved mid-read
    return { status: 200, body: { results: all.slice(from - overlap, from + size), next_cursor: from + size < all.length ? String(from + size) : null } };
  };
  const gs = appsScriptSim(["Code.gs", "Notify.gs", "Todoist.gs"], PROPS, { clock, http });
  useSite(http);
  const c = newC(clock);
  const seen = { fresh: 0, stale: 0, error: 0, line: 0, hiddenDropped: 0, ticked: 0 };

  for (let round = 0; round < 250; round++) {
    clock.now += pick([1, 4, 6, 12, 40, 900]) * 60000;
    if (maybe(3) || !site.projects.length) { // Todoist's contents change
      site.projects = ["Inbox", "Maintenance", "Work", "Clean", "work"].slice(0, 2 + rnd(4)).map((name, i) => ({ id: "p" + i, name }));
      site.sections = Array.from({ length: rnd(4) }, (_, i) => ({ id: "s" + i, name: "Section " + i, section_order: rnd(5) }));
      site.tasks = Array.from({ length: rnd(26) }, (_, i) => {
        const day = new Date(clock.now + (rnd(9) - 4) * 86400e3).toISOString().slice(0, 10);
        const due = pick([null, null, { date: day }, { date: day + "T09:05:00" }, { date: day + "T01:30:00Z" }, { date: day + "T23:15:00.000000Z", is_recurring: true, string: "every Tue" }, { date: "someday", string: "someday soon" }]);
        return { id: "t" + i, content: pick(["Counters", "LinkedIn | Alumni", "Call " + i, ""]), description: maybe(3) ? " note " + "z".repeat(rnd(400)) : "",
          project_id: maybe(9) ? "gone" : pick(site.projects).id, section_id: maybe(2) && site.sections.length ? pick(site.sections).id : null,
          parent_id: i && maybe(3) ? "t" + rnd(i) : null, child_order: rnd(6), priority: pick([1, 2, 3, 4, 9, undefined]),
          checked: maybe(12), is_deleted: maybe(15), due };
      });
    }
    site.status = pick([200, 200, 200, 200, 401, 500]);
    if (maybe(12)) { // the hidden projects change
      const hide = pick(["Work", "", "Clean, WORK", undefined]);
      if (hide === undefined) { delete gs.props.REMINDERS_HIDE_LISTS; delete ENV.REMINDERS_HIDE_LISTS; } else { gs.props.REMINDERS_HIDE_LISTS = hide; ENV.REMINDERS_HIDE_LISTS = hide; }
      site.status = 200; // the Worker hides as it reads, so the two agree again from the next good read
    }
    const theirs = gs.run("syncTodoist");
    let ours;
    try { const items = await todoist.fetchTodoist(ENV); todoist.storeTodoist(c, items); ours = { status: "updated" }; }
    catch (err) { todoist.todoistFailed(c, err.message); ours = { status: "error", message: String(err.message).slice(0, 200) }; }
    assert.equal(ours.status, theirs.status, `round ${round}: whether the read worked`);
    if (ours.status === "error") assert.equal(ours.message, theirs.message, `round ${round}: the error kept`);
    assert.ok(!/secret task text/.test(c.props.TODOIST_META), "an error never keeps what Todoist said");

    const hidden = String(ENV.REMINDERS_HIDE_LISTS == null ? "Work" : ENV.REMINDERS_HIDE_LISTS).split(",").map(s => s.trim().toLowerCase());
    if (ours.status === "updated") {
      const stored = JSON.parse(c.props.TODOIST_ITEMS);
      assert.ok(stored.every(r => !hidden.includes(r.list.toLowerCase())), "a hidden project is never stored");
      const all = todoist.todoistItems(site.tasks, site.projects, site.sections, () => ({ date: "", time: "" }));
      if (all.length > stored.length) seen.hiddenDropped++;
    }
    for (let i = 0; i < 3; i++) { // the family ticks things in the Hub
      const key = maybe(5) ? "nosuch" : "t" + rnd(26), on = !maybe(3), by = pick(["Jon", "Maggie", "x".repeat(30)]);
      gs.run("tickReminder_", key, on, by); todoist.tickReminder(c, key, on, by);
    }
    clock.now += pick([0, 2, 10, 45]) * 60000;
    const mine = plain(todoist.getReminders(c)), gsView = gs.run("getReminders_", true);
    // Hiding as it reads means a change to the hidden list shows at the next good read here, at once there.
    const lastGoodHid = JSON.parse(c.props.TODOIST_ITEMS || "[]").every(r => !hidden.includes(r.list.toLowerCase()));
    if (lastGoodHid && (gsView.items || []).length === (mine.items || []).length) {
      assert.deepEqual(mine, gsView, `round ${round}: what the Hub is sent`);
      const today = local(new Date(clock.now)).iso;
      const line = todoist.remindersLine(c, today);
      assert.equal(line, gs.run("remindersLine_", today), `round ${round}: Jon's summary line`);
      if (line) seen.line++;
      seen[mine.status === "none" ? "error" : mine.status]++;
      if ((mine.items || []).some(r => r.ticked)) seen.ticked++;
    }
    assert.equal(todoist.todoistBehind(c.props.TODOIST_META, clock.now), (() => { const m = JSON.parse(gs.props.TODOIST_META || "{}"); return clock.now - (m.syncedAt || 0) > 5 * 60000 && clock.now - (m.attemptedAt || 0) > 5 * 60000; })(), `round ${round}: whether a device asking now re-reads Todoist`);
  }
  const least = { fresh: 40, stale: 30, line: 30, hiddenDropped: 30, ticked: 30 };
  Object.keys(least).forEach(k => assert.ok(seen[k] >= least[k], `only ${seen[k]} rounds with "${k}": ${JSON.stringify(seen)}`));
});

/** A pretend Notion with a Meal Plan, Recipes and Weekly Check-Ins. */
function fakeNotion() {
  const n = { meals: [], recipes: {}, checkinPages: [], nextPage: 1, fail: 0, log: [] };
  n.http = (method, url, headers, body) => {
    assert.equal(headers.Authorization, "Bearer ntok");
    assert.equal(headers["Notion-Version"], "2025-09-03");
    const path = new URL(url).pathname.replace("/v1", ""), b = body ? JSON.parse(body) : null;
    n.log.push(method + " " + path);
    if (n.fail) return { status: n.fail, body: { message: "Could not find data_source" } };
    if (path === "/data_sources/meals-src/query") {
      const [from, to] = [b.filter.and[0].date.on_or_after, b.filter.and[1].date.on_or_before];
      return { status: 200, body: { results: n.meals.filter(p => { const d = p.properties.Date.date; return d && d.start.slice(0, 10) >= from && d.start.slice(0, 10) <= to; }) } };
    }
    if (path.startsWith("/pages/") && method === "GET") {
      const r = n.recipes[path.slice(7)];
      return r ? { status: 200, body: r } : { status: 404, body: { message: "Could not find page" } };
    }
    if (path === "/data_sources/checkins-src/query") {
      const live = n.checkinPages.filter(p => !p.in_trash && p.properties["Hub ID"].rich_text.length);
      const from = b.start_cursor ? Number(b.start_cursor) : 0, size = 4;
      return { status: 200, body: { results: live.slice(from, from + size).map(p => ({ id: p.id, properties: { "Hub ID": { rich_text: p.properties["Hub ID"].rich_text.map(t => ({ plain_text: t.text.content })) } } })),
        has_more: from + size < live.length, next_cursor: String(from + size) } };
    }
    if (path === "/pages" && method === "POST") { n.checkinPages.push(Object.assign({ id: "page" + n.nextPage++, in_trash: false }, b)); return { status: 200, body: {} }; }
    if (path.startsWith("/pages/") && method === "PATCH") { n.checkinPages.find(p => p.id === path.slice(7)).in_trash = b.in_trash; return { status: 200, body: {} }; }
    return { status: 400, body: { message: "unexpected " + method + " " + path } };
  };
  return n;
}

test("Notion dinners: the same week, links and notes as Notion.gs", async () => {
  const rnd = rng(9), pick = a => a[rnd(a.length)], maybe = n => rnd(n) === 0;
  const clock = { now: Date.parse("2026-10-29T12:00:00Z") };
  const n = fakeNotion();
  const gs = appsScriptSim(["Code.gs", "Notify.gs", "Notion.gs"], PROPS, { clock, http: n.http });
  useSite(n.http);
  const c = newC(clock);
  gs.run("getMeals_"); core.getMeals(c);
  const sel = name => (name ? { select: { name } } : { select: null });
  const text = s => [{ plain_text: s }];
  const seen = { changed: 0, failed: 0, linked: 0, two: 0, weeks: new Set() };

  for (let round = 0; round < 300; round++) {
    clock.now += pick([10, 10, 10, 200, 1500, 7000]) * 60000;
    if (maybe(3) || !n.meals.length) {
      n.recipes = {};
      for (let i = 0; i < 6; i++) if (!maybe(5)) n.recipes["r" + i] = { url: "https://notion.so/r" + i, properties: maybe(2) ? { Source: { url: "https://cook.example/" + i } } : {} };
      n.meals = Array.from({ length: 4 + rnd(14) }, (_, i) => {
        const day = new Date(clock.now + (rnd(16) - 7) * 86400e3).toISOString().slice(0, 10);
        return { properties: {
          Date: { date: maybe(12) ? null : { start: day + (maybe(4) ? "T18:00:00.000-04:00" : "") } },
          Meal: { title: text(pick(["Tacos", "Sheet-Pan  Sausage", "Soup", ""])) },
          "Meal Type": sel(pick(["Dinner", "Dinner", "", "Lunch"])), Status: sel(pick(["", "", "Planned", "Skipped"])),
          Notes: { rich_text: text(pick(["", "", "20 min.", "use the big pot"])) }, "Who Cooks": sel(pick(["", "Jon", "Maggie", "Together", "Leftovers"])),
          Recipe: { relation: Array.from({ length: rnd(3) }, () => ({ id: "r" + rnd(6) })) },
        } };
      });
    }
    n.fail = pick([0, 0, 0, 0, 404, 500]);
    const before = JSON.stringify(core.getMeals(c));
    const theirs = gs.run("syncNotionMeals");
    const today = local(new Date(clock.now)).iso, week = notion.weekStart(today);
    let ours;
    try {
      const recipes = notion.loadRecipes(c);
      const meals = notion.weekOfDinners(await notion.fetchDinners(ENV, week, recipes, clock.now), week);
      const changed = !notion.sameMeals(core.getMeals(c), meals);
      if (changed) core.saveMeals(c, meals);
      notion.saveRecipes(c, recipes);
      notion.notionMealsDone(c, week);
      ours = { status: changed ? "updated" : "current" };
    } catch (err) { notion.notionMealsFailed(c, err.message); ours = { status: "error" }; }
    assert.equal(ours.status, theirs.status, `round ${round}: ${theirs.message || ""}`);
    assert.deepEqual(plain(core.getMeals(c)), gs.run("getMeals_"), `round ${round}: the week's dinners`);
    assert.deepEqual(plain(notion.notionMealsInfo(c, ENV)), gs.run("notionMealsInfo_"), `round ${round}: what the Hub is told about the sync`);
    if (ours.status === "updated") seen.changed++;
    if (ours.status === "error") { seen.failed++; assert.equal(JSON.stringify(core.getMeals(c)), before, "a failed read leaves the last plan"); }
    const meals = Object.values(core.getMeals(c)).map(m => m.meal);
    if (meals.some(m => / \| https/.test(m))) seen.linked++;
    if (meals.some(m => / \+ /.test(m))) seen.two++;
    seen.weeks.add(week);
  }
  assert.equal(notion.notionMealsInfo(c, {}), null);
  assert.ok(seen.changed >= 40 && seen.failed >= 30 && seen.linked >= 50 && seen.two >= 20 && seen.weeks.size >= 5, JSON.stringify({ ...seen, weeks: seen.weeks.size }));
  assert.ok([...seen.weeks].every(w => new Date(w + "T12:00:00Z").getUTCDay() === 6), "every plan week starts on a Saturday");
});

test("Notion check-ins: the same pages made and trashed as NotionCheckins.gs", async () => {
  const rnd = rng(13), pick = a => a[rnd(a.length)], maybe = n => rnd(n) === 0;
  const clock = { now: Date.parse("2026-11-01T12:00:00Z") };
  const theirs = fakeNotion(), ours = fakeNotion(); // each side makes its own pages
  const ids = n => () => ("0000000" + (n.i++).toString(16)).slice(-8) + "-0000";
  const gs = appsScriptSim(["Code.gs", "Notify.gs", "Notion.gs", "NotionCheckins.gs"], PROPS, { clock, http: theirs.http, uuid: ids({ i: 1 }) });
  const nextId = ids({ i: 1 });
  const c = Object.assign(newC(clock), { newId: () => nextId().slice(0, 8) });
  gs.run("getCheckins_", 10);
  let made = 0, trashed = 0, failed = 0;

  for (let round = 0; round < 120; round++) {
    clock.now += pick([30, 30, 1440, 10080]) * 60000;
    for (let i = rnd(4); i > 0; i--) {
      const type = pick(["huddle", "couples"]);
      const answers = type === "huddle" ? { rose: pick(["Good week", "", "  "]), week: "Busy", extra: "kept", long: "w".repeat(maybe(4) ? 4500 : 3) } : { q0: "Thanks", q6: 7, q3: null };
      gs.run("saveCheckin_", type, answers); core.saveCheckin(c, type, answers);
    }
    if (maybe(4) && c.tabs.CheckIns.length > 1) { const id = pick(c.tabs.CheckIns).id; gs.run("deleteCheckin_", id); core.deleteCheckin(c, id); }
    theirs.fail = ours.fail = pick([0, 0, 0, 0, 403]);
    const a = gs.run("syncNotionCheckins");
    useSite(ours.http);
    const b = await notion.syncNotionCheckins(ENV, core.getCheckins(c, Infinity).reverse());
    assert.deepEqual(b, a, `round ${round}: what the sync reports`);
    assert.deepEqual(plain(ours.checkinPages), plain(theirs.checkinPages), `round ${round}: the pages in Notion`);
    if (/[1-9]\d* copied/.test(b.message)) made++;
    if (/[1-9]\d* trashed/.test(b.message)) trashed++;
    if (b.status === "error") failed++;
  }
  assert.ok(made >= 40 && trashed >= 10 && failed >= 10, JSON.stringify({ made, trashed, failed }));
  const page = ours.checkinPages.find(p => /Family Huddle · /.test(p.properties.Name.title[0].text.content));
  assert.match(page.properties.Name.title[0].text.content, /^Family Huddle · [A-Z][a-z]{2} \d{1,2}, 20\d\d$/);
  assert.equal(notion.notionCheckinsOn({ NOTION_TOKEN: "x" }), false);
});
