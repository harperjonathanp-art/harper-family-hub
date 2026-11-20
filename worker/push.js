/**
 * HARPER FAMILY HUB — sending an outbox
 *
 * The rules (hub/notify.js) decide what to send and to whom. This sends it,
 * with the same signing and encryption the push relay does for Apps Script
 * (push-worker/worker.js), and reports back as Notify.gs's deliver_ did:
 *   { delivered, failed, error?, gone: [endpoint, …] }
 * `gone` are phones that have dropped their subscription (404 or 410); the
 * caller forgets them.
 */

import { sendOne, vapidSigningKey, MAX_PAYLOAD } from "../push-worker/worker.js";

// The free plan allows 50 outside requests per run; leave room for the rest of the run's work.
const MAX_SENDS = 40;
const enc = new TextEncoder();

export function pushReady(env) {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/** outbox: [{ people, msg }]. devices: the Devices rows ({ person, subscription }). */
export async function deliver(env, outbox, devices) {
  const result = { delivered: 0, failed: 0, gone: [] };
  if (!outbox || !outbox.length) return result;
  try {
    if (!pushReady(env)) { result.error = "not_configured"; return result; }
    const publicKey = env.VAPID_PUBLIC_KEY.trim();
    const signingKey = await vapidSigningKey(publicKey, env.VAPID_PRIVATE_KEY.trim());
    let sends = 0;
    for (const item of outbox) {
      const subs = [];
      devices.forEach(function (d) {
        if (item.people.indexOf(d.person) < 0) return;
        try { subs.push(JSON.parse(d.subscription)); } catch (err) {}
      });
      if (!subs.length) continue;
      const payload = enc.encode(JSON.stringify(item.msg || {}));
      if (payload.length > MAX_PAYLOAD) { result.failed += subs.length; result.error = "too_large"; continue; }
      const room = subs.slice(0, Math.max(0, MAX_SENDS - sends));
      if (room.length < subs.length) { result.failed += subs.length - room.length; result.error = "too_many_at_once"; }
      sends += room.length;
      const results = await Promise.all(room.map(sub => sendOne(sub, payload, signingKey, publicKey, env)));
      results.forEach(function (r) {
        if (r.status >= 200 && r.status < 300) { result.delivered++; return; }
        result.failed++;
        // 404/410: the phone dropped this subscription, so stop sending to it.
        if (r.status === 404 || r.status === 410) result.gone.push(r.endpoint);
        else result.error = "push_" + r.status + (r.error ? ": " + r.error : "");
      });
    }
  } catch (err) {
    result.error = String(err && err.message || err);
  }
  if (result.error) console.warn("deliver: " + result.error);
  return result;
}
