/**
 * HARPER FAMILY HUB — handing over to the Worker
 *
 * The Hub's backend is moving from this script to the Cloudflare Worker in
 * worker/. This file is what the Worker uses to take over, and nothing else
 * calls it:
 *
 *   GET  ?action=export   everything the Worker needs to carry on from here:
 *                         every tab's rows as plain text, this script's own
 *                         bookkeeping, and the calendar's events
 *   GET  ?action=events   the calendar's events only (the calendar stays here)
 *   POST action=handover  on: this script stops. The Hub's requests are
 *                         refused with "moved" (a phone still using the PIN is
 *                         told to sign in), check-ins stop going to Notion from
 *                         here, and the timers are removed.
 *                         off: all of that is put back.
 *
 * Both need the family PIN, like every other request.
 * SETUP: add this file (+ → Script, named Handover), replace Code.gs with the
 * repo's copy, and publish a new version. Nothing changes until the Worker asks.
 */

const HANDOVER_TIMERS_ = { notifyTick: 5, syncTodoist: 10, syncNotionMeals: 10, syncNotionCheckins: 30 };

function exportAll_() {
  const tz = Session.getScriptTimeZone();
  const text = function (v) {
    if (v instanceof Date) return v.toISOString();
    return v == null ? '' : String(v);
  };
  const tasks = rows_('Tasks');
  const byId = {};
  tasks.forEach(function (t) { byId[String(t.id)] = t; });
  // A period key the Sheet turned into a date cell: "2026-09" (monthly) and "2026-09-26"
  // (daily, or a repeating task's turn) both became dates. Which it was depends on the task.
  const monthly = function (t) { return !!t && t.recurrence === 'monthly' && !parseRepeat_(t.repeat); };
  const key = function (c) {
    if (!(c.periodKey instanceof Date)) return String(c.periodKey);
    const t = byId[String(c.taskId)];
    const byMonth = monthly(t) || (!!t && String(t.parentId || '') && !parseRepeat_(t.repeat) && monthly(byId[String(t.parentId)]));
    return Utilities.formatDate(c.periodKey, tz, byMonth ? 'yyyy-MM' : 'yyyy-MM-dd');
  };
  const props = PropertiesService.getScriptProperties().getProperties();
  const meta = loadMetaIfAny_();
  const out = {
    ok: true,
    exportedAt: new Date().toISOString(),
    handedOver: handedOver_(),
    tabs: {
      Tasks: tasks.map(function (t) {
        return {
          id: String(t.id), title: text(t.title), recurrence: text(t.recurrence), assignee: text(t.assignee),
          createdAt: text(t.createdAt), due: dateStr_(t.due), repeat: text(t.repeat),
          lastDone: dateStr_(t.lastDone), prevDue: dateStr_(t.prevDue), time: timeStr_(t.time),
          parentId: String(t.parentId || ''), sort: sortNum_(t.sort) == null ? '' : sortNum_(t.sort),
        };
      }),
      Completions: rows_('Completions').map(function (c) {
        return { taskId: String(c.taskId), periodKey: key(c), completedBy: c.completedBy === true ? '' : text(c.completedBy), timestamp: text(c.timestamp) };
      }),
      Meals: rows_('Meals').map(function (r) { return { day: text(r.day), meal: text(r.meal), note: text(r.note) }; }),
      CheckIns: rows_('CheckIns').map(function (r) {
        return {
          id: String(r.id), date: r.date instanceof Date ? Utilities.formatDate(r.date, tz, 'yyyy-MM-dd') : String(r.date),
          type: text(r.type), answersJson: text(r.answersJson),
        };
      }),
      Devices: rows_('Devices').map(function (r) {
        return { endpoint: text(r.endpoint), person: text(r.person), subscription: text(r.subscription), addedAt: text(r.addedAt) };
      }),
      NotifyPrefs: rows_('NotifyPrefs').map(function (r) {
        return { person: text(r.person), prefs: text(r.prefs), updatedAt: text(r.updatedAt) };
      }),
    },
    props: {
      NOTIFY_STATE: props.NOTIFY_STATE || '',
      NOTION_MEALS_STATE: props.NOTION_MEALS_STATE || '',
      TODOIST_TICKS: props.TODOIST_TICKS || '',
    },
    // What the Hub is sent today, for the Worker to check its own answers against.
    all: {
      tasks: getTasks_(), meals: getMeals_(), checkins: getCheckins_(10), groceries: getGroceries_(),
      mealsFrom: typeof notionMealsInfo_ === 'function' ? notionMealsInfo_() : null,
    },
    events: getEvents_(),
    // Which of the settings the Worker needs its own copy of are set here (names only, never values).
    has: ['TODOIST_TOKEN', 'NOTION_TOKEN', 'NOTION_MEALS_SOURCE', 'NOTION_CHECKINS_SOURCE', 'NOTION_CHECKINS_SOURCE_OFF', 'REMINDERS_HIDE_LISTS']
      .filter(function (k) { return !!props[k]; }),
    timers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }),
  };
  // Jon's Todoist tasks, minus the hidden projects: those never leave this script.
  if (meta && meta.syncedAt && typeof visibleItems_ === 'function') {
    out.props.TODOIST_ITEMS = JSON.stringify(visibleItems_(meta));
    out.props.TODOIST_META = JSON.stringify({ syncedAt: meta.syncedAt, attemptedAt: meta.attemptedAt || meta.syncedAt, error: meta.error || '', count: meta.count || 0 });
    try { out.all.reminders = getReminders_(true); } catch (err) {}
  }
  return out;
}

function loadMetaIfAny_() {
  return typeof loadMeta_ === 'function' ? loadMeta_() : null;
}

/** on: stop, and say what was stopped. off: start again. */
function handover_(on) {
  const props = PropertiesService.getScriptProperties();
  const report = { ok: true, handedOver: !!on, timers: [], notes: [] };
  if (on) {
    props.setProperty('HANDED_OVER', '1');
    // Check-ins made after today exist only in the Worker. Left running, the copy to Notion
    // here would see their pages as belonging to deleted check-ins and trash them.
    const src = props.getProperty('NOTION_CHECKINS_SOURCE');
    if (src) { props.setProperty('NOTION_CHECKINS_SOURCE_OFF', src); props.deleteProperty('NOTION_CHECKINS_SOURCE'); }
  } else {
    props.deleteProperty('HANDED_OVER');
    const src = props.getProperty('NOTION_CHECKINS_SOURCE_OFF');
    if (src) { props.setProperty('NOTION_CHECKINS_SOURCE', src); props.deleteProperty('NOTION_CHECKINS_SOURCE_OFF'); }
  }
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() in HANDOVER_TIMERS_) ScriptApp.deleteTrigger(t);
    });
    if (!on) {
      Object.keys(HANDOVER_TIMERS_).forEach(function (fn) {
        if (typeof globalThis[fn] !== 'function') return;
        if (fn === 'syncTodoist' && !prop_('TODOIST_TOKEN')) return;
        if (fn === 'syncNotionMeals' && !(prop_('NOTION_TOKEN') && prop_('NOTION_MEALS_SOURCE'))) return;
        if (fn === 'syncNotionCheckins' && !(prop_('NOTION_TOKEN') && prop_('NOTION_CHECKINS_SOURCE'))) return;
        ScriptApp.newTrigger(fn).timeBased().everyMinutes(HANDOVER_TIMERS_[fn]).create();
      });
    }
  } catch (err) {
    // The Worker's push relay refuses this script's notifications once it has taken over,
    // so a timer left behind can't send anything; it is only wasted effort.
    report.notes.push('timers not changed: ' + String(err && err.message || err).slice(0, 150));
  }
  try { report.timers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }); } catch (err) {}
  return report;
}
