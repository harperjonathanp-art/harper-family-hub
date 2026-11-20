// The move itself: a Sheet with months of history, cells turned into dates the way
// Google Sheets does it, copied into the Worker, checked, and taken over.
process.env.TZ = "America/New_York";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHub } from "./harness.js";
import { appsScriptSim } from "./appsscript-sim.js";

const FILES = ["Code.gs", "Notify.gs", "Todoist.gs", "Notion.gs", "NotionCheckins.gs", "Handover.gs"];
const COLS = { Tasks: ["id", "title", "recurrence", "assignee", "createdAt", "due", "repeat", "lastDone", "prevDue", "time", "parentId", "sort"], Completions: ["taskId", "periodKey", "completedBy", "timestamp"], CheckIns: ["id", "date", "type", "answersJson"] };
function rng(seed) {
  return n => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
}
const rnd = rng(4242), pick = a => a[rnd(a.length)], maybe = n => rnd(n) === 0;
const people = ["Jon", "Maggie", "Clayton", "Heidi", "Family", ""];
const repeats = ["every 1 day", "every 1 week", "every 2 weeks", "every 1 week on sun,tue,thu", "every 1 month", "every 3 months on 3rd sat", "every 1 year", "nonsense"];

let h, gs, jon;
const clock = { now: Date.parse("2026-08-01T16:00:00Z") };
const todoistTasks = [{ id: "t1", content: "Renew passport", project_id: "p1", due: { date: "2026-11-20" } }, { id: "t2", content: "Email a student's parent", project_id: "p2" }];
const anyId = () => { const rows = gs.tabs.Tasks.rows; return rows.length > 1 ? String(rows[1 + rnd(rows.length - 1)][0]) : "nosuch"; };
/** A random thing the family does, as { fn, args } for Code.gs and { action, … } for the Hub's API. */
function something() {
  const k = rnd(20);
  if (k <= 4) {
    const b = { title: pick(["Bins", "Dishes", "Mow the lawn", "Homework"]), assignee: pick(people), recurrence: pick(["once", "daily", "weekly", "monthly", "quarterly", "yearly"]) };
    if (maybe(2)) b.due = new Date(clock.now + (rnd(30) - 10) * 86400e3).toISOString().slice(0, 10);
    if (maybe(3)) b.time = pick(["07:30", "15:30"]);
    if (maybe(3)) b.repeat = pick(repeats);
    if (maybe(3)) b.parentId = anyId();
    return { fn: "addTask_", args: [b], api: Object.assign({ action: "addTask" }, b), adds: true };
  }
  if (k <= 7) {
    const b = { id: anyId() };
    if (maybe(2)) b.due = maybe(3) ? "" : new Date(clock.now + rnd(20) * 86400e3).toISOString().slice(0, 10);
    if (maybe(3)) b.repeat = pick(repeats.concat(""));
    if (maybe(3)) b.parentId = maybe(2) ? "" : anyId();
    if (maybe(3)) b.order = [anyId(), anyId(), anyId()];
    return { fn: "updateTask_", args: [b], api: Object.assign({ action: "updateTask" }, b) };
  }
  if (k <= 17) { const id = anyId(); return { fn: "toggleTask_", args: [id, "Jon"], api: { action: "toggleTask", id } }; }
  if (k === 18) { const id = anyId(); return { fn: "deleteTask_", args: [id], api: { action: "deleteTask", id } }; }
  const type = pick(["huddle", "couples"]);
  return { fn: "saveCheckin_", args: [type, { rose: "x" }], api: { action: "saveCheckin", type, answers: { rose: "x" } } };
}

/** Turns text cells into the dates, times and numbers Google Sheets would have made of them. */
function coerceLikeSheets() {
  const day = s => { const [y, m, d] = s.split("-").map(Number); return new gs.Date(y, m - 1, d); };
  let turned = 0;
  gs.tabs.Tasks.rows.slice(1).forEach(r => {
    [5, 7, 8].forEach(i => { if (/^\d{4}-\d{2}-\d{2}$/.test(r[i])) { r[i] = day(r[i]); turned++; } });
    if (/^\d{2}:\d{2}$/.test(r[9])) { const [H, M] = r[9].split(":").map(Number); r[9] = new gs.Date(1899, 11, 30, H, M, 12); turned++; }
  });
  gs.tabs.Completions.rows.slice(1).forEach(r => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(r[1])) { r[1] = day(r[1]); turned++; }
    else if (/^\d{4}-\d{2}$/.test(r[1])) { r[1] = day(r[1] + "-01"); turned++; }
    else if (/^\d{4}$/.test(r[1])) { r[1] = Number(r[1]); turned++; }
  });
  gs.tabs.CheckIns.rows.slice(1).forEach(r => { r[1] = day(r[1]); turned++; });
  return turned;
}
const setHub = async vars => { h.options.bindings = Object.assign({}, h.options.bindings, vars); await h.mf.setOptions(h.options); h.db = await h.mf.getD1Database("DB"); };
const cron = async () => (await h.mf.getWorker()).scheduled({ cron: "*/5 * * * *" });
const shadow = async () => JSON.parse((await h.db.prepare("SELECT value FROM props WHERE key = 'SHADOW'").first()).value);
const api = async body => (await h.post("/api", body, jon)).json();
const hubAll = async () => (await h.get("/api?action=all&reminders=1", jon)).json();
const text = t => Object.assign({}, t, { title: String(t.title), assignee: String(t.assignee || "") });

before(async () => {
  const site = (method, url) => {
    const kind = new URL(url).pathname.split("/").pop();
    return { status: 200, body: { results: kind === "projects" ? [{ id: "p1", name: "Maintenance" }, { id: "p2", name: "Work" }] : kind === "sections" ? [] : todoistTasks, next_cursor: null } };
  };
  gs = appsScriptSim(FILES, { TODOIST_TOKEN: "tok", NOTION_TOKEN: "ntok", NOTION_MEALS_SOURCE: "m", NOTION_CHECKINS_SOURCE: "c", VAPID_PUBLIC_KEY: "pk" },
    { clock, http: site, timers: ["notifyTick", "syncTodoist", "syncNotionMeals", "syncNotionCheckins", "somethingElse"] });
  gs.eval("getEvents_ = function () { return [{ cal: 'Family', title: 'Soccer', allDay: true, date: '2026-11-21', start: '12:00 AM', end: '12:00 AM', sort: 1 }]; };");
  // Sixteen weeks of family life in the Sheet.
  ["getTasks_", "getMeals_", "notifyInfo_"].forEach(f => gs.run(f)); gs.run("getCheckins_", 10);
  for (let step = 0; step < 900; step++) {
    clock.now += pick([5, 30, 60, 120, 240, 300, 480]) * 60000; // about three hours apart: sixteen weeks in all
    const a = something(); gs.run(a.fn, ...a.args);
  }
  gs.run("addTask_", { title: "007" }); gs.tabs.Tasks.rows[gs.tabs.Tasks.rows.length - 1][1] = 7; // a title the Sheet read as a number
  gs.run("saveMeals_", { Mon: { meal: "Tacos", note: "20 min." }, Sat: { meal: "Soup | https://x.example/r", note: "" } });
  gs.run("pushSubscribe_", "Jon", { endpoint: "https://fcm.googleapis.com/fcm/send/jon", keys: { p256dh: "k", auth: "a" } });
  gs.run("savePrefs_", "Jon", { summary: { on: true, at: "06:45" } });
  gs.run("dueNotifications_", new Date(clock.now));
  gs.run("syncTodoist"); gs.run("tickReminder_", "t1", true, "Maggie");
  assert.ok(clock.now < Date.parse("2026-11-20T21:30:00Z") && clock.now > Date.parse("2026-10-25T00:00:00Z"), "the history ends shortly before the move: " + new Date(clock.now).toISOString());
  clock.now = Date.parse("2026-11-20T21:30:40Z"); // Friday afternoon: the day of the move
  for (let i = 0; i < 25; i++) { const a = something(); gs.run(a.fn, ...a.args); } // some of it today
  const asText = gs.request({ method: "GET", query: { action: "all", pin: "4321" } });
  const turned = coerceLikeSheets();
  assert.ok(turned > 300, `only ${turned} cells were turned into dates`);
  const asCells = gs.request({ method: "GET", query: { action: "all", pin: "4321" } });
  assert.deepEqual(asCells.tasks.map(text), asText.tasks.map(text), "Code.gs itself reads the Sheet's date cells as it read the text");

  h = await startHub({ MOVED: "groceries,shadow", TEST_NOW: "2026-11-20T21:30:40Z", TODOIST_TOKEN: "tok" });
  h.appsScript = sent => gs.request(sent);
  h.site = async (request, url) => {
    if (url.host === "api.todoist.com") { const r = site("GET", url.href); return new Response(JSON.stringify(r.body)); }
  };
  jon = await h.signIn("jon@example.com", "Jon");
});
after(() => h.mf.dispose());

test("shadow: the Worker's copy gives the Hub exactly what Apps Script does, and nobody is served from it", async () => {
  const before = await hubAll();
  await cron();
  const s = await shadow();
  assert.deepEqual([s.ok, s.differences, s.error], [true, { tasks: 0, meals: 0, checkins: 0, reminders: 0 }, undefined], JSON.stringify(s));
  assert.ok(s.rows.Tasks > 50 && s.rows.Completions > 80 && s.rows.CheckIns > 20 && s.rows.Devices === 1, JSON.stringify(s.rows));
  assert.ok(s.oldTicksSetAside > 30, "ticks for days and weeks long over aren't carried in the rows every request loads");
  assert.deepEqual(s.missing, ["NOTION_TOKEN", "NOTION_MEALS_SOURCE", "NOTION_CHECKINS_SOURCE"], "it says which settings the Worker still needs its own copy of");
  assert.deepEqual([s.runs, s.cleanRuns], [1, 1]);
  assert.deepEqual(await hubAll(), before, "the Hub is still answered by Apps Script");
  assert.deepEqual(gs.timers.length, 5, "and Apps Script's timers are untouched");
  await cron();
  assert.deepEqual([(await shadow()).runs, (await shadow()).cleanRuns], [2, 2]);
});

test("shadow notices a difference, and records where without recording what", async () => {
  gs.eval("var realGetTasks_ = getTasks_; getTasks_ = function () { var t = realGetTasks_(); t[3].completed = !t[3].completed; t[5].due = '2030-01-01'; return t; };");
  await cron();
  const s = await shadow();
  assert.deepEqual([s.ok, s.differences.tasks, s.cleanRuns], [false, 2, 0]);
  assert.deepEqual(s.sample.map(x => x.fields), [["completed"], ["due"]]);
  assert.ok(!/Bins|Dishes|Mow|Homework/.test(JSON.stringify(s)), "no task's words are kept in the report");
  gs.eval("getTasks_ = realGetTasks_;");
  await cron();
  assert.deepEqual([(await shadow()).ok, (await shadow()).cleanRuns], [true, 1]);
});

test("the Worker won't take over from a script that can't be told to stop", async () => {
  const old = await startHub({ MOVED: "core" });
  try {
    const token = await old.signIn("jon@example.com", "Jon");
    old.appsScript = sent => (sent.method === "POST" ? { ok: false, error: "unknown_action" } : { ok: true, tasks: [], meals: {}, events: [], checkins: [] });
    const r = await old.get("/api?action=all", token);
    assert.deepEqual([r.status, await r.json()], [503, { ok: false, error: "moving" }]);
    assert.equal(await old.db.prepare("SELECT 1 AS x FROM props WHERE key = 'CUTOVER_AT'").first(), null);
    await (await old.mf.getWorker()).scheduled({ cron: "*/5 * * * *" }).catch(() => {}); // the timer can't either
    assert.equal((await old.db.prepare("SELECT COUNT(*) AS n FROM hub_tasks").first()).n, 0);
  } finally { await old.mf.dispose(); }
});

test("the move: Apps Script stops, everything comes over, and the Hub carries on where it was", async () => {
  const theirs = gs.request({ method: "GET", query: { action: "all", pin: "4321", reminders: "1" } });
  for (let i = 0; i < 5; i++) { const a = something(); gs.run(a.fn, ...a.args); } // things done after the last shadow copy
  const lastMinute = gs.request({ method: "GET", query: { action: "all", pin: "4321", reminders: "1" } });
  assert.notDeepEqual(lastMinute.tasks, theirs.tasks);
  await setHub({ MOVED: "groceries,core" });
  h.upstream.length = 0;

  const mine = await hubAll(); // the first request after the move does the takeover
  assert.deepEqual(h.upstream.map(u => (u.body || u.query).action).slice(0, 2), ["handover", "export"], "Apps Script is told to stop before the last copy is taken");
  assert.deepEqual(mine.tasks.map(text), lastMinute.tasks.map(text), "tasks, including what was done at the last minute");
  assert.deepEqual([mine.meals, mine.checkins], [lastMinute.meals, lastMinute.checkins]);
  assert.deepEqual(mine.events.map(e => e.title), ["Soccer"]);
  assert.deepEqual(mine.reminders.items.map(r => [r.title, r.ticked, r.tickedBy]), [["Renew passport", true, "Maggie"]], "Jon's Todoist copy and its tick, without the Work project");
  const info = await (await h.get("/api?action=notify", jon)).json();
  assert.deepEqual([info.devices.Jon, info.prefs.Jon.summary.at, info.lastTick], [1, "06:45", JSON.parse(gs.props.NOTIFY_STATE).lastTick], "phones, settings and what notifications remember");

  assert.equal(gs.props.HANDED_OVER, "1");
  assert.deepEqual(gs.timers, ["somethingElse"], "Apps Script's four timers are removed, and only those");
  assert.deepEqual([gs.props.NOTION_CHECKINS_SOURCE, gs.props.NOTION_CHECKINS_SOURCE_OFF], [undefined, "c"], "it can no longer trash check-in pages in Notion");
  assert.deepEqual(gs.request({ method: "POST", body: { action: "toggleTask", id: "x", pin: "4321" } }), { ok: false, error: "moved" });
  assert.equal(gs.request({ method: "GET", query: { action: "events", pin: "4321" } }).events.length, 1, "but it still serves the calendar");
  const relay = await h.call("/send", { method: "POST", body: JSON.stringify({ subscriptions: [{}] }), headers: { Authorization: "Bearer push-secret" } });
  assert.deepEqual((await relay.json()).results, [], "and its notifications, if it tried, would go nowhere");

  const old = (await h.db.prepare("SELECT COUNT(*) AS n FROM hub_completions_old").first()).n, kept = (await h.db.prepare("SELECT COUNT(*) AS n FROM hub_completions").first()).n;
  assert.ok(old > 30 && kept > 5 && old + kept === gs.tabs.Completions.rows.length - 1, `every tick is kept: ${kept} in use, ${old} set aside`);
  h.upstream.length = 0;
  await hubAll();
  assert.deepEqual(h.upstream, [], "after that, Apps Script isn't asked for anything");
});

test("after the move the same actions give the same results, today and in the weeks after", async () => {
  // Apps Script is frozen for the Hub, but its rules can still be run here directly, on its Sheet
  // with the date cells, next to the Worker on what it copied. They must keep agreeing.
  const idOf = {}; // a task made after the move has a different id on each side
  const mineAs = t => Object.assign(text(t), { id: idOf[t.id] || t.id, parentId: idOf[t.parentId] || t.parentId });
  let compared = 0;
  for (const at of ["2026-11-20T23:10:00Z", "2026-11-21T15:00:00Z", "2026-11-23T02:00:00Z", "2026-12-01T13:00:00Z", "2027-01-02T18:00:00Z"]) {
    clock.now = Date.parse(at);
    await setHub({ TEST_NOW: at });
    for (let i = 0; i < 40; i++) {
      const a = something();
      const fromWorker = Object.fromEntries(Object.entries(idOf).map(([w, g]) => [g, w]));
      const swap = v => (typeof v === "string" && fromWorker[v]) || v;
      const body = Object.assign({}, a.api);
      ["id", "parentId"].forEach(k => { if (k in body) body[k] = swap(body[k]); });
      if (body.order) body.order = body.order.map(swap);
      gs.run(a.fn, ...a.args);
      const d = await api(body);
      const theirs = gs.run("getTasks_");
      if (a.adds) idOf[d.tasks[d.tasks.length - 1].id] = theirs[theirs.length - 1].id;
      assert.deepEqual(d.tasks.map(mineAs), theirs.map(text), `${at}, action ${i}: ${a.fn} ${JSON.stringify(a.args)}`);
      assert.deepEqual(d.checkins.map(c => [c.date, c.type]), gs.run("getCheckins_", 10).map(c => [c.date, c.type]));
      compared++;
    }
  }
  assert.equal(compared, 200);
});
