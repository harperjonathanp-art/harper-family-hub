/**
 * HARPER FAMILY HUB — the Worker
 *
 * The Hub's whole backend:
 *   /auth/…           sign-in with Google, or by a parent's say-so (auth.js)
 *   /auth/calendar…   a parent letting the Hub read the calendar (calendar-auth.js)
 *   /api              the Hub's data, for a signed-in device (api.js)
 * and, every five minutes, the timer: calendar, Todoist, Notion, notifications
 * (hub/api.js).
 *
 * Cloudflare deploys this file on every push to main (wrangler.jsonc).
 * See README.md next to this file.
 */

import { handleAuth, sessionFor } from "./auth.js";
import { handleCalendarAuth } from "./calendar-auth.js";
import { handleApi } from "./api.js";
import { tick } from "./hub/api.js";
import { json, cors } from "./util.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isAuth = url.pathname.indexOf("/auth/") === 0, isApi = url.pathname === "/api";
    if (!isAuth && !isApi) {
      if (request.method === "GET" && url.pathname === "/") return new Response("Family Hub is running.\n");
      return json({ ok: false, error: "not_found" }, 404);
    }

    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (!env.DB) return json({ ok: false, error: "no_database" }, 503, headers);
    try {
      if (url.pathname.indexOf("/auth/calendar") === 0) return await handleCalendarAuth(request, env, url, headers);
      if (isAuth) return await handleAuth(request, env, url, headers);
      const session = await sessionFor(request, env);
      if (!session) return json({ ok: false, error: "signed_out" }, 401, headers);
      return await handleApi(request, env, url, session, headers, ctx);
    } catch (err) {
      console.error(String(err && err.stack || err).slice(0, 500));
      return json({ ok: false, error: "server_error" }, 500, headers);
    }
  },

  /** Every five minutes (wrangler.jsonc). */
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    await tick(env);
  },
};
