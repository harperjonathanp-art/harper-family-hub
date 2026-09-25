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
  Tasks:       ['id', 'title', 'recurrence', 'assignee', 'createdAt'],
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
  }
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
    done[c.taskId + '|' + c.periodKey] = c.completedBy || true;
  });
  return rows_('Tasks').map(function (t) {
    const pk = periodKey_(t.recurrence);
    const key = t.id + '|' + pk;
    return {
      id: String(t.id),
      title: t.title,
      recurrence: t.recurrence,
      assignee: t.assignee,
      completed: key in done,
      completedBy: done[key] || null,
    };
  });
}

function addTask_(b) {
  const task = {
    id: Utilities.getUuid().slice(0, 8),
    title: String(b.title || '').slice(0, 200),
    recurrence: b.recurrence || 'once',
    assignee: b.assignee || '',
  };
  sheet_('Tasks').appendRow([task.id, task.title, task.recurrence, task.assignee, new Date().toISOString()]);
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
  const pk = periodKey_(task.recurrence);
  const existed = removeRowsWhere_('Completions', function (r) {
    return String(r[0]) === String(id) && String(r[1]) === pk;
  });
  if (!existed) {
    sheet_('Completions').appendRow([String(id), pk, by || '', new Date().toISOString()]);
  }
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
