/**
 * HARPER FAMILY HUB — where the Hub's rows are kept
 *
 * The rules in worker/hub work on rows in memory, the way Code.gs worked on a
 * Sheet's rows. This file loads them from the database, lets one piece of work
 * change them, and saves exactly what changed.
 *
 *   const result = await transact(env, ["Tasks", "Completions"], c => {
 *     toggleTask(c, id, by);          // changes c.tabs.Tasks / c.tabs.Completions
 *     return getTasks(c);
 *   });
 *
 * Apps Script took a lock so that two phones saving at once couldn't undo each
 * other. A database on Cloudflare has no lock to take, so the save itself is
 * the check: every change carries the number the data had when it was read
 * ("rev"), and is only applied if that number is still current. If someone
 * else saved in between, nothing is written, and the work is done again on the
 * fresh rows. The work must therefore only change `c`; anything that reaches
 * outside (sending a notification) happens after, with what it returned.
 *
 * Tabs and their columns are named as the Sheet's were. `c.props` is the
 * script's own bookkeeping, as text by key (what Script Properties held).
 */

export const TABS = {
  Tasks:       ["id", "title", "recurrence", "assignee", "createdAt", "due", "repeat", "lastDone", "prevDue", "time", "parentId", "sort"],
  Completions: ["taskId", "periodKey", "completedBy", "timestamp"],
  Meals:       ["day", "meal", "note"],
  CheckIns:    ["id", "date", "type", "answersJson"],
  Devices:     ["endpoint", "person", "subscription", "addedAt"],
  NotifyPrefs: ["person", "prefs", "updatedAt"],
};
const MAX_TRIES = 10; // each round at least one saver gets through, so ten at once always all finish
const REV = "(SELECT value FROM props WHERE key = 'rev')";

const table = tab => "hub_" + tab.toLowerCase();
let tablesReady = false;

export async function ready(env) {
  if (tablesReady) return;
  // Columns have no declared type, so a value comes back exactly as it went in.
  const makes = Object.keys(TABS).map(tab => env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${table(tab)} (${TABS[tab].map(col => `"${col}"`).join(", ")})`));
  makes.push(env.DB.prepare("CREATE TABLE IF NOT EXISTS props (key TEXT PRIMARY KEY, value TEXT NOT NULL)"));
  makes.push(env.DB.prepare("INSERT OR IGNORE INTO props (key, value) VALUES ('rev', '0')"));
  await env.DB.batch(makes);
  tablesReady = true;
}

/** Reads the tabs asked for, and all the props, in one trip. */
async function load(env, tabs) {
  await ready(env);
  const res = await env.DB.batch(tabs.map(tab => env.DB.prepare(`SELECT rowid AS _rowid, * FROM ${table(tab)} ORDER BY rowid`))
    .concat(env.DB.prepare("SELECT key, value FROM props")));
  const rowids = new WeakMap(), was = {}, data = { tabs: {}, props: {} };
  tabs.forEach((tab, i) => {
    was[tab] = new Map();
    data.tabs[tab] = res[i].results.map(r => {
      const row = {};
      TABS[tab].forEach(col => { row[col] = r[col] == null ? "" : r[col]; });
      rowids.set(row, r._rowid);
      was[tab].set(r._rowid, JSON.stringify(row));
      return row;
    });
  });
  res[tabs.length].results.forEach(r => { data.props[r.key] = r.value; });
  const rev = data.props.rev;
  delete data.props.rev;
  return { data, rowids, was, rev, propsWas: Object.assign({}, data.props) };
}

/** A cell as the database takes it: text, a number, or blank. */
function cell(v) {
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "string") return v;
  return typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
}

/** Saves what changed. Gives false, writing nothing, if someone else saved since these rows were read. */
async function save(env, loaded) {
  const { data, rowids, was, rev, propsWas } = loaded, db = env.DB, work = [];
  Object.keys(data.tabs).forEach(tab => {
    const cols = TABS[tab], t = table(tab), kept = new Set();
    data.tabs[tab].forEach(row => {
      const id = rowids.get(row), vals = cols.map(col => cell(row[col]));
      if (id == null) { // a new row
        work.push(db.prepare(`INSERT INTO ${t} (${cols.map(c => `"${c}"`).join(", ")}) SELECT ${cols.map(() => "?").join(", ")} WHERE ${REV} = ?`)
          .bind(...vals, rev));
        return;
      }
      kept.add(id);
      const now = {};
      cols.forEach((col, i) => { now[col] = vals[i]; });
      if (JSON.stringify(now) !== was[tab].get(id)) {
        work.push(db.prepare(`UPDATE ${t} SET ${cols.map(c => `"${c}" = ?`).join(", ")} WHERE rowid = ? AND ${REV} = ?`).bind(...vals, id, rev));
      }
    });
    was[tab].forEach((_, id) => {
      if (!kept.has(id)) work.push(db.prepare(`DELETE FROM ${t} WHERE rowid = ? AND ${REV} = ?`).bind(id, rev));
    });
  });
  Object.keys(data.props).forEach(key => {
    if (key === "rev" || data.props[key] === propsWas[key]) return;
    work.push(db.prepare(`INSERT INTO props (key, value) SELECT ?, ? WHERE ${REV} = ? ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .bind(key, String(data.props[key]), rev));
  });
  Object.keys(propsWas).forEach(key => {
    if (!(key in data.props)) work.push(db.prepare(`DELETE FROM props WHERE key = ? AND ${REV} = ?`).bind(key, rev));
  });
  if (!work.length) return true; // nothing changed: nothing to check
  // Last of all the number moves on. Either every change above saw the old number, or none did.
  work.push(db.prepare("UPDATE props SET value = ? WHERE key = 'rev' AND value = ?").bind(String(Number(rev) + 1), rev));
  const res = await db.batch(work);
  return res[res.length - 1].meta.changes === 1;
}

/**
 * Loads `tabs`, runs `work(c)` on them, and saves what it changed. `work` may run
 * more than once (see the top of this file) and must not wait on anything.
 * `more` is added to the context: the clock, an id maker, and what the rules
 * need to know about the calendar, Todoist and Notion.
 */
export async function transact(env, tabs, work, more) {
  for (let attempt = 1; ; attempt++) {
    const loaded = await load(env, tabs);
    const c = Object.assign({
      tabs: loaded.data.tabs, props: loaded.data.props,
      now: new Date(), newId: () => crypto.randomUUID().slice(0, 8),
    }, more || {});
    const result = work(c);
    if (result && typeof result.then === "function") throw new Error("the work given to transact must not wait on anything");
    if (await save(env, loaded)) return result;
    if (attempt >= MAX_TRIES) throw new Error("couldn't save: the data kept changing");
    await new Promise(r => setTimeout(r, Math.random() * 15 * attempt)); // let the others finish, not all retry in step
  }
}
