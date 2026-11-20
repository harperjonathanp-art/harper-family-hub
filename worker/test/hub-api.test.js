// The whole thing wired together with "core" moved: the Worker answering the Hub
// from its own database, sending real (encrypted) push messages, and the timer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto as wc } from "node:crypto";
import { startHub, MfResponse } from "./harness.js";

const b64u = bytes => Buffer.from(bytes).toString("base64url");
const enc = new TextEncoder();
const concat = (...p) => Buffer.concat(p.map(x => Buffer.from(x)));
async function hkdf(salt, ikm, info, len) {
  const key = await wc.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await wc.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}
/** A phone: its push subscription, and how to read what is sent to it (RFC 8291). */
async function phone(name) {
  const keys = await wc.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await wc.subtle.exportKey("raw", keys.publicKey)), auth = wc.getRandomValues(new Uint8Array(16));
  return {
    subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/" + name, keys: { p256dh: b64u(pub), auth: b64u(auth) } },
    async read(body) {
      const salt = body.subarray(0, 16), idLen = body[20], asPub = body.subarray(21, 21 + idLen), sealed = body.subarray(21 + idLen);
      const asKey = await wc.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const shared = new Uint8Array(await wc.subtle.deriveBits({ name: "ECDH", public: asKey }, keys.privateKey, 256));
      const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), pub, asPub), 32);
      const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
      const key = await wc.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
      const plain = new Uint8Array(await wc.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed));
      return JSON.parse(Buffer.from(plain.subarray(0, plain.lastIndexOf(2))).toString());
    },
  };
}

let h, jon, kid, jonPhone, kidPhone, vapid;
const pushed = [];       // what the push services were sent, decrypted: { to, msg }
const gone = new Set();  // endpoints that answer 410
const todoistSite = { status: 200, tasks: [] };
const notionSite = { dinners: [], made: [] };
const api = async (body, token) => (await h.post("/api", body, token || jon)).json();
const all = async (token, q) => (await h.get("/api?action=all" + (q || ""), token || jon)).json();
const until = async (ok, what) => { for (let i = 0; i < 100; i++) { if (ok()) return; await new Promise(r => setTimeout(r, 50)); } assert.fail("timed out waiting for " + what); };
const tick = async at => {
  if (at) await h.mf.setOptions(Object.assign({}, h.options, { bindings: Object.assign({}, h.options.bindings, { TEST_NOW: at }) }));
  await (await h.mf.getWorker()).scheduled({ cron: "*/5 * * * *" });
};

before(async () => {
  const pair = await wc.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  vapid = { pub: b64u(new Uint8Array(await wc.subtle.exportKey("raw", pair.publicKey))), priv: (await wc.subtle.exportKey("jwk", pair.privateKey)).d };
  jonPhone = await phone("jon"); kidPhone = await phone("kid");
  h = await startHub({
    MOVED: "groceries,core", TEST_NOW: "2026-11-20T21:30:00Z", // Friday, 4:30 PM at home
    VAPID_PUBLIC_KEY: vapid.pub, VAPID_PRIVATE_KEY: vapid.priv,
    TODOIST_TOKEN: "tok", NOTION_TOKEN: "ntok", NOTION_MEALS_SOURCE: "meals-src", NOTION_CHECKINS_SOURCE: "checkins-src",
  });
  h.site = async (request, url) => {
    if (url.host === "fcm.googleapis.com") {
      if (gone.has(url.href)) return new MfResponse("gone", { status: 410 });
      assert.match(request.headers.get("Authorization"), /^vapid t=.+, k=/);
      const who = url.href.endsWith("/jon") ? jonPhone : kidPhone;
      pushed.push({ to: url.href.split("/").pop(), msg: await who.read(Buffer.from(await request.arrayBuffer())) });
      return new MfResponse(null, { status: 201 });
    }
    if (url.host === "api.todoist.com") {
      if (todoistSite.status !== 200) return new MfResponse("no", { status: todoistSite.status });
      const kind = url.pathname.split("/").pop();
      return MfResponse.json({ results: kind === "projects" ? [{ id: "p1", name: "Maintenance" }, { id: "p2", name: "Work" }] : kind === "sections" ? [] : todoistSite.tasks, next_cursor: null });
    }
    if (url.host === "api.notion.com") {
      const path = url.pathname.replace("/v1", "");
      if (path === "/data_sources/meals-src/query") return MfResponse.json({ results: notionSite.dinners });
      if (path === "/data_sources/checkins-src/query") return MfResponse.json({ results: [], has_more: false });
      if (path === "/pages") { notionSite.made.push(JSON.parse(await request.text())); return MfResponse.json({}); }
    }
  };
  jon = await h.signIn("jon@example.com", "Jon");
  kid = await h.signIn("clayton@example.com", "Clayton");
  h.appsScript = () => ({ ok: true, tasks: [{ id: "old", title: "From the Sheet" }], groceries: [{ id: "g1", item: "Milk", done: false, addedBy: "" }],
    events: [{ cal: "Family", title: "Soccer", allDay: false, date: "2026-11-21", start: "10:00 AM", end: "11:00 AM", sort: 1 }] });
});
after(() => h.mf.dispose());

test("the Hub is answered from the Worker's own database", async () => {
  h.upstream.length = 0;
  const d = await all();
  assert.deepEqual([d.ok, d.tasks, d.checkins, d.events, d.mealsFrom.source], [true, [], [], [], "notion"]);
  assert.deepEqual(Object.keys(d.meals), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.equal(d.now, "2026-11-20T21:30:00.000Z");
  const saved = await api({ action: "addTask", title: "Bins", assignee: "Jon", recurrence: "weekly", by: "Heidi" });
  assert.deepEqual(saved.tasks.map(t => [t.title, t.recurrence, t.completed]), [["Bins", "weekly", false]]);
  assert.deepEqual(Object.keys(saved), ["ok", "tasks", "meals", "checkins", "groceries"]);
  const ticked = await api({ action: "toggleTask", id: saved.tasks[0].id, by: "Heidi" });
  assert.deepEqual([ticked.tasks[0].completed, ticked.tasks[0].completedBy], [true, "Jon"], "who ticked it comes from the sign-in");
  assert.deepEqual(await api({ action: "nonsense" }), { ok: false, error: "unknown_action" });
  assert.deepEqual(h.upstream.filter(u => u.method === "POST"), [], "no save went to Apps Script");
  assert.ok(h.upstream.every(u => u.query && u.query.action === "all"), "Apps Script was asked only for the grocery list's one-time copy");
  assert.deepEqual((await all()).groceries, [{ id: "g1", item: "Milk", done: false, addedBy: "" }], "and the grocery list comes along as before");
});

test("two saves at the same instant both land", async () => {
  await Promise.all([api({ action: "addTask", title: "One" }), api({ action: "addTask", title: "Two" }, kid), api({ action: "addTask", title: "Three" })]);
  const titles = (await all()).tasks.map(t => t.title);
  ["One", "Two", "Three"].forEach(t => assert.ok(titles.includes(t), t + " was lost"));
});

test("a new to-do reaches the phone it's for, encrypted, and a test shows how it went", async () => {
  assert.deepEqual(await api({ action: "pushSubscribe", person: "Jon", subscription: kidPhone.subscription }, kid), { ok: true, sent: { delivered: 0, failed: 0 } });
  assert.deepEqual(await api({ action: "pushSubscribe", subscription: jonPhone.subscription }), { ok: true, sent: { delivered: 0, failed: 0 } });
  const info = await (await h.get("/api?action=notify", kid)).json();
  assert.deepEqual([info.ready, info.publicKey, info.devices], [true, vapid.pub, { Jon: 1, Maggie: 0, Clayton: 1, Heidi: 0 }]);
  assert.equal(info.prefs.Clayton.summary.at, "07:00");

  pushed.length = 0;
  await api({ action: "addTask", title: "Tidy your room", assignee: "Clayton", repeat: "every 1 week" });
  await until(() => pushed.length === 1, "the push for the new to-do");
  assert.deepEqual(pushed[0], { to: "kid", msg: { title: "Jon added a to-do for you", body: "Tidy your room · every 1 week", tag: pushed[0].msg.tag, view: "tasks" } });
  assert.match(pushed[0].msg.tag, /^task-[0-9a-f]{8}$/);

  pushed.length = 0;
  assert.deepEqual(await api({ action: "pushTest", person: "Jon" }, kid), { ok: true, sent: { delivered: 1, failed: 0 } });
  assert.deepEqual(pushed.map(p => [p.to, p.msg.title]), [["kid", "Notifications are on"]], "a test goes to the person signed in, whoever the page names");

  const prefs = await api({ action: "savePrefs", prefs: { summary: { on: true, at: "07:00" }, quiet: { on: false } } });
  assert.equal(prefs.prefs.quiet.on, false);
});

test("a phone that has dropped its subscription is forgotten", async () => {
  gone.add(kidPhone.subscription.endpoint);
  assert.deepEqual(await api({ action: "pushTest" }, kid), { ok: true, sent: { delivered: 0, failed: 1 } });
  assert.equal((await (await h.get("/api?action=notify", jon)).json()).devices.Clayton, 0);
  gone.clear();
  await api({ action: "pushSubscribe", subscription: kidPhone.subscription }, kid);
});

test("the Jon & Maggie check-ins and Jon's Todoist go only to a parent's device", async () => {
  await api({ action: "saveCheckin", type: "huddle", answers: { rose: "Good week" } }, kid);
  await api({ action: "saveCheckin", type: "couples", answers: { q0: "Private" } });
  assert.deepEqual(await api({ action: "saveCheckin", type: "couples", answers: { q0: "x" } }, kid), { ok: false, error: "parents_only", sent: { delivered: 0, failed: 0 } });
  const mine = await all(jon), theirs = await all(kid, "&reminders=1");
  assert.deepEqual(mine.checkins.map(c => c.type).sort(), ["couples", "huddle"]);
  assert.deepEqual(theirs.checkins.map(c => c.type), ["huddle"]);
  assert.ok(!JSON.stringify(theirs).includes("Private"));
  const couples = mine.checkins.find(c => c.type === "couples");
  await api({ action: "deleteCheckin", id: couples.id }, kid);
  assert.equal((await all(jon)).checkins.length, 2, "a child can't delete one either");
  assert.equal("reminders" in theirs, false, "a child's device isn't sent Jon's Todoist tasks even if it asks");

  todoistSite.tasks = [{ id: "t1", content: "Renew passport", project_id: "p1", due: { date: "2026-11-20" } }, { id: "t2", content: "Email a student's parent", project_id: "p2", due: { date: "2026-11-20" } }];
  const d = await all(jon, "&reminders=1");
  assert.deepEqual([d.reminders.status, d.reminders.lists, d.reminders.items.map(r => r.title)], ["fresh", ["Maintenance"], ["Renew passport"]], "asking for them reads Todoist if the copy is old; Work never comes");
  const stored = (await h.db.prepare("SELECT value FROM props WHERE key = 'TODOIST_ITEMS'").first()).value;
  assert.ok(!stored.includes("student"), "and the Work project isn't even stored");
  await api({ action: "tickReminder", key: "t1", on: true }, kid);
  assert.equal((await all(jon, "&reminders=1")).reminders.items[0].ticked, undefined, "a child's device can't tick them");
  await api({ action: "tickReminder", key: "t1", on: true });
  assert.deepEqual((await all(jon, "&reminders=1")).reminders.items.map(r => [r.ticked, r.tickedBy]), [[true, "Jon"]]);
  await api({ action: "tickReminder", key: "t1", on: false });
});

test("the timer: calendar copied in, Todoist read, and the 7:00 summary sent once", async () => {
  pushed.length = 0;
  await tick("2026-11-21T11:58:00Z"); // Saturday, 6:58 AM: nothing due yet
  assert.deepEqual(pushed, []);
  assert.equal((await all()).events[0].title, "Soccer", "the calendar's events are now served from the Worker's copy");

  await tick("2026-11-21T12:03:00Z"); // 7:03 AM
  await until(() => pushed.length >= 2, "the morning summaries");
  const mine = pushed.find(p => p.to === "jon").msg, theirs = pushed.find(p => p.to === "kid").msg;
  assert.equal(mine.title, "Today · Saturday, Nov 21");
  assert.deepEqual(mine.body.split("\n"), [
    "Dinner: not planned yet",
    "Calendar: 10:00 AM Soccer",
    "Todoist: Renew passport",
    "Kids: Tidy your room (Clayton)",
    "Family: One, Two, Three",
  ]);
  assert.ok(theirs.body.includes("Yours: Tidy your room") && !theirs.body.includes("Todoist") && !theirs.body.includes("Kids:"));
  await tick("2026-11-21T12:08:00Z");
  await tick("2026-11-21T12:13:00Z");
  assert.equal(pushed.filter(p => p.msg.tag === "summary").length, 2, "each person's summary goes once");
});

test("the timer: Notion's dinners come in, and check-ins go out to Notion", async () => {
  notionSite.dinners = ["2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"].map((day, i) => ({ properties: {
    Date: { date: { start: day } }, Meal: { title: [{ plain_text: "Dinner " + i }] }, "Meal Type": { select: { name: "Dinner" } }, "Who Cooks": { select: { name: "Jon" } } } }));
  await tick("2026-11-21T12:18:00Z"); // :18 — the dinners, and the half-hourly check-ins copy
  const d = await all();
  assert.deepEqual([d.meals.Sat, d.meals.Fri], [{ meal: "Dinner 0", note: "Jon cooks" }, { meal: "Dinner 6", note: "Jon cooks" }]);
  assert.equal(d.mealsFrom.error, "");
  assert.deepEqual(notionSite.made.map(p => p.properties.Type.select.name).sort(), ["Family Huddle", "Jon & Maggie"]);
  assert.match(notionSite.made[0].properties.Name.title[0].text.content, / · Nov 20, 2026$/);

  // A plan that changed outside the Hub is announced once it has sat for ten minutes, to everyone.
  pushed.length = 0;
  await tick("2026-11-21T12:23:00Z");
  assert.equal(pushed.filter(p => p.msg.tag === "meals").length, 0, "not yet: it changed five minutes ago");
  await tick("2026-11-21T12:33:00Z");
  await until(() => pushed.filter(p => p.msg.tag === "meals").length === 2, "the meal-plan alert");
  assert.equal(pushed.find(p => p.msg.tag === "meals").msg.title, "The week's dinners are planned");
});

test("if Todoist can't be reached the last good copy stays, marked with its age", async () => {
  todoistSite.status = 500;
  await tick("2026-11-21T14:00:00Z");
  const r = (await all(jon, "&reminders=1")).reminders;
  assert.deepEqual([r.status, r.error, r.items.map(i => i.title)], ["stale", "Todoist 500 on /projects", ["Renew passport"]]);
});
