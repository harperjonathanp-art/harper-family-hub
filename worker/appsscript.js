/**
 * HARPER FAMILY HUB — asking Apps Script
 *
 * For whatever hasn't moved into the Worker yet (see moved.js). The family PIN
 * is added here, so a signed-in device never holds it.
 *
 * SETUP — the Worker's Settings > Variables and Secrets:
 *   APPS_SCRIPT_URL  secret  the web app's address (…/exec)
 *   FAMILY_PIN       secret  the same PIN as the FAMILY_PIN Script Property
 */

/**
 * A GET with `query`, or a POST of `body`. Gives { data } (Apps Script's JSON
 * answer) or { error, status }.
 */
export async function appsScript(env, query, body) {
  const base = String(env.APPS_SCRIPT_URL || "").trim(), pin = String(env.FAMILY_PIN || "").trim();
  if (!base || !pin) return { error: "not_configured", status: 503 };
  let res;
  try {
    if (body) {
      // Apps Script answers a POST with a redirect to where the result waits; fetch follows it.
      res = await fetch(base, { method: "POST", body: JSON.stringify(Object.assign({}, body, { pin })) });
    } else {
      const to = new URL(base);
      Object.keys(query).forEach(k => to.searchParams.set(k, query[k]));
      to.searchParams.set("pin", pin);
      res = await fetch(to.toString());
    }
  } catch (err) {
    return { error: "backend_unreachable", status: 502 };
  }
  // Apps Script reports its own trouble as a web page, not JSON.
  let data;
  try { data = JSON.parse(await res.text()); } catch (err) {
    console.warn("apps script answered " + res.status + " without JSON");
    return { error: "backend_error", status: 502 };
  }
  if (!data || typeof data !== "object") return { error: "backend_error", status: 502 };
  // The PIN is this Worker's to get right, not the device's: don't tell the page its PIN is wrong.
  if (data.ok === false && data.error === "bad_pin") return { error: "backend_pin", status: 503 };
  return { data };
}
