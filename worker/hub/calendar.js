/**
 * HARPER FAMILY HUB — the calendar
 *
 * What getEvents_ in apps-script/Code.gs did: the next 14 days of the family's
 * four Google calendars, as the Hub shows them. Apps Script read them as Jon,
 * through CalendarApp. The Worker reads them as Jon too, through the Google
 * Calendar API, with read-only access he grants once in the Hub's Settings
 * (calendar-auth.js). What Google gives back for that is kept encrypted with a
 * key only the Worker has, so the database alone can't be used to read a calendar.
 *
 * SETUP — the Worker's Settings > Variables and Secrets, each a Secret, with the
 * same values as the Script Properties of the same names:
 *   CAL_JON, CAL_MAGGIE, CAL_FAMILY, CAL_MCHS    the calendar IDs
 * A calendar whose ID is missing is left out. One that can't be read keeps
 * showing what was last read from it.
 */

import { TZ, local, today, isoAdd, dayStart } from "./time.js";

// Each calendar's ID comes from the variable named in `env`.
export const CALENDARS = [
  { env: "CAL_JON", name: "Jon", color: "#4285F4" },
  { env: "CAL_MAGGIE", name: "Maggie", color: "#009688" },
  { env: "CAL_FAMILY", name: "Family", color: "#F6BF26" },
  { env: "CAL_MCHS", name: "MCHS", color: "#C5B783" },
];
const DAYS_AHEAD = 14; // how far ahead the calendar view looks
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const GRANT = "GOOGLE_CALENDAR";  // Google's refresh token, encrypted
const CACHE = "CALENDAR_CACHE";   // { calendar name: its events as last read }
const STATE = "CALENDAR_STATE";   // { at, errors: { calendar name: why } }

export { SCOPE as CALENDAR_SCOPE };
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = text => Uint8Array.from(atob(text), ch => ch.charCodeAt(0));

async function key(env) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode("family-hub calendar grant|" + String(env.GOOGLE_CLIENT_SECRET || "").trim()));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
/** Google's refresh token as it is stored: unreadable without the Worker's own secret. */
export async function sealGrant(env, refreshToken) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), enc.encode(refreshToken)));
  return b64(iv) + "." + b64(sealed);
}
async function openGrant(env, stored) {
  const [iv, sealed] = String(stored || "").split(".");
  if (!iv || !sealed) throw new Error("the calendar isn't connected");
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(env), unb64(sealed)));
}

export function calendarConnected(props) { return !!props[GRANT]; }
export function calendarStatus(props) {
  let state = {};
  try { state = JSON.parse(props[STATE] || "{}"); } catch (err) {}
  return { connected: calendarConnected(props), readAt: state.at || 0, errors: state.errors || {} };
}
export function saveGrant(c, sealed) { c.props[GRANT] = sealed; }
export function dropGrant(c) { delete c.props[GRANT]; delete c.props[CACHE]; delete c.props[STATE]; }

/** Tells Google the access is no longer wanted. Best effort: forgetting it here is what matters. */
export async function withdraw(env, stored, refreshToken) {
  try {
    const token = refreshToken || await openGrant(env, stored);
    await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() });
  } catch (err) {}
}

/** A short-lived access token from the stored grant. Throws a short reason, never a token. */
async function accessToken(env, stored) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: await openGrant(env, stored),
      client_id: String(env.GOOGLE_CLIENT_ID || "").trim(), client_secret: String(env.GOOGLE_CLIENT_SECRET || "").trim(),
    }).toString(),
  });
  let data = {};
  try { data = await res.json(); } catch (err) {}
  // invalid_grant: the access was withdrawn or has lapsed, and needs connecting again in Settings.
  if (!res.ok || !data.access_token) throw new Error("Google " + res.status + ": " + (data.error || "no access token"));
  return data.access_token;
}

/** One calendar's events in the window, as the Hub is sent them. */
async function readCalendar(token, cal, id, from, to) {
  const out = [];
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(id) + "/events");
    url.searchParams.set("singleEvents", "true"); // a repeating event as each of its days
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("timeMin", from.toISOString());
    url.searchParams.set("timeMax", to.toISOString());
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: "Bearer " + token } });
    let data = {};
    try { data = await res.json(); } catch (err) {}
    if (!res.ok) throw new Error("Google " + res.status + ": " + ((data.error && (data.error.status || data.error.message)) || "no answer"));
    (data.items || []).forEach(item => { const e = shape(cal, item, data.timeZone); if (e) out.push(e); });
    pageToken = data.nextPageToken || "";
    if (!pageToken) return out;
  }
  throw new Error("more pages than expected");
}

/**
 * A Google Calendar event as getEvents_ gave it. An all-day event is dated by its own day;
 * its start "time" is midnight in its calendar's zone, as Apps Script reported it.
 */
export function shape(cal, item, calendarZone) {
  if (!item || item.status === "cancelled" || !item.start || !item.end) return null;
  const allDay = !!item.start.date;
  const start = allDay ? dayStart(item.start.date, item.start.timeZone || calendarZone || TZ) : new Date(item.start.dateTime);
  const end = allDay ? dayStart(item.end.date, item.end.timeZone || calendarZone || TZ) : new Date(item.end.dateTime);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  const date = allDay ? item.start.date : local(start).iso;
  return {
    cal: cal.name,
    color: cal.color,
    title: String(item.summary || ""),
    allDay: allDay,
    date: date,
    start: local(start).time12,
    end: local(end).time12,
    sort: (allDay ? dayStart(date) : start).getTime(),
  };
}

/**
 * Reads every calendar that has an ID. `stored` is the saved grant, `before` the
 * events last read from each calendar: one that fails keeps those.
 * Gives { byCalendar, errors }. Throws only if Google won't give an access token at all.
 */
export async function readCalendars(env, stored, before, now) {
  const token = await accessToken(env, stored);
  const from = dayStart(today(now)), to = dayStart(isoAdd(today(now), DAYS_AHEAD));
  const byCalendar = {}, errors = {};
  for (const cal of CALENDARS) {
    const id = String(env[cal.env] || "").trim();
    if (!id) continue;
    try { byCalendar[cal.name] = await readCalendar(token, cal, id, from, to); }
    catch (err) {
      errors[cal.name] = String(err && err.message || err).slice(0, 120);
      if (before && before[cal.name]) byCalendar[cal.name] = before[cal.name];
    }
  }
  return { byCalendar, errors };
}

/** All calendars' events in one list, soonest first. */
export function merged(byCalendar) {
  const out = [];
  CALENDARS.forEach(cal => (byCalendar[cal.name] || []).forEach(e => out.push(e)));
  out.sort(function (a, b) { return a.sort - b.sort; });
  return out;
}

export function loadCache(props) { try { return JSON.parse(props[CACHE] || "{}") || {}; } catch (err) { return {}; } }
/** Keeps what was read (run inside transact). Only writes what changed, apart from the time. */
export function keep(c, read) {
  const text = JSON.stringify(read.byCalendar);
  if (c.props[CACHE] !== text) c.props[CACHE] = text;
  c.props[STATE] = JSON.stringify({ at: c.now.getTime(), errors: read.errors });
}
export function failed(c, message) {
  c.props[STATE] = JSON.stringify({ at: (JSON.parse(c.props[STATE] || "{}").at) || 0, errors: { all: String(message).slice(0, 150) } });
}

/**
 * How two lists of events differ, for the rehearsal: counts only, nothing an event says.
 * Events at the same moment can come in either order, so the lists are compared sorted.
 */
export function compareEvents(mine, theirs) {
  const line = e => JSON.stringify([e.sort, e.cal, e.title, e.allDay, e.date, e.start, e.end, e.color]);
  const a = mine.map(line).sort(), b = theirs.map(line).sort();
  const inB = new Map();
  b.forEach(x => inB.set(x, (inB.get(x) || 0) + 1));
  let both = 0;
  a.forEach(x => { const n = inB.get(x) || 0; if (n) { both++; inB.set(x, n - 1); } });
  const perCalendar = {};
  CALENDARS.forEach(cal => { perCalendar[cal.name] = [mine.filter(e => e.cal === cal.name).length, theirs.filter(e => e.cal === cal.name).length]; });
  return { mine: a.length, theirs: b.length, same: both, onlyMine: a.length - both, onlyTheirs: b.length - both, perCalendar };
}
