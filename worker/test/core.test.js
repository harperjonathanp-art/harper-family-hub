// Tasks, dinners and check-ins: the Worker's version (hub/core.js) against the
// real apps-script/Code.gs, on the same random actions with the same clock.
process.env.TZ = "America/New_York"; // Code.gs reads a Date's local time as the family's time zone
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { appsScriptSim } from "./appsscript-sim.js";
import * as core from "../hub/core.js";

const COLS = {
  Tasks: ["id", "title", "recurrence", "assignee", "createdAt", "due", "repeat", "lastDone", "prevDue", "time", "parentId", "sort"],
  Completions: ["taskId", "periodKey", "completedBy", "timestamp"],
  Meals: ["day", "meal", "note"],
  CheckIns: ["id", "date", "type", "answersJson"],
};
const plain = x => JSON.parse(JSON.stringify(x === undefined ? null : x));

function rng(seed) { // mulberry32
  return n => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

function scenario(name, startIso, seed, steps) {
  test(`${name}: ${steps} random actions give the same result as Code.gs`, () => {
    const rnd = rng(seed), pick = a => a[rnd(a.length)], maybe = n => rnd(n) === 0;
    const clock = { now: Date.parse(startIso) };
    const ids = n => () => ("0000000" + (n.i++).toString(16)).slice(-8) + "-0000";
    const gs = appsScriptSim(["Code.gs"], {}, { clock, uuid: ids({ i: 1 }) });
    const nextId = ids({ i: 1 });
    const c = { tabs: { Tasks: [], Completions: [], Meals: [], CheckIns: [] }, now: null, newId: () => nextId().slice(0, 8) };
    gs.run("getTasks_"); gs.run("getMeals_"); gs.run("getCheckins_", 10); // makes the tabs, as the first request does

    const people = ["Jon", "Maggie", "Clayton", "Heidi", "Family", ""];
    const recurrences = ["once", "once", "daily", "weekly", "monthly", "quarterly", "yearly", undefined];
    const repeats = ["every 1 day", "every 2 days", "every 1 week", "every 2 weeks", "every 1 week on sun,tue,thu", "Every 1 Week on Mon",
      "every 3 weeks on sat sun", "every 1 month", "every 3 months", "every 3 months on 3rd sat", "every 1 month on last fri",
      "every 1 month on 5th mon", "every 1 year", "every 1 year on first sun", "every 6 months", "every 1 week on funday",
      "every 2 days on mon", "sometimes", "", "", ""];
    const times = ["07:30", "7:05", "15:30", "23:59", "24:00", "9:5", "noon", "", ""];
    const dayNear = () => { // a date within a few weeks of now, as the page would send it
      const d = new Date(clock.now + (rnd(60) - 20) * 86400000);
      return d.toISOString().slice(0, 10);
    };
    const dues = () => pick([dayNear(), dayNear(), "", "", "2026-13-45", "tomorrow", undefined]);
    const count = { add: 0, update: 0, toggle: 0, untick: 0, delete: 0, meals: 0, checkin: 0, sub: 0, repeatTick: 0, days: 0, order: 0 };
    let lastDay = "";

    for (let step = 0; step < steps; step++) {
      // Time passes: usually minutes, sometimes past midnight, now and then weeks.
      clock.now += pick([60e3, 5 * 60e3, 3600e3, 3600e3, 5 * 3600e3, 11 * 3600e3, 26 * 3600e3, 26 * 3600e3, 8 * 86400e3, 33 * 86400e3]);
      c.now = new Date(clock.now);
      const tasks = c.tabs.Tasks, anyId = () => tasks.length ? String(pick(tasks).id) : "nosuch";
      const kind = tasks.length < 4 ? 0 : rnd(20);
      let what;
      if (kind <= 4) {
        const b = { title: pick(["Bins", "Dishes", "  Mow lawn ", "Homework", "", "x".repeat(250)]), assignee: pick(people) };
        const r = pick(recurrences); if (r !== undefined) b.recurrence = r;
        const due = dues(); if (due !== undefined) b.due = due;
        if (maybe(2)) b.time = pick(times);
        if (maybe(2)) b.repeat = pick(repeats);
        if (maybe(3)) { b.parentId = maybe(6) ? "nosuch" : anyId(); count.sub++; }
        what = "add " + JSON.stringify(b);
        const theirs = gs.run("addTask_", b), ours = core.addTask(c, b);
        assert.deepEqual(plain(ours), theirs, `step ${step}: what addTask returns (${what})`);
        count.add++;
      } else if (kind <= 8) {
        const b = { id: maybe(15) ? "nosuch" : anyId() };
        if (maybe(3)) b.title = pick(["Renamed", "  ", "", "Another name"]);
        if (maybe(3)) b.assignee = pick(people);
        if (maybe(2)) { const due = dues(); b.due = due === undefined ? "" : due; }
        if (maybe(3)) b.time = pick(times);
        if (maybe(3)) b.repeat = pick(repeats);
        if (maybe(3)) b.parentId = maybe(4) ? "" : maybe(8) ? b.id : anyId();
        if (maybe(3)) { b.order = Array.from({ length: 1 + rnd(5) }, anyId); if (maybe(4)) b.order.push("nosuch"); count.order++; }
        what = "update " + JSON.stringify(b);
        gs.run("updateTask_", b); core.updateTask(c, b);
        count.update++;
      } else if (kind <= 15) {
        const id = maybe(20) ? "nosuch" : anyId(), by = pick(people);
        const before = core.getTasks(c).find(t => t.id === id);
        if (before && before.completed) count.untick++;
        if (before && before.recurrence === "repeat") count.repeatTick++;
        what = `toggle ${id} by ${by}`;
        gs.run("toggleTask_", id, by); core.toggleTask(c, id, by);
        count.toggle++;
      } else if (kind === 16) {
        const id = anyId();
        what = "delete " + id;
        gs.run("deleteTask_", id); core.deleteTask(c, id);
        count.delete++;
      } else if (kind === 17) {
        const meals = maybe(8) ? null : {};
        if (meals) core.DAYS.forEach(d => { if (maybe(2)) meals[d] = { meal: pick(["Tacos", "Pad Thai | https://x.example/r", ""]), note: pick(["", "20 min.", undefined]) }; });
        what = "saveMeals " + JSON.stringify(meals);
        gs.run("saveMeals_", meals); core.saveMeals(c, meals);
        count.meals++;
      } else if (kind === 18) {
        const type = pick(["huddle", "couples", "other"]), answers = maybe(6) ? null : { rose: "a", q0: pick(["x", "y"]) };
        what = `saveCheckin ${type}`;
        gs.run("saveCheckin_", type, answers); core.saveCheckin(c, type, answers);
        count.checkin++;
      } else {
        const id = c.tabs.CheckIns.length ? pick(c.tabs.CheckIns).id : "nosuch";
        what = "deleteCheckin " + id;
        gs.run("deleteCheckin_", id); core.deleteCheckin(c, id);
      }

      const at = `step ${step} at ${c.now.toISOString()}: ${what}`;
      assert.deepEqual(plain(core.getTasks(c)), gs.run("getTasks_"), at + " — tasks as the Hub is sent them");
      assert.deepEqual(plain(core.getMeals(c)), gs.run("getMeals_"), at + " — meals");
      assert.deepEqual(plain(core.getCheckins(c, 10)), gs.run("getCheckins_", 10), at + " — check-ins");
      // And what is stored, column for column.
      for (const tab of Object.keys(COLS)) {
        const theirs = gs.tabs[tab].rows.slice(1).map(r => Object.fromEntries(COLS[tab].map((k, i) => [k, r[i] === undefined ? "" : r[i]])));
        assert.deepEqual(plain(c.tabs[tab]), theirs, at + ` — the ${tab} rows`);
      }
      const day = c.now.toLocaleDateString("en-CA");
      if (day !== lastDay) { count.days++; lastDay = day; }
    }
    // The comparison only means something if everything was really tried.
    const least = { add: 100, update: 100, toggle: 200, untick: 30, delete: 20, meals: 20, checkin: 20, sub: 30, repeatTick: 40, days: 100, order: 30 };
    Object.keys(least).forEach(k => assert.ok(count[k] >= least[k], `${name}: only ${count[k]} of "${k}" (want ${least[k]})`));
  });
}

scenario("autumn, through the end of daylight saving", "2026-10-28T16:00:00Z", 11, 1500);
scenario("New Year", "2026-12-20T03:30:00Z", 22, 1500);
scenario("spring, through the start of daylight saving", "2027-03-01T04:59:00Z", 33, 1500);

test("the same instant gives the same period keys as Code.gs, around every boundary", () => {
  const clock = { now: 0 };
  const gs = appsScriptSim(["Code.gs"], {}, { clock });
  // Each hour for ten days around: New Year, the DST changes, a month end, a quarter end.
  for (const start of ["2026-12-27", "2026-10-28", "2027-03-10", "2027-02-25", "2027-06-27"]) {
    for (let h = 0; h < 240; h++) {
      clock.now = Date.parse(start + "T00:30:00Z") + h * 3600e3;
      for (const r of ["daily", "weekly", "monthly", "quarterly", "yearly", "once", "repeat", undefined]) {
        assert.equal(core.periodKey(r, new Date(clock.now)), gs.run("periodKey_", r), `${r} at ${new Date(clock.now).toISOString()}`);
      }
    }
  }
});

test("nothing in worker/hub reads a Date's local time", () => {
  // A Worker's local time is UTC. Everything must go through hub/time.js instead.
  const dir = new URL("../hub/", import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(new URL(f, dir), "utf8");
    const bad = src.match(/\.(getDay|getDate|getMonth|getHours|getMinutes|getFullYear|getYear|setDate|setHours|setMonth|setFullYear|getTimezoneOffset|toLocale\w*String)\(/g);
    assert.equal(bad, null, `${f} uses ${bad}`);
  }
});
