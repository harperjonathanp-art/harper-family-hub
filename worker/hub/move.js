/**
 * HARPER FAMILY HUB — moving out of the Sheet
 *
 * How the core (tasks, dinners, check-ins, notifications, Todoist, Notion)
 * gets from Apps Script into the Worker without anyone noticing.
 *
 *   While moved.js says "shadow"   every 15 minutes the Worker takes a fresh
 *       copy of everything from Apps Script (apps-script/Handover.gs), works
 *       out what it would send the Hub from that copy, and compares it with
 *       what Apps Script sends. The result is kept (SHADOW, below). Nobody is
 *       served from the copy.
 *   When moved.js says "core"      the first request or timer run tells Apps
 *       Script to stop, takes one last copy, and from then on the Worker is
 *       the Hub's backend. That happens once (CUTOVER_AT).
 *
 * To undo a move after the fact: take "core" out of moved.js, and in the Apps
 * Script editor run handover_(false). The Sheet then stands as it was at the
 * move; what was done since stays in the Worker's database, unseen.
 */

import { transact, TABS, ready } from "../store.js";
import { appsScript } from "../appsscript.js";
import * as core from "./core.js";
import * as todoist from "./todoist.js";
import * as notion from "./notion.js";
import { today } from "./time.js";
import { groceriesCopied, copyGroceries } from "../groceries.js";

const ALL = Object.keys(TABS);
const KEPT_PROPS = ["NOTIFY_STATE", "NOTION_MEALS_STATE", "TODOIST_TICKS", "TODOIST_ITEMS", "TODOIST_META"];
const SECRETS = ["TODOIST_TOKEN", "NOTION_TOKEN", "NOTION_MEALS_SOURCE", "NOTION_CHECKINS_SOURCE"];
const OLD = "hub_completions_old"; // ticks for periods that are over: kept, never loaded

/** Apps Script's export, checked for shape. Throws a short reason if it isn't one. */
async function fetchExport(env) {
  const up = await appsScript(env, { action: "export" });
  if (up.error) throw new Error(up.error);
  const x = up.data;
  if (x.ok !== true || !x.tabs || !x.props || !x.all) throw new Error("Apps Script has no export yet: paste Handover.gs and the new Code.gs, and publish");
  ALL.forEach(tab => { if (!Array.isArray(x.tabs[tab])) throw new Error("the export has no " + tab); });
  return x;
}

/** One exported row as the store keeps it: every column, text or a number. */
function rowOf(tab, r) {
  const row = {};
  TABS[tab].forEach(col => { const v = r[col]; row[col] = v == null ? "" : (typeof v === "number" ? v : String(v)); });
  return row;
}

/**
 * Makes the Worker's rows the same as the export's. A tab that hasn't changed
 * since the last copy isn't rewritten. Ticks that can never matter again are
 * left out (and returned). Does nothing once the Worker has taken over.
 */
async function importAll(env, x, now) {
  const tabs = {};
  ALL.forEach(tab => { tabs[tab] = x.tabs[tab].map(r => rowOf(tab, r)); });
  const stale = core.staleCompletions({ tabs, now });
  tabs.Completions = tabs.Completions.filter(r => stale.indexOf(r) < 0);
  const imported = await transact(env, ALL, c => {
    if (c.props.CUTOVER_AT) return false;
    ALL.forEach(tab => {
      if (JSON.stringify(c.tabs[tab]) === JSON.stringify(tabs[tab])) return;
      c.tabs[tab].length = 0;
      tabs[tab].forEach(r => c.tabs[tab].push(Object.assign({}, r)));
    });
    KEPT_PROPS.forEach(key => {
      const v = x.props[key];
      if (v) { if (c.props[key] !== v) c.props[key] = v; } else delete c.props[key];
    });
    const events = JSON.stringify(Array.isArray(x.events) ? x.events : []);
    if (c.props.EVENTS !== events) c.props.EVENTS = events;
    return true;
  }, { now });
  return { imported, stale };
}

const sorted = v => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));
const same = (a, b) => sorted(a) === sorted(b);

/**
 * What the Worker would send the Hub from its copy, against what Apps Script
 * sends. Counts and ids only: nothing of what the tasks or answers say is kept.
 */
function compare(c, env, theirs) {
  const text = t => Object.assign({}, t, { title: String(t.title), assignee: String(t.assignee == null ? "" : t.assignee), badRepeat: t.badRepeat || undefined });
  const mine = core.getTasks(c), diff = { tasks: 0, meals: 0, checkins: 0, reminders: 0 }, sample = [];
  const n = Math.max(mine.length, (theirs.tasks || []).length);
  for (let i = 0; i < n; i++) {
    const a = mine[i] && text(mine[i]), b = theirs.tasks[i] && text(theirs.tasks[i]);
    if (a && b && same(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))) continue;
    diff.tasks++;
    if (sample.length < 5) sample.push({ id: (a || b).id, fields: a && b ? Object.keys(Object.assign({}, a, b)).filter(k => !same(a[k] === undefined ? null : a[k], b[k] === undefined ? null : b[k])) : [a ? "only in the Worker" : "only in Apps Script"] });
  }
  if (!same(core.getMeals(c), theirs.meals)) diff.meals++;
  if (!same(core.getCheckins(c, 10), theirs.checkins)) diff.checkins++;
  if (theirs.reminders) {
    const keys = r => (r.items || []).map(i => [i.key, i.title, i.due, i.time, !!i.ticked]);
    if (!same(keys(todoist.getReminders(c)), keys(theirs.reminders))) diff.reminders++;
  }
  return { diff, sample };
}

/**
 * Whether the Worker itself can read Todoist and Notion with the settings it was
 * given, and whether it reads what Apps Script read. Only reads; nothing is kept
 * but counts. Apps Script's copy can be a few minutes old, so "same" is a guide.
 */
async function tryTheSites(env, x, now) {
  const live = { at: now.toISOString() };
  const tryIt = async (name, on, work) => {
    if (!on) return;
    try { live[name] = Object.assign({ ok: true }, await work()); } catch (err) { live[name] = { ok: false, error: String(err && err.message || err).slice(0, 150) }; }
  };
  await tryIt("todoist", todoist.todoistOn(env), async () => {
    const mine = await todoist.fetchTodoist(env), keys = list => list.map(r => [r.key, r.due, r.time]);
    let theirs = []; try { theirs = JSON.parse(x.props.TODOIST_ITEMS || "[]"); } catch (err) {}
    return { tasks: mine.length, sameAsAppsScript: same(keys(mine), keys(theirs)) };
  });
  await tryIt("dinners", notion.notionOn(env), async () => {
    const week = notion.weekStart(today(now));
    const meals = notion.weekOfDinners(await notion.fetchDinners(env, week, {}, now.getTime()), week);
    return { week, planned: Object.keys(meals).filter(d => meals[d].meal).length, sameAsAppsScript: notion.sameMeals(meals, x.all.meals || {}) };
  });
  await tryIt("checkins", notion.notionCheckinsOn(env), async () => ({ pagesInNotion: await notion.countCheckinPages(env), checkinsInHub: x.tabs.CheckIns.length }));
  return live;
}

/** One shadow run. Never throws: what went wrong is part of what's recorded. */
export async function shadowRun(env, now) {
  const result = { at: now.toISOString(), ok: false };
  try {
    const x = await fetchExport(env);
    const at = new Date(x.exportedAt); // compare as of the moment Apps Script answered
    const { stale } = await importAll(env, x, at);
    const found = await transact(env, ALL, c => compare(c, env, x.all), { now: at });
    result.rows = {}; ALL.forEach(tab => { result.rows[tab] = x.tabs[tab].length; });
    result.oldTicksSetAside = stale.length;
    result.differences = found.diff;
    if (found.sample.length) result.sample = found.sample;
    // What the Worker must be given before it can take over what Apps Script does today.
    result.missing = SECRETS.filter(k => (x.has || []).indexOf(k) >= 0 && !String(env[k] || "").trim());
    result.timers = x.timers || [];
    result.ok = Object.keys(found.diff).every(k => found.diff[k] === 0);
    if (now.getUTCMinutes() < 5) result.live = await tryTheSites(env, x, now); // once an hour
  } catch (err) {
    result.error = String(err && err.message || err).slice(0, 200);
  }
  await transact(env, [], c => {
    const before = JSON.parse(c.props.SHADOW || "{}");
    if (!result.live && before.live) result.live = before.live; // the last hourly try stays on show
    result.runs = (before.runs || 0) + 1;
    result.cleanRuns = result.ok ? (before.cleanRuns || 0) + 1 : 0; // in a row
    c.props.SHADOW = JSON.stringify(result);
  });
  return result;
}

let cutOver = false; // remembered while this copy of the Worker lives

/**
 * Before the first answer with "core" moved: Apps Script is told to stop, then
 * one last copy is taken. Throws (and changes nothing) if Apps Script can't be
 * told, so the Hub is never served from a copy that is still being written to
 * elsewhere.
 */
export async function ensureCutover(env, now) {
  if (cutOver) return;
  await ready(env);
  if (await env.DB.prepare("SELECT 1 AS x FROM props WHERE key = 'CUTOVER_AT'").first()) { cutOver = true; return; }
  const hand = await appsScript(env, null, { action: "handover", on: true });
  if (hand.error || hand.data.ok !== true || hand.data.handedOver !== true) {
    throw new Error("Apps Script couldn't be told to stop (" + (hand.error || hand.data.error || "no answer") + ")");
  }
  const x = await fetchExport(env);
  const { imported, stale } = await importAll(env, x, now);
  // The grocery list moved earlier and is normally here already; if not, this is the last chance to fetch it.
  if (!(await groceriesCopied(env))) await copyGroceries(env, x.all.groceries);
  if (imported && stale.length) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ${OLD} ("taskId", "periodKey", "completedBy", "timestamp")`).run();
    for (let i = 0; i < stale.length; i += 100) {
      await env.DB.batch(stale.slice(i, i + 100).map(r => env.DB.prepare(`INSERT INTO ${OLD} VALUES (?, ?, ?, ?)`).bind(r.taskId, r.periodKey, r.completedBy, r.timestamp)));
    }
  }
  await transact(env, [], c => { if (!c.props.CUTOVER_AT) c.props.CUTOVER_AT = now.toISOString(); });
  cutOver = true;
}

/** Once a day: ticks whose day, week or month is over leave the rows every request loads. */
export async function setAsideOldTicks(env, now) {
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
