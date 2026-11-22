// The calendar, wired in: a parent connects it, the timer reads it, and the Hub is shown it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHub, MfResponse, HUB } from "./harness.js";
import { fakeCalendars } from "./fake-calendar.js";

const NOW = "2026-11-21T15:02:00Z";
const IDS = { CAL_JON: "jon@example.com", CAL_MAGGIE: "maggie@example.com", CAL_FAMILY: "family@group.calendar.google.com", CAL_MCHS: "school@example.org" };
const at = Date.parse("2026-11-22T20:00:00Z");
const cals = {
  "jon@example.com": { tz: "America/New_York", events: [{ title: "Dentist", start: at, end: at + 3600e3 }] },
  "maggie@example.com": { tz: "America/New_York", events: [{ title: "Book club", start: at + 86400e3, end: at + 90000e3 }] },
  "family@group.calendar.google.com": { tz: "UTC", events: [{ title: "Grandma visits", allDay: true, from: "2026-11-25", to: "2026-11-28" }] },
  "school@example.org": { tz: "America/New_York", events: [{ title: "No school", allDay: true, from: "2026-11-23", to: "2026-11-24" }] },
};
const fake = fakeCalendars(cals);
const google = { codes: {}, revoked: [], tokenCalls: 0 };
const b64u = s => Buffer.from(s).toString("base64url");
let h, jon, kid;
const props = async key => { const r = await h.db.prepare("SELECT value FROM props WHERE key = ?").bind(key).first(); return r ? r.value : null; };
const cron = async () => (await h.mf.getWorker()).scheduled({ cron: "*/5 * * * *" });
/** Through Google's page: gives the response of the Worker's callback. `code` picks what Google answers. */
async function connect(token, code) {
  const b = await (await h.post("/auth/calendar/begin", {}, token)).json();
  if (!b.ok) return b;
  const start = await h.call(b.url.slice(HUB.length));
  const to = new URL(start.headers.get("Location")), cookie = start.headers.get("Set-Cookie").split(";")[0];
  assert.deepEqual([to.host, to.searchParams.get("access_type"), to.searchParams.get("scope"), to.searchParams.get("redirect_uri")],
    ["accounts.google.com", "offline", "openid email https://www.googleapis.com/auth/calendar.readonly", HUB + "/auth/calendar/callback"]);
  assert.equal((await h.call(b.url.slice(HUB.length))).status, 410, "the link works once");
  return h.call(`/auth/calendar/callback?state=${to.searchParams.get("state")}&code=${code}`, { headers: { Cookie: cookie } });
}

before(async () => {
  h = await startHub(Object.assign({ TEST_NOW: NOW }, IDS));
  google.codes = {
    jon: { refresh_token: "grant-jon", scope: "openid https://www.googleapis.com/auth/calendar.readonly", email: "jon@example.com" },
    stranger: { refresh_token: "grant-stranger", scope: "openid https://www.googleapis.com/auth/calendar.readonly", email: "someone@example.com" },
    child: { refresh_token: "grant-child", scope: "openid https://www.googleapis.com/auth/calendar.readonly", email: "clayton@example.com" },
    unticked: { refresh_token: "grant-x", scope: "openid email", email: "jon@example.com" },
  };
  h.site = async (request, url) => {
    if (url.href.startsWith("https://oauth2.googleapis.com/token")) {
      const f = new URLSearchParams(await request.clone().text()); // a copy: ordinary sign-in is left for the harness to answer
      if (f.get("grant_type") === "refresh_token") {
        google.tokenCalls++;
        return f.get("refresh_token") === "grant-jon" && !google.revoked.includes("grant-jon") ? MfResponse.json({ access_token: "at" }) : MfResponse.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (f.get("redirect_uri") === HUB + "/auth/callback") return; // ordinary sign-in: the harness answers
      const g = google.codes[f.get("code")];
      return MfResponse.json({ refresh_token: g.refresh_token, scope: g.scope, access_token: "at",
        id_token: "h." + b64u(JSON.stringify({ aud: "client-id", email: g.email, email_verified: true })) + ".s" });
    }
    if (url.href.startsWith("https://oauth2.googleapis.com/revoke")) { google.revoked.push(new URLSearchParams(await request.text()).get("token")); return new MfResponse(""); }
    if (url.host === "www.googleapis.com") { const r = fake.forGoogle(url.href); return MfResponse.json(r.body, { status: r.status }); }
  };
  jon = await h.signIn("jon@example.com", "Jon");
  kid = await h.signIn("clayton@example.com", "Clayton");
});
after(() => h.mf.dispose());

test("only a parent, with a parent's own Google account, can connect the calendar", async () => {
  assert.equal((await h.post("/auth/calendar/begin", {})).status, 401);
  assert.equal((await h.post("/auth/calendar/begin", {}, kid)).status, 403);
  assert.equal((await connect(jon, "stranger")).status, 403);
  assert.equal((await connect(jon, "child")).status, 403);
  assert.deepEqual(google.revoked, ["grant-stranger", "grant-child"], "access the Worker won't use is handed straight back");
  assert.equal((await connect(jon, "unticked")).status, 400, "Google's box for the calendars has to stay ticked");
  assert.equal(await props("GOOGLE_CALENDAR"), null);
  assert.deepEqual(await (await h.get("/auth/calendar", kid)).json(), { ok: true, connected: false, readAt: 0, errors: {}, calendars: ["Jon", "Maggie", "Family", "MCHS"] });

  const done = await connect(jon, "jon");
  assert.equal(done.status, 200);
  assert.match(await done.text(), /can now read Jon's Google calendars/);
  const kept = await props("GOOGLE_CALENDAR");
  assert.ok(kept && !kept.includes("grant-jon") && !Buffer.from(kept.split(".")[1], "base64").toString("latin1").includes("grant-jon"), "what Google gave is kept unreadable");
  assert.equal((await (await h.get("/auth/calendar", jon)).json()).connected, true);
});

test("the timer reads the calendars and the Hub is shown them", async () => {
  await cron();
  const d = await (await h.get("/api?action=all", jon)).json();
  assert.deepEqual(d.events.map(e => [e.cal, e.title, e.allDay, e.date]), [["Jon", "Dentist", false, "2026-11-22"], ["MCHS", "No school", true, "2026-11-23"], ["Maggie", "Book club", false, "2026-11-23"], ["Family", "Grandma visits", true, "2026-11-25"]]);
  assert.deepEqual(d.events[3], { cal: "Family", color: "#F6BF26", title: "Grandma visits", allDay: true, date: "2026-11-25", start: "7:00 PM", end: "7:00 PM", sort: Date.parse("2026-11-25T05:00:00Z") });
  const s = await (await h.get("/auth/calendar", jon)).json();
  assert.deepEqual([s.connected, s.errors, s.readAt], [true, {}, Date.parse(NOW)]);

  cals["jon@example.com"].events.push({ title: "Haircut", start: at + 7200e3, end: at + 9000e3 });
  await cron();
  assert.deepEqual((await (await h.get("/api?action=all", jon)).json()).events.map(e => e.title), ["Dentist", "Haircut", "No school", "Book club", "Grandma visits"]);
});

test("a calendar that can't be read keeps showing what was last read, and Settings says which", async () => {
  cals["school@example.org"].denied = true;
  await cron();
  const s = await (await h.get("/auth/calendar", jon)).json();
  assert.deepEqual([s.connected, s.errors], [true, { MCHS: "Google 403: PERMISSION_DENIED" }]);
  assert.ok((await (await h.get("/api?action=all", jon)).json()).events.some(e => e.cal === "MCHS"));
});

test("disconnecting forgets the access here and withdraws it at Google; the last events stay", async () => {
  assert.equal((await h.post("/auth/calendar/disconnect", {}, kid)).status, 403);
  assert.equal((await h.post("/auth/calendar/disconnect", {}, jon)).status, 200);
  assert.ok(google.revoked.includes("grant-jon"));
  assert.equal(await props("GOOGLE_CALENDAR"), null);
  await cron();
  assert.equal((await (await h.get("/api?action=all", jon)).json()).events.length, 5, "the Hub keeps the events it had, not an empty calendar");
});
