// Runs the Worker in Cloudflare's local simulator, with a pretend Google and
// a pretend Apps Script. From the worker folder: npm install, then npm test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { Miniflare, Response as MfResponse } from "miniflare";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HUB = "https://hub.example";
const PAGE = "https://harperjonathanp-art.github.io";
const upstream = []; // what the Worker sent to Apps Script
let appsScript = () => ({ ok: true, tasks: [], echo: true });
let mf, db;

const b64u = s => Buffer.from(s).toString("base64url");
const idToken = claims => "h." + b64u(JSON.stringify(Object.assign(
  { iss: "https://accounts.google.com", aud: "client-id", email_verified: true }, claims))) + ".s";

async function outbound(request) {
  const url = new URL(request.url);
  if (url.host === "oauth2.googleapis.com") {
    const form = new URLSearchParams(await request.text());
    assert.equal(form.get("client_secret"), "client-secret");
    assert.equal(form.get("redirect_uri"), HUB + "/auth/callback");
    const code = form.get("code");
    if (code === "broken") return new MfResponse("no", { status: 400 });
    const claims = code.startsWith("{") ? JSON.parse(code) : { email: code };
    return MfResponse.json({ id_token: idToken(claims) });
  }
  if (url.host === "script.example") {
    if (request.method === "POST") {
      upstream.push({ method: "POST", body: JSON.parse(await request.text()) });
      return new MfResponse(null, { status: 302, headers: { Location: "https://script.example/result" } });
    }
    if (url.pathname !== "/result") upstream.push({ method: "GET", query: Object.fromEntries(url.searchParams) });
    const out = appsScript();
    return typeof out === "string" ? new MfResponse(out, { headers: { "Content-Type": "text/html" } }) : MfResponse.json(out);
  }
  return new MfResponse("unexpected " + request.url, { status: 599 });
}

before(async () => {
  mf = new Miniflare({
    modules: true, modulesRoot: root, scriptPath: path.join(root, "worker/index.js"),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-07-01",
    d1Databases: ["DB"],
    bindings: {
      GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret",
      FAMILY_ACCOUNTS: "Jon=jon@example.com, maggie = Maggie@Example.com\nClayton=clayton@example.com, Nobody=x@example.com",
      APPS_SCRIPT_URL: "https://script.example/exec", FAMILY_PIN: "4321", PUSH_SECRET: "push-secret",
    },
    outboundService: outbound,
  });
  db = await mf.getD1Database("DB");
});
after(() => mf.dispose());

const call = (p, init) => mf.dispatchFetch(HUB + p, Object.assign({ redirect: "manual" }, init));
const post = (p, body, token) => call(p, {
  method: "POST", body: JSON.stringify(body),
  headers: Object.assign({ Origin: PAGE }, token ? { Authorization: "Bearer " + token } : {}),
});
const get = (p, token) => call(p, { headers: Object.assign({ Origin: PAGE }, token ? { Authorization: "Bearer " + token } : {}) });

/** A device asking to sign in: its secret, the id it gives the Worker, and the code it's shown. */
async function begin() {
  const secret = randomBytes(32).toString("base64url");
  const id = createHash("sha256").update(secret).digest("hex");
  const d = await (await post("/auth/begin", { id, device: "iPhone" })).json();
  assert.equal(d.ok, true);
  assert.match(d.code, /^\d{4}$/);
  return { secret, id, code: d.code };
}
const poll = async s => (await post("/auth/poll", { secret: s.secret })).json();

/** Through Google as far as the confirm page. */
async function toConfirmPage(s, email) {
  const start = await call("/auth/google?d=" + s.id);
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get("Location"));
  assert.equal(to.host, "accounts.google.com");
  assert.equal(to.searchParams.get("redirect_uri"), HUB + "/auth/callback");
  assert.equal(to.searchParams.get("scope"), "openid email");
  const cookie = start.headers.get("Set-Cookie").split(";")[0];
  assert.match(start.headers.get("Set-Cookie"), /HttpOnly; Secure; SameSite=Lax/);
  const state = to.searchParams.get("state");
  const back = await call(`/auth/callback?state=${state}&code=${encodeURIComponent(email)}`, { headers: { Cookie: cookie } });
  return { res: back, html: await back.text(), cookie, state };
}
const confirm = (c, person, cookie) => call("/auth/confirm", {
  method: "POST", headers: { Cookie: cookie == null ? c.cookie : cookie, "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant: (/name="grant" value="([^"]+)"/.exec(c.html) || [])[1] || "", person }).toString(),
});

/** Signs a device in with Google, all the way. */
async function signIn(email, person) {
  const s = await begin();
  const c = await toConfirmPage(s, email);
  assert.equal(c.res.status, 200);
  assert.equal((await confirm(c, person)).status, 200);
  const d = await poll(s);
  assert.equal(d.status, "done");
  return d.token;
}

test("the push relay still answers as before", async () => {
  assert.equal(await (await call("/")).text(), "Family Hub push relay is running.\n");
  assert.equal((await call("/send", { method: "POST", body: "{}" })).status, 401);
  const ok = await call("/send", { method: "POST", body: JSON.stringify({ subscriptions: [] }), headers: { Authorization: "Bearer push-secret" } });
  assert.equal(ok.status, 500); // past the secret check; these tests set no VAPID keys
  assert.deepEqual(await ok.json(), { error: "vapid_keys_missing" });
});

test("the API turns away a device that isn't signed in", async () => {
  for (const token of [undefined, "made-up"]) {
    const r = await get("/api?action=all", token);
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { ok: false, error: "signed_out" });
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), PAGE);
  }
  assert.equal(upstream.length, 0);
});

test("only the Hub's own page may read answers", async () => {
  const pre = await call("/api", { method: "OPTIONS", headers: { Origin: PAGE, "Access-Control-Request-Headers": "authorization" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  const other = await call("/api", { headers: { Origin: "https://elsewhere.example" } });
  assert.equal(other.headers.get("Access-Control-Allow-Origin"), null);
});

test("a parent signs in with Google", async () => {
  const s = await begin();
  assert.equal((await poll(s)).status, "waiting");
  const c = await toConfirmPage(s, "Jon@Example.com"); // Google's casing doesn't matter
  assert.equal(c.res.status, 200);
  assert.ok(c.html.includes(`<p class="code">${s.code}</p>`), "the confirm page shows the Hub's code");
  for (const p of ["Jon", "Clayton", "Heidi"]) assert.ok(c.html.includes(`value="${p}"`));
  assert.ok(!c.html.includes('value="Maggie"'), "a parent can't sign in as the other parent");
  assert.equal((await poll(s)).status, "waiting", "seeing the page isn't approval");
  assert.equal((await confirm(c, "Jon")).status, 200);
  const d = await poll(s);
  assert.deepEqual([d.status, d.person, d.parent], ["done", "Jon", true]);
  assert.equal((await poll(s)).status, "expired", "a token is handed out once");
  assert.deepEqual(await (await get("/auth/me", d.token)).json(), { ok: true, person: "Jon", parent: true });
  const stored = (await db.prepare("SELECT id FROM sessions").all()).results.map(r => r.id);
  assert.ok(!stored.includes(d.token), "the token itself isn't stored");
});

test("a parent can sign a child's device in with their own Google account", async () => {
  const token = await signIn("maggie@example.com", "Heidi");
  assert.deepEqual(await (await get("/auth/me", token)).json(), { ok: true, person: "Heidi", parent: false });
});

test("a child with a Google account signs in only as themselves", async () => {
  const s = await begin();
  const c = await toConfirmPage(s, "clayton@example.com");
  assert.ok(c.html.includes('type="hidden" name="person" value="Clayton"'));
  assert.equal((await confirm(c, "Jon")).status, 400);
  assert.equal((await poll(s)).status, "waiting");
  assert.equal((await confirm(c, "Clayton")).status, 200);
  assert.equal((await poll(s)).person, "Clayton");
});

test("Google sign-in refuses what it should", async () => {
  const s = await begin();
  let c = await toConfirmPage(s, "stranger@example.com");
  assert.equal(c.res.status, 403);
  c = await toConfirmPage(s, "x@example.com"); // listed under a name that isn't a family member
  assert.equal(c.res.status, 403);
  c = await toConfirmPage(s, JSON.stringify({ email: "jon@example.com", email_verified: false }));
  assert.equal(c.res.status, 502);
  c = await toConfirmPage(s, JSON.stringify({ email: "jon@example.com", aud: "someone-else" }));
  assert.equal(c.res.status, 502);
  c = await toConfirmPage(s, "broken");
  assert.equal(c.res.status, 502);

  const start = await call("/auth/google?d=" + s.id);
  const state = new URL(start.headers.get("Location")).searchParams.get("state");
  assert.equal((await call(`/auth/callback?state=${state}&code=jon@example.com`)).status, 400, "no cookie");
  assert.equal((await call(`/auth/callback?state=${state}&code=jon@example.com`, { headers: { Cookie: "hub_state=other" } })).status, 400);
  assert.equal((await call(`/auth/callback?state=${state}&error=access_denied`, { headers: { Cookie: "hub_state=" + state } })).status, 400);

  c = await toConfirmPage(s, "jon@example.com");
  assert.equal((await confirm(c, "Jon", "hub_state=other")).status, 410, "the button only works in the browser that signed in");
  assert.equal((await confirm(c, "Maggie")).status, 400);
  assert.equal((await confirm(c, "Jon")).status, 200);
  assert.equal((await confirm(c, "Clayton")).status, 410, "and only once");
  assert.equal((await poll(s)).person, "Jon");
  assert.equal((await call("/auth/google?d=" + "0".repeat(64))).status, 410);
});

test("a parent signs in another device by its code", async () => {
  const jon = await signIn("jon@example.com", "Jon");
  const kid = await signIn("clayton@example.com", "Clayton");
  const s = await begin();
  assert.equal((await post("/auth/approve", { code: s.code, person: "Heidi" })).status, 401);
  assert.equal((await post("/auth/approve", { code: s.code, person: "Heidi" }, kid)).status, 403);
  assert.equal((await post("/auth/approve", { code: s.code, person: "Maggie" }, jon)).status, 400);
  assert.equal((await post("/auth/approve", { code: s.code === "0000" ? "0001" : "0000", person: "Heidi" }, jon)).status, 404);
  assert.equal((await poll(s)).status, "waiting");
  assert.deepEqual(await (await post("/auth/approve", { code: " " + s.code + " ", person: "Heidi" }, jon)).json(), { ok: true, person: "Heidi" });
  assert.equal((await post("/auth/approve", { code: s.code, person: "Clayton" }, jon)).status, 404, "a code is used once");
  const d = await poll(s);
  assert.deepEqual([d.status, d.person, d.parent], ["done", "Heidi", false]);
});

test("a code stops working after ten minutes", async () => {
  const jon = await signIn("jon@example.com", "Jon");
  const s = await begin();
  await db.prepare("UPDATE signins SET created_at = created_at - 11 * 60000 WHERE id = ?").bind(s.id).run();
  assert.equal((await poll(s)).status, "expired");
  assert.equal((await post("/auth/approve", { code: s.code, person: "Jon" }, jon)).status, 404);
  assert.equal((await call("/auth/google?d=" + s.id)).status, 410);
  await begin(); // the next sign-in clears out the old one
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM signins WHERE id = ?").bind(s.id).first()).n, 0);
});

test("the API passes requests to Apps Script as the signed-in person", async () => {
  const kid = await signIn("clayton@example.com", "Clayton");
  upstream.length = 0;
  appsScript = () => ({ ok: true, tasks: [{ id: "a1" }] });

  let r = await get("/api?action=all&reminders=1&pin=0000", kid);
  assert.deepEqual(await r.json(), { ok: true, tasks: [{ id: "a1" }] });
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), PAGE);
  assert.deepEqual(upstream.pop(), { method: "GET", query: { action: "all", pin: "4321", reminders: "1" } });

  await get("/api?action=notify", kid);
  assert.deepEqual(upstream.pop(), { method: "GET", query: { action: "notify", pin: "4321" } });

  r = await post("/api", { action: "toggleTask", id: "a1", by: "Jon", pin: "0000" }, kid);
  assert.deepEqual(await r.json(), { ok: true, tasks: [{ id: "a1" }] }, "the answer comes back through Apps Script's redirect");
  assert.deepEqual(upstream.pop().body, { action: "toggleTask", id: "a1", by: "Clayton", pin: "4321" });

  await post("/api", { action: "savePrefs", person: "Jon", prefs: {} }, kid);
  assert.deepEqual(upstream.pop().body, { action: "savePrefs", person: "Clayton", prefs: {}, by: "Clayton", pin: "4321" });

  await post("/api", { action: "pushUnsubscribe", endpoint: "https://e" }, kid);
  assert.equal(upstream.pop().body.person, undefined);

  assert.equal((await call("/api", { method: "POST", body: "nope", headers: { Authorization: "Bearer " + kid } })).status, 400);
  assert.equal(upstream.length, 0);

  appsScript = () => "<html>Script error</html>";
  r = await get("/api?action=all", kid);
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { ok: false, error: "backend_error" });
  appsScript = () => ({ ok: false, error: "bad_pin" });
  assert.deepEqual(await (await get("/api?action=all", kid)).json(), { ok: false, error: "backend_pin" });
});

test("signing out, and a parent signing another device out", async () => {
  const jon = await signIn("jon@example.com", "Jon");
  const kid = await signIn("clayton@example.com", "Clayton");
  assert.equal((await get("/auth/devices", kid)).status, 403);
  const list = (await (await get("/auth/devices", jon)).json()).devices;
  const mine = list.filter(d => d.here);
  assert.deepEqual(mine.map(d => [d.person, d.by, d.device]), [["Jon", "Jon", "iPhone"]]);
  const kids = list.filter(d => d.person === "Clayton").pop();

  assert.equal((await post("/auth/signout", { device: mine[0].id }, kid)).status, 403, "a child can't sign a parent out");
  assert.equal((await get("/auth/me", jon)).status, 200);
  assert.equal((await post("/auth/signout", { device: kids.id }, jon)).status, 200);
  assert.equal((await get("/auth/me", kid)).status, 401);
  assert.equal((await post("/auth/signout", {}, jon)).status, 200);
  assert.equal((await get("/api?action=all", jon)).status, 401);
});
