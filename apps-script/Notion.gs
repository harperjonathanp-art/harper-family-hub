/**
 * HARPER FAMILY HUB — dinners from the Notion meal plan
 *
 * When NOTION_TOKEN and NOTION_MEALS_SOURCE are set in Script Properties, the
 * week's dinners come from the Meal Plan database in Notion instead of being
 * typed into the Hub. A timer reads the Dinner rows for this week's plan
 * (Saturday to Friday, the way it's planned in Notion) and writes them into the
 * Meals tab, so Today, Dinner, the dinner nudge and the meal-plan alert all work
 * as before. The week stays put until Saturday, so a dinner moved to another
 * night, or one that's past, is still there to see.
 *
 * One way only: Notion -> Hub. Nothing here writes to Notion, and while the
 * sync is on, the Hub shows the dinners read-only. Anything typed into the
 * Meals tab by hand is replaced at the next sync.
 *
 * The token is a Notion internal integration's secret. It lives only in
 * Script Properties, and the integration sees only the databases shared with it.
 *
 * SETUP: see README.md next to this file ("Meal plan from Notion").
 */

// ======================= CONFIG =======================
const NOTION_SYNC_MIN = 10;          // how often the timer reads Notion
const NOTION_VERSION = '2025-09-03';
const NOTION_WEEK_START = 'Sat';     // the plan week runs Saturday to Friday
const NOTION_RECIPE_CACHE_S = 21600; // a recipe's link is looked up at most every 6 hours
// The Meal Plan database's property names, as they read in Notion.
const NOTION_PROPS = {
  date: 'Date', meal: 'Meal', type: 'Meal Type', status: 'Status',
  notes: 'Notes', who: 'Who Cooks', recipe: 'Recipe',
};
// The Recipes database's link to the recipe online. Without one, the Hub links
// to the recipe's page in Notion.
const NOTION_RECIPE_LINK = 'Source';
// "Who Cooks" as the Hub words it. Anything else (Leftovers, Eating out) is shown as is.
const NOTION_WHO = { Jon: 'Jon cooks', Maggie: 'Maggie cooks', Together: 'Cooking together' };
// ======================================================

const NOTION_STATE_ = 'NOTION_MEALS_STATE'; // { at, error, week: 'yyyy-MM-dd' }

/** Whether the dinners come from Notion. */
function notionOn_() {
  return !!(prop_('NOTION_TOKEN') && prop_('NOTION_MEALS_SOURCE'));
}

/** What the Hub needs to know about the sync: null while the Hub plans dinners itself. */
function notionMealsInfo_() {
  if (!notionOn_()) return null;
  const s = loadNotionState_();
  return { source: 'notion', syncedAt: s.at || 0, error: s.error || '', weekStarts: NOTION_WEEK_START };
}

// ---------- setup & timer ----------

/** Run once from the editor: sets the timer and syncs. */
function setupNotionMeals() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncNotionMeals') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncNotionMeals').timeBased().everyMinutes(NOTION_SYNC_MIN).create();
  const r = syncNotionMeals();
  Logger.log('Meal plan from Notion: ' + r.status + (r.message ? ' — ' + r.message : ''));
  if (r.meals) {
    Object.keys(r.meals).forEach(function (d) {
      const m = r.meals[d];
      Logger.log('  ' + d + '  ' + (m.meal || '(nothing planned)') + (m.note ? '  [' + m.note + ']' : ''));
    });
  }
}

/** Timer entry point. Never throws: a failed read leaves the last good plan alone. */
function syncNotionMeals() {
  if (!notionOn_()) return { status: 'off', message: 'add NOTION_TOKEN and NOTION_MEALS_SOURCE in Script Properties' };
  const week = weekStart_(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
  let meals;
  try {
    meals = weekOfDinners_(fetchDinners_(week), week);
  } catch (err) {
    const message = String(err && err.message || err).slice(0, 200);
    const s = loadNotionState_();
    s.error = message;
    saveNotionState_(s);
    return { status: 'error', message: message };
  }

  // Read Notion first, then hold the lock only to write: Hub saves and the
  // notification timer wait on the same lock.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { status: 'busy' };
  try {
    const changed = !sameMeals_(getMeals_(), meals);
    if (changed) saveMeals_(meals);
    saveNotionState_({ at: Date.now(), error: '', week: week });
    return { status: changed ? 'updated' : 'current', meals: meals };
  } finally {
    lock.releaseLock();
  }
}

// ---------- reading Notion ----------

/** Each date's dinner in the week from `week`, as the Hub writes it: { 'yyyy-MM-dd': { meal, note } }. */
function fetchDinners_(week) {
  const P = NOTION_PROPS;
  const body = {
    filter: { and: [
      { property: P.date, date: { on_or_after: week } },
      { property: P.date, date: { on_or_before: isoAdd_(week, 6) } },
    ] },
    sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
    page_size: 100,
  };
  const res = notion_('post', '/data_sources/' + prop_('NOTION_MEALS_SOURCE') + '/query', body);
  const byDate = {};
  (res.results || []).forEach(function (page) {
    const p = page.properties || {};
    const type = selectName_(p[P.type]);
    if (type && type !== 'Dinner') return;             // a row with no Meal Type counts as dinner
    if (selectName_(p[P.status]) === 'Skipped') return;
    const date = String((p[P.date] && p[P.date].date && p[P.date].date.start) || '').slice(0, 10);
    if (!date) return;
    const name = plainText_(p[P.meal] && p[P.meal].title);
    const links = ((p[P.recipe] && p[P.recipe].relation) || []).map(function (r) { return recipeLink_(r.id); })
      .filter(String);
    const who = selectName_(p[P.who]);
    const notes = plainText_(p[P.notes] && p[P.notes].rich_text);
    const d = byDate[date] || (byDate[date] = { names: [], links: [], notes: [] });
    if (name) d.names.push(name);
    links.forEach(function (u) { if (d.links.indexOf(u) < 0) d.links.push(u); });
    [who ? (NOTION_WHO[who] || who) : '', notes].forEach(function (n) {
      if (n && d.notes.indexOf(n) < 0) d.notes.push(n);
    });
  });
  const out = {};
  Object.keys(byDate).forEach(function (date) {
    const d = byDate[date];
    // Recipe links go after the name, the way they're typed into the Hub, so it shows them the same way:
    // "Pad Thai | https://…". The Hub drops the " | " when it shows the name.
    const name = d.names.join(' + ');
    out[date] = { meal: [name, d.links.join(' ')].filter(String).join(' | '), note: d.notes.join(' · ') };
  });
  return out;
}

/** The Meals tab's seven days, filled from the plan week that starts on `week`. */
function weekOfDinners_(dinners, week) {
  const meals = {};
  for (let i = 0; i < 7; i++) {
    const date = isoAdd_(week, i);
    const d = dinners[date] || {};
    meals[isoDay_(date)] = { meal: d.meal || '', note: d.note || '' };
  }
  return meals;
}

/** A recipe's link online, or its page in Notion. Blank if the integration can't see the Recipes database. */
function recipeLink_(id) {
  const cache = CacheService.getScriptCache();
  const key = 'notion-recipe-' + id;
  const hit = cache.get(key);
  if (hit !== null) return hit;
  let link = '';
  try {
    const page = notion_('get', '/pages/' + id);
    const src = page.properties && page.properties[NOTION_RECIPE_LINK];
    link = (src && src.url) || page.url || '';
  } catch (err) {
    console.warn('recipeLink_: ' + String(err && err.message || err).slice(0, 200));
  }
  cache.put(key, link, NOTION_RECIPE_CACHE_S);
  return link;
}

function notion_(method, path, body) {
  const opts = {
    method: method,
    headers: { Authorization: 'Bearer ' + prop_('NOTION_TOKEN'), 'Notion-Version': NOTION_VERSION },
    muteHttpExceptions: true,
  };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  const r = UrlFetchApp.fetch('https://api.notion.com/v1' + path, opts);
  let data = {};
  try { data = JSON.parse(r.getContentText()); } catch (err) {}
  if (r.getResponseCode() !== 200) {
    // Notion's own error text, e.g. "Could not find data_source…" when it isn't shared with the integration.
    throw new Error('Notion ' + r.getResponseCode() + ': ' + (data.message || data.code || 'no answer'));
  }
  return data;
}

// ---------- small helpers ----------

function plainText_(parts) {
  return (parts || []).map(function (t) { return t.plain_text || ''; }).join('').replace(/\s+/g, ' ').trim();
}

function selectName_(prop) {
  return (prop && prop.select && prop.select.name) || '';
}

function isoAdd_(iso, days) {
  const p = iso.split('-').map(Number);
  return Utilities.formatDate(new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)), 'UTC', 'yyyy-MM-dd');
}

/** The plan week's first day (NOTION_WEEK_START) on or before `iso`. */
function weekStart_(iso) {
  return isoAdd_(iso, -((DAYS.indexOf(isoDay_(iso)) - DAYS.indexOf(NOTION_WEEK_START) + 7) % 7));
}

function isoDay_(iso) {
  const p = iso.split('-').map(Number);
  return DAYS[(new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7];
}

function sameMeals_(a, b) {
  return DAYS.every(function (d) {
    const x = a[d] || {}, y = b[d] || {};
    return String(x.meal || '') === String(y.meal || '') && String(x.note || '') === String(y.note || '');
  });
}

function loadNotionState_() {
  try { return JSON.parse(prop_(NOTION_STATE_) || '{}'); } catch (err) { return {}; }
}

function saveNotionState_(s) {
  PropertiesService.getScriptProperties().setProperty(NOTION_STATE_, JSON.stringify(s));
}
