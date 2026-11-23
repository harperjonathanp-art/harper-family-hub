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
  today: { label: "Today", title: () => "Today", render: () => renderToday(),
    icon: "M12 8a4 4 0 1 1 0 8a4 4 0 1 1 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" },
  calendar: { label: "Calendar", title: () => "Calendar", render: () => renderCalendar(),
    icon: "M6 5h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3zM3 10h18M8 3v4M16 3v4" },
  meals: { label: "Dinner", title: () => "This Week's Dinners", render: () => renderMeals(),
    icon: "M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 1.5-3 4-3 7h3v11" },
  tasks: { label: "Tasks", title: () => "Tasks", render: () => renderTasks(),
    icon: "M9 11l3 3 7-7M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" },
  checkins: { label: "Check-in", title: () => "Check-Ins", render: () => renderCheckins(),
    icon: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" },
};

/* ============ motion ============
   Only what someone does moves: switching screens, ticking, adding, deleting, opening a panel.
   The refresh every minute, a drag in progress and typing never animate, and nothing moves at
   all when the phone's Reduce Motion setting is on. */
const CALM = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const calm = () => !!(CALM && CALM.matches);
let ENTER = null; // the rows on screen just before an add: rows not among them slide in on the next draw
let FLASH = null; // a checkbox to pop on the next draw (one that's redrawn the moment it's ticked)
function expectNewRows() {
  ENTER = new Set([...document.querySelectorAll("#main [data-tid], #main [data-gid]")].map(el => el.dataset.tid || el.dataset.gid));
}
/* A row folds away, then `then` runs (and the next draw leaves it out). */
function leaveRow(els, then) {
  els = (Array.isArray(els) ? els : [els]).filter(Boolean);
  if (!els.length || calm()) { then(); return; }
  els.forEach(el => { el.style.height = el.offsetHeight + "px"; });
  void document.body.offsetHeight; // start the fold from the row's own height
  els.forEach(el => el.classList.add("leaving"));
  setTimeout(then, 240);
}
/* Change what's on screen with a slide: "forward" comes in from the right, "back" from the left. */
function slide(dir, change) {
  if (calm() || !document.startViewTransition || TD || DRAG) { change(); return; }
  document.documentElement.dataset.nav = dir;
  document.startViewTransition(change);
}
function announce(text) { const el = document.getElementById("srAnnounce"); if (el) el.textContent = text; }

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
  if (ENTER) {
    document.querySelectorAll("#main [data-tid], #main [data-gid]").forEach(el => {
      if (!ENTER.has(el.dataset.tid || el.dataset.gid)) el.classList.add("enter");
    });
    ENTER = null;
  }
  if (FLASH) {
    const box = document.querySelector(`#main input[data-key="${CSS.escape(FLASH)}"]`);
    if (box) box.classList.add("pop");
    FLASH = null;
  }
  drawNav();
}
/* The tab bar is drawn once and then only marked, so the active pill can glide between tabs. */
function drawNav() {
  const nav = document.getElementById("nav");
  if (!nav.childElementCount) {
    nav.innerHTML = Object.keys(VIEWS).map(k => `<button type="button" data-view="${k}" aria-label="${VIEWS[k].label}" onclick="go('${k}')">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${VIEWS[k].icon}"/></svg><span class="lbl" aria-hidden="true">${VIEWS[k].label}</span></button>`).join("");
  }
  nav.querySelectorAll("button").forEach(b => {
    const on = b.dataset.view === VIEW;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
}
function go(v) {
  if (v === VIEW) { render(); window.scrollTo({ top: 0, behavior: calm() ? "auto" : "smooth" }); return; }
  const order = Object.keys(VIEWS);
  slide(order.indexOf(v) < order.indexOf(VIEW) ? "back" : "forward", () => {
    VIEW = v; render(); window.scrollTo(0, 0); announce(VIEWS[v].title());
  });
}

/* ============ the panel that rises from the bottom ============
   Settings, Edit task and sign-in. `locked` (sign-in on a new device) fills the screen and can't be
   swiped or tapped away. Otherwise: the backdrop, a swipe down on the handle, Escape, or Done. */
const PANEL = { last: null, locked: false, timer: 0, drag: null };
function overlayHtml(inner, opts = {}) {
  const panel = document.getElementById("overlay"), back = document.getElementById("panelBack");
  document.getElementById("overlayPage").innerHTML = inner;
  PANEL.locked = !!opts.locked;
  panel.classList.toggle("locked", PANEL.locked);
  if (panel.classList.contains("open")) return; // already up: just the new contents
  clearTimeout(PANEL.timer);
  if (panel.classList.contains("hidden")) PANEL.last = document.activeElement;
  panel.classList.remove("hidden"); back.classList.remove("hidden");
  panel.style.transform = "";
  panel.scrollTop = 0;
  void panel.offsetWidth; // so it rises from below rather than appearing
  panel.classList.add("open"); back.classList.add("open");
  document.documentElement.classList.add("panel-open");
  panel.focus({ preventScroll: true });
}
function closeOverlay() {
  const panel = document.getElementById("overlay"), back = document.getElementById("panelBack");
  if (!panel.classList.contains("open")) return;
  panel.classList.remove("open", "dragging"); back.classList.remove("open");
  panel.style.transform = "";
  document.documentElement.classList.remove("panel-open");
  clearTimeout(PANEL.timer);
  PANEL.timer = setTimeout(() => { panel.classList.add("hidden"); back.classList.add("hidden"); }, calm() ? 0 : 420);
  const last = PANEL.last; PANEL.last = null;
  if (last && last.focus && document.contains(last)) last.focus({ preventScroll: true });
}
const panelUp = () => document.getElementById("overlay").classList.contains("open");
function panelBackTap() { if (!PANEL.locked) closeOverlay(); }
/* Swipe down on the handle: the panel follows the finger, and closes past about a third of its height. */
function panelGrab(e) {
  if (PANEL.locked) return;
  const panel = document.getElementById("overlay");
  PANEL.drag = { y: e.clientY, dy: 0, h: panel.offsetHeight };
  panel.classList.add("dragging");
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
}
function panelPull(e) {
  if (!PANEL.drag) return;
  PANEL.drag.dy = Math.max(0, e.clientY - PANEL.drag.y);
  document.getElementById("overlay").style.transform = `translateY(${PANEL.drag.dy}px)`;
}
function panelLetGo() {
  if (!PANEL.drag) return;
  const { dy, h } = PANEL.drag;
  PANEL.drag = null;
  const panel = document.getElementById("overlay");
  panel.classList.remove("dragging");
  if (dy > Math.min(140, h / 3)) closeOverlay();
  else panel.style.transform = "";
}
document.addEventListener("keydown", e => {
  if (!panelUp()) return;
  if (e.key === "Escape" && !PANEL.locked) { e.preventDefault(); closeOverlay(); return; }
  if (e.key !== "Tab") return;
  // Keyboard focus stays inside the panel while it's up.
  const panel = document.getElementById("overlay");
  const stops = [...panel.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.offsetParent !== null);
  if (!stops.length) { e.preventDefault(); return; }
  const first = stops[0], last = stops[stops.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
