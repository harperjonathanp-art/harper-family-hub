/**
 * HARPER FAMILY HUB — the Worker
 *
 * One Worker, three jobs:
 *   /send     the push relay, unchanged (push-worker/worker.js)
 *   /auth/…   sign-in with Google, or by a parent's say-so (auth.js)
 *   /api      the Hub's data, for a signed-in device (proxy.js)
 *
 * Cloudflare deploys this file on every push to main (wrangler.jsonc).
 * See README.md next to this file.
 */

import relay from "../push-worker/worker.js";
import { handleAuth, sessionFor } from "./auth.js";
import { handleApi } from "./proxy.js";
import { json, cors } from "./util.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isAuth = url.pathname.indexOf("/auth/") === 0, isApi = url.pathname === "/api";
    if (!isAuth && !isApi) return relay.fetch(request, env, ctx);

    const headers = cors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (!env.DB) return json({ ok: false, error: "no_database" }, 503, headers);
    try {
      if (isAuth) return await handleAuth(request, env, url, headers);
      const session = await sessionFor(request, env);
      if (!session) return json({ ok: false, error: "signed_out" }, 401, headers);
      return await handleApi(request, env, url, session, headers);
    } catch (err) {
      console.error(String(err && err.stack || err).slice(0, 500));
      return json({ ok: false, error: "server_error" }, 500, headers);
    }
  },
};
