// The Today screen.
"use strict";

/* ----- Today ----- */
function renderToday() {
  const t = todayStr();
  const dayIdx = (new Date().getDay() + 6) % 7;
  const dinner = (DATA.meals[DAYS[dayIdx]] || {}).meal;
  const dinnerNote = (DATA.meals[DAYS[dayIdx]] || {}).note;
  const todaysEvents = DATA.events.filter(e => e.date === t);
  // Subtasks show under their parents, so only top-level tasks are sorted into these lists.
  const top = tops();
  const daily = top.filter(x => x.recurrence === "daily" || isDailyRepeat(x));
  // Dated tasks once they're due (overdue first); undated one-offs as before.
  const oneOff = top.filter(x => !x.completed && !isDailyRepeat(x) &&
      (x.due ? x.due <= t : x.recurrence === "once")).sort(cmpTask);
  const onDeck = top.filter(x => ["weekly", "monthly", "quarterly", "yearly"].includes(x.recurrence) && !x.completed);

  const tonight = mealParts(dinner);
  let h = `<div class="lineup"><span class="marker now">Tonight</span>
    <h3>${dinner ? esc(tonight.name || "Tonight's recipe") : "Dinner isn't planned yet"}</h3>${recipeLinks(tonight.links)}
    ${dinnerNote ? `<div class="muted">${esc(dinnerNote)}</div>` : ""}
    ${dinner ? "" : `<div class="muted">${fromNotion() ? "Nothing in the Notion meal plan for tonight." : "Tap Dinner below to fill in the week."}</div>`}</div>`;

  h += `<h2>Today's schedule</h2>`;
  h += todaysEvents.length ? `<div class="block">${todaysEvents.map(eventRow).join("")}</div>`
                           : `<div class="block"><div class="empty">Nothing on the calendar today.</div></div>`;

  h += `<h2>Daily rhythm</h2>`;
  h += daily.length ? `<div class="block">${daily.map(taskRow).join("")}</div>`
                    : `<div class="block"><div class="empty">No daily tasks yet — add some in Tasks.</div></div>`;

  // Jon's reminders due today or overdue join the to-dos, ticked ones last.
  const rems = reminderTops().filter(r => r.due && r.due <= t);
  const todos = mixRows(oneOff, rems);
  if (todos.length) h += `<h2>To-dos</h2>${remStale()}<div class="block">${todos.join("")}</div>`;
  else h += `<h2>To-dos</h2>${remStale()}<div class="block"><div class="empty good">Nothing outstanding today.</div></div>`;
  if (onDeck.length) h += `<h2>On deck this period</h2><div class="block">${onDeck.map(taskRow).join("")}</div>`;
  return h;
}
