// What is switched on for real: the Worker as deployed, with no MOVED variable, follows moved.js.
process.env.TZ = "America/New_York";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startHub } from "./harness.js";
import { appsScriptSim } from "./appsscript-sim.js";

const FILES = ["Code.gs", "Notify.gs", "Todoist.gs", "Notion.gs", "NotionCheckins.gs", "Handover.gs"];

test("as deployed: the Worker takes over from Apps Script and answers the Hub itself", async () => {
  const gs = appsScriptSim(FILES, {}, { http: () => ({ status: 500, body: {} }), timers: ["notifyTick", "syncTodoist"] });
  gs.run("addGroceries_", "From the Sheet", ""); gs.run("addTask_", { title: "Bins" });
  const h = await startHub({ MOVED: undefined }); // no variable at all, as on Cloudflare
  try {
    const jon = await h.signIn("jon@example.com", "Jon");
    h.appsScript = sent => gs.request(sent);
    const d = await (await h.get("/api?action=all", jon)).json();
    assert.deepEqual([d.tasks.map(t => t.title), d.groceries.map(g => g.item)], [["Bins"], ["From the Sheet"]]);
    assert.deepEqual(h.upstream.map(u => (u.body || u.query).action), ["handover", "export"]);
    assert.deepEqual([gs.props.HANDED_OVER, gs.timers], ["1", []]);
    const handover = JSON.parse((await h.db.prepare("SELECT value FROM props WHERE key = 'HANDOVER'").first()).value);
    assert.deepEqual(handover, { timers: [], notes: [] }, "what Apps Script said when told to stop is kept");
    h.upstream.length = 0;
    const saved = await (await h.post("/api", { action: "addGroceries", text: "Eggs" }, jon)).json();
    assert.deepEqual(saved.groceries.map(g => g.item), ["From the Sheet", "Eggs"]);
    assert.deepEqual(h.upstream, [], "and Apps Script isn't asked again");
  } finally { await h.mf.dispose(); }
});

test("a MOVED variable on the Worker replaces moved.js: 'none' sends everything back to Apps Script", async () => {
  const h = await startHub({ MOVED: "none" });
  try {
    const jon = await h.signIn("jon@example.com", "Jon");
    h.appsScript = () => ({ ok: true, tasks: [], groceries: [] });
    await (await h.post("/api", { action: "addGroceries", text: "Eggs" }, jon)).json();
    assert.deepEqual(h.upstream.map(u => u.method), ["POST"]);
  } finally { await h.mf.dispose(); }
});
