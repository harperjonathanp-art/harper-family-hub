// Shared helpers, the screen list, drawing the current screen, and the overlay.
"use strict";

/* ============ helpers ============ */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function dayLabel(iso) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}
/* Recipe links typed into a dinner: show the dinner's name, and each link
   as a short tappable site name instead of the whole address. */
const URL_RE = /https?:\/\/[^\s<>"']+/gi; // iOS often capitalises the first letter typed
function mealParts(text) {
  const links = (String(text || "").match(URL_RE) || []).map(u => u.replace(/[).,;!?]+$/, ""));
  const name = String(text || "").replace(URL_RE, " ").replace(/\s+/g, " ").replace(/^[\s\-–—:|,(]+|[\s\-–—:|,(]+$/g, "");
  return { name, links };
}
function recipeLinks(links) {
  if (!links.length) return "";
  return `<div class="recipes">${links.map(u => {
    let site = u;
    try { site = new URL(u).hostname.replace(/^www\./, ""); } catch (e) {}
    return `<a class="recipe" href="${esc(u)}" target="_blank" rel="noopener">${esc(site)} ↗</a>`;
  }).join("")}</div>`;
}
function mealLinks(input) {
  const box = document.getElementById(input.id + "-links");
  if (box) box.innerHTML = recipeLinks(mealParts(input.value).links);
}

function chip(name) {
  const initial = (name || "?").slice(0, 1);
  return name ? `<span class="chip ${esc(name)}" title="${esc(name)}">${initial}</span>` : "";
}
function eventRow(e) {
  const time = e.allDay ? "All day" : e.start;
  return `<div class="ev"><span class="dot" style="background:${esc(e.color)}"></span>
    <span class="time">${esc(time)}</span>
    <span class="etitle">${esc(e.title)}<span class="cal">${esc(e.cal)}</span></span></div>`;
}
const GRIP_SVG = `<svg width="12" height="18" viewBox="0 0 12 18" aria-hidden="true" fill="currentColor">
  <circle cx="3" cy="3" r="1.6"/><circle cx="9" cy="3" r="1.6"/><circle cx="3" cy="9" r="1.6"/>
  <circle cx="9" cy="9" r="1.6"/><circle cx="3" cy="15" r="1.6"/><circle cx="9" cy="15" r="1.6"/></svg>`;

/* ============ views ============ */
// Each screen's renderer is looked up when it's drawn, so the screen files can load after this one.
const VIEWS = {
  today: { label: "Today", title: () => "Today", render: () => renderToday() },
  calendar: { label: "Calendar", title: () => "Calendar", render: () => renderCalendar() },
  meals: { label: "Dinner", title: () => "This Week's Dinners", render: () => renderMeals() },
  tasks: { label: "Tasks", title: () => "Tasks", render: () => renderTasks() },
  checkins: { label: "Check-in", title: () => "Check-Ins", render: () => renderCheckins() },
};

function render() {
  if (TD) return; // mid-drag: the rows stay put under the finger; the drop renders
  const v = VIEWS[VIEW];
  document.getElementById("viewTitle").textContent = v.title();
  document.getElementById("todayEyebrow").textContent =
    new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  document.getElementById("main").innerHTML = v.render();
  restoreDraft();
  document.querySelectorAll("#main .meal input").forEach(mealLinks);
  if (VIEW === "tasks") repeatUI();
  document.getElementById("main").addEventListener("input", saveDraft);
  document.getElementById("nav").innerHTML = Object.keys(VIEWS).map(k =>
    `<button class="${k === VIEW ? "active" : ""}" onclick="go('${k}')">${VIEWS[k].label}</button>`).join("");
}
function go(v) { VIEW = v; render(); window.scrollTo(0, 0); }

/* ============ setup & settings ============ */
function overlayHtml(inner) {
  document.getElementById("overlayPage").innerHTML = inner;
  document.getElementById("overlay").classList.remove("hidden");
}
function closeOverlay() { document.getElementById("overlay").classList.add("hidden"); }
