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
import { hubGet, hubPost, nowOf, syncNotionMeals } from "./hub/api.js";
import { recipeList, recipeOne, recipeAction, RECIPE_ACTIONS } from "./hub/recipes.js";

export async function handleApi(request, env, url, session, headers, ctx) {
  const reply = (obj, status) => json(obj, status, headers);

  if (request.method === "GET") {
    // Recipes, read from Notion (hub/recipes.js); everyone signed in may read them.
    if (url.searchParams.get("action") === "recipes") return reply(await recipeList(env, url.origin, nowOf(env)));
    if (url.searchParams.get("action") === "recipe") return reply(await recipeOne(env, url.origin, nowOf(env), String(url.searchParams.get("id") || "")));
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
    // Recipes written back to Notion (a parent only). Planning a night reads the week again at once,
    // and answers with the Hub's whole state, so it shows on This week straight away.
    if (RECIPE_ACTIONS.indexOf(body.action) >= 0) {
      const r = await recipeAction(env, session, body, url.origin, nowOf(env));
      if (r.ok && body.action === "planRecipe") {
        await syncNotionMeals(env);
        Object.assign(r, await hubGet(env, session, "all", false), { groceries: await listGroceries(env) });
      }
      return reply(r);
    }
    const data = await hubPost(env, session, body, p => { if (ctx && ctx.waitUntil) ctx.waitUntil(p); });
    if (data.tasks) data.groceries = await listGroceries(env); // after a save the Hub is sent the whole state
    return reply(data);
  }

  return reply({ ok: false, error: "not_found" }, 404);
}
