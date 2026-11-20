// The store: rows go in and come back the same, only what changed is written,
// and savers at the same instant never lose each other's work.
process.env.TZ = "America/New_York";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { transact, TABS } from "../store.js";
import * as core from "../hub/core.js";
import * as notify from "../hub/notify.js";
import { appsScriptSim } from "./appsscript-sim.js";

let mf, env;
const ALL = Object.keys(TABS);
const plain = x => JSON.parse(JSON.stringify(x === undefined ? null : x));
const rev = async () => Number((await env.DB.prepare("SELECT value FROM props WHERE key = 'rev'").first()).value);

before(async () => {
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('') } }", d1Databases: ["DB"] });
  env = { DB: await mf.getD1Database("DB") };
});
after(() => mf.dispose());

test("rows come back exactly as they went in, in order", async () => {
  await transact(env, ["Tasks", "Meals"], c => {
    c.tabs.Tasks.push({ id: "a1", title: "Bins", recurrence: "once", assignee: "", createdAt: "2026-11-20T00:00:00.000Z", due: "", repeat: "", lastDone: "", prevDue: "", time: "", parentId: "", sort: "" });
    c.tabs.Tasks.push({ id: "a2", title: "007", recurrence: "weekly", assignee: "Jon", createdAt: "x", due: "2026-11-21", repeat: "", lastDone: "", prevDue: "", time: "07:30", parentId: "a1", sort: 3 });
    c.props.NOTIFY_STATE = '{"sent":{}}';
  });
  await transact(env, ["Tasks", "Meals"], c => {
    assert.deepEqual(c.tabs.Tasks.map(t => [t.id, t.title, t.sort, t.time, t.due, t.assignee]),
      [["a1", "Bins", "", "", "", ""], ["a2", "007", 3, "07:30", "2026-11-21", "Jon"]], "text stays text, a number stays a number, blank stays blank");
    assert.deepEqual(c.tabs.Meals, []);
    assert.equal(c.props.NOTIFY_STATE, '{"sent":{}}');
    assert.equal("rev" in c.props, false, "the store's own counter isn't shown to the rules");
  });
});

test("nothing is written when nothing changed, and one save moves the counter once", async () => {
  const at = await rev();
  await transact(env, ALL, c => core.getTasks(c));
  assert.equal(await rev(), at);
  await transact(env, ALL, c => { c.tabs.Tasks[0].title = "Bins out"; c.tabs.Tasks.splice(1, 1); c.props.X = "1"; delete c.props.NOTIFY_STATE; });
  assert.equal(await rev(), at + 1);
  await transact(env, ALL, c => {
    assert.deepEqual(c.tabs.Tasks.map(t => t.title), ["Bins out"]);
    assert.deepEqual(c.props, { X: "1" });
  });
});

test("eight savers at the same instant: nothing is lost", async () => {
  let runs = 0;
  await Promise.all(Array.from({ length: 8 }, (_, i) => transact(env, ["CheckIns"], c => {
    runs++;
    c.tabs.CheckIns.push({ id: "c" + i, date: "2026-11-20", type: "huddle", answersJson: "{}" });
    c.props.COUNT = String(Number(c.props.COUNT || 0) + 1);
  })));
  await transact(env, ["CheckIns"], c => {
    assert.equal(c.tabs.CheckIns.length, 8);
    assert.equal(new Set(c.tabs.CheckIns.map(r => r.id)).size, 8);
    assert.equal(c.props.COUNT, "8", "each saver's count was added to the latest, not to a stale copy");
  });
  assert.ok(runs > 8, `some savers had to redo their work on fresh rows (${runs} runs for 8 saves)`);
});

test("the work may not wait on anything", async () => {
  await assert.rejects(transact(env, ["Tasks"], async () => {}), /must not wait/);
});

test("through the store, the rules still match Code.gs and Notify.gs", async () => {
  // The same comparison as core.test.js and notify.test.js, shorter, but with every
  // action loaded from and saved to the database, so what's stored is what's compared.
  await env.DB.batch(ALL.map(t => env.DB.prepare(`DELETE FROM hub_${t.toLowerCase()}`)).concat(env.DB.prepare("DELETE FROM props WHERE key != 'rev'")));
  let seed = 77;
  const rnd = n => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
  const pick = a => a[rnd(a.length)], maybe = n => rnd(n) === 0;
  const clock = { now: Date.parse("2026-10-30T20:00:00Z") };
  const ids = n => () => ("0000000" + (n.i++).toString(16)).slice(-8) + "-0000";
  const gs = appsScriptSim(["Code.gs", "Notify.gs"], {}, { clock, uuid: ids({ i: 1 }) });
  gs.eval("getEvents_ = function () { return []; };");
  ["getTasks_", "getMeals_", "notifyInfo_"].forEach(f => gs.run(f)); gs.run("getCheckins_", 10);
  const nextId = ids({ i: 1 });
  const hub = work => transact(env, ALL, work, { now: new Date(clock.now), newId: () => nextId().slice(0, 8), events: () => [] });
  const people = ["Jon", "Maggie", "Clayton", "Heidi"];
  let ticks = 0;

  for (let step = 0; step < 400; step++) {
    clock.now += pick([5, 5, 5, 60, 300, 1500]) * 60000;
    const tasks = await hub(c => core.getTasks(c)), anyId = () => tasks.length ? pick(tasks).id : "nosuch";
    const k = rnd(12), who = pick(people);
    let what, ours, theirs;
    if (k <= 2 || tasks.length < 3) {
      const b = { title: pick(["Bins", "Dishes", "Mow"]), assignee: pick(people.concat("Family")), recurrence: pick(["once", "daily", "weekly"]) };
      if (maybe(2)) b.due = new Date(clock.now + (rnd(9) - 3) * 86400e3).toISOString().slice(0, 10);
      if (maybe(3)) b.time = "15:30";
      if (maybe(3)) b.repeat = pick(["every 1 week", "every 2 days", "every 1 month on last fri"]);
      if (maybe(3)) b.parentId = anyId();
      what = "add " + JSON.stringify(b);
      theirs = gs.run("taskAdded_", gs.run("addTask_", b), who);
      ours = await hub(c => notify.taskAdded(c, core.addTask(c, b), who));
    } else if (k <= 4) {
      const b = { id: anyId(), due: maybe(2) ? "" : new Date(clock.now + rnd(9) * 86400e3).toISOString().slice(0, 10), order: [anyId(), anyId()] };
      if (maybe(2)) b.parentId = maybe(2) ? "" : anyId();
      what = "update " + JSON.stringify(b);
      theirs = gs.run("updateTask_", b); ours = await hub(c => core.updateTask(c, b));
    } else if (k <= 7) {
      const id = anyId();
      what = "toggle " + id;
      theirs = gs.run("toggleTask_", id, who); ours = await hub(c => core.toggleTask(c, id, who));
    } else if (k === 8) {
      const id = anyId();
      what = "delete " + id;
      theirs = gs.run("deleteTask_", id); ours = await hub(c => core.deleteTask(c, id));
    } else if (k === 9) {
      const meals = Object.fromEntries(core.DAYS.map(d => [d, { meal: pick(["Tacos", "Soup"]), note: "" }]));
      what = "saveMeals";
      gs.run("saveMeals_", meals); gs.run("mealsEdited_", meals, who);
      await hub(c => { core.saveMeals(c, meals); notify.mealsEdited(c, meals, who); });
    } else if (k === 10) {
      const sub = { endpoint: "https://push.example/" + rnd(6), keys: { p256dh: "k", auth: "a" } };
      what = "subscribe " + who;
      theirs = gs.run("pushSubscribe_", who, sub); ours = await hub(c => notify.pushSubscribe(c, who, sub));
    } else {
      const prefs = { summary: { on: true, at: pick(["07:00", "16:00", "21:30"]) }, quiet: { on: maybe(2), from: "21:00", to: "07:00" } };
      what = "savePrefs " + who;
      theirs = gs.run("savePrefs_", who, prefs); ours = await hub(c => notify.savePrefs(c, who, prefs));
    }
    assert.deepEqual(plain(ours), plain(theirs), `step ${step}: ${what} — what the action returns`);
    theirs = gs.run("dueNotifications_", new Date(clock.now)); ours = await hub(c => notify.dueNotifications(c));
    if (ours.length) ticks++;
    const at = `step ${step} at ${new Date(clock.now).toISOString()}: ${what}`;
    assert.deepEqual(plain(ours), theirs, at + " — what the timer sends");
    const state = await hub(c => ({ tasks: core.getTasks(c), meals: core.getMeals(c), checkins: core.getCheckins(c, 10), notify: JSON.parse(c.props.NOTIFY_STATE), tabs: c.tabs }));
    assert.deepEqual(plain(state.tasks), gs.run("getTasks_"), at + " — tasks");
    assert.deepEqual(plain(state.meals), gs.run("getMeals_"), at + " — meals");
    assert.deepEqual(state.notify, JSON.parse(gs.props.NOTIFY_STATE), at + " — what notifications remember");
    for (const tab of ALL) {
      const rows = gs.tabs[tab].rows.slice(1).map(r => Object.fromEntries(TABS[tab].map((col, i) => [col, r[i] === undefined ? "" : r[i]])));
      assert.deepEqual(plain(state.tabs[tab]), rows, at + ` — the ${tab} rows as stored`);
    }
  }
  assert.ok(ticks >= 20, `the timer sent something on only ${ticks} runs`);
});
