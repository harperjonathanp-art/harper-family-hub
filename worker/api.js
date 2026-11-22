/**
 * HARPER FAMILY HUB — the Hub's API
 *
 * What a signed-in Hub asks of the Worker, in the shape the page has always
 * used: GET /api?action=all (or notify), POST /api { action, … }. Most answers
 * carry the fresh state, so the page re-renders in one round trip.
 *
 * Who is asking comes from the session, never from what the page says.
 */

import { json } from "./util.js";
import { isGroceryAction, groceryAction, listGroceries } from "./groceries.js";
import { hubGet, hubPost } from "./hub/api.js";

export async function handleApi(request, env, url, session, headers, ctx) {
  const reply = (obj, status) => json(obj, status, headers);

  if (request.method === "GET") {
    const action = url.searchParams.get("action") === "notify" ? "notify" : "all";
    const data = await hubGet(env, session, action, url.searchParams.get("reminders") === "1");
    if (action === "all") data.groceries = await listGroceries(env);
    return reply(data);
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch (err) { return reply({ ok: false, error: "bad_json" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ ok: false, error: "bad_json" }, 400);
    if (isGroceryAction(body.action)) return reply(await groceryAction(env, body, session.person));
    const data = await hubPost(env, session, body, p => { if (ctx && ctx.waitUntil) ctx.waitUntil(p); });
    if (data.tasks) data.groceries = await listGroceries(env); // after a save the Hub is sent the whole state
    return reply(data);
  }

  return reply({ ok: false, error: "not_found" }, 404);
}
