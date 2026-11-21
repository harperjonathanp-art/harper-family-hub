/**
 * HARPER FAMILY HUB — sign-in
 *
 * A device is signed in when it holds a session token. It gets one in either
 * of two ways, and both start the same: the Hub asks for a sign-in
 * (/auth/begin), shows the short code it is given, and keeps asking whether
 * it has been approved (/auth/poll).
 *
 *   With Google   The Hub opens /auth/google. Google says who it is, the
 *                 confirm page shows the same short code, and tapping
 *                 "Sign in" approves it. Only the accounts listed in
 *                 FAMILY_ACCOUNTS get that far.
 *   By a parent   A parent already signed in types the code into their own
 *                 Hub (/auth/approve). For a device whose owner has no
 *                 Google account.
 *
 * Nothing has to travel back from Google's window to the Hub, so it works the
 * same in a home-screen app, where pop-ups and redirects often don't.
 *
 * Only a hash of each token is stored: reading the database doesn't let
 * anyone sign in.
 *
 * SETUP — the Worker's Settings > Variables and Secrets:
 *   GOOGLE_CLIENT_ID      text    the OAuth client's ID
 *   GOOGLE_CLIENT_SECRET  secret  the OAuth client's secret
 *   FAMILY_ACCOUNTS       secret  who each Google account is, e.g.
 *                                 Jon=jon@example.com, Maggie=maggie@example.com
 */

import { HUB_URL, PARENTS, KIDS, PEOPLE, json, sha256Hex, randomToken, sameString, esc } from "./util.js";

const SIGNIN_MINUTES = 10; // how long a short code lasts
const MAX_PENDING = 30;    // sign-ins waiting at once; far more than a family needs
const SEEN_EVERY_MS = 6 * 3600 * 1000; // how often a session's "last used" is rewritten

// ---------- storage ----------

let tablesReady = false;

/** Makes the tables the first time they're needed, as the Apps Script backend did with its tabs. */
export async function ready(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, person TEXT NOT NULL, approved_by TEXT NOT NULL,
      device TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS signins (
      id TEXT PRIMARY KEY, code TEXT NOT NULL, device TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      state TEXT, google_person TEXT, grant_hash TEXT, person TEXT, approved_by TEXT)`),
  ]);
  tablesReady = true;
}

/** The session a request carries, or null. */
export async function sessionFor(request, env) {
  const m = /^Bearer\s+(\S+)$/.exec(request.headers.get("Authorization") || "");
  if (!m) return null;
  await ready(env);
  const id = await sha256Hex(m[1]);
  const row = await env.DB.prepare("SELECT id, person, last_seen FROM sessions WHERE id = ?").bind(id).first();
  if (!row || PEOPLE.indexOf(row.person) < 0) return null;
  const now = Date.now();
  if (now - row.last_seen > SEEN_EVERY_MS) {
    await env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").bind(now, id).run();
  }
  return { id: row.id, person: row.person, parent: PARENTS.indexOf(row.person) >= 0 };
}

// ---------- who's who ----------

/** FAMILY_ACCOUNTS as { email: person }. "Jon=a@x.com, Maggie=b@x.com", one or more accounts each. */
export function familyAccounts(env) {
  const out = {};
  String(env.FAMILY_ACCOUNTS || "").split(/[,;\n]+/).forEach(part => {
    const m = /^\s*([A-Za-z]+)\s*[=:]\s*(\S+@\S+)\s*$/.exec(part);
    if (!m) return;
    const person = PEOPLE.filter(p => p.toLowerCase() === m[1].toLowerCase())[0];
    if (person) out[m[2].toLowerCase()] = person;
  });
  return out;
}

export function googleReady(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && Object.keys(familyAccounts(env)).length);
}

/** Who a signed-in person may sign a device in as: themselves, and for a parent, either child. */
function mayBe(person) {
  return PARENTS.indexOf(person) >= 0 ? [person].concat(KIDS) : [person];
}

// ---------- routes ----------

/** Everything under /auth/. `session` is the caller's own, if it sent one. */
export async function handleAuth(request, env, url, headers) {
  const path = url.pathname, method = request.method;
  await ready(env);
  if (method === "GET" && path === "/auth/google") return googleStart(env, url);
  if (method === "GET" && path === "/auth/callback") return googleCallback(request, env, url);
  if (method === "POST" && path === "/auth/confirm") return googleConfirm(request, env);

  const reply = (obj, status) => json(obj, status, headers);
  if (method === "GET" && path === "/auth/me") {
    const s = await sessionFor(request, env);
    return s ? reply({ ok: true, person: s.person, parent: s.parent }) : reply({ ok: false, error: "signed_out" }, 401);
  }
  if (method === "GET" && path === "/auth/devices") return devices(request, env, reply);
  if (method !== "POST") return reply({ ok: false, error: "not_found" }, 404);

  let body = {};
  try { body = await request.json(); } catch (err) { return reply({ ok: false, error: "bad_json" }, 400); }
  if (path === "/auth/begin") return begin(env, body, reply);
  if (path === "/auth/poll") return poll(env, body, reply);
  if (path === "/auth/approve") return approve(request, env, body, reply);
  if (path === "/auth/signout") return signOut(request, env, body, reply);
  return reply({ ok: false, error: "not_found" }, 404);
}

/** The Hub asks to sign in. `id` is the hash of a secret only that device holds. */
async function begin(env, body, reply) {
  const id = String(body.id || "");
  if (!/^[0-9a-f]{64}$/.test(id)) return reply({ ok: false, error: "bad_id" }, 400);
  const now = Date.now();
  await env.DB.prepare("DELETE FROM signins WHERE created_at < ? OR id = ?").bind(now - SIGNIN_MINUTES * 60000, id).run();
  const pending = (await env.DB.prepare("SELECT code FROM signins").all()).results.map(r => r.code);
  if (pending.length >= MAX_PENDING) return reply({ ok: false, error: "busy" }, 429);
  let code;
  do { code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0"); }
  while (pending.indexOf(code) >= 0); // a parent types this, so no two waiting sign-ins share one
  const device = String(body.device || "").replace(/[^\w .,()\-]/g, "").slice(0, 40);
  await env.DB.prepare("INSERT INTO signins (id, code, device, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, code, device, now).run();
  return reply({ ok: true, code: code, minutes: SIGNIN_MINUTES, google: googleReady(env) });
}

/** The Hub asks whether its sign-in has been approved. Approved, it gets its token, once. */
async function poll(env, body, reply) {
  const id = await sha256Hex(String(body.secret || ""));
  const fresh = Date.now() - SIGNIN_MINUTES * 60000;
  const done = await env.DB.prepare(
    "DELETE FROM signins WHERE id = ? AND person IS NOT NULL AND created_at >= ? RETURNING person, approved_by, device")
    .bind(id, fresh).first();
  if (!done) {
    const waiting = await env.DB.prepare("SELECT 1 AS x FROM signins WHERE id = ? AND created_at >= ?").bind(id, fresh).first();
    return reply({ ok: true, status: waiting ? "waiting" : "expired" });
  }
  const token = randomToken(32), now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id, person, approved_by, device, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), done.person, done.approved_by || "", done.device || "", now, now).run();
  return reply({ ok: true, status: "done", token: token, person: done.person, parent: PARENTS.indexOf(done.person) >= 0 });
}

/** A parent, in their own Hub, signs in the device showing `code`. */
async function approve(request, env, body, reply) {
  const s = await sessionFor(request, env);
  if (!s) return reply({ ok: false, error: "signed_out" }, 401);
  if (!s.parent) return reply({ ok: false, error: "parents_only" }, 403);
  const person = String(body.person || "");
  if (mayBe(s.person).indexOf(person) < 0) return reply({ ok: false, error: "bad_person" }, 400);
  const done = await env.DB.prepare(
    "UPDATE signins SET person = ?, approved_by = ? WHERE code = ? AND person IS NULL AND created_at >= ? RETURNING id")
    .bind(person, s.person, String(body.code || "").trim(), Date.now() - SIGNIN_MINUTES * 60000).first();
  return done ? reply({ ok: true, person: person }) : reply({ ok: false, error: "no_such_code" }, 404);
}

/** Signs out this device, or (a parent only) the device with the given id. */
async function signOut(request, env, body, reply) {
  const s = await sessionFor(request, env);
  if (!s) return reply({ ok: true });
  let id = s.id;
  if (body.device && body.device !== s.id) {
    if (!s.parent) return reply({ ok: false, error: "parents_only" }, 403);
    id = String(body.device);
  }
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
  return reply({ ok: true });
}

/** For a parent: every signed-in device. */
async function devices(request, env, reply) {
  const s = await sessionFor(request, env);
  if (!s) return reply({ ok: false, error: "signed_out" }, 401);
  if (!s.parent) return reply({ ok: false, error: "parents_only" }, 403);
  const rows = (await env.DB.prepare(
    "SELECT id, person, approved_by, device, created_at, last_seen FROM sessions ORDER BY created_at").all()).results;
  return reply({ ok: true, devices: rows.map(r => ({
    id: r.id, person: r.person, by: r.approved_by, device: r.device,
    addedAt: r.created_at, lastSeen: r.last_seen, here: r.id === s.id,
  })) });
}

// ---------- Google ----------

/** Sends the browser to Google, remembering which sign-in it's for. */
async function googleStart(env, url) {
  if (!googleReady(env)) return page("Google sign-in isn't set up yet", "Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and FAMILY_ACCOUNTS to the Worker, then try again.", 503);
  const state = randomToken(24);
  const found = await env.DB.prepare(
    "UPDATE signins SET state = ?, google_person = NULL, grant_hash = NULL WHERE id = ? AND person IS NULL AND created_at >= ? RETURNING id")
    .bind(state, String(url.searchParams.get("d") || ""), Date.now() - SIGNIN_MINUTES * 60000).first();
  if (!found) return page("That sign-in has expired", "Go back to the Family Hub and tap Sign in with Google again.", 410);
  const to = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  to.searchParams.set("client_id", env.GOOGLE_CLIENT_ID.trim());
  to.searchParams.set("redirect_uri", url.origin + "/auth/callback");
  to.searchParams.set("response_type", "code");
  to.searchParams.set("scope", "openid email");
  to.searchParams.set("state", state);
  to.searchParams.set("prompt", "select_account");
  return new Response(null, { status: 302, headers: { Location: to.toString(), "Set-Cookie": stateCookie(state), "Cache-Control": "no-store" } });
}

/** Google sends the browser back here. Shows who it is and asks them to confirm. */
async function googleCallback(request, env, url) {
  const state = String(url.searchParams.get("state") || "");
  if (!state || !sameString(cookie(request, "hub_state"), state)) {
    return page("That sign-in didn't match", "Go back to the Family Hub and tap Sign in with Google again.", 400);
  }
  if (url.searchParams.get("error") || !url.searchParams.get("code")) {
    return page("Sign-in was cancelled", "Nothing was changed. Go back to the Family Hub to try again.", 400);
  }
  const row = await env.DB.prepare("SELECT id, code FROM signins WHERE state = ? AND person IS NULL AND created_at >= ?")
    .bind(state, Date.now() - SIGNIN_MINUTES * 60000).first();
  if (!row) return page("That sign-in has expired", "Go back to the Family Hub and tap Sign in with Google again.", 410);

  let email;
  try {
    email = await googleEmail(env, String(url.searchParams.get("code")), url.origin + "/auth/callback");
  } catch (err) {
    console.warn("google sign-in: " + String(err && err.message || err).slice(0, 120)); // never the account
    return page("Google couldn't confirm that", "Go back to the Family Hub and tap Sign in with Google again.", 502);
  }
  const person = familyAccounts(env)[email];
  if (!person) {
    return page("That Google account isn't part of the Family Hub",
      "Choose a different account, or ask a parent to sign this device in from their own Hub.", 403);
  }
  const grant = randomToken(24);
  await env.DB.prepare("UPDATE signins SET google_person = ?, grant_hash = ? WHERE id = ?")
    .bind(person, await sha256Hex(grant), row.id).run();

  const who = mayBe(person);
  const choice = who.length > 1
    ? `<p class="q">Whose device is it?</p>` + who.map((p, i) =>
        `<label class="pick"><input type="radio" name="person" value="${esc(p)}"${i ? "" : " checked"}> ${esc(p)}</label>`).join("")
    : `<input type="hidden" name="person" value="${esc(person)}">`;
  return page("Sign in to the Family Hub", null, 200, `
    <p>Hello, ${esc(person)}. The Hub you're signing in should be showing this code:</p>
    <p class="code">${esc(row.code)}</p>
    <p class="warn">If you didn't just tap Sign in with Google in the Family Hub, or the code is different, close this page.</p>
    <form method="post" action="/auth/confirm">
      <input type="hidden" name="grant" value="${esc(grant)}">
      ${choice}
      <button type="submit">Sign in</button>
    </form>`);
}

/** The confirm page's button. Approves the sign-in; the Hub picks it up on its next poll. */
async function googleConfirm(request, env) {
  let form;
  try { form = await request.formData(); } catch (err) { return page("That didn't work", "Go back to the Family Hub and try again.", 400); }
  const grantHash = await sha256Hex(String(form.get("grant") || ""));
  const row = await env.DB.prepare(
    "SELECT id, state, google_person FROM signins WHERE grant_hash = ? AND person IS NULL AND created_at >= ?")
    .bind(grantHash, Date.now() - SIGNIN_MINUTES * 60000).first();
  if (!row || !sameString(cookie(request, "hub_state"), row.state || "")) {
    return page("That sign-in has expired", "Go back to the Family Hub and tap Sign in with Google again.", 410);
  }
  const person = String(form.get("person") || "");
  if (mayBe(row.google_person).indexOf(person) < 0) return page("That didn't work", "Go back to the Family Hub and try again.", 400);
  await env.DB.prepare("UPDATE signins SET person = ?, approved_by = ?, grant_hash = NULL, state = NULL WHERE id = ?")
    .bind(person, row.google_person, row.id).run();
  return page("Signed in", null, 200, `
    <p>This device is signed in as ${esc(person)}.</p>
    <p>Go back to the Family Hub: tap <b>Done</b> at the top of this page, or close it. The Hub finishes by itself within a few seconds.</p>
    <p><a href="${esc(HUB_URL)}">Open the Family Hub</a></p>`,
    { "Set-Cookie": stateCookie("", 0) });
}

/** Trades Google's one-time code for the account's verified email address. */
async function googleEmail(env, code, redirectUri) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: code, client_id: env.GOOGLE_CLIENT_ID.trim(), client_secret: env.GOOGLE_CLIENT_SECRET.trim(),
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) throw new Error("token " + res.status);
  // The ID token came straight from Google over HTTPS, so its signature needs no second check here.
  const idToken = String((await res.json()).id_token || "");
  const part = idToken.split(".")[1] || "";
  const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4));
  const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  if (claims.aud !== env.GOOGLE_CLIENT_ID.trim()) throw new Error("wrong audience");
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("wrong issuer");
  if (!claims.email || claims.email_verified !== true) throw new Error("email not verified");
  return String(claims.email).toLowerCase();
}

// ---------- small helpers ----------

function stateCookie(value, maxAge) {
  return `hub_state=${value}; Path=/auth; Max-Age=${maxAge == null ? SIGNIN_MINUTES * 60 : maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function cookie(request, name) {
  const found = (request.headers.get("Cookie") || "").split(/;\s*/).filter(c => c.indexOf(name + "=") === 0)[0];
  return found ? found.slice(name.length + 1) : "";
}

/** A plain page in the Hub's colours, for the few steps that happen outside it. */
export function page(title, text, status, html, headers) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
  body { margin: 0; background: #e7eae0; color: #1f2a24; font: 17px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width: 26rem; margin: 0 auto; padding: 3rem 1.25rem; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 1rem; }
  .code { font-size: 2.5rem; font-weight: 700; letter-spacing: .2em; margin: .5rem 0; }
  .warn { font-size: .9rem; color: #5b6660; }
  .q { font-weight: 600; margin-bottom: .25rem; }
  .pick { display: block; padding: .5rem 0; font-size: 1.1rem; }
  .pick input { width: 1.2rem; height: 1.2rem; vertical-align: -.15rem; margin-right: .4rem; }
  button { margin-top: 1.25rem; width: 100%; padding: .9rem; border: 0; border-radius: 10px;
    background: #2f5d46; color: #fff; font: inherit; font-weight: 600; }
  a { color: #2f5d46; }
  @media (prefers-color-scheme: dark) {
    body { background: #161b18; color: #e6ebe4; } .warn { color: #9aa59e; } a { color: #8fc7a8; }
  }
</style></head><body><main><h1>${esc(title)}</h1>${text ? `<p>${esc(text)}</p>` : ""}${html || ""}</main></body></html>`, {
    status: status || 200,
    headers: Object.assign({
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    }, headers || {}),
  });
}
