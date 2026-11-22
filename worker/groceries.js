/**
 * HARPER FAMILY HUB — the grocery list
 *
 * The same actions, answers and order as the Groceries part of
 * apps-script/Code.gs, which test/groceries.test.js checks it against.
 */

const ACTIONS = ["addGroceries", "toggleGrocery", "deleteGrocery", "clearGroceries", "reorderGroceries"];
const MAX_AT_ONCE = 50; // items taken from one paste
const MAX_LENGTH = 200; // characters kept of one item

let tablesReady = false;

async function ready(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS groceries (
      id TEXT PRIMARY KEY, item TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      added_by TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0)`),
  ]);
  tablesReady = true;
}

export function isGroceryAction(action) {
  return ACTIONS.indexOf(action) >= 0;
}

/** The list as the Hub's page expects it, in order. */
export async function listGroceries(env) {
  await ready(env);
  const rows = (await env.DB.prepare("SELECT id, item, done, added_by FROM groceries ORDER BY sort, rowid").all()).results;
  return rows.map(r => ({ id: r.id, item: r.item, done: r.done === 1, addedBy: r.added_by || "" }));
}

/** One of the page's grocery actions. Answers with the list as it now stands. */
export async function groceryAction(env, body, person) {
  await ready(env);
  const db = env.DB, id = String(body.id == null ? "" : body.id);
  switch (body.action) {
    case "addGroceries": {
      // One item per line, so a pasted ingredient list becomes separate items.
      const items = String(body.text || "").split(/\n+/)
        .map(s => s.replace(/^[\s•*\-–—]+/, "").trim())
        .filter(Boolean)
        .slice(0, MAX_AT_ONCE);
      const now = new Date().toISOString();
      // Each goes after the last, including the one added just before it in this batch.
      if (items.length) {
        await db.batch(items.map(item => db.prepare(
          `INSERT INTO groceries (id, item, done, added_by, added_at, sort)
           VALUES (?, ?, 0, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM groceries))`)
          .bind(crypto.randomUUID().slice(0, 8), item.slice(0, MAX_LENGTH), person, now)));
      }
      break;
    }
    case "toggleGrocery":
      await db.prepare("UPDATE groceries SET done = 1 - done WHERE id = ?").bind(id).run();
      break;
    case "deleteGrocery":
      await db.prepare("DELETE FROM groceries WHERE id = ?").bind(id).run();
      break;
    case "clearGroceries":
      await db.prepare("DELETE FROM groceries WHERE done = 1").run();
      break;
    case "reorderGroceries": {
      // The order given, then anything it doesn't name (added meanwhile) in the order it had.
      if (!Array.isArray(body.ids)) break;
      const have = (await db.prepare("SELECT id FROM groceries ORDER BY sort, rowid").all()).results.map(r => r.id);
      const left = new Set(have), order = [];
      body.ids.forEach(x => { x = String(x); if (left.has(x)) { order.push(x); left.delete(x); } });
      have.forEach(x => { if (left.has(x)) order.push(x); });
      if (order.length) {
        await db.batch(order.map((x, i) => db.prepare("UPDATE groceries SET sort = ? WHERE id = ?").bind(i + 1, x)));
      }
      break;
    }
  }
  return { ok: true, groceries: await listGroceries(env) };
}
