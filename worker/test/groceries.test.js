// The grocery list, against the Groceries part of the real apps-script/Code.gs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHub } from "./harness.js";
import { appsScriptSim } from "./appsscript-sim.js";

let h, jon, kid;
const api = async (body, token) => (await h.post("/api", body, token || jon)).json();
const list = async () => (await (await h.get("/api?action=all", jon)).json()).groceries;
const items = l => l.map(g => (g.done ? "✓" : "") + g.item);

before(async () => {
  h = await startHub();
  jon = await h.signIn("jon@example.com", "Jon");
  kid = await h.signIn("clayton@example.com", "Clayton");
});
after(() => h.mf.dispose());

test("the list starts empty, and who added an item comes from the sign-in", async () => {
  assert.deepEqual(await list(), []);
  const d = await api({ action: "addGroceries", text: "Butter", by: "Maggie" }, kid);
  assert.deepEqual(Object.keys(d), ["ok", "groceries"]);
  assert.deepEqual([d.groceries[0].item, d.groceries[0].done, d.groceries[0].addedBy], ["Butter", false, "Clayton"]);
  assert.match(d.groceries[0].id, /^[0-9a-f]{8}$/);
  const ticked = await api({ action: "toggleGrocery", id: d.groceries[0].id });
  assert.deepEqual(items(ticked.groceries), ["✓Butter"]);
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

test("the list comes with every full answer, so the Hub redraws in one round trip", async () => {
  const saved = await api({ action: "addTask", title: "Bins" });
  assert.deepEqual(Object.keys(saved), ["ok", "tasks", "meals", "checkins", "groceries"]);
  assert.deepEqual(items(saved.groceries), items(await list()));
  assert.equal("groceries" in (await api({ action: "savePrefs", prefs: {} })), false, "a settings answer has no list");
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
