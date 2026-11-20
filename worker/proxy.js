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
 * SETUP — the Worker's Settings > Variables and Secrets:
 *   APPS_SCRIPT_URL  secret  the web app's address (…/exec)
 *   FAMILY_PIN       secret  the same PIN as the FAMILY_PIN Script Property
 * Which features are answered here is the list in moved.js.
 */

import { json } from "./util.js";
import { MOVED } from "./moved.js";
import { isGroceryAction, groceryAction, listGroceries, groceriesCopied, copyGroceries } from "./groceries.js";

// Actions that name whose settings or phone they're about.
const ABOUT_A_PERSON = ["pushSubscribe", "savePrefs", "pushTest"];

/** Whether a feature lives here. A MOVED variable on the Worker, if there is one, replaces the list in moved.js. */
function moved(env, feature) {
  const list = env.MOVED != null ? String(env.MOVED).split(",") : MOVED;
  return list.map(s => s.trim().toLowerCase()).indexOf(feature) >= 0;
}

export async function handleApi(request, env, url, session, headers) {
  const reply = (obj, status) => json(obj, status, headers);
  const groceriesHere = moved(env, "groceries");

  if (request.method === "GET") {
    const action = url.searchParams.get("action") === "notify" ? "notify" : "all";
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

/**
 * Asks Apps Script: a GET with `query`, or a POST of `body`. The PIN is added here.
 * Gives { data } (its JSON answer) or { error, status }.
 */
async function appsScript(env, query, body) {
  const base = String(env.APPS_SCRIPT_URL || "").trim(), pin = String(env.FAMILY_PIN || "").trim();
  if (!base || !pin) return { error: "not_configured", status: 503 };
  let res;
  try {
    if (body) {
      // Apps Script answers a POST with a redirect to where the result waits; fetch follows it.
      res = await fetch(base, { method: "POST", body: JSON.stringify(Object.assign({}, body, { pin })) });
    } else {
      const to = new URL(base);
      Object.keys(query).forEach(k => to.searchParams.set(k, query[k]));
      to.searchParams.set("pin", pin);
      res = await fetch(to.toString());
    }
  } catch (err) {
    return { error: "backend_unreachable", status: 502 };
  }
  // Apps Script reports its own trouble as a web page, not JSON.
  let data;
  try { data = JSON.parse(await res.text()); } catch (err) {
    console.warn("apps script answered " + res.status + " without JSON");
    return { error: "backend_error", status: 502 };
  }
  if (!data || typeof data !== "object") return { error: "backend_error", status: 502 };
  // The PIN is this Worker's to get right, not the device's: don't tell the page its PIN is wrong.
  if (data.ok === false && data.error === "bad_pin") return { error: "backend_pin", status: 503 };
  return { data };
}
