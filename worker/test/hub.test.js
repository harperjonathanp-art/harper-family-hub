// Sign-in. From the worker folder: npm install, then npm test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHub, PAGE } from "./harness.js";

let h, db, call, post, get, begin, poll, toConfirmPage, confirm, signIn;
before(async () => {
  h = await startHub();
  ({ db, call, post, get, begin, poll, toConfirmPage, confirm, signIn } = h);
});
after(() => h.mf.dispose());

test("anything that isn't sign-in or the API is turned away", async () => {
  assert.equal(await (await call("/")).text(), "Family Hub is running.\n");
  const old = await call("/send", { method: "POST", body: JSON.stringify({ subscriptions: [] }), headers: { Authorization: "Bearer anything" } });
  assert.deepEqual([old.status, await old.json()], [404, { ok: false, error: "not_found" }], "the relay Apps Script used is gone");
});

test("the API turns away a device that isn't signed in", async () => {
  for (const token of [undefined, "made-up"]) {
    const r = await get("/api?action=all", token);
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { ok: false, error: "signed_out" });
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), PAGE);
  }
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
