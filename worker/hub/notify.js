/**
 * HARPER FAMILY HUB — notifications: what to send, to whom, and when
 *
 * The same rules as apps-script/Notify.gs, function for function, so the two
 * can be run side by side and compared (test/notify.test.js). The README in
 * apps-script/ describes the behaviour; this file must match it.
 *
 * Nothing here sends anything. Each entry point returns an outbox:
 *   [ { people: ["Jon", …], msg: { title, body, tag, view, checkin? } }, … ]
 * and push.js delivers it once the changes are saved.
 *
 * On top of what core.js needs, the context `c` has:
 *   c.tabs.Devices, c.tabs.NotifyPrefs   rows, named as the Sheet's columns were
 *   c.props                the script's own bookkeeping, as text by key (NOTIFY_STATE)
 *   c.events()             the calendar's events, as the Hub is sent them
 *   c.remindersLine(today) Jon's Todoist line for his summary, or null
 *   c.notionOn()           whether the dinners come from Notion
 */

import { local } from "./time.js";
import { DAYS, periodKey, getTasks, getMeals, getCheckins } from "./core.js";

export const PARENTS = ["Jon", "Maggie"];
export const KIDS = ["Clayton", "Heidi"];
const REMINDERS_OWNER = "Jon"; // whose Todoist tasks go in a morning summary

const LATE_WINDOW_MIN = 60;   // a reminder still goes if the timer runs this late
const MEALS_SETTLE_MIN = 10;  // the plan must sit unchanged this long before it's announced
const QUEUE_MAX = 8;          // alerts held through quiet hours, per person

// What each person gets until they change it in the Hub's Settings.
const DEFAULT_PREFS = {
  summary:  { on: true, at: "07:00" },
  dinner:   { on: true, at: "15:00" },
  huddle:   { on: true, day: "Sun", at: "18:00" },
  couples:  { on: true, day: "Sun", at: "19:30" },
  assigned: { on: true },
  meals:    { on: true },
  quiet:    { on: true, from: "21:00", to: "07:00" },
};

// Reminders that go at a time each person picks. Quiet hours don't hold
// these back; they only hold back the alerts that happen on their own.
const SCHEDULED = {
  summary: summaryMsg,
  dinner:  dinnerMsg,
  huddle:  function (c, person, data, clock) { return checkinMsg("huddle", data, clock); },
  couples: function (c, person, data, clock) {
    return PARENTS.indexOf(person) >= 0 ? checkinMsg("couples", data, clock) : null;
  },
};

// ---------- Hub actions ----------

/** `config`: { publicKey, ready } — whether this Worker can send push at all. */
export function notifyInfo(c, config) {
  const stored = storedPrefs(c);
  const prefs = {}, devices = {};
  PARENTS.concat(KIDS).forEach(function (p) { prefs[p] = prefsFor(p, stored); devices[p] = 0; });
  c.tabs.Devices.forEach(function (d) { if (d.person in devices) devices[d.person]++; });
  return {
    ok: true,
    publicKey: config.publicKey || "",
    ready: !!config.ready,
    lastTick: loadState(c).lastTick || null,
    parents: PARENTS,
    prefs: prefs,
    devices: devices,
  };
}

export function pushSubscribe(c, person, sub) {
  if (!isPerson(person)) return { ok: false, error: "bad_person" };
  if (!sub || !/^https:\/\//.test(String(sub.endpoint)) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return { ok: false, error: "bad_subscription" };
  }
  const clean = {
    endpoint: String(sub.endpoint),
    keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
  };
  removeWhere(c.tabs.Devices, function (r) { return String(r.endpoint) === clean.endpoint; });
  c.tabs.Devices.push({ endpoint: clean.endpoint, person: person, subscription: JSON.stringify(clean), addedAt: c.now.toISOString() });
  return { ok: true };
}

export function pushUnsubscribe(c, endpoint) {
  removeWhere(c.tabs.Devices, function (r) { return String(r.endpoint) === String(endpoint); });
  return { ok: true };
}

export function savePrefs(c, person, input) {
  if (!isPerson(person)) return { ok: false, error: "bad_person" };
  const clean = cleanPrefs(input);
  removeWhere(c.tabs.NotifyPrefs, function (r) { return String(r.person) === person; });
  c.tabs.NotifyPrefs.push({ person: person, prefs: JSON.stringify(clean), updatedAt: c.now.toISOString() });
  return { ok: true, prefs: clean };
}

export function testMessage(person) {
  return { people: [person], msg: {
    title: "Notifications are on",
    body: "This is how Family Hub alerts will look on this phone.",
    tag: "test", view: "today",
  } };
}

/** A to-do was added: tell the person it's for (everyone, if it's a family one). */
export function taskAdded(c, task, by) {
  try {
    const family = task.assignee === "Family";
    let people = family ? PARENTS.concat(KIDS) : (isPerson(task.assignee) ? [task.assignee] : []);
    people = people.filter(function (p) { return p !== by; });
    if (!people.length) return [];
    const ctx = context(c, c.now);
    const recur = task.repeat ? " · " + task.repeat
      : task.recurrence && task.recurrence !== "once" ? " · " + task.recurrence : "";
    const out = route(ctx, people, "assigned", {
      title: (isPerson(by) ? by : "Someone") + (family ? " added a family to-do" : " added a to-do for you"),
      body: clip(task.title, 120) + recur,
      tag: "task-" + task.id, view: "tasks",
    });
    saveState(c, ctx.state);
    return out;
  } catch (err) {
    console.warn("taskAdded: " + err); // never let a notification problem block the save
    return [];
  }
}

/** The meal plan was saved from the Hub: note who, so they aren't told about their own plan. */
export function mealsEdited(c, meals, by) {
  try {
    const state = loadState(c);
    const m = state.meals || (state.meals = { plan: null, announced: null, since: 0, editors: [] });
    const plan = mealPlan(meals || {});
    if (plan !== m.plan) { m.plan = plan; m.since = c.now.getTime(); }
    if (isPerson(by) && m.editors.indexOf(by) < 0) m.editors.push(by);
    saveState(c, state);
  } catch (err) {
    console.warn("mealsEdited: " + err);
  }
}

/** When notifications first run here: start from today's plan, so it isn't announced as new. */
export function startMeals(c) {
  const state = loadState(c);
  if (!state.meals) {
    const plan = mealPlan(getMeals(c));
    state.meals = { plan: plan, announced: plan, since: c.now.getTime(), editors: [] };
    saveState(c, state);
  }
}

// ---------- the timer's work ----------

/** Everything due at `c.now`. Run every five minutes. */
export function dueNotifications(c) {
  const ctx = context(c, c.now);
  const data = lazyData(c);
  let outbox = [];
  ctx.people.forEach(function (person) {
    const prefs = ctx.prefs(person);
    Object.keys(SCHEDULED).forEach(function (kind) {
      const p = prefs[kind];
      if (!p.on || (p.day && p.day !== ctx.clock.day)) return;
      const at = minutes(p.at);
      if (ctx.clock.min < at || ctx.clock.min >= at + LATE_WINDOW_MIN) return;
      const key = kind + "|" + person;
      if (ctx.state.sent[key] === ctx.clock.today) return;
      ctx.state.sent[key] = ctx.clock.today;
      const msg = SCHEDULED[kind](c, person, data, ctx.clock);
      if (msg) outbox.push({ people: [person], msg: msg });
    });
    if (!inQuiet(prefs.quiet, ctx.clock.min)) outbox = outbox.concat(flushQueue(ctx, person));
  });
  outbox = outbox.concat(mealsReady(ctx, data));
  ctx.state.lastTick = ctx.clock.ms;
  saveState(c, ctx.state);
  return outbox;
}

/**
 * One alert when the week's dinners are planned: every day has a dinner, the
 * plan differs from the last one announced, and nobody has changed it for
 * MEALS_SETTLE_MIN minutes. Catches a plan that changed without a Hub save
 * (the Notion sync) too.
 */
function mealsReady(ctx, data) {
  const plan = mealPlan(data.meals);
  const m = ctx.state.meals;
  if (!m) {
    ctx.state.meals = { plan: plan, announced: plan, since: ctx.clock.ms, editors: [] };
    return [];
  }
  // Hub saves update m.plan themselves, so a change noticed here came from
  // elsewhere: its editor is unknown, and nobody is left out of the alert.
  if (plan !== m.plan) { m.plan = plan; m.since = ctx.clock.ms; m.editors = []; }
  if (plan === m.announced) { m.editors = []; return []; }
  const dinners = JSON.parse(plan);
  if (dinners.some(function (d) { return !d; })) return [];
  if (ctx.clock.ms - m.since < MEALS_SETTLE_MIN * 60000) return [];

  const editors = m.editors || [];
  m.announced = plan;
  m.editors = [];
  const who = editors.length === 1 ? editors[0] : "";
  return route(ctx, ctx.people.filter(function (p) { return editors.indexOf(p) < 0; }), "meals", {
    title: who ? who + " planned the week's dinners" : "The week's dinners are planned",
    body: DAYS.map(function (d, i) { return d + "  " + clip(mealName(dinners[i]), 40); }).join("\n"),
    tag: "meals", view: "meals",
  });
}

// ---------- messages ----------

function summaryMsg(c, person, data, clock) {
  const open = data.tasks.filter(function (t) {
    // Dated tasks when due or overdue; undated ones as the Today screen shows them.
    // An undated subtask is part of its parent, so it isn't listed on its own.
    if (t.parentId && !t.due) return false;
    return !t.completed && (t.due ? t.due <= clock.today : (t.recurrence === "daily" || t.recurrence === "once"));
  });
  const mine = open.filter(function (t) { return t.assignee === person; });
  const family = open.filter(function (t) { return t.assignee === "Family" || !t.assignee; });
  const kids = PARENTS.indexOf(person) >= 0
    ? open.filter(function (t) { return KIDS.indexOf(t.assignee) >= 0; }) : [];
  const events = data.events.filter(function (e) { return e.date === clock.today; });
  const dinner = (data.meals[clock.day] || {}).meal;

  const lines = [
    "Dinner: " + (dinner ? clip(mealName(dinner), 40) : "not planned yet"),
    "Calendar: " + (events.length
      ? list(events.map(function (e) { return (e.allDay ? "" : e.start + " ") + e.title; }))
      : "nothing today"),
  ];
  if (mine.length) lines.push("Yours: " + list(mine.map(function (t) { return t.title; })));
  // Jon's Todoist tasks go in his summary only.
  const reminders = c.remindersLine && person === REMINDERS_OWNER ? c.remindersLine(clock.today) : null;
  if (reminders) lines.push(reminders);
  if (kids.length) lines.push("Kids: " + list(kids.map(function (t) { return t.title + " (" + t.assignee + ")"; })));
  if (family.length) lines.push("Family: " + list(family.map(function (t) { return t.title; })));
  if (!mine.length && !kids.length && !family.length && !reminders) lines.push("No to-dos today.");
  return { title: "Today · " + clock.label, body: lines.join("\n"), tag: "summary", view: "today" };
}

function dinnerMsg(c, person, data, clock) {
  if ((data.meals[clock.day] || {}).meal) return null;
  return {
    title: "Dinner isn't planned yet",
    body: c.notionOn && c.notionOn()
      ? "Nothing's on the Notion meal plan for tonight."
      : "Nothing's on the plan for tonight. Tap to fill it in.",
    tag: "dinner", view: "meals",
  };
}

function checkinMsg(type, data, clock) {
  const monday = periodKey("weekly", new Date(clock.ms)).slice(1);
  const done = data.checkins.some(function (x) { return x.type === type && x.date >= monday; });
  if (done) return null;
  return type === "huddle"
    ? { title: "Family Huddle", body: "Rose/Thorn/Bud, the week ahead, chores, the fun pick, gratitude. Tap to open it.",
        tag: "huddle", view: "checkins", checkin: "huddle" }
    : { title: "Weekly Check-In", body: "The seven questions, then the week's logistics. Tap to open them.",
        tag: "couples", view: "checkins", checkin: "couples" };
}

// ---------- routing, quiet hours ----------

/** Everything the timer and the Hub actions need to decide who gets what. */
function context(c, now) {
  const stored = storedPrefs(c);
  const people = [];
  c.tabs.Devices.forEach(function (d) { if (people.indexOf(d.person) < 0) people.push(d.person); });
  return {
    clock: clockAt(now),
    state: loadState(c),
    people: people, // only people with a phone signed up
    prefs: function (person) { return prefsFor(person, stored); },
  };
}

/** Send now, or hold until the person's quiet hours end. */
function route(ctx, people, kind, msg) {
  const now = [];
  people.forEach(function (person) {
    if (ctx.people.indexOf(person) < 0) return;
    const prefs = ctx.prefs(person);
    if (!prefs[kind].on) return;
    if (inQuiet(prefs.quiet, ctx.clock.min)) {
      const q = ctx.state.queue[person] = ctx.state.queue[person] || [];
      q.push({ kind: kind, msg: msg });
      if (q.length > QUEUE_MAX) q.shift();
    } else {
      now.push(person);
    }
  });
  return now.length ? [{ people: now, msg: msg }] : [];
}

/** What was held through quiet hours, folded into as few alerts as possible. */
function flushQueue(ctx, person) {
  const q = ctx.state.queue[person];
  if (!q || !q.length) return [];
  delete ctx.state.queue[person];
  const out = [];
  const tasks = q.filter(function (x) { return x.kind === "assigned"; });
  if (tasks.length === 1) out.push(tasks[0].msg);
  if (tasks.length > 1) {
    out.push({
      title: tasks.length + " new to-dos",
      body: tasks.map(function (t) { return t.msg.body; }).join("\n"),
      tag: "tasks-held", view: "tasks",
    });
  }
  const meals = q.filter(function (x) { return x.kind === "meals"; }).pop();
  if (meals) out.push(meals.msg);
  return out.map(function (msg) { return { people: [person], msg: msg }; });
}

function inQuiet(quiet, min) {
  if (!quiet.on) return false;
  const from = minutes(quiet.from), to = minutes(quiet.to);
  if (from === to) return false;
  return from < to ? (min >= from && min < to) : (min >= from || min < to);
}

// ---------- preferences & state ----------

function storedPrefs(c) {
  const out = {};
  c.tabs.NotifyPrefs.forEach(function (r) {
    try { out[r.person] = JSON.parse(r.prefs); } catch (err) {}
  });
  return out;
}

function prefsFor(person, stored) {
  return cleanPrefs(stored[person]);
}

/** Fills gaps from DEFAULT_PREFS and drops anything malformed. */
export function cleanPrefs(input) {
  input = input || {};
  const out = {};
  Object.keys(DEFAULT_PREFS).forEach(function (kind) {
    const def = DEFAULT_PREFS[kind], got = input[kind] || {}, p = {};
    Object.keys(def).forEach(function (field) {
      const v = got[field];
      if (field === "on") p.on = typeof v === "boolean" ? v : def.on;
      else if (field === "day") p.day = DAYS.indexOf(v) >= 0 ? v : def.day;
      else p[field] = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : def[field];
    });
    out[kind] = p;
  });
  return out;
}

// Bookkeeping: what's been sent, what's held for quiet hours, the meal plan last announced.
function loadState(c) {
  let s = {};
  try { s = JSON.parse(c.props.NOTIFY_STATE || "{}"); } catch (err) {}
  if (!s || typeof s !== "object") s = {};
  s.sent = s.sent || {};
  s.queue = s.queue || {};
  return s;
}

function saveState(c, s) {
  c.props.NOTIFY_STATE = JSON.stringify(s);
}

// ---------- small helpers ----------

function clockAt(now) {
  const p = local(now);
  return {
    ms: now.getTime(),
    today: p.iso,
    day: DAYS[(p.wd + 6) % 7],
    min: p.H * 60 + p.M,
    label: p.weekdayLong + ", " + p.monthShort + " " + p.d,
  };
}

/** Reads each kind of data at most once per run, and only if a message needs it. */
function lazyData(c) {
  const cache = {};
  const load = function (key, fn) {
    if (!(key in cache)) cache[key] = fn();
    return cache[key];
  };
  return {
    get tasks() { return load("tasks", function () { return getTasks(c); }); },
    get meals() { return load("meals", function () { return getMeals(c); }); },
    get events() { return load("events", function () { return c.events ? c.events() : []; }); },
    get checkins() { return load("checkins", function () { return getCheckins(c, 10); }); },
  };
}

/** A dinner as it reads in a notification: recipe links dropped. */
function mealName(text) {
  const name = String(text || "").replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ")
    .replace(/^[\s\-–—:|,(]+|[\s\-–—:|,(]+$/g, "");
  return name || (text ? "recipe link" : "");
}

function mealPlan(meals) {
  return JSON.stringify(DAYS.map(function (d) { return String((meals[d] || {}).meal || "").trim(); }));
}

export function isPerson(p) {
  return PARENTS.indexOf(p) >= 0 || KIDS.indexOf(p) >= 0;
}

function minutes(hhmm) {
  const parts = String(hhmm).split(":");
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function clip(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function list(items) {
  const shown = items.slice(0, 3).map(function (s) { return clip(s, 40); }).join(", ");
  return items.length > 3 ? shown + " +" + (items.length - 3) + " more" : shown;
}

function removeWhere(rows, predicate) {
  let removed = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (predicate(rows[i])) { rows.splice(i, 1); removed = true; }
  }
  return removed;
}
