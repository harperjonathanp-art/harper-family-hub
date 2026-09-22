/**
 * HARPER FAMILY HUB — notifications
 * Decides what to send and when. The push relay (push-worker/) delivers it
 * to the phones, because Apps Script can't do Web Push encryption itself.
 *
 * SETUP (see README.md next to this file):
 *  1. Script Properties: add PUSH_WORKER_URL, PUSH_SECRET, VAPID_PUBLIC_KEY.
 *  2. Run setupNotifications() once from the editor. It installs the timer
 *     and logs a checklist of what's working.
 */

const PARENTS = ['Jon', 'Maggie'];
const KIDS = ['Clayton', 'Heidi'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const TICK_MINUTES = 5;       // how often notifyTick runs
const LATE_WINDOW_MIN = 60;   // a reminder still goes if the timer runs this late
const MEALS_SETTLE_MIN = 10;  // the plan must sit unchanged this long before it's announced
const QUEUE_MAX = 8;          // alerts held through quiet hours, per person

// What each person gets until they change it in the Hub's Settings.
const DEFAULT_PREFS = {
  summary:  { on: true, at: '07:00' },
  dinner:   { on: true, at: '15:00' },
  huddle:   { on: true, day: 'Sun', at: '18:00' },
  couples:  { on: true, day: 'Sun', at: '19:30' },
  assigned: { on: true },
  meals:    { on: true },
  quiet:    { on: true, from: '21:00', to: '07:00' },
};

// Reminders that go at a time each person picks. Quiet hours don't hold
// these back; they only hold back the alerts that happen on their own.
const SCHEDULED = {
  summary: summaryMsg_,
  dinner:  dinnerMsg_,
  huddle:  function (person, data, clock) { return checkinMsg_('huddle', data, clock); },
  couples: function (person, data, clock) {
    return PARENTS.indexOf(person) >= 0 ? checkinMsg_('couples', data, clock) : null;
  },
};

// ---------- run from the editor / by the timer ----------

/** Run once from the editor. Installs the timer and logs what's working. */
function setupNotifications() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'notifyTick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('notifyTick').timeBased().everyMinutes(TICK_MINUTES).create();

  // Start from today's meal plan, so the current plan isn't announced as new.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const state = loadState_();
    if (!state.meals) {
      const plan = mealPlan_(getMeals_());
      state.meals = { plan: plan, announced: plan, since: Date.now(), editors: [] };
      saveState_(state);
    }
  } finally {
    lock.releaseLock();
  }

  const report = ['PUSH_WORKER_URL', 'PUSH_SECRET', 'VAPID_PUBLIC_KEY'].map(function (k) {
    return (prop_(k) ? '✓ ' : '✗ missing Script Property ') + k;
  });
  const url = prop_('PUSH_WORKER_URL'), secret = prop_('PUSH_SECRET');
  if (url && secret) {
    const res = relay_(url, secret, { subscriptions: [], notification: {} });
    report.push(res.ok ? '✓ push relay answered and accepted PUSH_SECRET'
      : '✗ push relay: ' + (/^relay_401/.test(res.error) ? 'PUSH_SECRET doesn\'t match the Worker\'s' : res.error));
  }
  const counts = {};
  rows_('Devices').forEach(function (d) { counts[d.person] = (counts[d.person] || 0) + 1; });
  const names = Object.keys(counts).map(function (p) { return counts[p] > 1 ? p + ' (' + counts[p] + ')' : p; });
  report.push(names.length ? '✓ phones signed up: ' + names.join(', ')
    : '… no phones signed up yet — turn notifications on in the Hub\'s Settings');
  report.push('✓ notifyTick runs every ' + TICK_MINUTES + ' minutes');
  console.log(report.join('\n'));
}

/** Runs every few minutes from the timer setupNotifications installs. */
function notifyTick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  let outbox;
  try {
    outbox = dueNotifications_(new Date());
  } finally {
    lock.releaseLock();
  }
  deliver_(outbox);
}

// ---------- Hub actions (called from Code.gs, under the script lock) ----------

function notifyInfo_() {
  const stored = storedPrefs_();
  const prefs = {}, devices = {};
  PARENTS.concat(KIDS).forEach(function (p) { prefs[p] = prefsFor_(p, stored); devices[p] = 0; });
  rows_('Devices').forEach(function (d) { if (d.person in devices) devices[d.person]++; });
  return {
    ok: true,
    publicKey: prop_('VAPID_PUBLIC_KEY') || '',
    ready: !!(prop_('VAPID_PUBLIC_KEY') && prop_('PUSH_WORKER_URL') && prop_('PUSH_SECRET')),
    lastTick: loadState_().lastTick || null,
    parents: PARENTS,
    prefs: prefs,
    devices: devices,
  };
}

function pushSubscribe_(person, sub) {
  if (!isPerson_(person)) return { ok: false, error: 'bad_person' };
  if (!sub || !/^https:\/\//.test(String(sub.endpoint)) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return { ok: false, error: 'bad_subscription' };
  }
  const clean = {
    endpoint: String(sub.endpoint),
    keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) },
  };
  removeRowsWhere_('Devices', function (r) { return String(r[0]) === clean.endpoint; });
  sheet_('Devices').appendRow([clean.endpoint, person, JSON.stringify(clean), new Date().toISOString()]);
  return { ok: true };
}

function pushUnsubscribe_(endpoint) {
  removeRowsWhere_('Devices', function (r) { return String(r[0]) === String(endpoint); });
  return { ok: true };
}

function savePrefs_(person, input) {
  if (!isPerson_(person)) return { ok: false, error: 'bad_person' };
  const clean = cleanPrefs_(input);
  removeRowsWhere_('NotifyPrefs', function (r) { return String(r[0]) === person; });
  sheet_('NotifyPrefs').appendRow([person, JSON.stringify(clean), new Date().toISOString()]);
  return { ok: true, prefs: clean };
}

function testMessage_(person) {
  return { people: [person], msg: {
    title: 'Notifications are on',
    body: 'This is how Family Hub alerts will look on this phone.',
    tag: 'test', view: 'today',
  } };
}

/** A to-do was added: tell the person it's for (everyone, if it's a family one). */
function taskAdded_(task, by) {
  try {
    const family = task.assignee === 'Family';
    let people = family ? PARENTS.concat(KIDS) : (isPerson_(task.assignee) ? [task.assignee] : []);
    people = people.filter(function (p) { return p !== by; });
    if (!people.length) return [];
    const ctx = context_(new Date());
    const recur = task.recurrence && task.recurrence !== 'once' ? ' · ' + task.recurrence : '';
    const out = route_(ctx, people, 'assigned', {
      title: (isPerson_(by) ? by : 'Someone') + (family ? ' added a family to-do' : ' added a to-do for you'),
      body: clip_(task.title, 120) + recur,
      tag: 'task-' + task.id, view: 'tasks',
    });
    saveState_(ctx.state);
    return out;
  } catch (err) {
    console.warn('taskAdded_: ' + err); // never let a notification problem block the save
    return [];
  }
}

/** The meal plan was saved from the Hub: note who, so they aren't told about their own plan. */
function mealsEdited_(meals, by) {
  try {
    const state = loadState_();
    const m = state.meals || (state.meals = { plan: null, announced: null, since: 0, editors: [] });
    const plan = mealPlan_(meals || {});
    if (plan !== m.plan) { m.plan = plan; m.since = Date.now(); }
    if (isPerson_(by) && m.editors.indexOf(by) < 0) m.editors.push(by);
    saveState_(state);
  } catch (err) {
    console.warn('mealsEdited_: ' + err);
  }
}

// ---------- the timer's work ----------

function dueNotifications_(now) {
  const ctx = context_(now);
  const data = lazyData_();
  let outbox = [];
  ctx.people.forEach(function (person) {
    const prefs = ctx.prefs(person);
    Object.keys(SCHEDULED).forEach(function (kind) {
      const p = prefs[kind];
      if (!p.on || (p.day && p.day !== ctx.clock.day)) return;
      const at = minutes_(p.at);
      if (ctx.clock.min < at || ctx.clock.min >= at + LATE_WINDOW_MIN) return;
      const key = kind + '|' + person;
      if (ctx.state.sent[key] === ctx.clock.today) return;
      ctx.state.sent[key] = ctx.clock.today;
      const msg = SCHEDULED[kind](person, data, ctx.clock);
      if (msg) outbox.push({ people: [person], msg: msg });
    });
    if (!inQuiet_(prefs.quiet, ctx.clock.min)) outbox = outbox.concat(flushQueue_(ctx, person));
  });
  outbox = outbox.concat(mealsReady_(ctx, data));
  ctx.state.lastTick = ctx.clock.ms;
  saveState_(ctx.state);
  return outbox;
}

/**
 * One alert when the week's dinners are planned: every day has a dinner, the
 * plan differs from the last one announced, and nobody has changed it for
 * MEALS_SETTLE_MIN minutes. Catches edits made straight in the Sheet too.
 */
function mealsReady_(ctx, data) {
  const plan = mealPlan_(data.meals);
  const m = ctx.state.meals;
  if (!m) {
    ctx.state.meals = { plan: plan, announced: plan, since: ctx.clock.ms, editors: [] };
    return [];
  }
  // Hub saves update m.plan themselves, so a change noticed here came from the
  // Sheet: its editor is unknown, and nobody is left out of the alert.
  if (plan !== m.plan) { m.plan = plan; m.since = ctx.clock.ms; m.editors = []; }
  if (plan === m.announced) { m.editors = []; return []; }
  const dinners = JSON.parse(plan);
  if (dinners.some(function (d) { return !d; })) return [];
  if (ctx.clock.ms - m.since < MEALS_SETTLE_MIN * 60000) return [];

  const editors = m.editors || [];
  m.announced = plan;
  m.editors = [];
  const who = editors.length === 1 ? editors[0] : '';
  return route_(ctx, ctx.people.filter(function (p) { return editors.indexOf(p) < 0; }), 'meals', {
    title: who ? who + ' planned the week\'s dinners' : 'The week\'s dinners are planned',
    body: DAYS.map(function (d, i) { return d + '  ' + clip_(mealName_(dinners[i]), 40); }).join('\n'),
    tag: 'meals', view: 'meals',
  });
}

// ---------- messages ----------

function summaryMsg_(person, data, clock) {
  const open = data.tasks.filter(function (t) {
    return !t.completed && (t.recurrence === 'daily' || t.recurrence === 'once');
  });
  const mine = open.filter(function (t) { return t.assignee === person; });
  const family = open.filter(function (t) { return t.assignee === 'Family' || !t.assignee; });
  const kids = PARENTS.indexOf(person) >= 0
    ? open.filter(function (t) { return KIDS.indexOf(t.assignee) >= 0; }) : [];
  const events = data.events.filter(function (e) { return e.date === clock.today; });
  const dinner = (data.meals[clock.day] || {}).meal;

  const lines = [
    'Dinner: ' + (dinner ? clip_(mealName_(dinner), 40) : 'not planned yet'),
    'Calendar: ' + (events.length
      ? list_(events.map(function (e) { return (e.allDay ? '' : e.start + ' ') + e.title; }))
      : 'nothing today'),
  ];
  if (mine.length) lines.push('Yours: ' + list_(mine.map(function (t) { return t.title; })));
  if (kids.length) lines.push('Kids: ' + list_(kids.map(function (t) { return t.title + ' (' + t.assignee + ')'; })));
  if (family.length) lines.push('Family: ' + list_(family.map(function (t) { return t.title; })));
  if (!mine.length && !kids.length && !family.length) lines.push('No to-dos today.');
  return { title: 'Today · ' + clock.label, body: lines.join('\n'), tag: 'summary', view: 'today' };
}

function dinnerMsg_(person, data, clock) {
  if ((data.meals[clock.day] || {}).meal) return null;
  return {
    title: 'Dinner isn\'t planned yet',
    body: 'Nothing\'s on the plan for tonight. Tap to fill it in.',
    tag: 'dinner', view: 'meals',
  };
}

function checkinMsg_(type, data, clock) {
  const monday = periodKey_('weekly', new Date(clock.ms)).slice(1);
  const done = data.checkins.some(function (c) { return c.type === type && c.date >= monday; });
  if (done) return null;
  return type === 'huddle'
    ? { title: 'Family Huddle', body: 'Rose/Thorn/Bud, the week ahead, chores, the fun pick, gratitude. Tap to open it.',
        tag: 'huddle', view: 'checkins', checkin: 'huddle' }
    : { title: 'Weekly Check-In', body: 'The seven questions, then the week\'s logistics. Tap to open them.',
        tag: 'couples', view: 'checkins', checkin: 'couples' };
}

// ---------- routing, quiet hours, delivery ----------

/** Everything the timer and the Hub actions need to decide who gets what. */
function context_(now) {
  const stored = storedPrefs_();
  const people = [];
  rows_('Devices').forEach(function (d) { if (people.indexOf(d.person) < 0) people.push(d.person); });
  return {
    clock: clock_(now),
    state: loadState_(),
    people: people, // only people with a phone signed up
    prefs: function (person) { return prefsFor_(person, stored); },
  };
}

/** Send now, or hold until the person's quiet hours end. */
function route_(ctx, people, kind, msg) {
  const now = [];
  people.forEach(function (person) {
    if (ctx.people.indexOf(person) < 0) return;
    const prefs = ctx.prefs(person);
    if (!prefs[kind].on) return;
    if (inQuiet_(prefs.quiet, ctx.clock.min)) {
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
function flushQueue_(ctx, person) {
  const q = ctx.state.queue[person];
  if (!q || !q.length) return [];
  delete ctx.state.queue[person];
  const out = [];
  const tasks = q.filter(function (x) { return x.kind === 'assigned'; });
  if (tasks.length === 1) out.push(tasks[0].msg);
  if (tasks.length > 1) {
    out.push({
      title: tasks.length + ' new to-dos',
      body: tasks.map(function (t) { return t.msg.body; }).join('\n'),
      tag: 'tasks-held', view: 'tasks',
    });
  }
  const meals = q.filter(function (x) { return x.kind === 'meals'; }).pop();
  if (meals) out.push(meals.msg);
  return out.map(function (msg) { return { people: [person], msg: msg }; });
}

function inQuiet_(quiet, min) {
  if (!quiet.on) return false;
  const from = minutes_(quiet.from), to = minutes_(quiet.to);
  if (from === to) return false;
  return from < to ? (min >= from && min < to) : (min >= from || min < to);
}

/** Sends each outbox item to every phone its people have signed up. */
function deliver_(outbox) {
  const result = { delivered: 0, failed: 0 };
  if (!outbox.length) return result;
  try {
    const url = prop_('PUSH_WORKER_URL'), secret = prop_('PUSH_SECRET');
    if (!url || !secret) { result.error = 'not_configured'; return result; }
    const devices = rows_('Devices');
    const gone = [];
    outbox.forEach(function (item) {
      const subs = [];
      devices.forEach(function (d) {
        if (item.people.indexOf(d.person) < 0) return;
        try { subs.push(JSON.parse(d.subscription)); } catch (err) {}
      });
      if (!subs.length) return;
      const res = relay_(url, secret, { subscriptions: subs, notification: item.msg });
      if (!res.ok) { result.failed += subs.length; result.error = res.error; return; }
      res.results.forEach(function (r) {
        if (r.status >= 200 && r.status < 300) { result.delivered++; return; }
        result.failed++;
        // 404/410: the phone dropped this subscription, so stop sending to it.
        if (r.status === 404 || r.status === 410) gone.push(r.endpoint);
        else result.error = 'push_' + r.status + (r.error ? ': ' + r.error : '');
      });
    });
    if (gone.length) {
      const lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try {
        removeRowsWhere_('Devices', function (r) { return gone.indexOf(String(r[0])) >= 0; });
      } finally {
        lock.releaseLock();
      }
    }
  } catch (err) {
    result.error = String(err);
  }
  if (result.error) console.warn('deliver_: ' + result.error);
  return result;
}

function relay_(url, secret, body) {
  try {
    const res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/send', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + secret },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      let why = '';
      try { why = JSON.parse(res.getContentText()).error || ''; } catch (err) {}
      return { ok: false, error: 'relay_' + res.getResponseCode() + (why ? ' ' + why : '') };
    }
    return { ok: true, results: JSON.parse(res.getContentText()).results || [] };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------- preferences & state ----------

function storedPrefs_() {
  const out = {};
  rows_('NotifyPrefs').forEach(function (r) {
    try { out[r.person] = JSON.parse(r.prefs); } catch (err) {}
  });
  return out;
}

function prefsFor_(person, stored) {
  return cleanPrefs_(stored[person]);
}

/** Fills gaps from DEFAULT_PREFS and drops anything malformed. */
function cleanPrefs_(input) {
  input = input || {};
  const out = {};
  Object.keys(DEFAULT_PREFS).forEach(function (kind) {
    const def = DEFAULT_PREFS[kind], got = input[kind] || {}, p = {};
    Object.keys(def).forEach(function (field) {
      const v = got[field];
      if (field === 'on') p.on = typeof v === 'boolean' ? v : def.on;
      else if (field === 'day') p.day = DAYS.indexOf(v) >= 0 ? v : def.day;
      else p[field] = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : def[field];
    });
    out[kind] = p;
  });
  return out;
}

// Bookkeeping (what's been sent, what's held for quiet hours, the meal plan
// last announced) lives in the NOTIFY_STATE Script Property.
function loadState_() {
  let s = {};
  try { s = JSON.parse(prop_('NOTIFY_STATE') || '{}'); } catch (err) {}
  s.sent = s.sent || {};
  s.queue = s.queue || {};
  return s;
}

function saveState_(s) {
  PropertiesService.getScriptProperties().setProperty('NOTIFY_STATE', JSON.stringify(s));
}

// ---------- small helpers ----------

function clock_(now) {
  const tz = Session.getScriptTimeZone();
  const f = function (pattern) { return Utilities.formatDate(now, tz, pattern); };
  return {
    ms: now.getTime(),
    today: f('yyyy-MM-dd'),
    day: DAYS[Number(f('u')) - 1], // u: 1 = Monday … 7 = Sunday
    min: Number(f('H')) * 60 + Number(f('m')),
    label: f('EEEE, MMM d'),
  };
}

/** Reads each kind of data at most once per run, and only if a message needs it. */
function lazyData_() {
  const cache = {};
  const load = function (key, fn) {
    if (!(key in cache)) cache[key] = fn();
    return cache[key];
  };
  return {
    get tasks() { return load('tasks', getTasks_); },
    get meals() { return load('meals', getMeals_); },
    get events() { return load('events', getEvents_); },
    get checkins() { return load('checkins', function () { return getCheckins_(10); }); },
  };
}

/** A dinner as it reads in a notification: recipe links dropped. */
function mealName_(text) {
  const name = String(text || '').replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:|,(]+|[\s\-–—:|,(]+$/g, '');
  return name || (text ? 'recipe link' : '');
}

function mealPlan_(meals) {
  return JSON.stringify(DAYS.map(function (d) { return String((meals[d] || {}).meal || '').trim(); }));
}

function isPerson_(p) {
  return PARENTS.indexOf(p) >= 0 || KIDS.indexOf(p) >= 0;
}

function minutes_(hhmm) {
  const parts = String(hhmm).split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function clip_(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function list_(items) {
  const shown = items.slice(0, 3).map(function (s) { return clip_(s, 40); }).join(', ');
  return items.length > 3 ? shown + ' +' + (items.length - 3) + ' more' : shown;
}
