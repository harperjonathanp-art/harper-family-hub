/**
 * HARPER FAMILY HUB — Jon's Todoist tasks
 *
 * Todoist is the one place Jon keeps his own to-dos. This file reads his open
 * tasks, with their projects and sections, from the Todoist API (v1) on a
 * timer, and keeps the last good copy for the Hub.
 *
 * Read-only: nothing here completes, edits or creates anything in Todoist.
 * A tick in the Hub only marks a task on the Hub (see "ticks" below).
 *
 * The token is Jon's personal Todoist API token. It lives only in Script
 * Properties (TODOIST_TOKEN): never in this file, the repo, the Hub's pages or
 * a log. Errors are logged by status code only, never with task text.
 *
 * Every task is identified by its Todoist ID. Titles repeat ("Counters") and
 * can hold a pipe ("LinkedIn | Alumni"), so a title never identifies a task.
 *
 * SETUP: see README.md next to this file ("Todoist").
 */

// ======================= CONFIG =======================
const TODOIST_API = 'https://api.todoist.com/api/v1';
const TODOIST_SYNC_MIN = 10;   // how often the timer reads Todoist
const TODOIST_FRESH_MIN = 5;   // a device asking for tasks re-reads Todoist if the copy is older than this
const TODOIST_STALE_MIN = 30;  // older than this, the Hub says how old its copy is
const TODOIST_PAGE = 200;      // the API's largest page
const TODOIST_MAX_PAGES = 25;  // a guard, far above what Jon's tasks need
const TODOIST_NOTES_MAX = 300; // descriptions are kept this long; the Hub shows less
const REMINDERS_TZ = 'America/New_York';
// Script Property REMINDERS_HIDE_LISTS: Todoist projects never sent to the Hub,
// comma separated. Work names students, so it stays hidden unless this says otherwise.
const REMINDERS_HIDE_DEFAULT = 'Work';
const REMINDERS_OWNER = 'Jon';  // whose tasks these are: only his morning summary lists them
const REMINDERS_CHUNK = 3000;   // Script Properties hold 9 KB a value, and some characters take 3 bytes
// ======================================================

const TD_META_ = 'TODOIST_META';   // { syncedAt, attemptedAt, error, count, chunks }
const TD_DATA_ = 'TODOIST_DATA_';  // + chunk number
const TD_TICKS_ = 'TODOIST_TICKS'; // tasks ticked in the Hub: { id: { at, by, due } }
const TD_TICKS_MAX_ = 300;

// ---------- setup & timer ----------

/**
 * Run once from the editor: sets the timer, removes the old Reminders email
 * timers and their saved copy, and syncs.
 */
function setupTodoist() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'syncTodoist' || fn === 'syncReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncTodoist').timeBased().everyMinutes(TODOIST_SYNC_MIN).create();
  // The old snapshot-email feature kept its copy under REMINDERS_*; it's no longer read.
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k === 'REMINDERS_META' || k === 'REMINDERS_TICKS' || k.indexOf('REMINDERS_DATA_') === 0) props.deleteProperty(k);
  });
  const r = syncTodoist();
  Logger.log('Todoist: ' + r.status + (r.count != null ? ' (' + r.count + ' open tasks)' : '') +
    (r.message ? ' — ' + r.message : ''));
}

/**
 * Timer entry point. Never throws: a failed read leaves the last good copy alone.
 * waitMs: how long to wait for another read to finish (a timer passes its event object instead).
 */
function syncTodoist(waitMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(typeof waitMs === 'number' ? waitMs : 10000)) return { status: 'busy' };
  try {
    const got = fetchTodoist_();
    storeTasks_(got.items);
    return { status: 'updated', count: got.items.length };
  } catch (err) {
    const message = String(err && err.message || err).slice(0, 200); // our own error text, never task data
    saveMeta_({ attemptedAt: Date.now(), error: message });
    return { status: 'error', message: message };
  } finally {
    lock.releaseLock();
  }
}

// ---------- reading Todoist ----------

function fetchTodoist_() {
  if (!prop_('TODOIST_TOKEN')) throw new Error('TODOIST_TOKEN is not set in Script Properties');
  const projects = todoistAll_('/projects');
  const sections = todoistAll_('/sections');
  const tasks = todoistAll_('/tasks');
  const toLocal = function (iso) {
    const d = new Date(iso);
    return { date: Utilities.formatDate(d, REMINDERS_TZ, 'yyyy-MM-dd'), time: Utilities.formatDate(d, REMINDERS_TZ, 'h:mm a') };
  };
  return { items: todoistItems_(tasks, projects, sections, toLocal) };
}

/** Every page of a paginated list ({ results, next_cursor }). */
function todoistAll_(path) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < TODOIST_MAX_PAGES; page++) {
    const data = todoistGet_(path + '?limit=' + TODOIST_PAGE + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    (data.results || []).forEach(function (x) { out.push(x); });
    cursor = data.next_cursor;
    if (!cursor) return out;
  }
  throw new Error('Todoist ' + path + ': more pages than expected');
}

function todoistGet_(path) {
  const r = UrlFetchApp.fetch(TODOIST_API + path, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + prop_('TODOIST_TOKEN') },
    muteHttpExceptions: true,
  });
  const code = r.getResponseCode();
  if (code === 401 || code === 403) throw new Error('Todoist ' + code + ': check TODOIST_TOKEN');
  if (code !== 200) throw new Error('Todoist ' + code + ' on ' + path.split('?')[0]);
  return JSON.parse(r.getContentText());
}

// ---------- shaping (pure: no Apps Script services, so it can be tested anywhere) ----------

/**
 * Todoist's tasks, projects and sections -> the Hub's rows, in Todoist's own
 * order (project, then section, then position). Each row:
 *   key        the Todoist task ID (strings, never titles)
 *   list       project name           section   section name, or ''
 *   title      the task               notes     its description (trimmed)
 *   parentKey  the parent task's ID, or ''   parent  the parent's title, for display
 *   due        yyyy-MM-dd or ''       time      '7:30 AM', or '' for an all-day task
 *   dueText    Todoist's own wording when the date couldn't be read, so nothing is lost
 *   recurring  true/false             repeat    Todoist's wording of the repeat ("every Tue")
 *   priority   'P1'..'P4', as Todoist's apps show it (the API's 4 is P1)
 * toLocal(isoUtc) -> { date, time } in Eastern time, for fixed-zone due times.
 */
function todoistItems_(tasks, projects, sections, toLocal) {
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
    const due = todoistDue_(t.due, toLocal);
    const p = proj[t.project_id] || { name: 'Inbox', ord: -1 };
    const s = t.section_id && sect[t.section_id];
    const parent = t.parent_id && byId[t.parent_id];
    return {
      key: String(t.id), list: p.name, section: s ? s.name : '',
      title: String(t.content || ''), notes: String(t.description || '').trim().slice(0, TODOIST_NOTES_MAX),
      parentKey: t.parent_id ? String(t.parent_id) : '', parent: parent ? String(parent.content || '') : '',
      due: due.date, time: due.time, dueText: due.text,
      recurring: !!(t.due && t.due.is_recurring), repeat: t.due && t.due.is_recurring ? String(t.due.string || '') : '',
      priority: 'P' + (5 - Math.min(4, Math.max(1, Number(t.priority) || 1))),
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
function todoistDue_(due, toLocal) {
  const none = { date: '', time: '', text: '' };
  if (!due || !due.date) return none;
  const d = String(due.date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return { date: d, time: '', text: '' };
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(d)) {
    const at = new Date(d);
    if (!isNaN(at.getTime())) { const l = toLocal(d); return { date: l.date, time: l.time, text: '' }; }
  }
  const m = d.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (m) {
    const h = Number(m[2]);
    return { date: m[1], time: ((h % 12) || 12) + ':' + m[3] + ' ' + (h < 12 ? 'AM' : 'PM'), text: '' };
  }
  return { date: '', time: '', text: String(due.string || d) };
}

/** A tick lasts while the task is still open in Todoist at the same due it had when ticked. */
function settleTicks_(ticks, items) {
  const due = {};
  items.forEach(function (r) { due[r.key] = r.due + ' ' + r.time; });
  const kept = {};
  Object.keys(ticks).forEach(function (k) {
    if (due[k] != null && due[k] === ticks[k].due) kept[k] = ticks[k];
  });
  return kept;
}

// ---------- keeping the last good copy ----------

function storeTasks_(items) {
  const props = PropertiesService.getScriptProperties();
  const packed = JSON.stringify(items.map(function (r) {
    return [r.key, r.list, r.section, r.title, r.notes, r.parentKey, r.parent, r.due, r.time, r.dueText, r.recurring ? 1 : 0, r.repeat, r.priority];
  }));
  const chunks = {};
  let n = 0;
  for (let i = 0; i < packed.length; i += REMINDERS_CHUNK) chunks[TD_DATA_ + (n++)] = packed.slice(i, i + REMINDERS_CHUNK);
  const old = loadMeta_().chunks || 0;
  const now = Date.now();
  chunks[TD_META_] = JSON.stringify({ syncedAt: now, attemptedAt: now, error: '', count: items.length, chunks: n });
  chunks[TD_TICKS_] = JSON.stringify(settleTicks_(loadTicks_(), items));
  props.setProperties(chunks, false);
  for (let i = n; i < old; i++) props.deleteProperty(TD_DATA_ + i);
}

function loadItems_(meta) {
  const props = PropertiesService.getScriptProperties();
  let packed = '';
  for (let i = 0; i < (meta.chunks || 0); i++) packed += props.getProperty(TD_DATA_ + i) || '';
  let rows = [];
  try { rows = packed ? JSON.parse(packed) : []; } catch (err) { rows = []; }
  return rows.map(function (r) {
    return {
      key: r[0], list: r[1], section: r[2], title: r[3], notes: r[4], parentKey: r[5], parent: r[6],
      due: r[7], time: r[8], dueText: r[9], recurring: !!r[10], repeat: r[11], priority: r[12],
    };
  });
}

function loadMeta_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(TD_META_) || '{}'); }
  catch (err) { return {}; }
}

function saveMeta_(patch) {
  const meta = loadMeta_();
  Object.keys(patch).forEach(function (k) { meta[k] = patch[k]; });
  PropertiesService.getScriptProperties().setProperty(TD_META_, JSON.stringify(meta));
}

// ---------- ticks made in the Hub ----------
// Just for fun: a tick only marks a task on the Hub, on every device. Nothing
// goes to Todoist. Once the task is done in Todoist (it leaves the list) or its
// due date moves (a repeating task's next turn, or a reschedule), the tick is dropped.

function loadTicks_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(TD_TICKS_) || '{}'); }
  catch (err) { return {}; }
}

/** From the Hub: tick (or untick) one task the Hub can see, by its Todoist ID. */
function tickReminder_(key, on, by) {
  key = String(key || '');
  const item = visibleItems_(loadMeta_()).filter(function (r) { return r.key === key; })[0];
  const ticks = loadTicks_();
  if (on && item) ticks[key] = { at: Date.now(), by: String(by || '').slice(0, 20), due: item.due + ' ' + item.time };
  else delete ticks[key];
  const keys = Object.keys(ticks);
  if (keys.length > TD_TICKS_MAX_) {
    keys.sort(function (a, b) { return ticks[a].at - ticks[b].at; })
      .slice(0, keys.length - TD_TICKS_MAX_).forEach(function (k) { delete ticks[k]; });
  }
  PropertiesService.getScriptProperties().setProperty(TD_TICKS_, JSON.stringify(ticks));
}

// ---------- the morning summary ----------

/**
 * The owner's summary line: top-level tasks due today or overdue, not ticked
 * in the Hub, each with how many of its subtasks are left. Null when there is
 * nothing to say.
 */
function remindersLine_(today) {
  let rm;
  try { rm = getReminders_(true); } catch (err) { return null; }
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
    return n ? r.title + ' (' + n + ' subtask' + (n === 1 ? '' : 's') + ')' : r.title;
  });
  const from = rm.status === 'stale'
    ? ' (as of ' + Utilities.formatDate(new Date(rm.syncedAt), REMINDERS_TZ, 'MMM d, h:mm a') + ')' : '';
  return 'Todoist' + from + ': ' + list_(names);
}

// ---------- what the Hub is sent ----------

/** The tasks minus the projects named in REMINDERS_HIDE_LISTS (default Work). */
function visibleItems_(meta) {
  const hide = String(prop_('REMINDERS_HIDE_LISTS') == null ? REMINDERS_HIDE_DEFAULT : prop_('REMINDERS_HIDE_LISTS'))
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  return loadItems_(meta).filter(function (r) { return hide.indexOf(String(r.list).toLowerCase()) < 0; });
}

/**
 * The Hub's view of Jon's Todoist. Projects named in REMINDERS_HIDE_LISTS are
 * left out here, so a hidden project never reaches any phone.
 *   fresh  the last read worked and is recent
 *   stale  the last read failed or is old: the Hub keeps showing the last good
 *          copy, labelled with when it was read, never an empty list
 *   none / error  nothing has ever been read
 */
function getReminders_(noSync) {
  let meta = loadMeta_();
  // Behind and the timer hasn't tried lately: read now, unless another read is
  // already running. (Not from the notification timer, which holds the lock.)
  if (!noSync && Date.now() - (meta.syncedAt || 0) > TODOIST_FRESH_MIN * 60000 &&
      Date.now() - (meta.attemptedAt || 0) > TODOIST_FRESH_MIN * 60000) {
    syncTodoist(0);
    meta = loadMeta_();
  }
  if (!meta.syncedAt) return { status: meta.error ? 'error' : 'none', error: meta.error || '', items: [], lists: [] };

  const ticks = loadTicks_();
  const items = visibleItems_(meta).map(function (r) {
    const t = ticks[r.key];
    if (t && t.due === r.due + ' ' + r.time) { r.ticked = true; r.tickedBy = t.by; }
    return r;
  });
  const lists = [];
  items.forEach(function (r) { if (lists.indexOf(r.list) < 0) lists.push(r.list); });
  const failed = !!meta.error && (meta.attemptedAt || 0) >= meta.syncedAt;
  return {
    status: failed || Date.now() - meta.syncedAt > TODOIST_STALE_MIN * 60000 ? 'stale' : 'fresh',
    syncedAt: meta.syncedAt, error: failed ? meta.error : '',
    lists: lists, items: items,
  };
}
