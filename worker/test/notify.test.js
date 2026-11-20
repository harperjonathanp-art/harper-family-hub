// Notifications: the Worker's version (hub/notify.js) against the real
// apps-script/Notify.gs, through simulated weeks of five-minute timer runs.
process.env.TZ = "America/New_York"; // the scripts read a Date's local time as the family's time zone
import { test } from "node:test";
import assert from "node:assert/strict";
import { appsScriptSim } from "./appsscript-sim.js";
import * as core from "../hub/core.js";
import * as notify from "../hub/notify.js";

const plain = x => JSON.parse(JSON.stringify(x === undefined ? null : x));
const COLS = { Devices: ["endpoint", "person", "subscription", "addedAt"], NotifyPrefs: ["person", "prefs", "updatedAt"] };

function rng(seed) { // mulberry32
  return n => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

function scenario(name, startIso, seed, ticks) {
  test(`${name}: ${ticks} timer runs send what Notify.gs sends`, () => {
    const rnd = rng(seed), pick = a => a[rnd(a.length)], maybe = n => rnd(n) === 0;
    const clock = { now: Date.parse(startIso) };
    const world = { events: [], reminders: null, notion: false }; // what the calendar, Todoist and Notion say
    const ids = n => () => ("0000000" + (n.i++).toString(16)).slice(-8) + "-0000";
    const gs = appsScriptSim(["Code.gs", "Notify.gs"], { VAPID_PUBLIC_KEY: "pk", PUSH_WORKER_URL: "https://relay.example", PUSH_SECRET: "s" }, {
      clock, uuid: ids({ i: 1 }),
      globals: { __events: () => JSON.stringify(world.events), __reminders: () => world.reminders, __notion: () => world.notion },
    });
    gs.eval(`getEvents_ = function () { return JSON.parse(__events()); };
      var REMINDERS_OWNER = "Jon"; function remindersLine_(today) { return __reminders(); }
      function notionOn_() { return __notion(); }`);
    const nextId = ids({ i: 1 });
    const c = {
      tabs: { Tasks: [], Completions: [], Meals: [], CheckIns: [], Devices: [], NotifyPrefs: [] }, props: {},
      now: null, newId: () => nextId().slice(0, 8),
      events: () => world.events, remindersLine: () => world.reminders, notionOn: () => world.notion,
    };
    ["getTasks_", "getMeals_", "notifyInfo_"].forEach(f => gs.run(f)); gs.run("getCheckins_", 10); // makes the tabs

    const people = ["Jon", "Maggie", "Clayton", "Heidi"], anyone = people.concat(["Family", "", "Grandma"]);
    const hhmm = offsetMin => { // a time near now at home, as Settings would save it
      const d = new Date(clock.now + offsetMin * 60000), f = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      return f.format(d).replace(/:(\d)\d$/, (m, t) => ":" + t + pick(["0", "5"]));
    };
    const dayNow = () => core.DAYS[(new Date(clock.now - 5 * 3600e3).getUTCDay() + 6) % 7];
    const sent = {}; // how many of each kind went out
    const tally = outbox => outbox.forEach(o => { const k = o.msg.tag.replace(/^task-.*/, "task"); sent[k] = (sent[k] || 0) + 1; });
    const count = { quiet: 0, late: 0, mealsBySomeone: 0, mealsByNobody: 0, sameMeals: 0 };
    let endpoint = 0, lastMeals = null;

    for (let tick = 0; tick < ticks; tick++) {
      // The timer: every five minutes, give or take, and now and then badly late.
      const gap = maybe(25) ? 20 + rnd(110) : 5;
      if (gap > 60) count.late++;
      clock.now += gap * 60000 + rnd(50) * 1000;
      c.now = new Date(clock.now);
      let what = "tick";

      // Between timer runs the family does things.
      if (maybe(3)) {
        const k = rnd(14), who = pick(people);
        if (k <= 1) {
          const sub = maybe(8) ? { endpoint: "http://bad" } : { endpoint: "https://push.example/" + (maybe(4) ? rnd(endpoint + 1) : ++endpoint), keys: { p256dh: "k", auth: "a" }, extra: 1 };
          const person = maybe(10) ? "Grandma" : who;
          what = `subscribe ${person} ${sub.endpoint}`;
          assert.deepEqual(plain(notify.pushSubscribe(c, person, sub)), gs.run("pushSubscribe_", person, sub), what);
        } else if (k === 2 && c.tabs.Devices.length > 2) {
          const ep = pick(c.tabs.Devices).endpoint;
          what = "unsubscribe " + ep;
          assert.deepEqual(plain(notify.pushUnsubscribe(c, ep)), gs.run("pushUnsubscribe_", ep), what);
        } else if (k <= 5) {
          const prefs = {
            summary: { on: !maybe(6), at: hhmm(rnd(120) - 30) },
            dinner: { on: !maybe(6), at: hhmm(rnd(120) - 30) },
            huddle: { on: !maybe(6), day: maybe(2) ? dayNow() : pick(core.DAYS), at: hhmm(rnd(120) - 30) },
            couples: { on: !maybe(6), day: maybe(2) ? dayNow() : pick(core.DAYS.concat("Someday")), at: hhmm(rnd(120) - 30) },
            assigned: { on: !maybe(6) }, meals: { on: !maybe(6) },
            quiet: { on: !maybe(4), from: hhmm(rnd(240) - 120), to: maybe(10) ? "25:99" : hhmm(rnd(240) + 30) },
          };
          if (maybe(8)) delete prefs.dinner;
          if (maybe(8)) prefs.quiet.to = prefs.quiet.from;
          what = `savePrefs ${who} ` + JSON.stringify(prefs);
          assert.deepEqual(plain(notify.savePrefs(c, who, prefs)), gs.run("savePrefs_", who, prefs), what);
        } else if (k <= 8) {
          const b = { title: pick(["Bins", "Dishes", "Mow the lawn", "y".repeat(140)]), assignee: pick(anyone), recurrence: pick(["once", "daily", "weekly"]) };
          if (maybe(3)) b.repeat = "every 1 week";
          if (maybe(2)) b.due = new Date(clock.now + (rnd(5) - 2) * 86400e3).toISOString().slice(0, 10);
          if (maybe(4) && c.tabs.Tasks.length) b.parentId = pick(c.tabs.Tasks).id;
          const by = pick(anyone);
          what = `addTask by ${by} ` + JSON.stringify(b);
          const theirs = gs.run("taskAdded_", gs.run("addTask_", b), by), ours = plain(notify.taskAdded(c, core.addTask(c, b), by));
          assert.deepEqual(ours, theirs, `tick ${tick}: ${what}`);
          tally(ours);
        } else if (k === 9 && c.tabs.Tasks.length) {
          const id = pick(c.tabs.Tasks).id;
          what = "toggle " + id;
          gs.run("toggleTask_", id, who); core.toggleTask(c, id, who);
        } else if (k <= 11) {
          // A new plan, or (so that saving a plan nobody changed is tried too) the last one again.
          const again = lastMeals && maybe(4);
          const meals = again ? lastMeals : {};
          if (!again) core.DAYS.forEach(d => { if (!maybe(12)) meals[d] = { meal: pick(["Tacos", "Soup", "Pad Thai | https://x.example/r", "https://only.a/link", " Chili "]), note: "" }; });
          lastMeals = meals;
          if (again) count.sameMeals++;
          const fromHub = again || !maybe(3), by = pick(anyone);
          what = (fromHub ? `saveMeals by ${by} ` : "meals changed outside the Hub ") + JSON.stringify(Object.values(meals).map(m => m.meal));
          gs.run("saveMeals_", meals); core.saveMeals(c, meals);
          if (fromHub) { gs.run("mealsEdited_", meals, by); notify.mealsEdited(c, meals, by); }
        } else if (k === 12) {
          const type = pick(["huddle", "couples"]);
          what = "saveCheckin " + type;
          gs.run("saveCheckin_", type, { a: 1 }); core.saveCheckin(c, type, { a: 1 });
        } else {
          world.events = maybe(3) ? [] : Array.from({ length: 1 + rnd(5) }, (_, i) => ({ title: "Event " + i, allDay: maybe(3), start: "3:30 PM", date: new Date(clock.now + (rnd(3) - 1) * 86400e3).toISOString().slice(0, 10) }));
          world.reminders = maybe(2) ? null : "Todoist: Call the dentist, Renew passport";
          world.notion = maybe(2);
          what = "the calendar, Todoist and Notion changed";
        }
      }

      const before = plain(JSON.parse(c.props.NOTIFY_STATE || "{}"));
      const ours = plain(notify.dueNotifications(c)), theirs = gs.run("dueNotifications_", new Date(clock.now));
      const at = `tick ${tick} at ${c.now.toISOString()} after: ${what}`;
      assert.deepEqual(ours, theirs, at + " — what is sent");
      assert.deepEqual(JSON.parse(c.props.NOTIFY_STATE), JSON.parse(gs.props.NOTIFY_STATE), at + " — what is remembered");
      for (const tab of Object.keys(COLS)) {
        const rows = gs.tabs[tab].rows.slice(1).map(r => Object.fromEntries(COLS[tab].map((k, i) => [k, r[i]])));
        assert.deepEqual(plain(c.tabs[tab]), rows, at + ` — the ${tab} rows`);
      }
      if (tick % 97 === 0) assert.deepEqual(plain(notify.notifyInfo(c, { publicKey: "pk", ready: true })), gs.run("notifyInfo_"), at + " — settings as the Hub is sent them");
      tally(ours);
      ours.forEach(o => { if (o.msg.tag === "meals") count[/planned the week/.test(o.msg.title) && !/^The week/.test(o.msg.title) ? "mealsBySomeone" : "mealsByNobody"]++; });
      const after = JSON.parse(c.props.NOTIFY_STATE);
      if (Object.keys(after.queue).length > Object.keys((before || {}).queue || {}).length) count.quiet++;
    }
    // The comparison only means something if every kind of alert really went out.
    const least = { summary: 20, dinner: 5, huddle: 3, couples: 2, task: 40, "tasks-held": 5, meals: 10 };
    Object.keys(least).forEach(k => assert.ok((sent[k] || 0) >= least[k], `${name}: only ${sent[k] || 0} "${k}" alerts (want ${least[k]}). All: ${JSON.stringify(sent)}`));
    const leastOther = { quiet: 10, late: 20, mealsBySomeone: 2, mealsByNobody: 3, sameMeals: 20 };
    Object.keys(leastOther).forEach(k => assert.ok(count[k] >= leastOther[k], `${name}: only ${count[k]} of "${k}". ${JSON.stringify(count)}`));
  });
}

scenario("three weeks in autumn, through the end of daylight saving", "2026-10-20T11:00:00Z", 101, 6000);
scenario("three weeks over New Year", "2026-12-18T02:00:00Z", 202, 6000);
scenario("three weeks in spring, through the start of daylight saving", "2027-03-02T15:00:00Z", 303, 6000);
