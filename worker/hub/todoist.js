/**
 * HARPER FAMILY HUB — Jon's Todoist tasks
 *
 * The same as apps-script/Todoist.gs: read-only, keyed by Todoist's task IDs,
 * the last good copy kept and shown with its age if Todoist can't be reached.
 * A tick in the Hub marks a task on the Hub only.
 *
 * One thing is stricter than before. The projects named in REMINDERS_HIDE_LISTS
 * (Work, unless it says otherwise: its tasks name students) are dropped as they
 * are read, so they are never stored here at all, not merely never sent.
 *
 * The token is the Worker secret TODOIST_TOKEN. Errors are kept by status code
 * only, never with task text.
 */

import { local, stamp } from "./time.js";
import { list } from "./notify.js";

const TODOIST_API = "https://api.todoist.com/api/v1";
export const TODOIST_FRESH_MIN = 5;   // a device asking for tasks re-reads Todoist if the copy is older than this
const TODOIST_STALE_MIN = 30;  // older than this, the Hub says how old its copy is
const TODOIST_PAGE = 200;      // the API's largest page
const TODOIST_MAX_PAGES = 25;  // a guard, far above what Jon's tasks need
const TODOIST_NOTES_MAX = 300; // descriptions are kept this long; the Hub shows less
const HIDE_DEFAULT = "Work";
const TICKS_MAX = 300;

const ITEMS = "TODOIST_ITEMS"; // the last good copy, as JSON
const META = "TODOIST_META";   // { syncedAt, attemptedAt, error, count }
const TICKS = "TODOIST_TICKS"; // tasks ticked in the Hub: { id: { at, by, due } }

export function todoistOn(env) { return !!String(env.TODOIST_TOKEN || "").trim(); }

function hidden(env) {
  return String(env.REMINDERS_HIDE_LISTS == null ? HIDE_DEFAULT : env.REMINDERS_HIDE_LISTS)
    .split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

// ---------- reading Todoist (the only part that waits on anything) ----------

/** Todoist's open tasks as the Hub's rows, hidden projects already dropped. Throws with a status code, never task text. */
export async function fetchTodoist(env) {
  if (!todoistOn(env)) throw new Error("TODOIST_TOKEN is not set on the Worker");
  const projects = await todoistAll(env, "/projects");
  const sections = await todoistAll(env, "/sections");
  const tasks = await todoistAll(env, "/tasks");
  const toLocal = function (isoUtc) { const p = local(new Date(isoUtc)); return { date: p.iso, time: p.time12 }; };
  const hide = hidden(env);
  return todoistItems(tasks, projects, sections, toLocal)
    .filter(function (r) { return hide.indexOf(String(r.list).toLowerCase()) < 0; });
}

/** Every page of a paginated list ({ results, next_cursor }). */
async function todoistAll(env, path) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < TODOIST_MAX_PAGES; page++) {
    const res = await fetch(TODOIST_API + path + "?limit=" + TODOIST_PAGE + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), {
      headers: { Authorization: "Bearer " + String(env.TODOIST_TOKEN).trim() },
    });
    if (res.status === 401 || res.status === 403) throw new Error("Todoist " + res.status + ": check TODOIST_TOKEN");
    if (res.status !== 200) throw new Error("Todoist " + res.status + " on " + path);
    const data = await res.json();
    (data.results || []).forEach(function (x) { out.push(x); });
    cursor = data.next_cursor;
    if (!cursor) return out;
  }
  throw new Error("Todoist " + path + ": more pages than expected");
}

// ---------- shaping (as in Todoist.gs) ----------

/**
 * Todoist's tasks, projects and sections -> the Hub's rows, in Todoist's own
 * order (project, then section, then position). See Todoist.gs for each field.
 */
export function todoistItems(tasks, projects, sections, toLocal) {
  const proj = {}, sect = {};
  projects.forEach(function (p, i) { proj[p.id] = { name: p.name, ord: i }; });
  sections.forEach(function (s) { sect[s.id] = { name: s.name, ord: s.section_order || 0 }; });
  const byId = {}, seen = {};
  const live = tasks.filter(function (t) {
    if (!t || t.checked || t.is_deleted || seen[t.id]) return false; // pages can repeat a task if it moved mid-read
    seen[t.id] = true;
    byId[t.id] = t;
    return true;
  });
  const rows = live.map(function (t) {
    const due = todoistDue(t.due, toLocal);
    const p = proj[t.project_id] || { name: "Inbox", ord: -1 };
    const s = t.section_id && sect[t.section_id];
    const parent = t.parent_id && byId[t.parent_id];
    return {
      key: String(t.id), list: p.name, section: s ? s.name : "",
      title: String(t.content || ""), notes: String(t.description || "").trim().slice(0, TODOIST_NOTES_MAX),
      parentKey: t.parent_id ? String(t.parent_id) : "", parent: parent ? String(parent.content || "") : "",
      due: due.date, time: due.time, dueText: due.text,
      recurring: !!(t.due && t.due.is_recurring), repeat: t.due && t.due.is_recurring ? String(t.due.string || "") : "",
      priority: "P" + (5 - Math.min(4, Math.max(1, Number(t.priority) || 1))),
      _sort: [p.ord, s ? s.ord : -1, Number(t.child_order) || 0],
    };
  });
  rows.sort(function (a, b) {
    for (let i = 0; i < 3; i++) if (a._sort[i] !== b._sort[i]) return a._sort[i] - b._sort[i];
    return 0;
  });
  rows.forEach(function (r) { delete r._sort; });
  return rows;
}

/**
 * Todoist's three kinds of due date:
 *   "2026-11-12"              all day: no time
 *   "2026-11-12T09:00:00"     floating: that clock time wherever Jon is
 *   "2026-11-12T14:00:00Z"    fixed zone, stored in UTC: shown in Eastern time
 */
export function todoistDue(due, toLocal) {
  const none = { date: "", time: "", text: "" };
  if (!due || !due.date) return none;
  const d = String(due.date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return { date: d, time: "", text: "" };
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(d)) {
    const at = new Date(d);
    if (!isNaN(at.getTime())) { const l = toLocal(d); return { date: l.date, time: l.time, text: "" }; }
  }
  const m = d.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (m) {
    const h = Number(m[2]);
    return { date: m[1], time: ((h % 12) || 12) + ":" + m[3] + " " + (h < 12 ? "AM" : "PM"), text: "" };
  }
  return { date: "", time: "", text: String(due.string || d) };
}

/** A tick lasts while the task is still open in Todoist at the same due it had when ticked. */
function settleTicks(ticks, items) {
  const due = {};
  items.forEach(function (r) { due[r.key] = r.due + " " + r.time; });
  const kept = {};
  Object.keys(ticks).forEach(function (k) {
    if (due[k] != null && due[k] === ticks[k].due) kept[k] = ticks[k];
  });
  return kept;
}

// ---------- keeping the last good copy (run inside transact) ----------

const parse = function (text, empty) { try { return JSON.parse(text || "") || empty; } catch (err) { return empty; } };
const loadMeta = c => parse(c.props[META], {});
const loadTicks = c => parse(c.props[TICKS], {});
const loadItems = c => parse(c.props[ITEMS], []);

/** A read worked: keep it, and drop ticks that no longer apply. */
export function storeTodoist(c, items) {
  const now = c.now.getTime();
  c.props[ITEMS] = JSON.stringify(items);
  c.props[META] = JSON.stringify({ syncedAt: now, attemptedAt: now, error: "", count: items.length });
  c.props[TICKS] = JSON.stringify(settleTicks(loadTicks(c), items));
}

/** A read failed: the last good copy stays; only the attempt is noted. */
export function todoistFailed(c, message) {
  const meta = loadMeta(c);
  meta.attemptedAt = c.now.getTime();
  meta.error = String(message).slice(0, 200);
  c.props[META] = JSON.stringify(meta);
}

/** Whether a device asking now should trigger a fresh read first. */
export function todoistBehind(metaText, nowMs) {
  const meta = parse(metaText, {});
  return nowMs - (meta.syncedAt || 0) > TODOIST_FRESH_MIN * 60000 && nowMs - (meta.attemptedAt || 0) > TODOIST_FRESH_MIN * 60000;
}

// ---------- ticks made in the Hub ----------

/** From the Hub: tick (or untick) one task the Hub can see, by its Todoist ID. */
export function tickReminder(c, key, on, by) {
  key = String(key || "");
  const item = loadItems(c).filter(function (r) { return r.key === key; })[0];
  const ticks = loadTicks(c);
  if (on && item) ticks[key] = { at: c.now.getTime(), by: String(by || "").slice(0, 20), due: item.due + " " + item.time };
  else delete ticks[key];
  const keys = Object.keys(ticks);
  if (keys.length > TICKS_MAX) {
    keys.sort(function (a, b) { return ticks[a].at - ticks[b].at; })
      .slice(0, keys.length - TICKS_MAX).forEach(function (k) { delete ticks[k]; });
  }
  c.props[TICKS] = JSON.stringify(ticks);
}

// ---------- what the Hub is sent ----------

/**
 * The Hub's view of Jon's Todoist.
 *   fresh  the last read worked and is recent
 *   stale  the last read failed or is old: the last good copy, labelled with when it was read
 *   none / error  nothing has ever been read
 */
export function getReminders(c) {
  const meta = loadMeta(c), now = c.now.getTime();
  if (!meta.syncedAt) return { status: meta.error ? "error" : "none", error: meta.error || "", items: [], lists: [] };
  const ticks = loadTicks(c);
  const items = loadItems(c).map(function (r) {
    const t = ticks[r.key];
    if (t && t.due === r.due + " " + r.time) { r.ticked = true; r.tickedBy = t.by; }
    return r;
  });
  const lists = [];
  items.forEach(function (r) { if (lists.indexOf(r.list) < 0) lists.push(r.list); });
  const failed = !!meta.error && (meta.attemptedAt || 0) >= meta.syncedAt;
  return {
    status: failed || now - meta.syncedAt > TODOIST_STALE_MIN * 60000 ? "stale" : "fresh",
    syncedAt: meta.syncedAt, error: failed ? meta.error : "",
    lists: lists, items: items,
  };
}

/**
 * Jon's morning summary line: top-level tasks due today or overdue, not ticked
 * in the Hub, each with how many of its subtasks are left. Null when there is
 * nothing to say.
 */
export function remindersLine(c, today) {
  let rm;
  try { rm = getReminders(c); } catch (err) { return null; }
  if (!rm.items || !rm.items.length) return null;
  const byKey = {};
  rm.items.forEach(function (r) { byKey[r.key] = r; });
  const topOf = function (r) { while (r.parentKey && byKey[r.parentKey]) r = byKey[r.parentKey]; return r; };
  const left = {};
  rm.items.forEach(function (r) {
    if (!r.parentKey || r.ticked) return;
    const top = topOf(r);
    if (top !== r) left[top.key] = (left[top.key] || 0) + 1;
  });
  const due = rm.items.filter(function (r) { return topOf(r) === r && r.due && r.due <= today && !r.ticked; })
    .sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
  if (!due.length) return null;
  const names = due.map(function (r) {
    const n = left[r.key] || 0;
    return n ? r.title + " (" + n + " subtask" + (n === 1 ? "" : "s") + ")" : r.title;
  });
  const from = rm.status === "stale" ? " (as of " + stamp(new Date(rm.syncedAt)) + ")" : "";
  return "Todoist" + from + ": " + list(names);
}
