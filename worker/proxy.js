/**
 * HARPER FAMILY HUB — the Hub's API
 *
 * A signed-in Hub talks to /api exactly as it talked to the Apps Script web
 * app: GET ?action=all, POST { action, … }. A feature that has moved into this
 * Worker is answered here; everything else is handed on to Apps Script with
 * the family PIN added here, so a signed-in device never holds the PIN.
 *
 * Who is asking comes from the session, not from what the page says: `by`
 * (who ticked, who added) and `person` (whose notifications) are set here.
 *
 * Which features are answered here is the list in moved.js.
 */

import { json } from "./util.js";
import { MOVED } from "./moved.js";
import { appsScript } from "./appsscript.js";
import { isGroceryAction, groceryAction, listGroceries, groceriesCopied, copyGroceries } from "./groceries.js";
import { hubGet, hubPost } from "./hub/api.js";

// Actions that name whose settings or phone they're about.
const ABOUT_A_PERSON = ["pushSubscribe", "savePrefs", "pushTest"];

/** Whether a feature lives here. A MOVED variable on the Worker, if there is one, replaces the list in moved.js. */
export function moved(env, feature) {
  const list = env.MOVED != null ? String(env.MOVED).split(",") : MOVED;
  return list.map(s => s.trim().toLowerCase()).indexOf(feature) >= 0;
}

export async function handleApi(request, env, url, session, headers, ctx) {
  const reply = (obj, status) => json(obj, status, headers);
  const groceriesHere = moved(env, "groceries"), coreHere = moved(env, "core");

  if (request.method === "GET") {
    const action = url.searchParams.get("action") === "notify" ? "notify" : "all";
    if (coreHere) { // nothing is asked of Apps Script
      const data = await hubGet(env, session, action, url.searchParams.get("reminders") === "1");
      if (action === "all" && groceriesHere) {
        if (!(await groceriesCopied(env))) { // only if the grocery list somehow never came over
          const first = await appsScript(env, { action: "all" });
          if (!first.error && first.data.ok === true) await copyGroceries(env, first.data.groceries);
        }
        if (await groceriesCopied(env)) data.groceries = await listGroceries(env);
      }
      return reply(data);
    }
    const query = { action };
    if (url.searchParams.get("reminders") === "1") query.reminders = "1";
    const up = await appsScript(env, query);
    if (up.error) return reply({ ok: false, error: up.error }, up.status);
    if (groceriesHere && action === "all" && up.data.ok === true) {
      if (!(await groceriesCopied(env))) await copyGroceries(env, up.data.groceries);
      up.data.groceries = await listGroceries(env);
    }
    return reply(up.data);
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (err) { return reply({ ok: false, error: "bad_json" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ ok: false, error: "bad_json" }, 400);

    if (groceriesHere && isGroceryAction(body.action)) {
      if (!(await groceriesCopied(env))) {
        const first = await appsScript(env, { action: "all" });
        if (first.error) return reply({ ok: false, error: first.error }, first.status);
        if (first.data.ok !== true) return reply({ ok: false, error: "backend_error" }, 502);
        await copyGroceries(env, first.data.groceries);
      }
      return reply(await groceryAction(env, body, session.person)); // Apps Script isn't asked at all
    }

    if (coreHere) {
      const data = await hubPost(env, session, body, p => { if (ctx && ctx.waitUntil) ctx.waitUntil(p); });
      // After a save the Hub is sent the whole state, grocery list included.
      if (data.tasks && groceriesHere && (await groceriesCopied(env))) data.groceries = await listGroceries(env);
      return reply(data);
    }

    body.by = session.person;
    if (ABOUT_A_PERSON.indexOf(body.action) >= 0) body.person = session.person;
    const up = await appsScript(env, null, body);
    if (up.error) return reply({ ok: false, error: up.error }, up.status);
    // Apps Script sends the whole state back after a save; its grocery list is the old one.
    if (groceriesHere && up.data.ok === true && "groceries" in up.data && (await groceriesCopied(env))) {
      up.data.groceries = await listGroceries(env);
    }
    return reply(up.data);
  }

  return reply({ ok: false, error: "not_found" }, 404);
}
