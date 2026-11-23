/**
 * HARPER FAMILY HUB — the Hub's requests and the timer
 *
 *   hubGet / hubPost   what the Hub's page asks for and saves (once doGet and
 *                      doPost in apps-script/Code.gs)
 *   tick               every five minutes: what the Apps Script timers did
 *
 * Tasks, dinners, check-ins, phones' notification sign-ups and settings, the
 * notifications themselves, Todoist, both Notion syncs and the calendar all
 * read each other, so they live together here.
 *
 * The Jon & Maggie check-ins and Jon's Todoist tasks go only to a parent's device.
 */

import { transact } from "../store.js";
import { deliver, pushReady } from "../push.js";
import { today } from "./time.js";
import * as core from "./core.js";
import * as notify from "./notify.js";
import * as todoist from "./todoist.js";
import * as notion from "./notion.js";
import * as calendar from "./calendar.js";
import * as recipes from "./recipes.js";

const CORE = ["Tasks", "Completions", "Meals", "CheckIns"];
const ALL = CORE.concat(["Devices", "NotifyPrefs"]);
const EVENTS = "EVENTS"; // the calendar's events as Apps Script last sent them, as JSON

/** The moment a request or timer run happens. (TEST_NOW lets a test pick it.) */
export const nowOf = env => (env.TEST_NOW ? new Date(env.TEST_NOW) : new Date());

/** What the rules need to know beyond the rows. */
function attach(c, env) {
  c.events = () => events(c);
  c.remindersLine = day => todoist.remindersLine(c, day);
  c.notionOn = () => notion.notionOn(env);
  return c;
}
function events(c) {
  try { const e = JSON.parse(c.props[EVENTS] || "[]"); return Array.isArray(e) ? e : []; } catch (err) { return []; }
}

/** The last ten check-ins this person may read. */
function checkinsFor(c, session) {
  if (session.parent) return core.getCheckins(c, 10);
  return core.getCheckins(c, Infinity).filter(x => x.type !== "couples").slice(0, 10);
}

// ---------- the Hub's requests ----------

/** GET ?action=all[&reminders=1] or ?action=notify. */
export async function hubGet(env, session, action, wantReminders) {
  const now = nowOf(env);
  if (action === "notify") {
    return transact(env, ["Devices", "NotifyPrefs"], c => notify.notifyInfo(c, { publicKey: String(env.VAPID_PUBLIC_KEY || "").trim(), ready: pushReady(env) }), { now });
  }
  // Jon's Todoist tasks go only to a parent's device that asks for them.
  const reminders = wantReminders && session.parent;
  if (reminders && todoist.todoistOn(env)) {
    // Behind, and nothing has tried lately: read Todoist now, as Todoist.gs did.
    const meta = await transact(env, [], c => c.props.TODOIST_META, { now });
    if (todoist.todoistBehind(meta, now.getTime())) await syncTodoist(env);
  }
  return transact(env, CORE, c => {
    attach(c, env);
    const out = {
      ok: true,
      now: c.now.toISOString(),
      tasks: core.getTasks(c),
      meals: core.getMeals(c),
      mealsFrom: notion.notionMealsInfo(c, env), // set when the dinners come from Notion; the Hub then shows them read-only
      events: events(c),
      checkins: checkinsFor(c, session),
    };
    if (reminders) {
      try { out.reminders = todoist.getReminders(c); } catch (err) { out.reminders = { status: "error", error: "backend error", items: [], lists: [] }; }
    }
    return out;
  }, { now });
}

/** POST { action, … }. `wait` keeps the Worker alive for work that outlasts the answer (ctx.waitUntil). */
export async function hubPost(env, session, body, wait) {
  const by = session.person, now = nowOf(env);
  const done = await transact(env, ALL, c => {
    attach(c, env);
    let outbox = [], reply = null; // notification settings actions answer with their own payload
    switch (body.action) {
      case "addTask":       outbox = notify.taskAdded(c, core.addTask(c, body), by); break;
      case "updateTask":    core.updateTask(c, body); break;
      case "deleteTask":    core.deleteTask(c, body.id); break;
      case "toggleTask":    core.toggleTask(c, body.id, by); break;
      case "saveMeals":     core.saveMeals(c, body.meals); notify.mealsEdited(c, body.meals, by); break;
      case "saveCheckin":
        if (body.type === "couples" && !session.parent) reply = { ok: false, error: "parents_only" };
        else core.saveCheckin(c, body.type, body.answers);
        break;
      case "deleteCheckin": {
        const row = c.tabs.CheckIns.filter(r => String(r.id) === String(body.id))[0];
        if (row && row.type === "couples" && !session.parent) reply = { ok: false, error: "parents_only" };
        else core.deleteCheckin(c, body.id);
        break;
      }
      case "pushSubscribe":   reply = notify.pushSubscribe(c, by, body.subscription); break;
      case "pushUnsubscribe": reply = notify.pushUnsubscribe(c, body.endpoint); break;
      case "savePrefs":       reply = notify.savePrefs(c, by, body.prefs); break;
      case "pushTest":        outbox = [notify.testMessage(by)]; reply = { ok: true }; break;
      case "tickReminder":
        if (session.parent) todoist.tickReminder(c, body.key, body.on === true, by);
        reply = { ok: true };
        break;
      default: return { reply: { ok: false, error: "unknown_action" }, outbox: [], devices: [], unknown: true };
    }
    // The fresh state, so the Hub can re-render in one round trip.
    const state = reply ? null : { ok: true, tasks: core.getTasks(c), meals: core.getMeals(c), checkins: checkinsFor(c, session) };
    return { reply, state, outbox, devices: c.tabs.Devices.map(d => ({ person: d.person, subscription: d.subscription })) };
  }, { now });

  if (done.unknown) return done.reply;
  if (done.reply) {
    // The Hub shows how a test went, so that one is waited for.
    const sent = await send(env, done.outbox, done.devices);
    return Object.assign(done.reply, { sent });
  }
  if (done.outbox.length) wait(send(env, done.outbox, done.devices)); // the save doesn't wait for the phones
  return done.state;
}

/** Delivers an outbox, and forgets the phones that have dropped their subscription. */
async function send(env, outbox, devices) {
  const res = await deliver(env, outbox, devices);
  if (res.gone.length) {
    await transact(env, ["Devices"], c => {
      for (let i = c.tabs.Devices.length - 1; i >= 0; i--) {
        if (res.gone.indexOf(String(c.tabs.Devices[i].endpoint)) >= 0) c.tabs.Devices.splice(i, 1);
      }
    });
  }
  const out = { delivered: res.delivered, failed: res.failed };
  if (res.error) out.error = res.error;
  return out;
}

// ---------- the timer ----------

/**
 * Every five minutes. Each job stands alone: one failing doesn't stop the rest,
 * and the notifications always run last, on what the others brought in.
 *   every run        the calendar's events, then what's due to be sent
 *   once a day       old ticks set aside
 *   every 10 min     Todoist; the Notion dinners (on the other five minutes)
 *   every 30 min     check-ins to Notion
 *   every run        recipes: the list every 6 hours, and a few recipe pages each run (recipes.js)
 */
export async function tick(env) {
  const now = nowOf(env), minute = now.getUTCMinutes(), report = {};
  const job = async (name, due, work) => {
    if (!due) return;
    try { report[name] = (await work()) || "ok"; } catch (err) { report[name] = "failed: " + String(err && err.message || err).slice(0, 120); }
  };
  await job("events", true, () => syncEvents(env));
  await job("todoist", todoist.todoistOn(env) && minute % 10 < 5, () => syncTodoist(env));
  await job("dinners", notion.notionOn(env) && minute % 10 >= 5, () => syncNotionMeals(env));
  await job("checkins", notion.notionCheckinsOn(env) && minute % 30 >= 15 && minute % 30 < 20, async () => {
    const all = await transact(env, ["CheckIns"], c => core.getCheckins(c, Infinity).reverse()); // oldest first
    const r = await notion.syncNotionCheckins(env, all);
    return r.status + " — " + r.message;
  });
  await job("recipes", notion.notionOn(env), () => recipes.syncRecipes(env, now));
  await job("old ticks", now.getUTCHours() === 9 && minute < 5, () => setAsideOldTicks(env, now));
  await job("notify", true, async () => {
    const due = await transact(env, ALL, c => {
      attach(c, env);
      return { outbox: notify.dueNotifications(c), devices: c.tabs.Devices.map(d => ({ person: d.person, subscription: d.subscription })) };
    }, { now });
    const sent = await send(env, due.outbox, due.devices);
    return due.outbox.length ? JSON.stringify(sent) : "nothing due";
  });
  const failed = Object.keys(report).filter(k => /^failed|^error/.test(report[k]));
  if (failed.length) console.warn("tick: " + failed.map(k => k + " " + report[k]).join("; "));
  return report;
}

/** Reads the family's Google calendars and keeps the events here, so no request waits on Google. */
async function syncEvents(env) {
  const now = nowOf(env);
  const had = await transact(env, [], c => ({ grant: c.props.GOOGLE_CALENDAR, cache: calendar.loadCache(c.props) }), { now });
  if (!had.grant) throw new Error("the calendar isn't connected: a parent connects it in the Hub's Settings");
  let read;
  try { read = await calendar.readCalendars(env, had.grant, had.cache, now); }
  catch (err) {
    const why = String(err && err.message || err).slice(0, 150);
    await transact(env, [], c => calendar.failed(c, why), { now }); // the events last read stay on show
    throw new Error(why);
  }
  const text = JSON.stringify(calendar.merged(read.byCalendar));
  await transact(env, [], c => { calendar.keep(c, read); if (c.props[EVENTS] !== text) c.props[EVENTS] = text; }, { now });
  const errors = Object.keys(read.errors).map(k => k + ": " + read.errors[k]).join("; ");
  return errors ? "partly: " + errors : "ok";
}

/** Once a day: ticks whose day, week or month is over leave the rows every request loads. None are dropped. */
async function setAsideOldTicks(env, now) {
  const OLD = "hub_completions_old";
  const stale = await transact(env, ["Completions"], c => core.staleCompletions(c), { now });
  if (!stale.length) return "none";
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ${OLD} ("taskId", "periodKey", "completedBy", "timestamp")`).run();
  for (let i = 0; i < stale.length; i += 100) {
    await env.DB.batch(stale.slice(i, i + 100).map(r => env.DB.prepare(`INSERT INTO ${OLD} VALUES (?, ?, ?, ?)`).bind(r.taskId, r.periodKey, r.completedBy, r.timestamp)));
  }
  const gone = new Set(stale.map(r => JSON.stringify(r)));
  await transact(env, ["Completions"], c => {
    for (let i = c.tabs.Completions.length - 1; i >= 0; i--) if (gone.has(JSON.stringify(c.tabs.Completions[i]))) c.tabs.Completions.splice(i, 1);
  }, { now });
  return stale.length + " set aside";
}

/** Reads Todoist and keeps the result, or notes the failure and keeps the last good copy. Never throws. */
export async function syncTodoist(env) {
  const now = nowOf(env);
  try {
    const items = await todoist.fetchTodoist(env);
    await transact(env, [], c => todoist.storeTodoist(c, items), { now });
    return "updated (" + items.length + " open tasks)";
  } catch (err) {
    const message = String(err && err.message || err).slice(0, 200); // our own error text, never task data
    await transact(env, [], c => todoist.todoistFailed(c, message), { now });
    return "error — " + message;
  }
}

/** Reads this plan week's dinners from Notion into the Hub's meals. Never throws. */
export async function syncNotionMeals(env) {
  const now = nowOf(env), week = notion.weekStart(today(now));
  try {
    const recipes = await transact(env, [], c => notion.loadRecipes(c), { now });
    const dinners = await notion.fetchDinners(env, week, recipes, now.getTime());
    const meals = notion.weekOfDinners(dinners, week);
    // Notion is read first; the save is only the last, quick step.
    return await transact(env, ["Meals"], c => {
      const changed = !notion.sameMeals(core.getMeals(c), meals);
      if (changed) core.saveMeals(c, meals);
      notion.saveRecipes(c, recipes);
      notion.notionMealsDone(c, week, notion.weekOfRecipes(dinners, week));
      return changed ? "updated" : "current";
    }, { now });
  } catch (err) {
    const message = String(err && err.message || err).slice(0, 200);
    await transact(env, [], c => notion.notionMealsFailed(c, message), { now });
    return "error — " + message;
  }
}

