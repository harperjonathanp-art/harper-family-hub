// One pretend set of Google calendars, served two ways: to the Apps Script
// simulator as CalendarApp would, and to the Worker as the Google Calendar API
// would. Whatever one side is told, the other is told the same.
import { dayStart } from "../hub/time.js";

/**
 * calendars: { id: { tz, events: [ { title, allDay: true, from: "yyyy-MM-dd", to: "yyyy-MM-dd" (the day after the last) }
 *                                 | { title, start: ms, end: ms } | { cancelled: true, … } ] } }
 */
export function fakeCalendars(calendars) {
  const span = (cal, e) => (e.allDay ? [dayStart(e.from, cal.tz).getTime(), dayStart(e.to, cal.tz).getTime()] : [e.start, e.end]);
  const within = (cal, from, to) => cal.events.filter(e => !e.cancelled && span(cal, e)[1] > from && span(cal, e)[0] < to)
    .sort((a, b) => span(cal, a)[0] - span(cal, b)[0]);
  return {
    calendars,
    /** For appsScriptSim's opts.calendars. */
    forAppsScript: (id, ScriptDate) => {
      const cal = calendars[id];
      if (!cal || cal.denied) return null;
      return { getEvents: (from, to) => within(cal, from.getTime(), to.getTime()).map(e => ({
        getTitle: () => e.title || "",
        isAllDayEvent: () => !!e.allDay,
        // "midnight at the beginning of the day on which the event starts in the script's time zone"
        getAllDayStartDate: () => { const [y, m, d] = e.from.split("-").map(Number); return new ScriptDate(y, m - 1, d); },
        getStartTime: () => new ScriptDate(span(cal, e)[0]),
        getEndTime: () => new ScriptDate(span(cal, e)[1]),
      })) };
    },
    /** Answers a Google Calendar API events request, three to a page. Gives { status, body }. */
    forGoogle: url => {
      const u = new URL(url), id = decodeURIComponent(u.pathname.split("/")[4]), cal = calendars[id];
      if (!cal) return { status: 404, body: { error: { status: "NOT_FOUND" } } };
      if (cal.denied) return { status: 403, body: { error: { status: "PERMISSION_DENIED" } } };
      if (u.searchParams.get("singleEvents") !== "true" || u.searchParams.get("orderBy") !== "startTime") return { status: 400, body: { error: { status: "INVALID_ARGUMENT" } } };
      const all = within(cal, Date.parse(u.searchParams.get("timeMin")), Date.parse(u.searchParams.get("timeMax")));
      const withCancelled = all.concat(cal.events.filter(e => e.cancelled).map(e => Object.assign({}, e)));
      const from = Number(u.searchParams.get("pageToken") || 0), page = withCancelled.slice(from, from + 3);
      return { status: 200, body: {
        timeZone: cal.tz,
        items: page.map(e => Object.assign(
          { summary: e.title, status: e.cancelled ? "cancelled" : "confirmed" },
          e.allDay ? { start: { date: e.from }, end: { date: e.to } }
            : { start: { dateTime: new Date(e.start).toISOString() }, end: { dateTime: new Date(e.end).toISOString() } })),
        nextPageToken: from + 3 < withCancelled.length ? String(from + 3) : undefined,
      } };
    },
  };
}
