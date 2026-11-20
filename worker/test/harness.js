// What the tests share: the Worker in Cloudflare's local simulator, with a
// pretend Google and a pretend Apps Script, and helpers to sign devices in.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { Miniflare, Response as MfResponse } from "miniflare";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const HUB = "https://hub.example";
export const PAGE = "https://harperjonathanp-art.github.io";

const b64u = s => Buffer.from(s).toString("base64url");
const idToken = claims => "h." + b64u(JSON.stringify(Object.assign(
  { iss: "https://accounts.google.com", aud: "client-id", email_verified: true }, claims))) + ".s";

/** Starts a Worker. `vars` are extra variables for it, e.g. { MOVED: "groceries" }. */
export async function startHub(vars) {
  const h = {
    upstream: [],                                   // what the Worker sent to Apps Script
    appsScript: () => ({ ok: true, tasks: [] }),    // what Apps Script answers; tests replace it
  };

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
      let sent;
      if (request.method === "POST") {
        sent = { method: "POST", body: JSON.parse(await request.text()) };
        h.upstream.push(sent);
        h.pending = h.appsScript(sent);
        return new MfResponse(null, { status: 302, headers: { Location: "https://script.example/result" } });
      }
      let out;
      if (url.pathname === "/result") out = h.pending;
      else { sent = { method: "GET", query: Object.fromEntries(url.searchParams) }; h.upstream.push(sent); out = h.appsScript(sent); }
      return typeof out === "string" ? new MfResponse(out, { headers: { "Content-Type": "text/html" } }) : MfResponse.json(out);
    }
    return new MfResponse("unexpected " + request.url, { status: 599 });
  }

  h.mf = new Miniflare({
    modules: true, modulesRoot: root, scriptPath: path.join(root, "worker/index.js"),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-07-01",
    d1Databases: ["DB"],
    bindings: Object.assign({
      GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret",
      FAMILY_ACCOUNTS: "Jon=jon@example.com, maggie = Maggie@Example.com\nClayton=clayton@example.com, Nobody=x@example.com",
      APPS_SCRIPT_URL: "https://script.example/exec", FAMILY_PIN: "4321", PUSH_SECRET: "push-secret",
    }, vars || {}),
    outboundService: outbound,
  });
  h.db = await h.mf.getD1Database("DB");

  h.call = (p, init) => h.mf.dispatchFetch(HUB + p, Object.assign({ redirect: "manual" }, init));
  h.post = (p, body, token) => h.call(p, {
    method: "POST", body: JSON.stringify(body),
    headers: Object.assign({ Origin: PAGE }, token ? { Authorization: "Bearer " + token } : {}),
  });
  h.get = (p, token) => h.call(p, { headers: Object.assign({ Origin: PAGE }, token ? { Authorization: "Bearer " + token } : {}) });

  /** A device asking to sign in: its secret, the id it gives the Worker, and the code it's shown. */
  h.begin = async () => {
    const secret = randomBytes(32).toString("base64url");
    const id = createHash("sha256").update(secret).digest("hex");
    const d = await (await h.post("/auth/begin", { id, device: "iPhone" })).json();
    assert.equal(d.ok, true);
    assert.match(d.code, /^\d{4}$/);
    return { secret, id, code: d.code };
  };
  h.poll = async s => (await h.post("/auth/poll", { secret: s.secret })).json();

  /** Through Google as far as the confirm page. */
  h.toConfirmPage = async (s, email) => {
    const start = await h.call("/auth/google?d=" + s.id);
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get("Location"));
    assert.equal(to.host, "accounts.google.com");
    assert.equal(to.searchParams.get("redirect_uri"), HUB + "/auth/callback");
    assert.equal(to.searchParams.get("scope"), "openid email");
    const cookie = start.headers.get("Set-Cookie").split(";")[0];
    assert.match(start.headers.get("Set-Cookie"), /HttpOnly; Secure; SameSite=Lax/);
    const state = to.searchParams.get("state");
    const back = await h.call(`/auth/callback?state=${state}&code=${encodeURIComponent(email)}`, { headers: { Cookie: cookie } });
    return { res: back, html: await back.text(), cookie, state };
  };
  h.confirm = (c, person, cookie) => h.call("/auth/confirm", {
    method: "POST", headers: { Cookie: cookie == null ? c.cookie : cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant: (/name="grant" value="([^"]+)"/.exec(c.html) || [])[1] || "", person }).toString(),
  });

  /** Signs a device in with Google, all the way. Gives its token. */
  h.signIn = async (email, person) => {
    const s = await h.begin();
    const c = await h.toConfirmPage(s, email);
    assert.equal(c.res.status, 200);
    assert.equal((await h.confirm(c, person)).status, 200);
    const d = await h.poll(s);
    assert.equal(d.status, "done");
    return d.token;
  };
  return h;
}
