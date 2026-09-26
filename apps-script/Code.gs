/**
 * HARPER FAMILY HUB — Apps Script backend
 * Serves calendar events, tasks, meals, and check-ins as JSON
 * for the GitHub Pages frontend. Data lives in one Google Sheet.
 *
 * This file is published in a public repo, so the PIN, the Sheet ID and
 * the calendar IDs live in Script Properties, never in the code.
 *
 * SETUP (see README.md next to this file):
 *  1. Project Settings > Script Properties > add FAMILY_PIN, SHEET_ID and
 *     the CAL_* calendar IDs (calendars must be shared with this account).
 *  2. Deploy > New deployment > Web app > Execute as: Me > Access: Anyone.
 *  3. Notifications live in Notify.gs, with their own setup steps.
 */

// ======================= CONFIG =======================
// Each calendar's ID comes from the Script Property named in `prop`.
// A calendar whose property is missing is simply skipped.
const CALENDARS = [
  // Jon — personal
  { prop: 'CAL_JON', name: 'Jon', color: '#2C4A63' },

  // Maggie — her primary calendar ID is her Google account email.
  // She must share it with the account running this script.
  { prop: 'CAL_MAGGIE', name: 'Maggie', color: '#B98A2E' },

  // Family — shared calendar for kids' activities, church, etc.
  // ID looks like xxxxxxxx@group.calendar.google.com
  // (Google Calendar > Settings > [calendar] > Integrate calendar > Calendar ID)
  { prop: 'CAL_FAMILY', name: 'Family', color: '#6B8F71' },

  // MCHS — school calendar, shown in Mill Creek maroon.
  // If it's a public/subscribed calendar, its ID is under the same
  // Integrate calendar setting once it appears in your calendar list.
  { prop: 'CAL_MCHS', name: 'MCHS', color: '#862633' },
];

const DAYS_AHEAD = 14; // how far ahead the calendar view looks
// ======================================================

const TABS = {
  Tasks:       ['id', 'title', 'recurrence', 'assignee', 'createdAt', 'due', 'repeat', 'lastDone', 'prevDue'],
  Completions: ['taskId', 'periodKey', 'completedBy', 'timestamp'],
  Meals:       ['day', 'meal', 'note'],
  CheckIns:    ['id', 'date', 'type', 'answersJson'],
  Devices:     ['endpoint', 'person', 'subscription', 'addedAt'],
  NotifyPrefs: ['person', 'prefs', 'updatedAt'],
  Groceries:   ['id', 'item', 'done', 'addedBy', 'addedAt'],
};

// ---------- entry points ----------

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!pinOk_(p.pin)) return json_({ ok: false, error: 'bad_pin' });
  if (p.action === 'notify') return json_(notifyInfo_());
  return json_({
    ok: true,
    now: new Date().toISOString(),
    tasks: getTasks_(),
    meals: getMeals_(),
    events: getEvents_(),
    checkins: getCheckins_(10),
    groceries: getGroceries_(),
  });
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }
  if (!pinOk_(body.pin)) return json_({ ok: false, error: 'bad_pin' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let outbox = [];  // notifications to send once the lock is released
  let reply = null; // notification settings actions answer with their own payload
  try {
    switch (body.action) {
      case 'addTask':      outbox = taskAdded_(addTask_(body), body.by); break;
      case 'deleteTask':   deleteTask_(body.id); break;
      case 'toggleTask':   toggleTask_(body.id, body.by); break;
      case 'saveMeals':    saveMeals_(body.meals); mealsEdited_(body.meals, body.by); break;
      case 'saveCheckin':  saveCheckin_(body.type, body.answers); break;
      case 'deleteCheckin': deleteCheckin_(body.id); break;
      case 'addGroceries':   addGroceries_(body.text, body.by); break;
      case 'toggleGrocery':  toggleGrocery_(body.id); break;
      case 'deleteGrocery':  deleteGrocery_(body.id); break;
      case 'clearGroceries': clearGroceries_(); break;
      case 'reorderGroceries': reorderGroceries_(body.ids); break;
      case 'pushSubscribe':   reply = pushSubscribe_(body.person, body.subscription); break;
      case 'pushUnsubscribe': reply = pushUnsubscribe_(body.endpoint); break;
      case 'savePrefs':       reply = savePrefs_(body.person, body.prefs); break;
      case 'pushTest':        outbox = [testMessage_(body.person)]; reply = { ok: true }; break;
      default: return json_({ ok: false, error: 'unknown_action' });
    }
  } finally {
    lock.releaseLock();
  }
  const sent = deliver_(outbox);
  if (reply) return json_(Object.assign(reply, { sent: sent }));
  // Return fresh state so the client can re-render in one round trip.
  return json_({
    ok: true,
    tasks: getTasks_(),
    meals: getMeals_(),
    checkins: getCheckins_(10),
    groceries: getGroceries_(),
  });
}

// ---------- auth & plumbing ----------

function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v == null ? null : v.trim(); // pasted values often carry a stray space
}

function pinOk_(pin) {
  const stored = prop_('FAMILY_PIN');
  return stored && String(pin) === String(stored);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

const HEADERS_CHECKED_ = {}; // tabs whose header row this run has already checked

function sheet_(name) {
  const id = prop_('SHEET_ID');
  if (!id) throw new Error('Add SHEET_ID in Project Settings > Script Properties.');
  const ss = SpreadsheetApp.openById(id);
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(TABS[name]);
    if (name === 'Meals') {
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
        .forEach(function (d) { sh.appendRow([d, '', '']); });
    }
  } else if (!HEADERS_CHECKED_[name]) {
    // A tab made by an older version lacks newer columns: add their headers.
    const want = TABS[name];
    const have = sh.getRange(1, 1, 1, want.length).getValues()[0];
    want.forEach(function (h, i) { if (have[i] === '') sh.getRange(1, i + 1).setValue(h); });
  }
  HEADERS_CHECKED_[name] = true;
  return sh;
}

function rows_(name) {
  const sh = sheet_(name);
  const vals = sh.getDataRange().getValues();
  const header = vals.shift();
  return vals.map(function (r) {
    const o = {};
    header.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

// ---------- period keys (recurrence reset logic) ----------

function periodKey_(recurrence, d) {
  d = d || new Date();
  const tz = Session.getScriptTimeZone();
  const fmt = function (pattern) { return Utilities.formatDate(d, tz, pattern); };
  switch (recurrence) {
    case 'daily':     return fmt('yyyy-MM-dd');
    case 'weekly': {
      const m = new Date(d);
      const shift = (m.getDay() + 6) % 7; // days since Monday
      m.setDate(m.getDate() - shift);
      return 'W' + Utilities.formatDate(m, tz, 'yyyy-MM-dd');
    }
    case 'monthly':   return fmt('yyyy-MM');
    case 'quarterly': return fmt('yyyy') + '-Q' + (Math.floor(d.getMonth() / 3) + 1);
    case 'yearly':    return fmt('yyyy');
    default:          return 'once';
  }
}

// ---------- tasks ----------

function getTasks_() {
  const completions = rows_('Completions');
  const done = {};
  completions.forEach(function (c) {
    periodKeys_(c.periodKey).forEach(function (k) { done[c.taskId + '|' + k] = c.completedBy || true; });
  });
  const today = today_();
  return rows_('Tasks').map(function (t) {
    const repeat = String(t.repeat || '').trim();
    if (parseRepeat_(repeat)) { // an unreadable repeat leaves it a plain task
      // A repeating task moves to its next date when it's done, so "completed"
      // means done today (it can still be unticked until tomorrow).
      const doneToday = dateStr_(t.lastDone) === today;
      return {
        id: String(t.id),
        title: t.title,
        recurrence: 'repeat',
        repeat: repeat,
        due: dateStr_(t.due),
        assignee: t.assignee,
        completed: doneToday,
        completedBy: doneToday ? (done[t.id + '|' + dateStr_(t.prevDue)] || null) : null,
      };
    }
    // A repeat typed in the Sheet that can't be read: a one-off, flagged so it can be fixed.
    const recurrence = t.recurrence === 'repeat' ? 'once' : t.recurrence;
    const pk = periodKey_(recurrence);
    const key = t.id + '|' + pk;
    return {
      id: String(t.id),
      title: t.title,
      recurrence: recurrence,
      badRepeat: repeat || undefined,
      due: dateStr_(t.due),
      assignee: t.assignee,
      completed: key in done,
      completedBy: done[key] || null,
    };
  });
}

function addTask_(b) {
  const repeat = parseRepeat_(b.repeat) ? String(b.repeat).trim().toLowerCase() : '';
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due)) ? String(b.due) : (repeat ? today_() : '');
  const task = {
    id: Utilities.getUuid().slice(0, 8),
    title: String(b.title || '').slice(0, 200),
    recurrence: repeat ? 'repeat' : (b.recurrence || 'once'),
    assignee: b.assignee || '',
    due: due,
    repeat: repeat,
  };
  sheet_('Tasks').appendRow([task.id, task.title, task.recurrence, task.assignee, new Date().toISOString(),
    task.due, task.repeat, '', '']);
  return task;
}

function deleteTask_(id) {
  removeRowsWhere_('Tasks', function (r) { return String(r[0]) === String(id); });
  removeRowsWhere_('Completions', function (r) { return String(r[0]) === String(id); });
}

function toggleTask_(id, by) {
  const tasks = rows_('Tasks');
  const task = tasks.filter(function (t) { return String(t.id) === String(id); })[0];
  if (!task) return;
  if (parseRepeat_(task.repeat)) { toggleRepeat_(task, by); return; }
  const pk = periodKey_(task.recurrence);
  const existed = removeRowsWhere_('Completions', function (r) {
    return String(r[0]) === String(id) && periodKeys_(r[1]).indexOf(pk) >= 0;
  });
  if (!existed) {
    sheet_('Completions').appendRow([String(id), pk, by || '', new Date().toISOString()]);
  }
}

/**
 * Ticking a repeating task moves it to its next date, like Apple Reminders.
 * Unticking it the same day puts it back where it was.
 */
function toggleRepeat_(task, by) {
  const today = today_();
  const prevDue = dateStr_(task.prevDue);
  if (dateStr_(task.lastDone) === today && prevDue) {
    updateRow_('Tasks', task.id, { due: prevDue, lastDone: '', prevDue: '' });
    removeRowsWhere_('Completions', function (r) {
      return String(r[0]) === String(task.id) && dateStr_(r[1]) === prevDue;
    });
    return;
  }
  const due = dateStr_(task.due) || today;
  updateRow_('Tasks', task.id, { due: nextDue_(task.repeat, due, today), lastDone: today, prevDue: due });
  sheet_('Completions').appendRow([String(task.id), due, by || '', new Date().toISOString()]);
}

/** Sets named columns on the row whose first cell is id. */
function updateRow_(name, id, fields) {
  const sh = sheet_(name);
  const vals = sh.getDataRange().getValues();
  const header = vals[0];
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) !== String(id)) continue;
    Object.keys(fields).forEach(function (k) {
      const c = header.indexOf(k);
      if (c >= 0) sh.getRange(i + 1, c + 1).setValue(fields[k]);
    });
    return true;
  }
  return false;
}

// ---------- repeat rules ----------
// Written the way Apple Reminders reads them, and stored as text in the Tasks tab:
//   "every 2 weeks"               "every 1 week on sun,tue,thu"
//   "every 3 months on 3rd sat"   "every 1 year on last fri"   "every 6 months"
// A weekly rule without days repeats on the due date's weekday; a monthly or
// yearly one without "on" keeps the due date's day of the month.

const WEEKDAYS_ = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const NTH_ = { '1st': 1, first: 1, '2nd': 2, second: 2, '3rd': 3, third: 3, '4th': 4, fourth: 4,
  '5th': 5, fifth: 5, last: -1 };

function parseRepeat_(text) {
  const m = String(text || '').trim().toLowerCase()
    .match(/^every\s+(\d+)\s+(day|week|month|year)s?(?:\s+on\s+(.+))?$/);
  if (!m) return null;
  const rule = { n: Math.max(1, Math.min(99, Number(m[1]))), unit: m[2] };
  const on = m[3] || '';
  if (rule.unit === 'week' && on) {
    // Every listed day must be a real weekday, or the rule isn't what was meant.
    const days = on.split(/[\s,]+/).filter(Boolean).map(function (d) { return WEEKDAYS_.indexOf(d.slice(0, 3)); });
    if (!days.length || days.some(function (d) { return d < 0; })) return null;
    rule.days = days.filter(function (d, i, all) { return all.indexOf(d) === i; }).sort();
  }
  if (rule.unit === 'day' && on) return null;
  if ((rule.unit === 'month' || rule.unit === 'year') && on) {
    const p = on.match(/^(\w+)\s+(\w{3})/);
    if (!p || !(p[1] in NTH_) || WEEKDAYS_.indexOf(p[2]) < 0) return null;
    rule.nth = { k: NTH_[p[1]], wd: WEEKDAYS_.indexOf(p[2]) };
  }
  return rule;
}

/** The first date in the series after the current due date that's also after today. */
function nextDue_(repeat, due, today) {
  const rule = parseRepeat_(repeat);
  if (!rule) return due;
  let d = stepRepeat_(rule, ymd_(due));
  for (let guard = 0; iso_(d) <= today && guard < 2000; guard++) d = stepRepeat_(rule, d);
  return iso_(d);
}

function stepRepeat_(rule, d) {
  if (rule.unit === 'day') return addDays_(d, rule.n);
  if (rule.unit === 'week') {
    if (!rule.days || !rule.days.length) return addDays_(d, 7 * rule.n);
    const wd = d.getUTCDay();
    const later = rule.days.filter(function (x) { return x > wd; });
    if (later.length) return addDays_(d, later[0] - wd); // later this week
    return addDays_(d, 7 * rule.n - wd + rule.days[0]);  // first listed day, n weeks on
  }
  return addMonths_(d, rule.unit === 'year' ? 12 * rule.n : rule.n, rule.nth);
}

// Dates as UTC midnights, so time zones and daylight saving can't shift a day.
function ymd_(s) {
  const p = String(s).split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
}
function iso_(d) { return d.toISOString().slice(0, 10); }
function addDays_(d, n) { return new Date(d.getTime() + n * 86400000); }
function daysIn_(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }

function addMonths_(d, months, nth) {
  const total = d.getUTCMonth() + months;
  const y = d.getUTCFullYear() + Math.floor(total / 12), m = ((total % 12) + 12) % 12;
  if (nth) return nthWeekday_(y, m, nth.k, nth.wd);
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), daysIn_(y, m))));
}

/** The kth (or last, k = -1) weekday wd of a month; a missing 5th falls back to the last. */
function nthWeekday_(y, m, k, wd) {
  const len = daysIn_(y, m);
  if (k > 0) {
    let day = 1 + (wd - new Date(Date.UTC(y, m, 1)).getUTCDay() + 7) % 7 + (k - 1) * 7;
    if (day > len) day -= 7;
    return new Date(Date.UTC(y, m, day));
  }
  return new Date(Date.UTC(y, m, len - (new Date(Date.UTC(y, m, len)).getUTCDay() - wd + 7) % 7));
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * A stored period key as the text it was written as. Sheets turns "2026-09-26"
 * (daily) and "2026-09" (monthly) into date cells, so a date gives both forms.
 */
function periodKeys_(v) {
  if (!(v instanceof Date)) return [String(v)];
  const tz = Session.getScriptTimeZone();
  return [Utilities.formatDate(v, tz, 'yyyy-MM-dd'), Utilities.formatDate(v, tz, 'yyyy-MM')];
}

/** Sheets turns typed dates into date cells; read them back as yyyy-MM-dd. */
function dateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v ? String(v).slice(0, 10) : '';
}

function removeRowsWhere_(name, predicate) {
  const sh = sheet_(name);
  const vals = sh.getDataRange().getValues();
  let removed = false;
  for (let i = vals.length - 1; i >= 1; i--) {
    if (predicate(vals[i])) { sh.deleteRow(i + 1); removed = true; }
  }
  return removed;
}

// ---------- meals ----------

function getMeals_() {
  const out = {};
  rows_('Meals').forEach(function (r) {
    out[r.day] = { meal: r.meal || '', note: r.note || '' };
  });
  return out;
}

function saveMeals_(meals) {
  const sh = sheet_('Meals');
  sh.clearContents();
  sh.appendRow(TABS.Meals);
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(function (d) {
    const m = (meals && meals[d]) || {};
    sh.appendRow([d, m.meal || '', m.note || '']);
  });
}

// ---------- calendar ----------

function getEvents_() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + DAYS_AHEAD);
  const tz = Session.getScriptTimeZone();
  const out = [];
  CALENDARS.forEach(function (c) {
    const id = prop_(c.prop);
    if (!id) return;
    let cal;
    try { cal = CalendarApp.getCalendarById(id); } catch (err) { return; }
    if (!cal) return;
    cal.getEvents(start, end).forEach(function (ev) {
      out.push({
        cal: c.name,
        color: c.color,
        title: ev.getTitle(),
        allDay: ev.isAllDayEvent(),
        date: Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd'),
        start: Utilities.formatDate(ev.getStartTime(), tz, 'h:mm a'),
        end: Utilities.formatDate(ev.getEndTime(), tz, 'h:mm a'),
        sort: ev.getStartTime().getTime(),
      });
    });
  });
  out.sort(function (a, b) { return a.sort - b.sort; });
  return out;
}

// ---------- groceries ----------

function getGroceries_() {
  return rows_('Groceries').map(function (r) {
    return { id: String(r.id), item: String(r.item), done: r.done === true, addedBy: r.addedBy || '' };
  });
}

/** One item per line, so a pasted ingredient list becomes separate items. */
function addGroceries_(text, by) {
  const sh = sheet_('Groceries');
  String(text || '').split(/\n+/)
    .map(function (s) { return s.replace(/^[\s•*\-–—]+/, '').trim(); })
    .filter(Boolean)
    .slice(0, 50)
    .forEach(function (item) {
      sh.appendRow([Utilities.getUuid().slice(0, 8), item.slice(0, 200), false, by || '', new Date().toISOString()]);
    });
}

function toggleGrocery_(id) {
  const sh = sheet_('Groceries');
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(id)) {
      sh.getRange(i + 1, 3).setValue(vals[i][2] !== true);
      return;
    }
  }
}

function deleteGrocery_(id) {
  removeRowsWhere_('Groceries', function (r) { return String(r[0]) === String(id); });
}

function clearGroceries_() {
  removeRowsWhere_('Groceries', function (r) { return r[2] === true; });
}

/** Rewrites the list in the order given. Items it doesn't name (added meanwhile) keep their place at the end. */
function reorderGroceries_(ids) {
  if (!Array.isArray(ids)) return;
  const sh = sheet_('Groceries');
  const vals = sh.getDataRange().getValues();
  const header = vals.shift();
  const byId = {};
  vals.forEach(function (r) { byId[String(r[0])] = r; });
  const ordered = [];
  ids.forEach(function (id) {
    const r = byId[String(id)];
    if (r) { ordered.push(r); delete byId[String(id)]; }
  });
  vals.forEach(function (r) { if (String(r[0]) in byId) ordered.push(r); });
  if (ordered.length) sh.getRange(2, 1, ordered.length, header.length).setValues(ordered);
}

// ---------- check-ins ----------

function getCheckins_(limit) {
  const tz = Session.getScriptTimeZone();
  const all = rows_('CheckIns').map(function (r) {
    let answers = {};
    try { answers = JSON.parse(r.answersJson); } catch (err) {}
    // Sheets usually turns the saved date into a date cell; keep it yyyy-MM-dd so it sorts.
    const date = r.date instanceof Date ? Utilities.formatDate(r.date, tz, 'yyyy-MM-dd') : String(r.date);
    return { id: String(r.id), date: date, type: r.type, answers: answers };
  });
  all.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  return all.slice(0, limit || 10);
}

function saveCheckin_(type, answers) {
  const tz = Session.getScriptTimeZone();
  sheet_('CheckIns').appendRow([
    Utilities.getUuid().slice(0, 8),
    Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'),
    type === 'couples' ? 'couples' : 'huddle',
    JSON.stringify(answers || {}),
  ]);
}

function deleteCheckin_(id) {
  removeRowsWhere_('CheckIns', function (r) { return String(r[0]) === String(id); });
}
