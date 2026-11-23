// The Calendar screen: a strip of this week's days, with a dot for each calendar that has something
// on that day; swipe (or the arrows) for next week. Tap a day to see it below, then what's coming up.
"use strict";

const CAL = { week: 0, day: null, x0: null, dx: 0, on: false, pid: null, swiped: 0 };
const AHEAD = 14; // the Worker reads two weeks from today

function mondayOf(iso) { const n = (new Date(iso + "T12:00:00").getDay() + 6) % 7; return isoPlus(iso, -n); }
/* The weeks the strip shows (Monday to Sunday), from this week to the one the last loaded day falls in. */
function calWeeks() {
  const t = todayStr(), first = mondayOf(t), lastMon = mondayOf(isoPlus(t, AHEAD - 1)), weeks = [];
  for (let m = first; m <= lastMon; m = isoPlus(m, 7)) weeks.push(m);
  return weeks;
}
const loaded = d => d >= todayStr() && d <= isoPlus(todayStr(), AHEAD - 1);
function weekName(i) { return ["This week", "Next week"][i] || "In two weeks"; }
function weekRange(mon) {
  const sun = isoPlus(mon, 6), a = shortDate(mon);
  return mon.slice(5, 7) === sun.slice(5, 7) ? `${a} – ${Number(sun.slice(8))}` : `${a} – ${shortDate(sun)}`;
}
/* The calendars with something on day d, in family order, at most four dots. */
function dayCals(d) {
  const seen = new Map();
  DATA.events.forEach(e => { if (onDay(e, d) && !seen.has(e.cal)) seen.set(e.cal, e.color); });
  const rank = c => (CAL_ORDER.includes(c) ? CAL_ORDER.indexOf(c) : 99);
  return [...seen].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).slice(0, 4);
}
/* Keep the chosen day sensible: today on first open, or once the day it was on has gone by. */
function calSettle() {
  const t = todayStr(), weeks = calWeeks();
  if (!CAL.day || !loaded(CAL.day)) CAL.day = t;
  CAL.week = Math.max(0, weeks.indexOf(mondayOf(CAL.day)));
  return weeks;
}

function renderCalendar() {
  const weeks = calSettle(), t = todayStr();
  const strip = weeks.map((mon, i) => `<div class="wk" role="group" aria-label="${esc(weekName(i))}"${i === CAL.week ? "" : " inert"}>${
    [0, 1, 2, 3, 4, 5, 6].map(n => {
      const d = isoPlus(mon, n), on = loaded(d), cals = on ? dayCals(d) : [], count = on ? eventsOn(d).length : 0;
      const label = `${dayLabel(d)}${d === t ? ", today" : ""}: ${!on ? "not loaded" : count ? count + (count === 1 ? " event" : " events") : "nothing on"}`;
      return `<button type="button" class="wkday${d === t ? " today" : ""}" data-day="${d}" aria-pressed="${d === CAL.day}"
        aria-label="${esc(label)}"${on ? "" : " disabled"} onclick="calPick('${d}')">
        <span class="wd" aria-hidden="true">${esc(weekdayShort(d).slice(0, 3))}</span>
        <span class="dn" aria-hidden="true">${Number(d.slice(8))}</span>
        <span class="dots" aria-hidden="true">${cals.map(([c, col]) => `<i style="background:${calColor(c, col)}"></i>`).join("")}</span>
      </button>`;
    }).join("")}</div>`).join("");

  // The key: whichever calendars have something in the two weeks
  const keyCals = [...new Map(DATA.events.map(e => [e.cal, e.color]))]
    .sort((a, b) => (CAL_ORDER.indexOf(a[0]) + 1 || 99) - (CAL_ORDER.indexOf(b[0]) + 1 || 99));
  const key = keyCals.length ? `<div class="cal-key">${keyCals.map(([c, col]) =>
    `<span><i style="background:${calColor(c, col)}"></i>${esc(c)}</span>`).join("")}</div>` : "";

  return `<section class="wkcal" aria-label="Weeks">
      <div class="wk-head">
        <div class="wk-title" id="wkTitle" aria-live="polite"></div>
        <button type="button" class="chipbtn wk-today" id="wkToday" onclick="calToday()">Today</button>
        <button type="button" class="icon-btn" id="wkPrev" aria-label="Previous week" onclick="calWeek(-1)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
        <button type="button" class="icon-btn" id="wkNext" aria-label="Next week" onclick="calWeek(1)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>
      </div>
      <div class="wk-deck" onpointerdown="calDown(event)">
        <div class="wk-track" id="wkTrack" style="transform:translateX(${-CAL.week * 100}%)">${strip}</div>
      </div>
      ${key}
    </section>
    <div id="calDay" data-day="${CAL.day}">${calDayHtml()}</div>`;
}

/* The chosen day, then the next few days with something on. */
function calDayHtml() {
  const d = CAL.day, t = todayStr(), now = new Date(), evs = eventsOn(d);
  let h = `<div class="dayhead">${esc(dayLabel(d))}${d === t ? '<span class="marker now">Today</span>' : ""}</div>`;
  h += evs.length
    ? `<div class="block">${evs.map(e => eventRow(e, evOver(e, d, now), d)).join("")}</div>`
    : `<div class="block"><div class="empty">${DATA.events.length ? "Nothing on the calendar." :
        "Nothing in the next two weeks — or the calendars aren't connected yet."}</div></div>`;

  const later = [];
  for (let x = isoPlus(d, 1); loaded(x) && later.length < 3; x = isoPlus(x, 1)) {
    const on = eventsOn(x);
    if (on.length) later.push([x, on]);
  }
  if (later.length) {
    h += `<h2>Coming up</h2>`;
    h += later.map(([x, on]) => `<button type="button" class="dayhead sm" onclick="calPick('${x}')">${esc(dayLabel(x))}</button>
      <div class="block">${on.map(e => eventRow(e, false, x)).join("")}</div>`).join("");
  }
  return h;
}

/* Puts the strip and the day below in step with CAL, without redrawing the screen. */
function calPaint(animate) {
  const weeks = calWeeks(), t = todayStr(), track = document.getElementById("wkTrack");
  if (!track) return;
  track.classList.toggle("still", !animate || calm());
  track.style.transform = `translateX(${-CAL.week * 100}%)`;
  track.querySelectorAll(".wk").forEach((w, i) => { w.inert = i !== CAL.week; });
  track.querySelectorAll(".wkday").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.day === CAL.day)));
  document.getElementById("wkTitle").innerHTML = `<b>${esc(weekName(CAL.week))}</b><span>${esc(weekRange(weeks[CAL.week]))}</span>`;
  document.getElementById("wkPrev").disabled = CAL.week === 0;
  document.getElementById("wkNext").disabled = CAL.week >= weeks.length - 1;
  document.getElementById("wkToday").hidden = CAL.day === t;
  const box = document.getElementById("calDay");
  if (box.dataset.day !== CAL.day) {
    const fresh = box.dataset.day != null;
    box.dataset.day = CAL.day;
    box.innerHTML = calDayHtml();
    if (fresh && animate && !calm()) { box.classList.remove("calday-in"); void box.offsetWidth; box.classList.add("calday-in"); }
  }
}

function calPick(d) {
  if (Date.now() - CAL.swiped < 350 || !loaded(d)) return; // the end of a swipe isn't a tap
  CAL.day = d;
  CAL.week = Math.max(0, calWeeks().indexOf(mondayOf(d)));
  calPaint(true);
  if (d !== todayStr()) {
    const head = document.querySelector("#calDay .dayhead");
    if (head && head.getBoundingClientRect().top > window.innerHeight - 120) head.scrollIntoView({ behavior: calm() ? "auto" : "smooth", block: "start" });
  }
}
/* Another week: today if it's in it, else its first day that's loaded. */
function calWeek(step) {
  const weeks = calWeeks(), i = Math.min(weeks.length - 1, Math.max(0, CAL.week + step));
  if (i === CAL.week) { calPaint(true); return; }
  CAL.week = i;
  const days = [0, 1, 2, 3, 4, 5, 6].map(n => isoPlus(weeks[i], n)).filter(loaded);
  CAL.day = days.includes(todayStr()) ? todayStr() : days[0];
  calPaint(true);
}
function calToday() { CAL.day = todayStr(); CAL.week = 0; calPaint(true); }

/* Swipe the strip sideways for the next or last week. */
function calDown(e) {
  if (e.button && e.button > 0) return;
  Object.assign(CAL, { x0: e.clientX, y0: e.clientY, dx: 0, on: false, pid: e.pointerId });
  const deck = e.currentTarget, track = document.getElementById("wkTrack"), last = calWeeks().length - 1;
  const move = ev => {
    if (ev.pointerId !== CAL.pid) return;
    const dx = ev.clientX - CAL.x0, dy = ev.clientY - CAL.y0;
    if (!CAL.on) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) { CAL.on = true; try { deck.setPointerCapture(ev.pointerId); } catch (err) {} }
      else if (Math.abs(dy) > 10) { stop(); return; } else return;
    }
    // past the first or last week it gives, but only a little
    CAL.dx = (CAL.week === 0 && dx > 0) || (CAL.week === last && dx < 0) ? dx / 3 : dx;
    track.classList.add("still");
    track.style.transform = `translateX(calc(${-CAL.week * 100}% + ${CAL.dx}px))`;
  };
  const up = () => {
    const was = CAL.on, dx = CAL.dx;
    stop();
    if (!was) return;
    CAL.swiped = Date.now();
    if (dx < -50) calWeek(1); else if (dx > 50) calWeek(-1); else calPaint(true);
  };
  const stop = () => {
    deck.removeEventListener("pointermove", move); deck.removeEventListener("pointerup", up); deck.removeEventListener("pointercancel", up);
    CAL.x0 = null; CAL.on = false;
  };
  deck.addEventListener("pointermove", move); deck.addEventListener("pointerup", up); deck.addEventListener("pointercancel", up);
}
document.addEventListener("touchmove", e => { if (CAL.on) e.preventDefault(); }, { passive: false });
// The arrow keys move a day (a week with Shift) while the strip has focus.
document.addEventListener("keydown", e => {
  if (VIEW !== "calendar" || panelUp() || !e.target.closest || !e.target.closest(".wk-deck")) return;
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const d = isoPlus(CAL.day, step * (e.shiftKey ? 7 : 1));
  if (!loaded(d)) return;
  calPick(d);
  const b = document.querySelector(`.wkday[data-day="${d}"]`);
  if (b) b.focus({ preventScroll: true });
});
