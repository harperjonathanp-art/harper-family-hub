// The Calendar screen.
"use strict";

/* ----- Calendar ----- */
function renderCalendar() {
  if (!DATA.events.length) return `<div class="block"><div class="empty">No events in the next two weeks — or the calendars aren't connected yet.</div></div>`;
  const byDay = {};
  DATA.events.forEach(e => { (byDay[e.date] = byDay[e.date] || []).push(e); });
  const t = todayStr();
  return Object.keys(byDay).sort().map(d =>
    `<div class="dayhead">${dayLabel(d)}${d === t ? '<span class="marker now">Today</span>' : ""}</div>
     <div class="block">${byDay[d].map(e => eventRow(e)).join("")}</div>`).join("");
}
