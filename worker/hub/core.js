/**
 * HARPER FAMILY HUB — tasks, dinners and check-ins
 *
 * The same rules as apps-script/Code.gs, function for function, so the two can
 * be run side by side on the same actions and compared (test/core.test.js).
 * What's different is only where things are kept and what time it is:
 *
 *   c.tabs   the rows, in memory: Tasks, Completions, Meals, CheckIns. Each row
 *            is an object named as the Sheet's columns were. The store loads
 *            them and saves what changed.
 *   c.now    the moment the request arrived
 *   c.newId  makes an id for a new task or check-in
 *
 * A row holds text as it was written. The Sheet turned dates and times into
 * cells of its own kind, and a good part of Code.gs undid that; none of that
 * is needed here.
 */

import { local, today as todayAt, ymd, iso, addDays } from "./time.js";

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---------- period keys (recurrence reset logic) ----------

export function periodKey(recurrence, d) {
  const p = local(d);
  switch (recurrence) {
    case "daily":     return p.iso;
    case "weekly":    return "W" + iso(addDays(ymd(p.iso), -((p.wd + 6) % 7))); // that week's Monday
    case "monthly":   return p.month;
    case "quarterly": return p.y + "-Q" + (Math.floor((p.m - 1) / 3) + 1);
    case "yearly":    return String(p.y);
    default:          return "once";
  }
}

// ---------- tasks ----------

export function getTasks(c) {
  const done = {};
  c.tabs.Completions.forEach(function (r) { done[r.taskId + "|" + String(r.periodKey)] = r.completedBy || true; });
  const today = todayAt(c.now);
  const all = c.tabs.Tasks;
  return all.map(function (t) {
    const repeat = String(t.repeat || "").trim();
    if (parseRepeat(repeat)) { // an unreadable repeat leaves it a plain task
      // A repeating task moves to its next date when it's done, so "completed"
      // means done today (it can still be unticked until tomorrow).
      const doneToday = dateStr(t.lastDone) === today;
      return {
        id: String(t.id),
        title: t.title,
        recurrence: "repeat",
        repeat: repeat,
        due: dateStr(t.due),
        time: cleanTime(t.time),
        parentId: String(t.parentId || ""),
        sort: sortNum(t.sort),
        assignee: t.assignee,
        completed: doneToday,
        completedBy: doneToday ? (done[t.id + "|" + dateStr(t.prevDue)] || null) : null,
      };
    }
    // A repeat that can't be read: a one-off, flagged so it can be fixed.
    const recurrence = t.recurrence === "repeat" ? "once" : t.recurrence;
    const pk = subPeriod(c, t, all, today) || periodKey(recurrence, c.now);
    const key = t.id + "|" + pk;
    return {
      id: String(t.id),
      title: t.title,
      recurrence: recurrence,
      badRepeat: repeat || undefined,
      due: dateStr(t.due),
      time: cleanTime(t.time),
      parentId: String(t.parentId || ""),
      sort: sortNum(t.sort),
      assignee: t.assignee,
      completed: key in done,
      completedBy: done[key] || null,
    };
  });
}

export function addTask(c, b) {
  const repeat = parseRepeat(b.repeat) ? String(b.repeat).trim().toLowerCase() : "";
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due)) ? String(b.due) : (repeat ? todayAt(c.now) : "");
  const tasks = c.tabs.Tasks;
  const parentId = validParent(tasks, "", b.parentId);
  const task = {
    id: c.newId(),
    title: String(b.title || "").slice(0, 200),
    recurrence: repeat ? "repeat" : (b.recurrence || "once"),
    assignee: b.assignee || "",
    due: due,
    time: due ? cleanTime(b.time) : "", // a time needs a day
    repeat: repeat,
    parentId: parentId,
    // A subtask goes last among its siblings; a top-level task is left unordered.
    sort: parentId ? lastSort(tasks, parentId) + 1 : "",
  };
  tasks.push({
    id: task.id, title: task.title, recurrence: task.recurrence, assignee: task.assignee,
    createdAt: c.now.toISOString(), due: task.due, repeat: task.repeat, lastDone: "", prevDue: "",
    time: task.time, parentId: task.parentId, sort: task.sort,
  });
  return task;
}

/**
 * Changes whichever of title, assignee, due, time, repeat and parentId the
 * request names, and, given `order` (task ids), puts those tasks in that
 * order. One call serves the edit form (several fields) and drag and drop
 * (a new day, a new parent, a new place in the list).
 */
export function updateTask(c, b) {
  const tasks = c.tabs.Tasks;
  const task = tasks.filter(function (t) { return String(t.id) === String(b.id); })[0];
  if (!task) return;
  const fields = {};
  if ("title" in b) {
    const title = String(b.title || "").trim().slice(0, 200);
    if (title) fields.title = title;
  }
  if ("assignee" in b) fields.assignee = String(b.assignee || "");
  let due = dateStr(task.due), repeat = parseRepeat(task.repeat) ? String(task.repeat).trim() : "";
  if ("repeat" in b) {
    repeat = parseRepeat(b.repeat) ? String(b.repeat).trim().toLowerCase() : "";
    fields.repeat = repeat;
    const kept = task.recurrence === "repeat" ? "once" : task.recurrence;
    fields.recurrence = repeat ? "repeat" : kept;
    if (!repeat || repeat !== String(task.repeat || "").trim()) { fields.lastDone = ""; fields.prevDue = ""; }
  }
  if ("due" in b) {
    due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due)) ? String(b.due) : "";
    if (due !== dateStr(task.due)) { fields.lastDone = ""; fields.prevDue = ""; }
  }
  if (repeat && !due) due = todayAt(c.now); // a repeating task always has a next date
  if (due !== dateStr(task.due) || "due" in b) fields.due = due;
  // The time is kept only while there is a day for it to belong to.
  const time = due ? ("time" in b ? cleanTime(b.time) : cleanTime(task.time)) : "";
  if (time !== cleanTime(task.time)) fields.time = time;
  if ("parentId" in b) {
    const parentId = validParent(tasks, task.id, b.parentId);
    if (parentId !== String(task.parentId || "")) {
      fields.parentId = parentId;
      // Joining a parent: last among its subtasks, unless `order` places it.
      fields.sort = parentId ? lastSort(tasks, parentId) + 1 : "";
    }
  }
  Object.assign(task, fields);
  if (Array.isArray(b.order)) setTaskOrder(c, b.order);
}

/** 'HH:mm' (24-hour) or ''. */
export function cleanTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? "" : v).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return "";
  return ("0" + m[1]).slice(-2) + ":" + m[2];
}

function sortNum(v) {
  return v === "" || v == null || isNaN(Number(v)) ? null : Number(v);
}

/** The parent a task may have: an existing top-level task other than itself, and only if the task has no subtasks of its own. */
function validParent(tasks, id, parentId) {
  parentId = String(parentId || "");
  if (!parentId || parentId === String(id)) return "";
  const parent = tasks.filter(function (t) { return String(t.id) === parentId; })[0];
  if (!parent || String(parent.parentId || "")) return ""; // subtasks go one level deep
  const hasSubs = id && tasks.some(function (t) { return String(t.parentId || "") === String(id); });
  return hasSubs ? "" : parentId;
}

function lastSort(tasks, parentId) {
  let last = 0;
  tasks.forEach(function (t) {
    if (String(t.parentId || "") === String(parentId) && sortNum(t.sort) != null) last = Math.max(last, sortNum(t.sort));
  });
  return last;
}

/** Numbers the named tasks 1, 2, 3… in the order given; others keep their own numbers. */
function setTaskOrder(c, ids) {
  const rank = {};
  ids.forEach(function (id, i) { rank[String(id)] = i + 1; });
  c.tabs.Tasks.forEach(function (t) { if (rank[String(t.id)] != null) t.sort = rank[String(t.id)]; });
}

/**
 * A subtask of a repeating task comes round with it: a tick counts for the
 * parent's current turn, so when the parent moves on its subtasks untick.
 * Returns that turn's key, or '' for a subtask that keeps its own ticks
 * (its parent doesn't repeat, or it has a repeat of its own).
 */
function subPeriod(c, task, tasks, today) {
  if (!String(task.parentId || "") || parseRepeat(task.repeat)) return "";
  const p = tasks.filter(function (t) { return String(t.id) === String(task.parentId); })[0];
  if (!p) return "";
  if (parseRepeat(p.repeat)) {
    // Ticked today, the parent already shows its next date; its turn is still the one just done.
    const turn = dateStr(p.lastDone) === today && dateStr(p.prevDue) ? dateStr(p.prevDue) : dateStr(p.due);
    return turn ? "turn:" + turn : "";
  }
  return p.recurrence && p.recurrence !== "once" && p.recurrence !== "repeat" ? periodKey(p.recurrence, c.now) : "";
}

export function deleteTask(c, id) {
  // A task's subtasks go with it.
  const ids = [String(id)];
  c.tabs.Tasks.forEach(function (t) { if (String(t.parentId || "") === String(id)) ids.push(String(t.id)); });
  removeWhere(c.tabs.Tasks, function (t) { return ids.indexOf(String(t.id)) >= 0; });
  removeWhere(c.tabs.Completions, function (r) { return ids.indexOf(String(r.taskId)) >= 0; });
}

export function toggleTask(c, id, by) {
  const tasks = c.tabs.Tasks;
  const task = tasks.filter(function (t) { return String(t.id) === String(id); })[0];
  if (!task) return;
  let ticked;
  if (parseRepeat(task.repeat)) ticked = toggleRepeat(c, task, by);
  else {
    const pk = subPeriod(c, task, tasks, todayAt(c.now)) || periodKey(task.recurrence, c.now);
    ticked = !removeWhere(c.tabs.Completions, function (r) {
      return String(r.taskId) === String(id) && String(r.periodKey) === pk;
    });
    if (ticked) c.tabs.Completions.push({ taskId: String(id), periodKey: pk, completedBy: by || "", timestamp: c.now.toISOString() });
  }
  if (ticked) tickSubtasks(c, id, by);
}

/**
 * Ticking a task ticks its open subtasks too, like Apple Reminders. Unticking
 * it leaves them be. A subtask with a repeat of its own keeps its own schedule.
 */
function tickSubtasks(c, id, by) {
  const tasks = c.tabs.Tasks; // a repeating parent has just moved on
  const subs = tasks.filter(function (t) { return String(t.parentId || "") === String(id) && !parseRepeat(t.repeat); });
  if (!subs.length) return;
  const done = {};
  c.tabs.Completions.forEach(function (r) { done[r.taskId + "|" + String(r.periodKey)] = true; });
  const today = todayAt(c.now), stamp = c.now.toISOString();
  subs.forEach(function (t) {
    const pk = subPeriod(c, t, tasks, today) || periodKey(t.recurrence, c.now);
    if (!done[t.id + "|" + pk]) c.tabs.Completions.push({ taskId: String(t.id), periodKey: pk, completedBy: by || "", timestamp: stamp });
  });
}

/**
 * Ticking a repeating task moves it to its next date, like Apple Reminders.
 * Unticking it the same day puts it back where it was. Returns whether it was ticked.
 */
function toggleRepeat(c, task, by) {
  const today = todayAt(c.now);
  const prevDue = dateStr(task.prevDue);
  if (dateStr(task.lastDone) === today && prevDue) {
    Object.assign(task, { due: prevDue, lastDone: "", prevDue: "" });
    removeWhere(c.tabs.Completions, function (r) {
      return String(r.taskId) === String(task.id) && dateStr(r.periodKey) === prevDue;
    });
    return false;
  }
  const due = dateStr(task.due) || today;
  const id = task.id;
  Object.assign(task, { due: nextDue(task.repeat, due, today), lastDone: today, prevDue: due });
  c.tabs.Completions.push({ taskId: String(id), periodKey: due, completedBy: by || "", timestamp: c.now.toISOString() });
  return true;
}

// ---------- repeat rules ----------
// Written the way Apple Reminders reads them, and stored as text:
//   "every 2 weeks"               "every 1 week on sun,tue,thu"
//   "every 3 months on 3rd sat"   "every 1 year on last fri"   "every 6 months"
// A weekly rule without days repeats on the due date's weekday; a monthly or
// yearly one without "on" keeps the due date's day of the month.

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const NTH = { "1st": 1, first: 1, "2nd": 2, second: 2, "3rd": 3, third: 3, "4th": 4, fourth: 4,
  "5th": 5, fifth: 5, last: -1 };

export function parseRepeat(text) {
  const m = String(text || "").trim().toLowerCase()
    .match(/^every\s+(\d+)\s+(day|week|month|year)s?(?:\s+on\s+(.+))?$/);
  if (!m) return null;
  const rule = { n: Math.max(1, Math.min(99, Number(m[1]))), unit: m[2] };
  const on = m[3] || "";
  if (rule.unit === "week" && on) {
    // Every listed day must be a real weekday, or the rule isn't what was meant.
    const days = on.split(/[\s,]+/).filter(Boolean).map(function (d) { return WEEKDAYS.indexOf(d.slice(0, 3)); });
    if (!days.length || days.some(function (d) { return d < 0; })) return null;
    rule.days = days.filter(function (d, i, all) { return all.indexOf(d) === i; }).sort();
  }
  if (rule.unit === "day" && on) return null;
  if ((rule.unit === "month" || rule.unit === "year") && on) {
    const p = on.match(/^(\w+)\s+(\w{3})/);
    if (!p || !(p[1] in NTH) || WEEKDAYS.indexOf(p[2]) < 0) return null;
    rule.nth = { k: NTH[p[1]], wd: WEEKDAYS.indexOf(p[2]) };
  }
  return rule;
}

/** The first date in the series after the current due date that's also after today. */
export function nextDue(repeat, due, today) {
  const rule = parseRepeat(repeat);
  if (!rule) return due;
  let d = stepRepeat(rule, ymd(due));
  for (let guard = 0; iso(d) <= today && guard < 2000; guard++) d = stepRepeat(rule, d);
  return iso(d);
}

function stepRepeat(rule, d) {
  if (rule.unit === "day") return addDays(d, rule.n);
  if (rule.unit === "week") {
    if (!rule.days || !rule.days.length) return addDays(d, 7 * rule.n);
    const wd = d.getUTCDay();
    const later = rule.days.filter(function (x) { return x > wd; });
    if (later.length) return addDays(d, later[0] - wd); // later this week
    return addDays(d, 7 * rule.n - wd + rule.days[0]);  // first listed day, n weeks on
  }
  return addMonths(d, rule.unit === "year" ? 12 * rule.n : rule.n, rule.nth);
}

function daysIn(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }

function addMonths(d, months, nth) {
  const total = d.getUTCMonth() + months;
  const y = d.getUTCFullYear() + Math.floor(total / 12), m = ((total % 12) + 12) % 12;
  if (nth) return nthWeekday(y, m, nth.k, nth.wd);
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), daysIn(y, m))));
}

/** The kth (or last, k = -1) weekday wd of a month; a missing 5th falls back to the last. */
function nthWeekday(y, m, k, wd) {
  const len = daysIn(y, m);
  if (k > 0) {
    let day = 1 + (wd - new Date(Date.UTC(y, m, 1)).getUTCDay() + 7) % 7 + (k - 1) * 7;
    if (day > len) day -= 7;
    return new Date(Date.UTC(y, m, day));
  }
  return new Date(Date.UTC(y, m, len - (new Date(Date.UTC(y, m, len)).getUTCDay() - wd + 7) % 7));
}

/** A stored date as yyyy-MM-dd. */
function dateStr(v) {
  return v ? String(v).slice(0, 10) : "";
}

/** Takes out the rows that match. Returns whether there were any. */
function removeWhere(rows, predicate) {
  let removed = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (predicate(rows[i])) { rows.splice(i, 1); removed = true; }
  }
  return removed;
}

// ---------- meals ----------

/** The Meals tab always holds the seven days. */
function mealRows(c) {
  if (!c.tabs.Meals.length) DAYS.forEach(function (d) { c.tabs.Meals.push({ day: d, meal: "", note: "" }); });
  return c.tabs.Meals;
}

export function getMeals(c) {
  const out = {};
  mealRows(c).forEach(function (r) { out[r.day] = { meal: r.meal || "", note: r.note || "" }; });
  return out;
}

export function saveMeals(c, meals) {
  c.tabs.Meals.length = 0;
  DAYS.forEach(function (d) {
    const m = (meals && meals[d]) || {};
    c.tabs.Meals.push({ day: d, meal: m.meal || "", note: m.note || "" });
  });
}

// ---------- check-ins ----------

export function getCheckins(c, limit) {
  const all = c.tabs.CheckIns.map(function (r) {
    let answers = {};
    try { answers = JSON.parse(r.answersJson); } catch (err) {}
    return { id: String(r.id), date: String(r.date), type: r.type, answers: answers };
  });
  all.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return all.slice(0, limit || 10);
}

export function saveCheckin(c, type, answers) {
  c.tabs.CheckIns.push({
    id: c.newId(),
    date: todayAt(c.now),
    type: type === "couples" ? "couples" : "huddle",
    answersJson: JSON.stringify(answers || {}),
  });
}

export function deleteCheckin(c, id) {
  removeWhere(c.tabs.CheckIns, function (r) { return String(r.id) === String(id); });
}
