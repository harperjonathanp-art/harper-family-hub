/**
 * HARPER FAMILY HUB — the Hub's API, for now passed straight to Apps Script
 *
 * A signed-in Hub talks to /api exactly as it talked to the Apps Script web
 * app: GET ?action=all, POST { action, … }. Until each feature moves into this
 * Worker, the request is handed on to Apps Script with the family PIN added
 * here, so a signed-in device never holds the PIN.
 *
 * Who is asking comes from the session, not from what the page says: `by`
 * (who ticked, who added) and `person` (whose notifications) are set here.
 *
 * SETUP — the Worker's Settings > Variables and Secrets:
 *   APPS_SCRIPT_URL  secret  the web app's address (…/exec)
 *   FAMILY_PIN       secret  the same PIN as the FAMILY_PIN Script Property
 */

import { json } from "./util.js";

// Actions that name whose settings or phone they're about.
const ABOUT_A_PERSON = ["pushSubscribe", "savePrefs", "pushTest"];

export async function handleApi(request, env, url, session, headers) {
  const reply = (obj, status) => json(obj, status, headers);
  const base = String(env.APPS_SCRIPT_URL || "").trim(), pin = String(env.FAMILY_PIN || "").trim();
  if (!base || !pin) return reply({ ok: false, error: "not_configured" }, 503);

  let upstream;
  try {
    if (request.method === "GET") {
      const to = new URL(base);
      to.searchParams.set("action", url.searchParams.get("action") === "notify" ? "notify" : "all");
      to.searchParams.set("pin", pin);
      if (url.searchParams.get("reminders") === "1") to.searchParams.set("reminders", "1");
      upstream = await fetch(to.toString());
    } else if (request.method === "POST") {
      let body;
      try { body = await request.json(); } catch (err) { return reply({ ok: false, error: "bad_json" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ ok: false, error: "bad_json" }, 400);
      body.pin = pin;
      body.by = session.person;
      if (ABOUT_A_PERSON.indexOf(body.action) >= 0) body.person = session.person;
      // Apps Script answers a POST with a redirect to where the result waits; fetch follows it.
      upstream = await fetch(base, { method: "POST", body: JSON.stringify(body) });
    } else {
      return reply({ ok: false, error: "not_found" }, 404);
    }
  } catch (err) {
    return reply({ ok: false, error: "backend_unreachable" }, 502);
  }

  // Apps Script reports its own trouble as a web page, not JSON.
  const text = await upstream.text();
  let data;
  try { data = JSON.parse(text); } catch (err) {
    console.warn("apps script answered " + upstream.status + " without JSON");
    return reply({ ok: false, error: "backend_error" }, 502);
  }
  // The PIN is this Worker's to get right, not the device's: don't tell the page its PIN is wrong.
  if (data && data.ok === false && data.error === "bad_pin") return reply({ ok: false, error: "backend_pin" }, 503);
  return new Response(text, { status: 200, headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, headers) });
}
