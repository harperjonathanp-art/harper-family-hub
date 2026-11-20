// What is switched on for real: the Worker as deployed, with no MOVED variable, follows moved.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startHub } from "./harness.js";

test("with no MOVED variable the Worker follows moved.js, and a variable replaces it", async () => {
  const sheet = () => ({ ok: true, tasks: [], groceries: [{ id: "s1", item: "From the Sheet", done: false, addedBy: "" }] });
  for (const [vars, asDeployed] of [[{ MOVED: undefined }, true], [{ MOVED: "none" }, false]]) {
    const h = await startHub(vars);
    try {
      const jon = await h.signIn("jon@example.com", "Jon");
      h.appsScript = sheet;
      h.upstream.length = 0;
      const d = await (await h.post("/api", { action: "addGroceries", text: "Eggs" }, jon)).json();
      if (asDeployed) {
        assert.deepEqual(d.groceries.map(g => g.item), ["From the Sheet", "Eggs"], "groceries are answered by the Worker");
        assert.deepEqual(h.upstream.map(u => u.method), ["GET"], "after one read of the Sheet to copy it");
      } else {
        assert.deepEqual(h.upstream.map(u => u.method), ["POST"], "MOVED=none sends groceries back to Apps Script");
      }
    } finally { await h.mf.dispose(); }
  }
});
