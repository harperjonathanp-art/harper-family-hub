/**
 * HARPER FAMILY HUB — Web Push
 *
 * The signing (VAPID, RFC 8292) and payload encryption (RFC 8291) that a push
 * service asks for before it will deliver a notification to a phone. push.js
 * decides which phones; this sends to one.
 *
 * SETUP — the Worker's Settings > Variables and Secrets (made with keys.html):
 *   VAPID_PUBLIC_KEY   text
 *   VAPID_PRIVATE_KEY  secret
 *   VAPID_SUBJECT      text    optional, e.g. mailto:you@example.com
 */

const HUB_URL = "https://harperjonathanp-art.github.io/harper-family-hub/";

// Only real push services, so the Worker can't be pointed anywhere else.
const PUSH_HOSTS = [
  /(^|\.)push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export const MAX_PAYLOAD = 3900; // push services cap the encrypted body at 4096 bytes
const enc = new TextEncoder();

export async function sendOne(sub, payload, signingKey, publicKey, env) {
  const endpoint = sub && sub.endpoint;
  try {
    const target = new URL(endpoint);
    if (target.protocol !== "https:" || !PUSH_HOSTS.some(h => h.test(target.hostname))) {
      return { endpoint, status: 400, error: "unknown_push_service" };
    }
    const jwt = await vapidJwt(target.origin, signingKey, env.VAPID_SUBJECT || HUB_URL);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "normal",
      },
      body: await encrypt(payload, sub.keys || {}),
    });
    const out = { endpoint, status: res.status };
    if (!res.ok) out.error = (await res.text()).slice(0, 200);
    return out;
  } catch (err) {
    return { endpoint, status: 0, error: String((err && err.message) || err) };
  }
}

// ---------- VAPID (RFC 8292) ----------

export async function vapidSigningKey(publicKey, privateKey) {
  const pub = b64uDecode(publicKey); // 0x04 || x || y
  return crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256",
    x: b64uEncode(pub.slice(1, 33)),
    y: b64uEncode(pub.slice(33, 65)),
    d: privateKey,
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function vapidJwt(audience, signingKey, subject) {
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const unsigned = header + "." + claims;
  // WebCrypto returns the raw r||s signature JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, enc.encode(unsigned));
  return unsigned + "." + b64uEncode(new Uint8Array(sig));
}

// ---------- payload encryption (RFC 8291 / aes128gcm, RFC 8188) ----------

async function encrypt(plaintext, keys) {
  const uaPublic = b64uDecode(keys.p256dh || "");
  const authSecret = b64uDecode(keys.auth || "");
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("bad_subscription_keys");

  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  const local = await crypto.subtle.generateKey(ecdh, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, ecdh, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, sharedSecret,
    concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // One record: the payload, then the 0x02 last-record delimiter.
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, aesKey, concat(plaintext, new Uint8Array([2]))));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096); // record size
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// ---------- helpers ----------

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  parts.forEach(p => { out.set(p, at); at += p.length; });
  return out;
}

function b64uEncode(bytes) {
  let s = "";
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
