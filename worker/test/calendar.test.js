// The calendar: the Worker reading Google Calendar (hub/calendar.js) against the
// real getEvents_ in Code.gs, both shown the same pretend calendars.
process.env.TZ = "America/New_York";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appsScriptSim } from "./appsscript-sim.js";
import { fakeCalendars } from "./fake-calendar.js";
import * as calendar from "../hub/calendar.js";
import { dayStart, today, isoAdd } from "../hub/time.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const ENV = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", CAL_JON: "jon@example.com", CAL_MAGGIE: "maggie@example.com", CAL_FAMILY: "family@group.calendar.google.com", CAL_MCHS: " school@example.org " };
const PROPS = { CAL_JON: "jon@example.com", CAL_MAGGIE: "maggie@example.com", CAL_FAMILY: "family@group.calendar.google.com", CAL_MCHS: "school@example.org" };
function rng(seed) {
  return n => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
}
/** Google, pretend: hands out an access token for the right grant, then the events. */
const useGoogle = (fake, log) => { globalThis.fetch = async (url, init) => {
  url = String(url); init = init || {};
  if (log) log.push(url.split("?")[0]);
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    const f = new URLSearchParams(init.body);
    if (f.get("refresh_token") !== "the-grant" || f.get("client_secret") !== "sec") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    return new Response(JSON.stringify({ access_token: "at" }));
  }
  assert.equal(init.headers.Authorization, "Bearer at");
  const r = fake.forGoogle(url);
  return new Response(JSON.stringify(r.body), { status: r.status });
}; };

test("the same events as getEvents_ in Code.gs, whatever the day, zone or daylight-saving change", async () => {
  const rnd = rng(31), pick = a => a[rnd(a.length)], maybe = n => rnd(n) === 0;
  const stored = await calendar.sealGrant(ENV, "the-grant");
  const seen = { events: 0, allDay: 0, manyDays: 0, utcAllDay: 0, straddles: 0, ties: 0, empty: 0 };
  for (const start of ["2026-10-28T03:00:00Z", "2026-11-21T10:10:00Z", "2026-12-25T23:30:00Z", "2027-03-08T04:30:00Z", "2027-07-01T15:00:00Z"]) {
    for (let round = 0; round < 12; round++) {
      const clock = { now: Date.parse(start) + round * 7 * 3600e3 + rnd(3600e3) };
      const day = n => new Date(clock.now + n * 86400e3).toISOString().slice(0, 10);
      const cals = {};
      Object.values(PROPS).forEach((id, i) => {
        const tz = [ "America/New_York", "America/New_York", "UTC", pick(["America/New_York", "America/Los_Angeles"]) ][i];
        cals[id] = { tz, events: Array.from({ length: maybe(6) ? 0 : rnd(9) }, (_, n) => {
          if (maybe(3)) { const from = rnd(22) - 4, len = maybe(3) ? 1 + rnd(5) : 1; return { title: pick(["Birthday", "No school", "Trip", ""]), allDay: true, from: day(from), to: day(from + len) }; }
          const at = clock.now + (rnd(22 * 24) - 4 * 24) * 3600e3 - (clock.now % 900e3) + pick([0, 0, 15, 30]) * 60e3;
          return { title: pick(["Soccer", "Dentist", "Choir", "Dinner with friends"]), start: at, end: at + pick([30, 60, 90, 600, 2000]) * 60e3 };
        }) };
        if (maybe(4)) cals[id].events.push({ title: "Called off", cancelled: true, start: clock.now + 3600e3, end: clock.now + 7200e3 });
        if (cals[id].events.length > 1 && maybe(2)) cals[id].events.push(Object.assign({}, cals[id].events[0], { title: "Same time" })); // two at one moment
      });
      // Right at the edges of the fourteen days: half an hour inside and outside each end.
      const first = dayStart(today(new Date(clock.now))).getTime(), last = dayStart(isoAdd(today(new Date(clock.now)), 14)).getTime();
      [[first - 3600e3, first - 1800e3, "ended before today"], [first - 1800e3, first + 1800e3, "ends just into today"],
       [last - 1800e3, last + 1800e3, "starts just inside"], [last + 1800e3, last + 3600e3, "starts after the last day"]]
        .forEach(([s, e, title]) => cals["jon@example.com"].events.push({ title, start: s, end: e }));
      const fake = fakeCalendars(cals);
      const gs = appsScriptSim(["Code.gs"], PROPS, { clock, calendars: fake.forAppsScript });
      useGoogle(fake);
      const theirs = gs.run("getEvents_");
      assert.deepEqual(theirs.filter(e => /today|inside|last day/.test(e.title)).map(e => e.title), ["ends just into today", "starts just inside"], "Code.gs itself keeps exactly the two inside the fourteen days");
      const read = await calendar.readCalendars(ENV, stored, {}, new Date(clock.now));
      const mine = calendar.merged(read.byCalendar);
      const at = `${new Date(clock.now).toISOString()} round ${round}`;
      assert.deepEqual(read.errors, {}, at);
      const diff = calendar.compareEvents(mine, theirs);
      assert.deepEqual([diff.onlyMine, diff.onlyTheirs, diff.mine], [0, 0, theirs.length], at + " — " + JSON.stringify(diff));
      assert.deepEqual(mine.map(e => e.sort), theirs.map(e => e.sort), at + " — in the same order of time");
      // Every field Code.gs gave (the Worker adds endDate, for events over several days)
      assert.deepEqual(Object.keys(mine[0] || {}).filter(k => k !== "endDate"), Object.keys(theirs[0] || {}), at + " — with the same fields");
      mine.forEach(e => assert.ok(e.endDate >= e.date, at + " — ends on or after the day it starts: " + JSON.stringify(e)));
      seen.events += mine.length; seen.allDay += mine.filter(e => e.allDay).length; if (!mine.length) seen.empty++;
      seen.utcAllDay += mine.filter(e => e.allDay && e.cal === "Family" && e.start !== "12:00 AM").length;
      const homeDay = today(new Date(clock.now));
      seen.straddles += mine.filter(e => e.date < homeDay).length;
      seen.ties += mine.filter((e, i) => i && mine[i - 1].sort === e.sort).length;
      Object.values(cals).forEach(c => c.events.forEach(e => { if (e.allDay && e.to > day(Number(1)) && e.from !== e.to && new Date(e.to) - new Date(e.from) > 86400e3) seen.manyDays++; }));
    }
  }
  const least = { events: 400, allDay: 150, manyDays: 40, utcAllDay: 30, straddles: 10, ties: 30 };
  Object.keys(least).forEach(k => assert.ok(seen[k] >= least[k], `only ${seen[k]} of "${k}": ${JSON.stringify(seen)}`));
});

test("a calendar that can't be read keeps what was last read from it; the others carry on", async () => {
  const stored = await calendar.sealGrant(ENV, "the-grant");
  const now = new Date("2026-11-21T15:00:00Z"), at = Date.parse("2026-11-22T20:00:00Z");
  const cals = Object.fromEntries(Object.values(PROPS).map(id => [id, { tz: "America/New_York", events: [{ title: "On " + id, start: at, end: at + 3600e3 }] }]));
  const fake = fakeCalendars(cals);
  useGoogle(fake);
  const first = await calendar.readCalendars(ENV, stored, {}, now);
  assert.deepEqual(calendar.merged(first.byCalendar).map(e => [e.cal, e.title, e.start, e.end, e.date]), [
    ["Jon", "On jon@example.com", "3:00 PM", "4:00 PM", "2026-11-22"], ["Maggie", "On maggie@example.com", "3:00 PM", "4:00 PM", "2026-11-22"],
    ["Family", "On family@group.calendar.google.com", "3:00 PM", "4:00 PM", "2026-11-22"], ["MCHS", "On school@example.org", "3:00 PM", "4:00 PM", "2026-11-22"]]);
  cals["school@example.org"].denied = true; cals["jon@example.com"].events = [];
  const second = await calendar.readCalendars(ENV, stored, first.byCalendar, now);
  assert.deepEqual(second.errors, { MCHS: "Google 403: PERMISSION_DENIED" });
  assert.deepEqual(calendar.merged(second.byCalendar).map(e => e.cal), ["Maggie", "Family", "MCHS"], "Jon's is now empty; the school's still shows what was last read");
  const fewer = await calendar.readCalendars(Object.assign({}, ENV, { CAL_MAGGIE: "" }), stored, {}, now);
  assert.deepEqual(Object.keys(fewer.byCalendar), ["Jon", "Family"], "a calendar with no ID is left out, and one never read has nothing to keep");
});

test("the grant is kept unreadable, and a lapsed one says so", async () => {
  const stored = await calendar.sealGrant(ENV, "the-grant");
  assert.ok(!stored.includes("the-grant") && !Buffer.from(stored.split(".")[1], "base64").toString("latin1").includes("the-grant"));
  assert.notEqual(stored, await calendar.sealGrant(ENV, "the-grant"), "sealed differently each time");
  useGoogle(fakeCalendars({}));
  await assert.rejects(calendar.readCalendars(Object.assign({}, ENV, { GOOGLE_CLIENT_SECRET: "other" }), stored, {}, new Date()), "another Worker's secret can't open it");
  await assert.rejects(calendar.readCalendars(ENV, await calendar.sealGrant(ENV, "withdrawn"), {}, new Date()), /Google 400: invalid_grant/);
  await assert.rejects(calendar.readCalendars(ENV, "", {}, new Date()), /isn't connected/);
});
