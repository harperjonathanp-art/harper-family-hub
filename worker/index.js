/**
 * HARPER FAMILY HUB — the Worker
 *
 * One Worker, three jobs:
 *   /send     the push relay, unchanged (push-worker/worker.js)
 *   /auth/…   sign-in with Google, or by a parent's say-so (auth.js)
 *   /api      the Hub's data, for a signed-in device (proxy.js)
 * and, every five minutes, the timer's work (hub/api.js).
 *
 * Cloudflare deploys this file on every push to main (wrangler.jsonc).
 * See README.md next to this file.
 */

import relay from "../push-worker/worker.js";
import { handleAuth, sessionFor } from "./auth.js";
import { handleApi, moved } from "./proxy.js";
import { tick, nowOf } from "./hub/api.js";
import { shadowRun } from "./hub/move.js";
import { json, cors } from "./util.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isAuth = url.pathname.indexOf("/auth/") === 0, isApi = url.pathname === "/api";
    if (!isAuth && !isApi) {
      // Once the Worker sends the notifications itself, Apps Script's are refused here,
      // so a timer left running there can never make a phone buzz twice.
      if (url.pathname === "/send" && request.method === "POST" && moved(env, "core")) {
        return json({ results: [], note: "the Worker sends the Hub's notifications now" });
      }
      return relay.fetch(request, env, ctx);
    }

    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (!env.DB) return json({ ok: false, error: "no_database" }, 503, headers);
    try {
      if (isAuth) return await handleAuth(request, env, url, headers);
      const session = await sessionFor(request, env);
      if (!session) return json({ ok: false, error: "signed_out" }, 401, headers);
      return await handleApi(request, env, url, session, headers, ctx);
    } catch (err) {
      console.error(String(err && err.stack || err).slice(0, 500));
      return json({ ok: false, error: "server_error" }, 500, headers);
    }
  },

  /** Every five minutes (wrangler.jsonc): what the Apps Script timers did, once the core has moved. */
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    if (moved(env, "core")) { await tick(env); return; }
    // Getting ready to move: copy and compare, changing nothing anyone sees (hub/move.js).
    const now = nowOf(env);
    if (moved(env, "shadow") && now.getUTCMinutes() % 15 < 5) await shadowRun(env, now);
  },
};
