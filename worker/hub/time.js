/**
 * HARPER FAMILY HUB — what time it is at home
 *
 * Apps Script ran in the family's time zone, so "today" there was simply
 * today. A Worker runs on UTC, where it is already tomorrow by early evening.
 * Everything that asks about the day, the weekday or the clock goes through
 * here, and nothing in worker/hub uses a Date's own local-time methods.
 */

export const TZ = "America/New_York";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatters = {};
function formatter(tz) {
  return formatters[tz] || (formatters[tz] = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }));
}

/** A moment as the clock and calendar read at home (or in `tz`). */
export function local(date, tz) {
  const p = {};
  formatter(tz || TZ).formatToParts(date).forEach(x => { p[x.type] = x.value; });
  const y = Number(p.year), m = Number(p.month), d = Number(p.day), H = Number(p.hour), M = Number(p.minute);
  const two = n => String(n).padStart(2, "0");
  return {
    y, m, d, H, M,
    wd: WEEKDAYS.indexOf(p.weekday),                 // 0 = Sunday
    iso: p.year + "-" + p.month + "-" + p.day,       // yyyy-MM-dd
    month: p.year + "-" + p.month,                   // yyyy-MM
    hhmm: two(H) + ":" + two(M),                     // HH:mm
    time12: ((H % 12) || 12) + ":" + two(M) + " " + (H < 12 ? "AM" : "PM"), // h:mm a
    weekdayLong: WEEKDAYS_LONG[WEEKDAYS.indexOf(p.weekday)],
    monthShort: MONTHS[m - 1],
  };
}

/** yyyy-MM-dd at home. */
export function today(now) { return local(now).iso; }

/** "Nov 12, 9:40 AM" at home. */
export function stamp(date) {
  const p = local(date);
  return p.monthShort + " " + p.d + ", " + p.time12;
}

// Calendar dates as UTC midnights, so time zones and daylight saving can't shift a day.
export function ymd(s) {
  const p = String(s).split("-").map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
}
export function iso(d) { return d.toISOString().slice(0, 10); }
export function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
export function isoAdd(s, days) { return iso(addDays(ymd(s), days)); }
/** "Oct 11, 2026" for a yyyy-MM-dd date. */
export function longDate(s) {
  const d = ymd(s);
  return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
}
