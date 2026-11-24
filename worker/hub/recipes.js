/**
 * HARPER FAMILY HUB — Recipes, read from Notion's Recipes database
 *
 * Reading, for everyone signed in; three writes, for a parent only (Stage 7c):
 *   rateRecipe      "How was it?": the stars, Family Favorite, the kids liked it, and the night it was made
 *   favoriteRecipe  the heart: Status Family Favorite (or back to Tried)
 *   planRecipe      a night in the Notion meal plan, linked to the recipe
 * A write changes only the columns it's about, never the page's text.
 *
 *   The list   Every 6 hours the timer reads all the recipes' columns (about five
 *              requests of 100) and keeps them as one copy in the database.
 *   The pages  Each timer run also reads a few recipe pages (ingredients, steps,
 *              notes), the ones not read yet or edited since, so the first full
 *              read takes a few hours and after that only edited pages are read.
 *              A recipe opened before its page has been read is read right then.
 *   Photos     Notion's photo links expire within minutes and an <img> can't carry
 *              the sign-in, so the list gives each photo a signed link to this
 *              Worker, good for about a week. The Worker fetches the photo (from
 *              Notion or the recipe's site) and keeps a copy for a week.
 *
 * Which database: NOTION_RECIPES_SOURCE if set, else the one the meal plan's
 * Recipe column links to (found once and remembered).
 *
 * Kept in their own tables, apart from the rows every request loads:
 *   recipe_store   'list' (every recipe's columns, as JSON), 'state', 'photo-key'
 *   recipe_bodies  one recipe page each, as read, and the words its ingredients use
 *   recipe_photos  the photos, kept a week
 */

import { notion, notionOn, NOTION_PROPS, plainText, selectName } from "./notion.js";
import { today, isoAdd } from "./time.js";

const LIST_EVERY_MS = 6 * 3600 * 1000;
export const PAGE_REQUESTS = 15;            // Notion requests for recipe pages per timer run
const PAGE_BLOCKS_MAX = 3;                  // a page is read in at most three requests of 100 blocks
const PHOTO_KEEP_MS = 7 * 86400 * 1000;
const PHOTO_LINK_MS = 7 * 86400 * 1000;     // a photo link is good for a week or two (it changes weekly, so phones can keep it)
const PHOTO_MAX_BYTES = 1800000;            // under the database's limit for one value
const PAUSE_MS = 350;                       // Notion allows about three requests a second

// The Recipes database's columns, as they read in Notion.
const P = {
  name: "Recipe", category: "Category", cuisine: "Cuisine", protein: "Protein", method: "Method", status: "Status",
  rating: "Rating", time: "Total Time (min)", servings: "Servings", cost: "Cost per Serving", costTotal: "Cost per Recipe",
  kid: "Kid Approved", lastMade: "Last Made", source: "Source", photo: "Photo", notes: "Notes",
};

const pause = () => new Promise(r => setTimeout(r, PAUSE_MS));
const parse = (text, empty) => { try { return JSON.parse(text || "") || empty; } catch (err) { return empty; } };

let tablesReady = false;
async function tables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS recipe_store (key TEXT PRIMARY KEY, value TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS recipe_bodies (id TEXT PRIMARY KEY, edited TEXT, body TEXT, words TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS recipe_photos (id TEXT PRIMARY KEY, src TEXT, type TEXT, data BLOB, at INTEGER)"),
  ]);
  tablesReady = true;
}
async function getStore(env, key) {
  const row = await env.DB.prepare("SELECT value FROM recipe_store WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}
function putStore(env, key, value) {
  return env.DB.prepare("INSERT INTO recipe_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value).run();
}

// ---------- reading Notion ----------

/** The Recipes database: the setting, or the one the meal plan's Recipe column links to. */
async function recipesSource(env, state) {
  const set = String(env.NOTION_RECIPES_SOURCE || "").trim();
  if (set) return set;
  if (state.source) return state.source;
  const meals = await notion(env, "GET", "/data_sources/" + String(env.NOTION_MEALS_SOURCE || "").trim());
  const col = meals.properties && meals.properties[NOTION_PROPS.recipe];
  const id = col && col.relation && col.relation.data_source_id;
  if (!id) throw new Error("the meal plan's " + NOTION_PROPS.recipe + " column doesn't link to a database");
  state.source = id;
  return id;
}

/** One recipe's columns, as the Hub shows them. */
export function recipeInfo(page) {
  const p = page.properties || {};
  const num = x => (x && typeof x.number === "number" ? x.number : null);
  const multi = x => ((x && x.multi_select) || []).map(o => o.name);
  const file = f => (!f ? "" : f.type === "external" ? (f.external && f.external.url) || "" : f.type === "file" || f.type === "file_upload" ? "notion" : "");
  const date = x => String((x && x.date && x.date.start) || "").slice(0, 10);
  return {
    id: page.id,
    name: plainText(p[P.name] && p[P.name].title) || "Untitled",
    emoji: page.icon && page.icon.type === "emoji" ? page.icon.emoji : "",
    category: selectName(p[P.category]),
    cuisine: multi(p[P.cuisine]),
    protein: selectName(p[P.protein]),
    method: multi(p[P.method]),
    status: selectName(p[P.status]),
    rating: parseInt(selectName(p[P.rating]), 10) || 0,
    time: num(p[P.time]),
    servings: num(p[P.servings]),
    cost: num(p[P.cost]),
    costTotal: num(p[P.costTotal]),
    kid: !!(p[P.kid] && p[P.kid].checkbox),
    lastMade: date(p[P.lastMade]),
    source: (p[P.source] && p[P.source].url) || "",
    notes: plainText(p[P.notes] && p[P.notes].rich_text),
    // the photo: a web address, "notion" for one kept in Notion (its link has to be fetched fresh), or none
    photo: file(((p[P.photo] && p[P.photo].files) || [])[0]) || file(page.cover),
    edited: page.last_edited_time || "",
    url: page.url || "",
  };
}

/** Every recipe's columns. Gives the recipes and how many requests it took. */
async function readList(env, source) {
  const out = [];
  let cursor = null, requests = 0;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (requests) await pause();
    const res = await notion(env, "POST", "/data_sources/" + source + "/query", body);
    requests++;
    (res.results || []).forEach(page => { if (page.object !== "data_source" && !page.in_trash) out.push(recipeInfo(page)); });
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor && requests < 20);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { list: out, requests };
}

/** A recipe page's blocks, read in up to three requests. */
async function readBlocks(env, id) {
  const blocks = [];
  let cursor = null, requests = 0;
  do {
    if (requests) await pause();
    const res = await notion(env, "GET", "/blocks/" + id + "/children?page_size=100" + (cursor ? "&start_cursor=" + encodeURIComponent(cursor) : ""));
    requests++;
    (res.results || []).forEach(b => blocks.push(b));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor && requests < PAGE_BLOCKS_MAX);
  return { blocks, requests };
}

// ---------- a recipe page, as laid out in Notion ----------

const SECTIONS = [
  ["ingredients", /^(ingredients?|what you('|’)ll need|shopping list)$/i],
  ["steps", /^(steps|directions|instructions|method|preparation|how to make it)$/i],
  ["notes", /^(notes?|tips|notes (&|and) tips)$/i],
];
const richOf = b => (b && b[b.type] && b[b.type].rich_text) || [];
const textOf = rich => rich.map(t => t.plain_text || "").join("").replace(/\s+/g, " ").trim();
const allBold = rich => rich.length > 0 && rich.every(t => !(t.plain_text || "").trim() || (t.annotations && t.annotations.bold));
/** A step's bold opener ("Make the sauce.") and the rest of it. */
function opener(rich) {
  let i = 0, lead = "";
  while (i < rich.length && rich[i].annotations && rich[i].annotations.bold) lead += rich[i++].plain_text || "";
  if (!lead.trim() || i === rich.length) return { t: textOf(rich) };
  return { lead: lead.replace(/\s+/g, " ").trim(), t: textOf(rich.slice(i)) };
}

/**
 * The page's blocks as { about, facts, ingredients, steps, notes, raw }:
 *   about        the paragraphs before the first heading
 *   facts        the "Time: … · Serves: … · From: …" line
 *   ingredients  [{ h: "Filling" } | { t: "1½ lb chicken" }]   (a bold line names a group)
 *   steps        [{ h } | { lead?, t }]                         (lead: the step's bold opener)
 *   notes        [{ h } | { t }]
 *   raw          every line as written, for a page that doesn't follow the layout
 */
export function parseRecipe(blocks) {
  const out = { about: [], facts: "", ingredients: [], steps: [], notes: [], raw: [] };
  let section = null;
  // Before any known heading, checkboxes (and the headings over them) may be ingredients on a page with no
  // "Ingredients" heading ("## Fries" with its checkboxes, "## Gravy" with its, then "## Steps").
  const loose = [], looseAbout = [];
  for (const b of blocks || []) {
    const rich = richOf(b), text = textOf(rich);
    if (/^heading_[123]$/.test(b.type)) {
      const name = text.replace(/[:：]\s*$/, "");
      const hit = SECTIONS.find(s => s[1].test(name));
      out.raw.push({ h: name });
      if (hit) { section = hit[0]; continue; }
      if (section) out[section].push({ h: name }); // a sub-heading ("For the sauce") inside a section
      else { out.about.push(name); looseAbout.push(true); loose.push({ h: name }); }
      continue;
    }
    if (!text) continue;
    const listed = /^(to_do|bulleted_list_item|numbered_list_item)$/.test(b.type);
    out.raw.push({ t: text, list: listed ? b.type : undefined });
    if (b.type !== "paragraph" && !listed && b.type !== "quote" && b.type !== "callout") continue;
    if (!section) {
      if (rich[0] && rich[0].annotations && rich[0].annotations.bold && /:\s*$/.test(rich[0].plain_text || "")) out.facts = text;
      else if (b.type === "to_do") { out.about.push(text); looseAbout.push(true); loose.push({ t: text }); }
      else { out.about.push(text); looseAbout.push(false); }
    } else if (section === "steps") {
      if (b.type === "paragraph" && allBold(rich)) out.steps.push({ h: text.replace(/[:：]\s*$/, "") });
      else out.steps.push(opener(rich));
    } else {
      if (b.type === "paragraph" && allBold(rich)) out[section].push({ h: text.replace(/[:：]\s*$/, "") });
      else out[section].push({ t: text });
    }
  }
  // Steps but no Ingredients heading: those early checkboxes were the ingredients, grouped by the headings above them.
  if (!out.ingredients.some(x => x.t) && out.steps.some(x => x.t) && loose.some(x => x.t)) {
    out.ingredients = loose.filter((x, i) => x.t || (loose[i + 1] && loose[i + 1].t));
    out.about = out.about.filter((_, i) => !looseAbout[i]);
  }
  const followed = out.ingredients.some(x => x.t) || out.steps.some(x => x.t);
  if (followed) delete out.raw;
  else out.raw = out.raw.filter(x => x.h || x.t).map(x => (x.h ? { h: x.h } : x.list ? { t: x.t, list: x.list } : { t: x.t }));
  return out;
}

/* A page as kept: its edit time and the version of the reading above, so a better reading reads every page again. */
const PARSE_VERSION = "2"; // 2: checkbox ingredients under their own headings, with no "Ingredients" heading
const stamp = edited => String(edited || "") + "#" + PARSE_VERSION;

// What isn't worth searching for in an ingredient line.
const NOT_WORDS = new Set(("cup cups tbsp tsp teaspoon teaspoons tablespoon tablespoons oz ounce ounces lb lbs pound pounds can cans " +
  "and the for with into about each plus divided large medium small fresh freshly chopped minced diced sliced thin thinly fine finely " +
  "cut inch inches whole optional taste more less half package packages box boxes jar bag pinch dash such pieces piece " +
  "drained rinsed peeled trimmed grated shredded crushed melted softened room temperature cold warm hot see note notes").split(" "));
/** The words a recipe's ingredients use, for search: "chicken broth carrots peas …". */
export function ingredientWords(body) {
  const seen = new Set();
  (body.ingredients || []).forEach(x => {
    if (!x.t) return;
    x.t.toLowerCase().replace(/\([^)]*\)/g, " ").split(/[^a-zà-ÿ]+/).forEach(w => {
      if (w.length > 2 && !NOT_WORDS.has(w)) seen.add(w);
    });
  });
  return [...seen].join(" ").slice(0, 600);
}

/** Reads one recipe page and keeps it. Gives the body and how many requests it took. */
async function readPage(env, info) {
  const { blocks, requests } = await readBlocks(env, info.id);
  const body = parseRecipe(blocks);
  await env.DB.prepare("INSERT INTO recipe_bodies (id, edited, body, words) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET edited = excluded.edited, body = excluded.body, words = excluded.words")
    .bind(info.id, stamp(info.edited), JSON.stringify(body), ingredientWords(body)).run();
  return { body, requests };
}

// ---------- the timer ----------

/** The list every 6 hours, then recipe pages not read yet (or edited since) until this run's requests are used. */
export async function syncRecipes(env, now) {
  await tables(env);
  const state = parse(await getStore(env, "state"), {});
  let list = null, used = 0, note = "";
  try {
    if (!state.listAt || now.getTime() - state.listAt >= LIST_EVERY_MS) {
      const source = await recipesSource(env, state);
      const read = await readList(env, source);
      used += read.requests;
      list = read.list;
      await putStore(env, "list", JSON.stringify(list));
      Object.assign(state, { listAt: now.getTime(), count: list.length, error: "" });
      note = "list read (" + list.length + "); ";
    }
  } catch (err) {
    state.error = String(err && err.message || err).slice(0, 200);
    await putStore(env, "state", JSON.stringify(state));
    throw new Error(state.error);
  }
  if (!list) list = parse(await getStore(env, "list"), []);

  const have = {};
  (await env.DB.prepare("SELECT id, edited FROM recipe_bodies").all()).results.forEach(r => { have[r.id] = r.edited; });
  // The ones made most lately first: the likeliest to be opened.
  const stale = list.filter(r => have[r.id] !== stamp(r.edited))
    .sort((a, b) => String(b.lastMade).localeCompare(String(a.lastMade)));
  let read = 0;
  const errors = [];
  for (const info of stale) {
    if (used >= PAGE_REQUESTS) break;
    if (used) await pause();
    try { used += (await readPage(env, info)).requests; read++; }
    catch (err) { used++; errors.push(info.name + ": " + String(err && err.message || err).slice(0, 80)); }
  }
  // Pages no longer in Notion go, a few at a time.
  const listed = new Set(list.map(r => r.id)), gone = Object.keys(have).filter(id => !listed.has(id)).slice(0, 50);
  if (gone.length && list.length) await env.DB.prepare(`DELETE FROM recipe_bodies WHERE id IN (${gone.map(() => "?").join(",")})`).bind(...gone).run();

  state.pagesLeft = Math.max(0, stale.length - read);
  if (errors.length) state.error = errors.join(" / ").slice(0, 200);
  else if (!state.error || note) state.error = "";
  await putStore(env, "state", JSON.stringify(state));
  return note + read + " pages read, " + state.pagesLeft + " left" + (errors.length ? "; " + errors.join(" / ").slice(0, 150) : "");
}

// ---------- what the Hub asks for ----------

/** The key photo links are signed with: made once, kept in the database. */
async function photoKey(env) {
  let raw = await getStore(env, "photo-key");
  if (!raw) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    raw = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("INSERT OR IGNORE INTO recipe_store (key, value) VALUES ('photo-key', ?)").bind(raw).run();
    raw = await getStore(env, "photo-key"); // the one that won, if two made one at once
  }
  return crypto.subtle.importKey("raw", new TextEncoder().encode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function signature(key, id, exp) {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id + "." + exp)));
  return btoa(String.fromCharCode(...mac.slice(0, 18))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** A photo link good until the end of next week, the same all week (so phones can keep the photo). */
async function photoLink(key, origin, id, nowMs) {
  const exp = (Math.floor(nowMs / PHOTO_LINK_MS) + 2) * PHOTO_LINK_MS / 1000;
  return origin + "/recipe-photo?id=" + encodeURIComponent(id) + "&e=" + exp + "&s=" + (await signature(key, id, exp));
}

/** What the page shows of one recipe in a list: no photo address, but a signed link to one. */
async function shown(info, key, origin, nowMs, words) {
  const out = Object.assign({}, info);
  delete out.photo;
  if (info.photo) out.img = await photoLink(key, origin, info.id, nowMs);
  if (words != null) out.words = words;
  return out;
}

/** GET /api?action=recipes: every recipe's columns, the words its ingredients use, and how far the reading has got. */
export async function recipeList(env, origin, now) {
  if (!notionOn(env)) return { ok: true, on: false, recipes: [] };
  await tables(env);
  const list = parse(await getStore(env, "list"), []), state = parse(await getStore(env, "state"), {});
  const words = {};
  (await env.DB.prepare("SELECT id, words FROM recipe_bodies").all()).results.forEach(r => { words[r.id] = r.words || ""; });
  const key = await photoKey(env);
  const recipes = [];
  for (const r of list) recipes.push(await shown(r, key, origin, now.getTime(), words[r.id] || ""));
  return { ok: true, on: true, recipes, syncedAt: state.listAt || 0, pagesLeft: state.pagesLeft == null ? recipes.length : state.pagesLeft, error: state.error || "" };
}

/** GET /api?action=recipe&id=…: one recipe, with its page (read now if it hasn't been yet). */
export async function recipeOne(env, origin, now, id) {
  if (!notionOn(env)) return { ok: false, error: "no_recipes" };
  await tables(env);
  const list = parse(await getStore(env, "list"), []);
  const info = list.find(r => r.id === id);
  if (!info) return { ok: false, error: "not_found" };
  const row = await env.DB.prepare("SELECT edited, body FROM recipe_bodies WHERE id = ?").bind(id).first();
  let body = row ? parse(row.body, null) : null;
  if (!body || row.edited !== stamp(info.edited)) {
    try { body = (await readPage(env, info)).body; }
    catch (err) { if (!body) return { ok: false, error: "notion", message: String(err && err.message || err).slice(0, 200) }; }
  }
  return { ok: true, recipe: Object.assign(await shown(info, await photoKey(env), origin, now.getTime()), { body }) };
}

/** GET /recipe-photo?id=…&e=…&s=… (no sign-in: the signature is the permission). */
export async function recipePhoto(env, url, now) {
  const id = url.searchParams.get("id") || "", exp = Number(url.searchParams.get("e")) || 0, sig = url.searchParams.get("s") || "";
  if (!id || exp * 1000 < now.getTime()) return new Response("expired", { status: 403 });
  await tables(env);
  if (sig !== await signature(await photoKey(env), id, exp)) return new Response("bad signature", { status: 403 });
  const headers = type => ({ "Content-Type": type, "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff" });

  const list = parse(await getStore(env, "list"), []);
  const info = list.find(r => r.id === id);
  if (!info || !info.photo) return new Response("no photo", { status: 404 });
  const kept = await env.DB.prepare("SELECT src, type, data, at FROM recipe_photos WHERE id = ?").bind(id).first();
  const src = info.photo === "notion" ? "notion:" + info.edited : info.photo;
  if (kept && kept.src === src && now.getTime() - kept.at < PHOTO_KEEP_MS) return new Response(kept.data, { headers: headers(kept.type) });

  let from = info.photo;
  try {
    if (from === "notion") { // Notion's own copy: ask for a fresh link
      const page = await notion(env, "GET", "/pages/" + id);
      const f = (((page.properties || {})[P.photo] || {}).files || [])[0] || page.cover;
      from = f && (f.file ? f.file.url : f.external ? f.external.url : "");
    }
    if (!from) throw new Error("no link");
    const res = await fetch(from, { headers: { "User-Agent": "Mozilla/5.0 (compatible; HarperFamilyHub/1.0)", Accept: "image/*" } });
    const type = res.headers.get("Content-Type") || "";
    if (res.status !== 200 || !/^image\//.test(type)) throw new Error("answered " + res.status + " " + type);
    const data = await res.arrayBuffer();
    if (data.byteLength <= PHOTO_MAX_BYTES) {
      await env.DB.prepare("INSERT INTO recipe_photos (id, src, type, data, at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET src = excluded.src, type = excluded.type, data = excluded.data, at = excluded.at")
        .bind(id, src, type, data, now.getTime()).run();
    }
    return new Response(data, { headers: headers(type) });
  } catch (err) {
    if (kept) return new Response(kept.data, { headers: headers(kept.type) }); // an older copy beats none
    return new Response("photo unavailable", { status: 404 });
  }
}

// ---------- writing to Notion (a parent only) ----------

export const RECIPE_ACTIONS = ["rateRecipe", "favoriteRecipe", "planRecipe"];
const WHO_COOKS = ["Jon", "Maggie", "Together"];
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));

/** Saves a recipe's new columns, and keeps the list's copy in step (the page itself didn't change, so it isn't read again). */
async function patchRecipe(env, list, info, props) {
  const page = await notion(env, "PATCH", "/pages/" + info.id, { properties: props });
  const fresh = page && page.properties ? recipeInfo(page) : Object.assign({}, info);
  const i = list.findIndex(r => r.id === info.id);
  if (i >= 0) list[i] = fresh;
  await putStore(env, "list", JSON.stringify(list));
  if (fresh.edited && fresh.edited !== info.edited) {
    await env.DB.prepare("UPDATE recipe_bodies SET edited = ? WHERE id = ? AND edited = ?").bind(stamp(fresh.edited), info.id, stamp(info.edited)).run();
  }
  return fresh;
}

/** POST { action: rateRecipe | favoriteRecipe | planRecipe, id, … }. Gives { ok, recipe } or { ok: false, error }. */
export async function recipeAction(env, session, body, origin, now) {
  if (!notionOn(env)) return { ok: false, error: "no_recipes" };
  if (!session.parent) return { ok: false, error: "parents_only" };
  await tables(env);
  const list = parse(await getStore(env, "list"), []);
  const info = list.find(r => r.id === String(body.id || ""));
  if (!info) return { ok: false, error: "not_found" };
  const home = today(now);
  try {
    if (body.action === "rateRecipe") {
      const stars = Math.round(Number(body.stars) || 0), date = isDate(body.date) ? body.date : isoAdd(home, -1);
      if (stars < 1 || stars > 5) return { ok: false, error: "bad_stars" };
      if (date > home) return { ok: false, error: "bad_date" };
      const props = {};
      props[P.rating] = { select: { name: stars + " ⭐" } };
      const status = body.favorite ? "Family Favorite" : !info.status || info.status === "To Try" ? "Tried" : info.status;
      if (status !== info.status) props[P.status] = { select: { name: status } };
      if (body.kids === true && !info.kid) props[P.kid] = { checkbox: true }; // a "no" never un-ticks it
      if (!info.lastMade || date > info.lastMade) props[P.lastMade] = { date: { start: date } };
      const fresh = await patchRecipe(env, list, info, props);
      return { ok: true, recipe: await shown(fresh, await photoKey(env), origin, now.getTime()) };
    }
    if (body.action === "favoriteRecipe") {
      const want = body.on === true ? "Family Favorite" : info.status === "Family Favorite" ? "Tried" : info.status;
      if (want === info.status) return { ok: true, recipe: await shown(info, await photoKey(env), origin, now.getTime()) };
      const props = {};
      props[P.status] = { select: { name: want } };
      const fresh = await patchRecipe(env, list, info, props);
      return { ok: true, recipe: await shown(fresh, await photoKey(env), origin, now.getTime()) };
    }
    if (body.action === "planRecipe") {
      const date = String(body.date || ""), who = WHO_COOKS.indexOf(body.who) >= 0 ? body.who : "";
      if (!isDate(date) || date < home || date > isoAdd(home, 20)) return { ok: false, error: "bad_date" };
      const M = NOTION_PROPS, props = {};
      props[M.meal] = { title: [{ type: "text", text: { content: info.name.slice(0, 2000) } }] };
      props[M.date] = { date: { start: date } };
      props[M.type] = { select: { name: "Dinner" } };
      props[M.status] = { select: { name: "Planned" } };
      props[M.recipe] = { relation: [{ id: info.id }] };
      if (who) props[M.who] = { select: { name: who } };
      await notion(env, "POST", "/pages", { parent: { type: "data_source_id", data_source_id: String(env.NOTION_MEALS_SOURCE || "").trim() }, properties: props });
      return { ok: true, planned: date };
    }
  } catch (err) {
    // Notion's own words, e.g. when the connection isn't allowed to edit: shown so it can be fixed
    return { ok: false, error: "notion", message: String(err && err.message || err).slice(0, 200) };
  }
  return { ok: false, error: "unknown_action" };
}
