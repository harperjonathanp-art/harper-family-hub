/**
 * HARPER FAMILY HUB — connecting the calendar
 *
 * A parent, signed in to the Hub, lets the Worker read the family's Google
 * calendars (read-only), once. Nothing has to come back to the Hub from
 * Google's page, as with sign-in:
 *
 *   POST /auth/calendar/begin      (a parent's Hub) -> a link good for ten minutes
 *   GET  /auth/calendar/start?t=   that link: on to Google
 *   GET  /auth/calendar/callback   Google sends the browser back; the grant is kept
 *   GET  /auth/calendar            (a signed-in Hub) -> whether it's connected
 *   POST /auth/calendar/disconnect (a parent's Hub) -> forgotten here and withdrawn at Google
 *
 * Only a parent's own Google account (FAMILY_ACCOUNTS) is accepted. What Google
 * gives is kept encrypted (hub/calendar.js).
 *
 * SETUP, in the Google Cloud project that has the Hub's OAuth client:
 *   - enable the Google Calendar API
 *   - add <this Worker's address>/auth/calendar/callback to the client's
 *     Authorized redirect URIs
 *   - publish the app ("In production"): while it is "Testing", Google ends
 *     calendar access after seven days
 */

import { json, sha256Hex, randomToken, sameString, esc, PARENTS } from "./util.js";
import { sessionFor, familyAccounts, page } from "./auth.js";
import { transact } from "./store.js";
import * as calendar from "./hub/calendar.js";

const MINUTES = 10;
const PENDING = "CALENDAR_CONNECT"; // { hash, until, by, state }

const cookieOf = request => { const c = (request.headers.get("Cookie") || "").split(/;\s*/).filter(x => x.indexOf("hub_cal=") === 0)[0]; return c ? c.slice(8) : ""; };
const setCookie = (value, age) => `hub_cal=${value}; Path=/auth/calendar; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
const pending = c => { try { return JSON.parse(c.props[PENDING] || "null"); } catch (err) { return null; } };

export async function handleCalendarAuth(request, env, url, headers) {
  const path = url.pathname, method = request.method;
  const reply = (obj, status) => json(obj, status, headers);

  if (method === "GET" && path === "/auth/calendar/start") return start(env, url);
  if (method === "GET" && path === "/auth/calendar/callback") return callback(request, env, url);

  const session = await sessionFor(request, env);
  if (!session) return reply({ ok: false, error: "signed_out" }, 401);
  if (method === "GET" && path === "/auth/calendar") {
    const s = await transact(env, [], c => Object.assign(calendar.calendarStatus(c.props), { check: c.props.CALENDAR_CHECK ? JSON.parse(c.props.CALENDAR_CHECK) : null }));
    return reply({ ok: true, connected: s.connected, readAt: s.readAt, errors: s.errors,
      calendars: calendar.CALENDARS.filter(x => String(env[x.env] || "").trim()).map(x => x.name), check: session.parent ? s.check : undefined });
  }
  if (!session.parent) return reply({ ok: false, error: "parents_only" }, 403);
  if (method === "POST" && path === "/auth/calendar/begin") {
    const t = randomToken(32), hash = await sha256Hex(t);
    await transact(env, [], c => { c.props[PENDING] = JSON.stringify({ hash, until: Date.now() + MINUTES * 60000, by: session.person }); });
    return reply({ ok: true, url: url.origin + "/auth/calendar/start?t=" + t, minutes: MINUTES });
  }
  if (method === "POST" && path === "/auth/calendar/disconnect") {
    const grant = await transact(env, [], c => { const g = c.props.GOOGLE_CALENDAR; calendar.dropGrant(c); delete c.props.CALENDAR_CHECK; return g; });
    if (grant) await calendar.withdraw(env, grant);
    return reply({ ok: true });
  }
  return reply({ ok: false, error: "not_found" }, 404);
}

/** The link from the Hub: on to Google, remembering which request this is. */
async function start(env, url) {
  const hash = await sha256Hex(String(url.searchParams.get("t") || "")), state = randomToken(24);
  const ok = await transact(env, [], c => {
    const p = pending(c);
    if (!p || p.hash !== hash || p.until < Date.now() || p.state) return false; // a link works once
    p.state = state;
    c.props[PENDING] = JSON.stringify(p);
    return true;
  });
  if (!ok) return page("That link has expired", "Go back to the Family Hub's Settings and tap Connect the calendar again.", 410);
  const to = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  to.searchParams.set("client_id", String(env.GOOGLE_CLIENT_ID || "").trim());
  to.searchParams.set("redirect_uri", url.origin + "/auth/calendar/callback");
  to.searchParams.set("response_type", "code");
  to.searchParams.set("scope", "openid email " + calendar.CALENDAR_SCOPE);
  to.searchParams.set("access_type", "offline"); // so the Worker can keep reading without anyone signed in
  to.searchParams.set("prompt", "consent select_account");
  to.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { Location: to.toString(), "Set-Cookie": setCookie(state, MINUTES * 60), "Cache-Control": "no-store" } });
}

/** Google sends the browser back here with a code; it is traded for the grant, which is kept encrypted. */
async function callback(request, env, url) {
  const again = "Go back to the Family Hub's Settings and tap Connect the calendar again.";
  const state = String(url.searchParams.get("state") || "");
  if (!state || !sameString(cookieOf(request), state)) return page("That didn't match", again, 400);
  if (url.searchParams.get("error") || !url.searchParams.get("code")) return page("The calendar wasn't connected", "Nothing was changed. " + again, 400);
  const p = await transact(env, [], c => pending(c));
  if (!p || p.state !== state || p.until < Date.now()) return page("That link has expired", again, 410);

  let data = {};
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(url.searchParams.get("code")), grant_type: "authorization_code", redirect_uri: url.origin + "/auth/calendar/callback",
        client_id: String(env.GOOGLE_CLIENT_ID || "").trim(), client_secret: String(env.GOOGLE_CLIENT_SECRET || "").trim(),
      }).toString(),
    });
    data = await res.json();
    if (!res.ok) throw new Error("token " + res.status);
  } catch (err) {
    console.warn("calendar connect: " + String(err && err.message || err).slice(0, 100));
    return page("Google couldn't confirm that", again, 502);
  }
  // Whose calendar access this is: it came straight from Google, so the token's signature needs no second check.
  let email = "", verified = false;
  try {
    const part = String(data.id_token || "").split(".")[1] || "";
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4)), ch => ch.charCodeAt(0))));
    email = String(claims.email || "").toLowerCase(); verified = claims.email_verified === true && claims.aud === String(env.GOOGLE_CLIENT_ID || "").trim();
  } catch (err) {}
  const person = verified ? familyAccounts(env)[email] : null;
  if (!person || PARENTS.indexOf(person) < 0) {
    if (data.refresh_token) await calendar.withdraw(env, null, data.refresh_token);
    return page("That Google account can't connect the calendar", "Only Jon's or Maggie's own account can. " + again, 403);
  }
  if (!data.refresh_token || String(data.scope || "").indexOf(calendar.CALENDAR_SCOPE) < 0) {
    return page("Google didn't give calendar access", "On Google's page, leave the box for seeing your calendars ticked. " + again, 400);
  }
  const sealed = await calendar.sealGrant(env, data.refresh_token);
  await transact(env, [], c => { calendar.saveGrant(c, sealed); delete c.props[PENDING]; });
  return page("The calendar is connected", null, 200, `
    <p>The Family Hub can now read ${esc(person)}'s Google calendars. It can only read them, and only the ones the Hub is set up to show.</p>
    <p>Go back to the Family Hub: tap <b>Done</b> at the top of this page, or close it.</p>`,
    { "Set-Cookie": setCookie("", 0) });
}
