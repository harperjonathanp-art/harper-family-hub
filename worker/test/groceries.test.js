// The grocery list once it lives in the Worker (MOVED = groceries).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHub } from "./harness.js";
import { appsScriptSim } from "./appsscript-sim.js";

const SHEET = [ // the list as Apps Script sends it at the moment of the move
  { id: "aaaa1111", item: "Milk", done: false, addedBy: "Maggie" },
  { id: "bbbb2222", item: "Eggs", done: true, addedBy: "Jon" },
  { id: "cccc3333", item: "Bread", done: false, addedBy: "" },
];
const state = extra => Object.assign({ ok: true, tasks: [{ id: "t1" }], meals: {}, checkins: [], groceries: SHEET }, extra);
let h, jon, kid;
const api = async (body, token) => (await h.post("/api", body, token || jon)).json();
const list = async () => (await (await h.get("/api?action=all", jon)).json()).groceries;
const items = l => l.map(g => (g.done ? "✓" : "") + g.item);

before(async () => {
  h = await startHub({ MOVED: "groceries" });
  jon = await h.signIn("jon@example.com", "Jon");
  kid = await h.signIn("clayton@example.com", "Clayton");
  h.appsScript = () => state();
});
after(() => h.mf.dispose());

test("the first use copies the Sheet's list in, once, as it was", async () => {
  h.upstream.length = 0;
  const first = await api({ action: "toggleGrocery", id: "aaaa1111" });
  assert.deepEqual(h.upstream.map(u => u.method + " " + (u.query ? u.query.action : "")), ["GET all"], "one read of the Sheet, to copy it");
  assert.deepEqual(first, { ok: true, groceries: [
    { id: "aaaa1111", item: "Milk", done: true, addedBy: "Maggie" },
    { id: "bbbb2222", item: "Eggs", done: true, addedBy: "Jon" },
    { id: "cccc3333", item: "Bread", done: false, addedBy: "" },
  ] });
  // From here the Sheet is never the source again, whatever it says.
  h.appsScript = () => state({ groceries: [{ id: "zzzz9999", item: "Stale", done: false, addedBy: "" }] });
  const all = await (await h.get("/api?action=all&reminders=1", jon)).json();
  assert.deepEqual(items(all.groceries), ["✓Milk", "✓Eggs", "Bread"]);
  assert.deepEqual(all.tasks, [{ id: "t1" }], "everything else still comes from Apps Script");
});

test("grocery actions don't go to Apps Script at all", async () => {
  h.upstream.length = 0;
  await api({ action: "toggleGrocery", id: "aaaa1111" });
  const d = await api({ action: "addGroceries", text: "Butter", by: "Maggie" }, kid);
  assert.equal(h.upstream.length, 0);
  assert.deepEqual(d.groceries[3].addedBy, "Clayton", "who added it comes from the sign-in");
  assert.match(d.groceries[3].id, /^[0-9a-f]{8}$/);
  assert.deepEqual(Object.keys(d), ["ok", "groceries"]);
});

test("a pasted list becomes one item per line", async () => {
  const before = (await list()).length;
  const d = await api({ action: "addGroceries", text: "• 2 onions\n\n- garlic\n  * olive oil  \n—\n– " + "x".repeat(250) });
  assert.deepEqual(items(d.groceries).slice(before, before + 3), ["2 onions", "garlic", "olive oil"]);
  assert.equal(d.groceries[before + 3].item.length, 200);
  assert.equal(d.groceries.length, before + 4);
  const many = await api({ action: "addGroceries", text: Array.from({ length: 60 }, (_, i) => "item " + i).join("\n") });
  assert.equal(many.groceries.length, before + 4 + 50, "at most 50 from one paste");
  assert.equal((await api({ action: "addGroceries", text: " \n - \n" })).groceries.length, before + 54);
});

test("another save's answer carries the Worker's list, not the Sheet's", async () => {
  h.appsScript = () => state({ groceries: [{ id: "zzzz9999", item: "Stale", done: false, addedBy: "" }] });
  const d = await api({ action: "toggleTask", id: "t1" });
  assert.equal(d.groceries[0].item, "Milk");
  assert.deepEqual(d.tasks, [{ id: "t1" }]);
  h.appsScript = () => ({ ok: true, prefs: {} }); // settings actions answer without a list
  assert.deepEqual(await api({ action: "savePrefs", prefs: {} }), { ok: true, prefs: {} });
});

test("it behaves as Code.gs does, action for action", async () => {
  // The same few hundred random actions go to the real Code.gs (over a pretend Sheet)
  // and to the Worker. After each one the two lists must read the same.
  const gs = appsScriptSim(["Code.gs"]);
  await api({ action: "clearGroceries" });
  for (const g of await list()) await api({ action: "deleteGrocery", id: g.id });
  assert.deepEqual(await list(), []);

  let seed = 20261120; // a fixed seed: the same actions every run
  const rnd = n => { // mulberry32
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const done = { add: 0, toggle: 0, delete: 0, clear: 0, reorder: 0 };
  const words = ["milk", "eggs", "• flour", "- rice", "  tea", "*jam", "— oats", "", "  ", "salt\n\npepper", "–", "1/2 lb beef"];
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const gsDo = (fn, ...args) => { gs.run(fn, ...args); return gs.run("getGroceries_"); };
  let ours = [], theirs = [];

  for (let step = 0; step < 300; step++) {
    const pick = ours.length ? rnd(ours.length) : -1;
    const kind = ours.length < 3 ? 0 : rnd(10);
    let what;
    if (kind <= 2) {
      const text = Array.from({ length: 1 + rnd(4) }, () => words[rnd(words.length)]).join("\n");
      done.add++;
      what = "add " + JSON.stringify(text);
      theirs = gsDo("addGroceries_", text, "Jon");
      ours = (await api({ action: "addGroceries", text })).groceries;
    } else if (kind <= 5) {
      done.toggle++;
      what = "toggle #" + pick;
      theirs = gsDo("toggleGrocery_", theirs[pick].id);
      ours = (await api({ action: "toggleGrocery", id: ours[pick].id })).groceries;
    } else if (kind === 6) {
      done.delete++;
      what = "delete #" + pick;
      theirs = gsDo("deleteGrocery_", theirs[pick].id);
      ours = (await api({ action: "deleteGrocery", id: ours[pick].id })).groceries;
    } else if (kind === 7) {
      if (ours.some(g => g.done) && ours.some(g => !g.done)) done.clear++; // a clear that has something to tell apart
      what = "clear";
      theirs = gsDo("clearGroceries_");
      ours = (await api({ action: "clearGroceries" })).groceries;
    } else {
      // A new order naming only some items, some of them twice, plus one that doesn't exist.
      const order = shuffle(ours.map((_, i) => i)).slice(0, 1 + rnd(ours.length));
      if (order.length > 1 && rnd(3) === 0) order.push(order[0]);
      done.reorder++;
      what = "reorder " + order.join(",");
      const a = order.map(i => theirs[i].id), b = order.map(i => ours[i].id);
      const ghost = rnd(2);
      theirs = gsDo("reorderGroceries_", ghost ? a.concat("nosuchid") : a);
      ours = (await api({ action: "reorderGroceries", ids: ghost ? b.concat("nosuchid") : b })).groceries;
    }
    const strip = l => l.map(g => [g.item, g.done, g.addedBy]);
    assert.deepEqual(strip(ours), strip(theirs), `step ${step}: ${what}`);
  }
  assert.ok(ours.length > 0);
  // The comparison only means something if every kind of action really happened.
  Object.keys(done).forEach(k => assert.ok(done[k] >= 10, `only ${done[k]} ${k} actions were tried`));
  await api({ action: "reorderGroceries", ids: "not a list" }); // ignored, as in Code.gs
  assert.deepEqual(items(await list()), items(ours));
});

test("if the Sheet can't be read, nothing is copied and nothing is lost", async () => {
  const fresh = await startHub({ MOVED: "groceries" });
  try {
    const token = await fresh.signIn("jon@example.com", "Jon");
    fresh.appsScript = () => "<html>Script error</html>";
    const r = await fresh.post("/api", { action: "addGroceries", text: "Milk" }, token);
    assert.equal(r.status, 502);
    fresh.appsScript = () => ({ ok: false, error: "bad_pin" });
    assert.equal((await fresh.post("/api", { action: "addGroceries", text: "Milk" }, token)).status, 503);
    fresh.appsScript = () => state();
    const d = await (await fresh.post("/api", { action: "addGroceries", text: "Butter" }, token)).json();
    assert.deepEqual(items(d.groceries), ["Milk", "✓Eggs", "Bread", "Butter"], "the Sheet's list came over on the next try");
  } finally { await fresh.mf.dispose(); }
});

test("an older backend that sends no grocery list starts the list empty", async () => {
  const fresh = await startHub({ MOVED: "groceries" });
  try {
    const token = await fresh.signIn("jon@example.com", "Jon");
    fresh.appsScript = () => ({ ok: true, tasks: [] });
    assert.deepEqual((await (await fresh.get("/api?action=all", token)).json()).groceries, []);
  } finally { await fresh.mf.dispose(); }
});
