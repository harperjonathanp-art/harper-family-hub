/**
 * HARPER FAMILY HUB — Notion: the week's dinners in, check-ins out
 *
 * The same as apps-script/Notion.gs and NotionCheckins.gs.
 *
 *   Dinners   Notion -> Hub, one way. With NOTION_TOKEN and NOTION_MEALS_SOURCE
 *             set, this plan week's Dinner rows (Saturday to Friday) replace the
 *             Hub's meals, and the Hub shows them read-only.
 *   Check-ins Hub -> Notion, one way. With NOTION_CHECKINS_SOURCE set too, each
 *             check-in gets a page in the Weekly Check-Ins database, found again
 *             by its Hub ID property. One deleted in the Hub goes to Notion's trash.
 *
 * The token and the two data source IDs are Worker secrets.
 */

import { isoAdd, ymd, longDate } from "./time.js";
import { DAYS } from "./core.js";

const NOTION_VERSION = "2025-09-03";
const NOTION_WEEK_START = "Sat";        // the plan week runs Saturday to Friday
const RECIPE_CACHE_MS = 6 * 3600 * 1000; // a recipe's link is looked up at most every 6 hours
// The Meal Plan database's property names, as they read in Notion.
const NOTION_PROPS = { date: "Date", meal: "Meal", type: "Meal Type", status: "Status", notes: "Notes", who: "Who Cooks", recipe: "Recipe" };
const NOTION_RECIPE_LINK = "Source"; // the Recipes database's link to the recipe online
// "Who Cooks" as the Hub words it. Anything else (Leftovers, Eating out) is shown as is.
const NOTION_WHO = { Jon: "Jon cooks", Maggie: "Maggie cooks", Together: "Cooking together" };

const STATE = "NOTION_MEALS_STATE"; // { at, error, week }
const RECIPES = "NOTION_RECIPES";   // { recipeId: { link, at } }

export const CHECKINS_PER_RUN = 15; // pages made per run, to stay inside the free plan's 50 outside requests
const CHECKINS_PROPS = { name: "Name", date: "Date", type: "Type", id: "Hub ID" };
const CHECKINS_TYPE = { huddle: "Family Huddle", couples: "Jon & Maggie" };
// The questions as the Hub words them: HUDDLE_FIELDS and COUPLES_QUESTIONS in
// index.html. Change them there and here together.
const CHECKINS_QUESTIONS = {
  huddle: [
    ["rose", "Rose / Thorn / Bud"], ["week", "Week ahead"], ["chores", "Home team check"],
    ["fun", "Fun pick"], ["grat", "Gratitude & prayer"],
  ],
  couples: [
    ["q0", "What are you grateful for and appreciate about me this week?"],
    ["q1", "What brought you joy this week?"],
    ["q2", "What is something that was hard this week?"],
    ["q3", "What is one thing I can do for you this week?"],
    ["q4", "Is there any unconfessed sin, conflict, or hurt that we need to resolve and/or seek forgiveness for?"],
    ["q5", "What is a dream, craving, or desire that has been on the forefront of your mind?"],
    ["q6", "How can I pray for you this week?"],
  ],
};
const TEXT_MAX = 2000; // Notion's limit on one piece of text

const secret = (env, k) => String(env[k] || "").trim();
export function notionOn(env) { return !!(secret(env, "NOTION_TOKEN") && secret(env, "NOTION_MEALS_SOURCE")); }
export function notionCheckinsOn(env) { return !!(secret(env, "NOTION_TOKEN") && secret(env, "NOTION_CHECKINS_SOURCE")); }

const parse = function (text, empty) { try { return JSON.parse(text || "") || empty; } catch (err) { return empty; } };

/** What the Hub needs to know about the dinner sync: null while the Hub plans dinners itself. */
export function notionMealsInfo(c, env) {
  if (!notionOn(env)) return null;
  const s = parse(c.props[STATE], {});
  return { source: "notion", syncedAt: s.at || 0, error: s.error || "", weekStarts: NOTION_WEEK_START };
}

export function notionMealsDone(c, week) { c.props[STATE] = JSON.stringify({ at: c.now.getTime(), error: "", week: week }); }
export function notionMealsFailed(c, message) {
  const s = parse(c.props[STATE], {});
  s.error = String(message).slice(0, 200);
  c.props[STATE] = JSON.stringify(s);
}

async function notion(env, method, path, body) {
  const res = await fetch("https://api.notion.com/v1" + path, {
    method: method,
    headers: Object.assign({ Authorization: "Bearer " + secret(env, "NOTION_TOKEN"), "Notion-Version": NOTION_VERSION },
      body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (err) {}
  // Notion's own error text, e.g. "Could not find data_source…" when it isn't shared with the integration.
  if (res.status !== 200) throw new Error("Notion " + res.status + ": " + (data.message || data.code || "no answer"));
  return data;
}

// ---------- dinners ----------

/**
 * Each date's dinner in the week from `week`: { 'yyyy-MM-dd': { meal, note } }.
 * `recipes` is the saved { id: { link, at } }; links looked up now are added to it.
 */
export async function fetchDinners(env, week, recipes, nowMs) {
  const P = NOTION_PROPS;
  const res = await notion(env, "POST", "/data_sources/" + secret(env, "NOTION_MEALS_SOURCE") + "/query", {
    filter: { and: [
      { property: P.date, date: { on_or_after: week } },
      { property: P.date, date: { on_or_before: isoAdd(week, 6) } },
    ] },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 100,
  });
  const byDate = {};
  for (const page of (res.results || [])) {
    const p = page.properties || {};
    const type = selectName(p[P.type]);
    if (type && type !== "Dinner") continue;             // a row with no Meal Type counts as dinner
    if (selectName(p[P.status]) === "Skipped") continue;
    const date = String((p[P.date] && p[P.date].date && p[P.date].date.start) || "").slice(0, 10);
    if (!date) continue;
    const name = plainText(p[P.meal] && p[P.meal].title);
    const links = [];
    for (const r of ((p[P.recipe] && p[P.recipe].relation) || [])) {
      const link = await recipeLink(env, r.id, recipes, nowMs);
      if (link) links.push(link);
    }
    const who = selectName(p[P.who]);
    const notes = plainText(p[P.notes] && p[P.notes].rich_text);
    const d = byDate[date] || (byDate[date] = { names: [], links: [], notes: [] });
    if (name) d.names.push(name);
    links.forEach(function (u) { if (d.links.indexOf(u) < 0) d.links.push(u); });
    [who ? (NOTION_WHO[who] || who) : "", notes].forEach(function (n) {
      if (n && d.notes.indexOf(n) < 0) d.notes.push(n);
    });
  }
  const out = {};
  Object.keys(byDate).forEach(function (date) {
    const d = byDate[date];
    // Recipe links go after the name, the way they're typed into the Hub: "Pad Thai | https://…".
    const name = d.names.join(" + ");
    out[date] = { meal: [name, d.links.join(" ")].filter(String).join(" | "), note: d.notes.join(" · ") };
  });
  return out;
}

/** A recipe's link online, or its page in Notion. Blank if the integration can't see the Recipes database. */
async function recipeLink(env, id, recipes, nowMs) {
  const hit = recipes[id];
  if (hit && nowMs - hit.at < RECIPE_CACHE_MS) return hit.link;
  let link = "";
  try {
    const page = await notion(env, "GET", "/pages/" + id);
    const src = page.properties && page.properties[NOTION_RECIPE_LINK];
    link = (src && src.url) || page.url || "";
  } catch (err) {
    console.warn("recipeLink: " + String(err && err.message || err).slice(0, 200));
  }
  recipes[id] = { link: link, at: nowMs };
  return link;
}

/** The seven days' meals, filled from the plan week that starts on `week`. */
export function weekOfDinners(dinners, week) {
  const meals = {};
  for (let i = 0; i < 7; i++) {
    const date = isoAdd(week, i);
    const d = dinners[date] || {};
    meals[isoDay(date)] = { meal: d.meal || "", note: d.note || "" };
  }
  return meals;
}

/** The plan week's first day (NOTION_WEEK_START) on or before `iso`. */
export function weekStart(iso) {
  return isoAdd(iso, -((DAYS.indexOf(isoDay(iso)) - DAYS.indexOf(NOTION_WEEK_START) + 7) % 7));
}

function isoDay(iso) { return DAYS[(ymd(iso).getUTCDay() + 6) % 7]; }

export function sameMeals(a, b) {
  return DAYS.every(function (d) {
    const x = a[d] || {}, y = b[d] || {};
    return String(x.meal || "") === String(y.meal || "") && String(x.note || "") === String(y.note || "");
  });
}

export function loadRecipes(c) { return parse(c.props[RECIPES], {}); }
/** Keeps the looked-up recipe links, dropping ones not used for a month. */
export function saveRecipes(c, recipes) {
  const kept = {}, cutoff = c.now.getTime() - 30 * 86400000;
  Object.keys(recipes).forEach(function (id) { if (recipes[id].at >= cutoff) kept[id] = recipes[id]; });
  const text = JSON.stringify(kept);
  if (text !== (c.props[RECIPES] || "{}")) c.props[RECIPES] = text;
}

function plainText(parts) {
  return (parts || []).map(function (t) { return t.plain_text || ""; }).join("").replace(/\s+/g, " ").trim();
}
function selectName(prop) { return (prop && prop.select && prop.select.name) || ""; }

// ---------- check-ins ----------

/**
 * Copies check-ins that have no page yet, and trashes the pages of ones deleted
 * in the Hub. `checkins`: every check-in, oldest first. Never throws.
 */
export async function syncNotionCheckins(env, checkins) {
  try {
    const pages = await checkinPages(env);
    const errors = [];
    let made = 0, trashed = 0, left = 0;
    for (const x of checkins) {
      if (pages[x.id]) continue;
      if (made >= CHECKINS_PER_RUN) { left++; continue; }
      try {
        await notion(env, "POST", "/pages", checkinPage(env, x));
        made++;
        await new Promise(function (r) { setTimeout(r, 350); }); // Notion allows about three requests a second
      } catch (err) {
        errors.push(x.date + " " + x.type + ": " + String(err && err.message || err));
      }
    }
    // No check-ins at all more likely means something is wrong than a cleared list:
    // leave Notion alone rather than trash every page.
    if (checkins.length) {
      const inHub = {};
      checkins.forEach(function (x) { inHub[x.id] = true; });
      for (const id of Object.keys(pages)) {
        if (inHub[id]) continue;
        for (const pageId of pages[id]) {
          if (trashed >= CHECKINS_PER_RUN) break;
          try {
            await notion(env, "PATCH", "/pages/" + pageId, { in_trash: true });
            trashed++;
            await new Promise(function (r) { setTimeout(r, 350); });
          } catch (err) {
            errors.push("trashing " + id + ": " + String(err && err.message || err));
          }
        }
      }
    }
    const counts = made + " copied, " + trashed + " trashed" + (left ? ", " + left + " left for the next run" : "");
    if (errors.length) return { status: "error", message: counts + ". " + errors.join(" / ").slice(0, 300) };
    return { status: made || trashed ? "updated" : "current", message: counts };
  } catch (err) {
    return { status: "error", message: String(err && err.message || err).slice(0, 200) };
  }
}

/** How many check-ins have a page in Notion. Only reads. */
export async function countCheckinPages(env) { return Object.keys(await checkinPages(env)).length; }

/** The pages the Hub has made, by check-in id: { id: [pageId, …] }. */
async function checkinPages(env) {
  const P = CHECKINS_PROPS, byId = {};
  let cursor = null;
  do {
    const body = { filter: { property: P.id, rich_text: { is_not_empty: true } }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notion(env, "POST", "/data_sources/" + secret(env, "NOTION_CHECKINS_SOURCE") + "/query", body);
    (res.results || []).forEach(function (page) {
      const p = page.properties || {};
      const id = plainText(p[P.id] && p[P.id].rich_text);
      if (id) (byId[id] = byId[id] || []).push(page.id);
    });
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return byId;
}

/** A check-in as a new page: "Family Huddle · Oct 11, 2026", then each question and its answer. */
export function checkinPage(env, x) {
  const P = CHECKINS_PROPS;
  const type = x.type === "couples" ? "couples" : "huddle";
  const label = CHECKINS_TYPE[type];
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(x.date);
  const shown = isDate ? longDate(x.date) : x.date;

  const props = {};
  props[P.name] = { title: richText(label + (shown ? " · " + shown : "")) };
  props[P.type] = { select: { name: label } };
  props[P.id] = { rich_text: richText(x.id) };
  if (isDate) props[P.date] = { date: { start: x.date } };

  const answers = x.answers || {};
  const questions = CHECKINS_QUESTIONS[type];
  const known = questions.map(function (q) { return q[0]; });
  const extra = Object.keys(answers).filter(function (k) { return known.indexOf(k) < 0; });
  const children = [];
  questions.concat(extra.map(function (k) { return [k, k]; })).forEach(function (q) {
    const answer = String(answers[q[0]] == null ? "" : answers[q[0]]).trim();
    children.push({ type: "heading_3", heading_3: { rich_text: richText(q[1]) } });
    children.push({ type: "paragraph", paragraph: { rich_text: answer
      ? richText(answer)
      : [{ type: "text", text: { content: "No answer" }, annotations: { italic: true, color: "gray" } }] } });
  });
  return {
    parent: { type: "data_source_id", data_source_id: secret(env, "NOTION_CHECKINS_SOURCE") },
    properties: props,
    children: children,
  };
}

/** Text as Notion takes it, in pieces short enough for its limit. */
function richText(s) {
  const out = [];
  for (let i = 0; i < s.length; i += TEXT_MAX) out.push({ type: "text", text: { content: s.slice(i, i + TEXT_MAX) } });
  return out;
}
