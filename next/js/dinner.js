// The Dinner screen: the week's dinners and the grocery list.
"use strict";

/* ----- Meals ----- */
function fromNotion() { return !!(DATA.mealsFrom && DATA.mealsFrom.source === "notion"); }
function renderMeals() {
  if (fromNotion()) return renderNotionMeals();
  const dayIdx = (new Date().getDay() + 6) % 7;
  const rows = DAYS.map((d, i) => {
    const m = DATA.meals[d] || {};
    return `<div class="meal ${i === dayIdx ? "today" : ""}">
      <span class="d">${d}</span>
      <div class="mealbody">
        <input type="text" id="meal-${d}" value="${esc(m.meal)}" placeholder="Dinner, or paste a recipe link…" oninput="mealLinks(this)">
        <div id="meal-${d}-links"></div>
      </div>
    </div>`;
  }).join("");
  const hint = localStorage.getItem("fd_draft_meals") ? `<div class="tiny" style="color:var(--warn);margin-bottom:var(--space-3)">Unsaved edits restored — tap Save week when you're ready.</div>` : "";
  return `${hint}<div class="block">${rows}</div>
    <div class="actions">
      <button class="primary" onclick="saveMeals()">Save week</button>
      <span class="tiny">Also editable straight from the Google Sheet.</span>
    </div>
    ${renderGroceries()}`;
}
/* Planned in Notion: this plan week (Saturday to Friday), read-only. The week
   stays put until it ends, so a dinner moved to another night is still there. */
function renderNotionMeals() {
  clearDraft("fd_draft_meals"); // nothing here to edit, so an old draft can't hold back a refresh
  const first = DAYS.indexOf(DATA.mealsFrom.weekStarts || "Sat");
  const back = ((new Date().getDay() + 6) % 7 - first + 7) % 7; // days since the week began
  const rows = [0, 1, 2, 3, 4, 5, 6].map(i => {
    const date = new Date(); date.setDate(date.getDate() - back + i);
    const d = DAYS[(date.getDay() + 6) % 7];
    const m = DATA.meals[d] || {};
    const parts = mealParts(m.meal);
    return `<div class="meal ro ${i === back ? "today" : i < back ? "past" : ""}">
      <span class="d">${d}<br>${date.getDate()}</span>
      <div class="mealbody">
        ${m.meal ? `<div class="mname">${esc(parts.name || "Recipe")}</div>` : `<div class="mname none">Not planned yet</div>`}
        ${recipeLinks(parts.links)}
        ${m.note ? `<div class="muted">${esc(m.note)}</div>` : ""}
      </div>
    </div>`;
  }).join("");
  const f = DATA.mealsFrom;
  const at = f.syncedAt ? new Date(f.syncedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  const status = f.error
    ? `<span class="tiny" style="color:var(--warn)">Couldn't reach Notion at the last check, so this is the last plan it sent.</span>`
    : `<span class="tiny">From the Notion meal plan${at ? `, checked ${esc(at)}` : ""}. Change it in Notion and the Hub catches up within 10 minutes.</span>`;
  return `<div class="block">${rows}</div>
    <div class="actions">${status}</div>
    ${renderGroceries()}`;
}
function saveMeals() {
  const meals = {};
  DAYS.forEach(d => { meals[d] = { meal: document.getElementById("meal-" + d).value.trim(), note: "" }; });
  DATA.meals = meals;
  clearDraft("fd_draft_meals");
  send({ action: "saveMeals", meals, by: cfg.user });
}

/* ----- Grocery list (on the Dinner page) ----- */
function renderGroceries() {
  const list = DATA.groceries;
  if (!Array.isArray(list)) {
    return `<h2>Grocery list</h2><div class="block"><div class="empty">The grocery list couldn't be loaded. It will be tried again in a minute.</div></div>`;
  }
  const left = list.filter(g => !g.done), got = list.filter(g => g.done);
  let h = `<h2>Grocery list${left.length ? `<span class="hint">${left.length} to get</span>` : ""}</h2>
    <div class="grocery-add">
      <textarea id="newGrocery" data-nodraft="1" rows="1" placeholder="Add an item, or paste a list…" aria-label="Add to the grocery list"
        enterkeyhint="done" onkeydown="if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); addGrocery(); }"></textarea>
      <button class="primary" onclick="addGrocery()">Add</button>
    </div>`;
  h += list.length ? `<div class="block grocery-list">${left.concat(got).map(groceryRow).join("")}</div>`
                   : `<div class="block"><div class="empty">Nothing on the list yet.</div></div>`;
  if (list.length) {
    h += `<div class="actions">
      ${left.length ? `<button class="ghost" onclick="shareGroceries()">Share list</button>` : ""}
      ${got.length ? `<button class="ghost" onclick="clearGroceries()">Clear ${got.length} checked</button>` : ""}
      <span class="tiny" id="groceryMsg" role="status"></span>
    </div>`;
  }
  return h;
}
function groceryRow(g) {
  const id = "g-" + esc(g.id);
  const grip = g.done ? `<span class="grip-space"></span>`
    : `<button class="grip" data-grip="${esc(g.id)}" aria-label="Move ${esc(g.item)} (arrow keys)"
        onpointerdown="dragStart(event, '${esc(g.id)}')" onpointermove="dragMove(event)"
        onpointerup="dragEnd()" onpointercancel="dragEnd()" onkeydown="gripKey(event, '${esc(g.id)}')">
        <svg width="12" height="18" viewBox="0 0 12 18" aria-hidden="true" fill="currentColor">
          <circle cx="3" cy="3" r="1.6"/><circle cx="9" cy="3" r="1.6"/><circle cx="3" cy="9" r="1.6"/>
          <circle cx="9" cy="9" r="1.6"/><circle cx="3" cy="15" r="1.6"/><circle cx="9" cy="15" r="1.6"/></svg></button>`;
  return `<div class="task ${g.done ? "done" : ""}" data-gid="${esc(g.id)}">
    ${grip}
    <input type="checkbox" id="${id}" ${g.done ? "checked" : ""} onchange="toggleGrocery('${esc(g.id)}')">
    <label class="ttl" for="${id}">${esc(g.item)}</label>
    <button class="del" onclick="deleteGrocery('${esc(g.id)}')" aria-label="Remove ${esc(g.item)}">×</button>
  </div>`;
}
/* Reordering: press the grip and drag. Pointer events cover touch and mouse;
   the other unchecked rows slide aside to show where the item will land. */
let DRAG = null;
function dragStart(e, id) {
  if (id.startsWith("tmp-") || DRAG) return; // still saving
  e.preventDefault();
  const row = e.currentTarget.closest(".task");
  const rows = [...row.parentElement.querySelectorAll(".task:not(.done)")];
  const from = rows.indexOf(row);
  e.currentTarget.setPointerCapture(e.pointerId);
  DRAG = { row, rows, from, to: from, startY: e.clientY,
    ids: rows.map(r => r.querySelector(".grip").dataset.grip), // what was on screen when the drag began
    h: row.getBoundingClientRect().height,
    mids: rows.map(r => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; }) };
  row.classList.add("dragging");
}
function dragMove(e) {
  if (!DRAG) return;
  const { row, rows, from, mids, h } = DRAG;
  const dy = e.clientY - DRAG.startY;
  const center = mids[from] + dy;
  const to = rows.filter((r, i) => i !== from && mids[i] < center).length;
  row.style.transform = `translateY(${dy}px)`;
  rows.forEach((r, i) => {
    if (r === row) return;
    const shift = from < to && i > from && i <= to ? -h : from > to && i >= to && i < from ? h : 0;
    r.style.transform = shift ? `translateY(${shift}px)` : "";
  });
  DRAG.to = to;
}
function dragEnd() {
  if (!DRAG) return;
  const { from, to, rows, ids } = DRAG;
  DRAG = null;
  rows.forEach(r => { r.style.transform = ""; r.classList.remove("dragging"); });
  if (from === to) { render(); return; } // picks up anything a refresh brought in mid-drag
  const [id] = ids.splice(from, 1);
  ids.splice(to, 0, id);
  applyOrder(ids);
}
function gripKey(e, id) {
  const step = { ArrowUp: -1, ArrowDown: 1 }[e.key];
  if (!step || id.startsWith("tmp-")) return;
  e.preventDefault();
  const ids = DATA.groceries.filter(g => !g.done).map(g => g.id);
  const from = ids.indexOf(id), to = from + step;
  if (from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  const refocus = () => { const b = document.querySelector(`[data-grip="${id}"]`); if (b) b.focus(); };
  applyOrder(ids).then(refocus);
  refocus();
}
/* Puts the unchecked items in the given order, matched by id rather than position,
   so a refresh that changed the list mid-drag can't move the wrong item. Items
   the order doesn't name (added meanwhile) keep their place after the rest. */
function applyOrder(ids) {
  const pos = new Map(ids.map((id, i) => [id, i]));
  const rank = g => pos.has(g.id) ? pos.get(g.id) : ids.length;
  const left = DATA.groceries.filter(g => !g.done).sort((a, b) => rank(a) - rank(b));
  DATA.groceries = left.concat(DATA.groceries.filter(g => g.done));
  ORDER_WANT = DATA.groceries.filter(g => !g.id.startsWith("tmp-")).map(g => g.id);
  render();
  return saveOrder();
}
/* One reorder save at a time, always sending the newest order. A save that a
   later move has superseded is skipped, and only the last answer is shown. */
let ORDER_WANT = null, ORDER_SEQ = 0, ORDER_Q = Promise.resolve();
function saveOrder() {
  const seq = ++ORDER_SEQ;
  note("Saving…");
  ORDER_Q = ORDER_Q.then(async () => {
    if (seq !== ORDER_SEQ) return;
    try {
      const d = await apiPost({ action: "reorderGroceries", ids: ORDER_WANT });
      if (seq !== ORDER_SEQ) return;
      if (!d.ok) { note("Save failed"); return; }
      DATA.groceries = d.groceries;
      localStorage.setItem("fd_cache", JSON.stringify(DATA));
      note("Saved ✓");
      if (!DRAG) render();
    } catch (e) {
      if (seq === ORDER_SEQ) note("Save failed — offline?");
    }
  });
  return ORDER_Q;
}

async function addGrocery() {
  const box = document.getElementById("newGrocery");
  const text = box.value.trim();
  if (!text) return;
  text.split(/\n+/).map(s => s.replace(/^[\s•*\-–—]+/, "").trim()).filter(Boolean)
    .forEach((item, i) => DATA.groceries.push({ id: "tmp-" + Date.now() + "-" + i, item, done: false }));
  box.value = "";
  expectNewRows();
  const refocus = () => { const b = document.getElementById("newGrocery"); if (b) b.focus(); }; // ready for the next item
  render(); refocus(); // show it straight away; the save fills in the real ids
  await send({ action: "addGroceries", text, by: cfg.user });
  refocus();
}
function toggleGrocery(id) {
  if (id.startsWith("tmp-")) { render(); return; } // still saving; the server hasn't named it yet
  const g = DATA.groceries.find(x => x.id === id);
  if (g) g.done = !g.done;
  const row = document.querySelector(`#main [data-gid="${CSS.escape(id)}"]`);
  if (row && g) row.classList.toggle("done", g.done);
  send({ action: "toggleGrocery", id });
}
function deleteGrocery(id) {
  if (id.startsWith("tmp-")) return; // still saving
  leaveRow(document.querySelector(`#main [data-gid="${CSS.escape(id)}"]`), () => {
    DATA.groceries = DATA.groceries.filter(x => x.id !== id);
    send({ action: "deleteGrocery", id });
  });
}
function clearGroceries() {
  DATA.groceries = DATA.groceries.filter(x => !x.done);
  send({ action: "clearGroceries" });
}
async function shareGroceries() {
  const text = "Grocery list\n" + DATA.groceries.filter(g => !g.done).map(g => "• " + g.item).join("\n");
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
    await navigator.clipboard.writeText(text);
    say("groceryMsg", "Copied ✓");
  } catch (e) {
    if (e.name !== "AbortError") say("groceryMsg", "Couldn't share — " + e.message);
  }
}
