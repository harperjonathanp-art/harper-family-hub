/** Small helpers shared by the Hub's Worker files. */

export const HUB_URL = "https://harperjonathanp-art.github.io/harper-family-hub/";

export const PARENTS = ["Jon", "Maggie"];
export const KIDS = ["Clayton", "Heidi"];
export const PEOPLE = PARENTS.concat(KIDS);

const enc = new TextEncoder();

export function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, headers || {}),
  });
}

export async function sha256Hex(text) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(text))));
  let out = "";
  hash.forEach(b => { out += b.toString(16).padStart(2, "0"); });
  return out;
}

/** A random value nobody can guess, safe to put in a URL. */
export function randomToken(bytes) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes || 32));
  let s = "";
  raw.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function sameString(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** The pages the Hub may be loaded from: HUB_ORIGIN (comma separated), or GitHub Pages. */
export function hubOrigins(env) {
  const set = String(env.HUB_ORIGIN || "").split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
  return set.length ? set : [new URL(HUB_URL).origin];
}

/** Headers that let the Hub's page (and only it) read an answer. */
export function cors(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (hubOrigins(env).indexOf(origin) < 0) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
