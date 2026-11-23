// The Check-in screen: the Family Huddle and the Weekly Check-In.
"use strict";

/* ----- Check-ins ----- */
let CHECKIN_OPEN = null; // "huddle" | "couples" | null

function renderCheckins() {
  if (CHECKIN_OPEN === "huddle") return renderHuddleForm();
  if (CHECKIN_OPEN === "couples") return renderCouplesForm();

  let h = `<button type="button" class="sheet tappable" onclick="openCheckin('huddle')">
      <span class="marker team">Everyone</span>
      <span class="ttl-lg">Family Huddle</span>
      <span class="muted">Sundays 6:30 PM · 20 min — Rose/Thorn/Bud, the week ahead, chores, the fun pick, gratitude</span>
    </button>
    <button type="button" class="sheet tappable" onclick="openCheckin('couples')">
      <span class="marker ceremony">Jon &amp; Maggie</span>
      <span class="ttl-lg">Weekly Check-In</span>
      <span class="muted">Sundays 8:00 PM · 30 min — the seven questions, then the week's logistics</span>
    </button>`;

  h += `<h2>Past check-ins</h2>`;
  if (!DATA.checkins.length) {
    h += `<div class="block"><div class="empty">History appears here after your first saved check-in.</div></div>`;
  } else {
    h += `<div class="block">` + DATA.checkins.map(c => {
      const label = c.type === "couples" ? "Jon & Maggie" : "Family Huddle";
      const parts = Object.entries(c.answers || {}).filter(([, v]) => v).map(([k, v]) => {
        const name = c.type === "couples"
          ? "Q" + (parseInt(k.replace("q", ""), 10) + 1) + " — " + COUPLES_QUESTIONS[parseInt(k.replace("q", ""), 10)]
          : (HUDDLE_FIELDS.find(f => f[0] === k) || [,""])[1];
        return `<b>${esc(name)}</b>${esc(v)}`;
      }).join("");
      const nice = /^\d{4}-\d{2}-\d{2}$/.test(c.date)
        ? new Date(c.date + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
        : c.date;
      return `<details class="hist"><summary>${esc(nice)} · ${label}</summary>
        <div class="ans">${parts || '<span class="tiny">Completed — no notes saved.</span>'}</div></details>`;
    }).join("") + `</div>`;
  }
  return h;
}
function openCheckin(type) { CHECKIN_OPEN = type; render(); }
function closeCheckin() {
  if (localStorage.getItem("fd_draft_" + CHECKIN_OPEN) && !confirm("Discard your notes for this check-in?")) return;
  clearDraft("fd_draft_" + CHECKIN_OPEN); CHECKIN_OPEN = null; render();
}

function renderHuddleForm() {
  const rows = HUDDLE_FIELDS.map(([key, title, hint], i) =>
    `<div class="q"><span class="num">${i + 1}</span><div class="body">
      <p>${title}</p><div class="tiny" style="margin:-4px 0 6px">${hint}</div>
      <textarea id="hud-${key}" placeholder="Notes (optional)"></textarea></div></div>`).join("");
  return `<div class="lineup"><span class="marker team">Everyone</span>
      <h3>Family Huddle</h3>
      <div class="muted">Clayton is Calendar Captain · Heidi is Fun Picker. Notes are optional — saving marks this week done.</div></div>
    <div class="block">${rows}</div>
    <div class="actions">
      <button class="primary" onclick="saveCheckin('huddle')">Save huddle</button>
      <button class="ghost" onclick="closeCheckin()">Cancel</button>
    </div>`;
}
function renderCouplesForm() {
  const rows = COUPLES_QUESTIONS.map((q, i) =>
    `<div class="q"><span class="num">${i + 1}</span><div class="body">
      <p>${q}</p><textarea id="cpl-q${i}" placeholder="Notes (optional)"></textarea></div></div>`).join("");
  return `<div class="lineup"><span class="marker ceremony">Jon &amp; Maggie</span>
      <h3>Weekly Check-In</h3>
      <div class="muted">Part one: the seven questions. Big topics get their own time. Hard stop at 30.</div></div>
    <div class="block">${rows}</div>
    <div class="actions">
      <button class="primary" onclick="saveCheckin('couples')">Save check-in</button>
      <button class="ghost" onclick="closeCheckin()">Cancel</button>
    </div>`;
}
function saveCheckin(type) {
  const answers = {};
  if (type === "huddle") HUDDLE_FIELDS.forEach(([k]) => { answers[k] = document.getElementById("hud-" + k).value.trim(); });
  else COUPLES_QUESTIONS.forEach((_, i) => { answers["q" + i] = document.getElementById("cpl-q" + i).value.trim(); });
  clearDraft("fd_draft_" + type);
  CHECKIN_OPEN = null;
  send({ action: "saveCheckin", type, answers });
}
