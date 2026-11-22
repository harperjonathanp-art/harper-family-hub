# Apps Script backend (retired)

**Nothing runs this any more.** On 22 November 2026 the Hub's backend finished
moving to the Cloudflare Worker in `worker/`; see `worker/README.md` for how
the Hub works now and where its settings live.

This folder is kept for two reasons. The Worker's tests run these files to
check that it behaves exactly as they did. And the sections below are still
the description of that behaviour: what each notification is and when it goes,
how repeats and subtasks work, what is read from Notion and Todoist. Where
they say "Script Properties", the same names are now settings on the Worker;
where they say to paste a file and publish, there is nothing to do.

What follows is as it was written when Apps Script was the backend.

---

The Hub reads from and writes to this Google Apps Script web app. The live
copy runs in Google's Apps Script editor; this folder is the tracked copy.
Change it here, then paste it into the editor and publish a new version.

| File | What it does |
|------|--------------|
| `Code.gs` | The web app: tasks, meals, calendar, check-ins |
| `Notify.gs` | Notifications: what to send, to whom, and when |
| `Todoist.gs` | Jon's Todoist tasks, read-only, from the Todoist API |
| `Notion.gs` | Optional: the week's dinners, read from the Notion meal plan |
| `NotionCheckins.gs` | Optional: check-ins copied to the Weekly Check-Ins database in Notion (needs `Notion.gs` too) |
| `Handover.gs` | For the move to the Worker in `worker/`: lets it copy everything out, and tells this script to stop. See "Moving a feature" in `worker/README.md` |
| `appsscript.json` | Project settings (time zone, web app access, the permissions the script asks for) |

## Script Properties

Anything private stays out of this public repo. Add these under
**Project Settings → Script Properties**:

| Property           | What it is                                             |
|--------------------|--------------------------------------------------------|
| `FAMILY_PIN`       | The PIN the Hub sends with every request               |
| `SHEET_ID`         | The Google Sheet that holds tasks, meals and check-ins |
| `CAL_JON`          | Jon's calendar ID (his Google account email)           |
| `CAL_MAGGIE`       | Maggie's calendar ID (her Google account email)        |
| `CAL_FAMILY`       | The shared Family calendar (`…@group.calendar.google.com`) |
| `CAL_MCHS`         | The MCHS school calendar                               |
| `PUSH_WORKER_URL`  | The push relay's address, e.g. `https://family-hub-push.<name>.workers.dev` |
| `PUSH_SECRET`      | The shared secret from `push-worker/keys.html`         |
| `VAPID_PUBLIC_KEY` | The public key from `push-worker/keys.html`            |
| `NOTION_TOKEN`     | Optional. The Notion integration's secret (see "Meal plan from Notion") |
| `NOTION_MEALS_SOURCE` | Optional. The Meal Plan database's data source ID |
| `NOTION_CHECKINS_SOURCE` | Optional. The Weekly Check-Ins database's data source ID (see "Check-ins to Notion") |
| `TODOIST_TOKEN` | Jon's Todoist API token (see "Todoist"). Never put it anywhere else |
| `REMINDERS_HIDE_LISTS` | Optional. Todoist projects the Hub never receives, comma separated. Left unset it hides `Work` (student names). Set it to change that, e.g. `Work, Personal` |

A calendar whose property is missing is left out of the Hub.
`NOTIFY_STATE` appears there too once notifications run, and `TODOIST_META`,
`TODOIST_DATA_…` and `TODOIST_TICKS` once Todoist is set up. They're the
script's own bookkeeping, so leave them alone.

## Publishing a change

Editing the code does not change the live Hub until you publish a new version:
**Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.**
Editing the existing deployment keeps the same web app URL, so the Hub's
Settings don't need to change. **New deployment** would create a new URL.

## Notifications

Phones get notifications through the push relay in `push-worker/`, which
does the Web Push encryption Apps Script can't. Set that up first (see
`push-worker/README.md`), then:

1. Add `PUSH_WORKER_URL`, `PUSH_SECRET` and `VAPID_PUBLIC_KEY` to Script Properties.
2. In the editor, add a script file named `Notify` (**+ → Script**) and paste
   `Notify.gs` into it. Replace `Code.gs` with this folder's copy too.
3. Pick **setupNotifications** in the function menu at the top and press **Run**.
   Google asks for permission once (to reach the push relay and run on a
   timer). The execution log then shows a checklist of what's working.
4. Publish a new version (above).
5. On each iPhone, open the Hub from its Home Screen icon, tap ⚙, then
   **Turn on notifications**, and **Send a test**.

What gets sent, and when, is set per person in the Hub's Settings: the
morning summary (Jon's also lists his Todoist tasks that are due today or
overdue, minus any ticked in the Hub; nobody else's does), the dinner nudge, the Family Huddle and Weekly Check-In
reminders, new to-dos, the meal plan being ready, and quiet hours. Quiet
hours hold back new to-do and meal-plan alerts until they end. The
scheduled reminders go at the times each person picks.

The meal-plan alert goes once every day has a dinner and the plan has sat
unchanged for 10 minutes (`MEALS_SETTLE_MIN` in `Notify.gs`). It isn't
sent to whoever saved the plan in the Hub. A plan changed straight in the
Sheet goes to everyone.

## Meal plan from Notion

Optional. With it on, the Hub's dinners come from the **Meal Plan** database
in Notion, so a plan made there doesn't have to be typed into the Hub too.
`Notion.gs` reads Notion every 10 minutes and writes this plan week's dinners,
Saturday to Friday, into the Meals tab. Today, Dinner, the dinner nudge and the
meal-plan alert all keep working from that tab.

- **One way, Notion to Hub.** Nothing is written to Notion. While it's on, the
  Hub's Dinner page is read-only, and anything typed
  into the Meals tab is replaced at the next sync. Remove `NOTION_TOKEN` to go
  back to planning in the Hub.
- **The week stays put.** The Dinner page shows Saturday to Friday and only
  turns over on Saturday, so earlier nights stay on it (dimmed) and a dinner
  moved to another night is still there to find. The first day is
  `NOTION_WEEK_START` at the top of `Notion.gs`.
- **What's read.** Rows whose `Meal Type` is Dinner (or blank), by `Date`.
  `Skipped` rows are left out. Two dinners on one date are shown together.
  `Notes` and `Who Cooks` are shown under the dinner. A linked `Recipe` adds a
  link: its `Source` address, or its Notion page if it has none. Property names
  are listed in `NOTION_PROPS` at the top of `Notion.gs`.
- **Meal-plan alert.** It goes once every night of the plan week has a
  dinner and the plan has been unchanged for 10 minutes: on Saturday when the
  new week comes in, and again if the week's plan changes after that.
- **If Notion can't be reached**, the Hub keeps the last plan and says so.

### Setup

1. In Notion, go to **Settings → Connections → Develop or manage
   integrations** (notion.so/profile/integrations), make a new **internal**
   integration named "Family Hub" with **Read content** only, and copy its
   secret.
2. Open the **Meal Plan** database, then **••• → Connections → Family Hub**.
   Do the same for **Recipes**, so recipe links come through. Without it,
   dinners still show, just without their links.
3. Copy the Meal Plan's data source ID: in the database, **••• → Manage data
   sources → ••• → Copy data source ID**.
4. Add `NOTION_TOKEN` (the secret) and `NOTION_MEALS_SOURCE` (the ID) under
   Script Properties.
5. Add a script file named `Notion` (**+ → Script**), paste `Notion.gs` into
   it, and replace `Code.gs` and `Notify.gs` with this folder's copies.
6. Pick **setupNotionMeals** in the function menu and press **Run**. It sets
   the 10-minute timer and syncs once. The execution log lists the week it
   read, e.g. `Tue  Sheet-Pan Sausage https://…  [20 min.]`. An error such as
   `Notion 404: Could not find data_source…` means step 2 or 3 needs another look.
7. Publish a new version (above).

## Check-ins to Notion

Optional. With it on, every check-in saved in the Hub, Family Huddle and
Jon & Maggie alike, gets a page in the **Weekly Check-Ins** database in Notion
(under Harper Life Dashboard → Daily Rhythm). Each page is titled like
`Family Huddle · Oct 11, 2026`, has `Date` and `Type` filled in, and lists
each question as a heading with the answer under it.

- **One way, Hub to Notion.** Check-ins are still saved and shown in the Hub
  as before; the Sheet stays the record. `NotionCheckins.gs` copies new ones
  every 30 minutes (`CHECKINS_SYNC_MIN`). The first run copies every
  check-in already in the Sheet, 25 at a time.
- **Deleting.** Delete a check-in in the Hub and its page goes to Notion's
  trash at the next sync. A page deleted only in Notion comes back, because
  the Sheet still has the check-in.
- **Editing in Notion.** Pages aren't changed once made, so notes or comments
  added in Notion stay. Leave the `Hub ID` property alone: it's how the sync
  knows which check-in a page belongs to.
- **The questions.** Headings come from `CHECKINS_QUESTIONS` in
  `NotionCheckins.gs`, which mirrors `HUDDLE_FIELDS` and `COUPLES_QUESTIONS` in
  `index.html`. Change both together.

### Setup

1. In Notion's integrations page (notion.so/profile/integrations), open
   **Family Hub** → **Capabilities** and also tick **Insert content** and
   **Update content** (update is what trashes the page of a deleted check-in).
   The meal-plan sync still only reads.
2. Open the **Weekly Check-Ins** database, then **••• → Connections → Family Hub**.
3. Copy its data source ID: **••• → Manage data sources → ••• → Copy data source ID**.
4. Add it under Script Properties as `NOTION_CHECKINS_SOURCE`. `NOTION_TOKEN`
   is the same one the meal plan uses.
5. Add a script file named `NotionCheckins` (**+ → Script**) and paste
   `NotionCheckins.gs` into it. `Notion.gs` must be in the project too.
6. Pick **setupNotionCheckins** in the function menu and press **Run**. It
   sets the timer and copies once. The log says what it did, e.g.
   `Check-ins to Notion: updated — 12 copied, 0 trashed`. An error such as
   `Notion 404: Could not find data_source…` means step 2 or 3 needs another
   look; `Notion 403` means step 1.

Nothing needs publishing: the Hub itself doesn't change.

## Todoist

Jon keeps his own to-dos in Todoist. `Todoist.gs` reads his open tasks, with
their projects (Maintenance, Clean, Work, Personal, Inbox…) and sections, from
the Todoist API (v1, `api.todoist.com/api/v1`) every 10 minutes, and keeps the
last good copy. A device that asks for the tasks also triggers a fresh read if
the copy is more than 5 minutes old.

- **Read-only.** Nothing completes, edits or creates anything in Todoist.
- **The token stays in Script Properties.** `TODOIST_TOKEN` is read only by the
  backend. It's never in the Hub's pages, this repo, or a log, and errors are
  logged by status code only, never with task text.
- **Keyed by Todoist's task IDs.** Titles repeat ("Counters" more than once)
  and can hold a pipe ("LinkedIn | Alumni"), so the Hub never matches,
  merges or de-duplicates tasks by title.
- **If Todoist can't be reached**, the Hub keeps showing the last good copy and
  says when it was read ("Couldn't reach Todoist — showing Jon's tasks as of
  Nov 12, 9:40 AM"). It never swaps it for an empty list.

### Setup

1. In Todoist: **Settings → Integrations → Developer → API token**. Copy it.
2. In Script Properties, add `TODOIST_TOKEN` and paste the token as its value.
   Don't paste it anywhere else.
3. Replace `Code.gs`, `Notify.gs` and `appsscript.json` with this folder's
   copies. Add a script file named `Todoist` (**+ → Script**) with `Todoist.gs`
   pasted in, and **delete the old `Reminders` file**. To edit `appsscript.json`,
   turn on **Project Settings → Show "appsscript.json" manifest file in editor**.
   The Gmail service and Gmail permission are gone from it; if **Services** still
   lists **Gmail API**, remove it.
4. Pick **setupTodoist** in the function menu and press **Run**. It removes the
   old Reminders email timers and the old saved snapshot, sets a timer every 10
   minutes, and reads Todoist once. The execution log says what it found, for
   example `Todoist: updated (57 open tasks)`.
5. Publish a new version (above).
6. Turn off the iPhone Shortcut that emails "REMINDERS SNAPSHOT"; nothing reads
   it any more.

If the log says `Todoist 401: check TODOIST_TOKEN`, the token is wrong or was
reset in Todoist: paste the new one into Script Properties.

### Who sees what

The tasks go only to a device that asks for them. A device belonging to Jon or
Maggie shows them until switched off; Clayton's and Heidi's devices don't.
That is a per-device choice in Settings (⚙ → **Todoist**), plus a per-project
one, and a family member can change it on their own device, so it is a
courtesy, not a lock. What *is* a lock is `REMINDERS_HIDE_LISTS`: those
projects never leave the script. `Work` is hidden by default because its tasks
name students.

New projects appear on their own.

### What the Hub shows

Todoist tasks sit among the Hub's own tasks, each row naming its project and
section, with its due date and time, its repeat (↻ every Tue), its priority
(P1–P3; P4 isn't shown) and the start of its description. A task due on a date
with no time is all-day. On **Today**, those due today or overdue join the
to-dos. On **Tasks**, dated ones sort into Overdue, Today, Next 7 days and
Later; undated ones get a folded section per project, in Todoist's order.

**Subtasks** fold under their top-level task, found by Todoist's parent ID, so
only the top-level task sorts by date. A subtask of a subtask goes in the same
fold and says which one it's under. A parent due today or overdue shows its
subtasks open; later ones start folded.

**Ticks are just for fun.** A tick in the Hub marks a task on every device but
does nothing in Todoist. It lasts until the task is done in Todoist (it leaves
the list) or its due date moves (a repeating task's next turn, or a reschedule);
then it's dropped.

## Tasks: due dates and repeats

A task can have a due date and a repeat, set in the Hub or typed straight into
the Tasks tab's `due` and `repeat` columns. Repeats are written the way Apple
Reminders words them:

| `repeat` | Means |
|----------|-------|
| `every 1 week` | Weekly, on the due date's weekday |
| `every 2 weeks` | Every other week |
| `every 1 week on sun,tue,thu` | Those days each week |
| `every 3 months` | Every 3 months, on the due date's day of the month |
| `every 3 months on 3rd sat` | Every 3 months, on the third Saturday |
| `every 1 year on last fri` | Yearly, on the last Friday of the due date's month |

Ticking a repeating task moves `due` to its next date, as Reminders does.
Unticking it the same day puts it back. Tasks with no repeat keep the older
daily/weekly/monthly reset behaviour.

## Tasks: times, subtasks and order

Three more Tasks tab columns. The script adds their headers the first time it
runs, so an existing Sheet needs no changes.

| Column | Holds |
|--------|-------|
| `time` | The time it's due, as text in 24-hour form (`15:30`). Only kept when there's a `due` date. A time typed in the Sheet works too. |
| `parentId` | For a subtask, the `id` of the task it sits under. Subtasks go one level deep: a subtask can't have subtasks of its own. |
| `sort` | Where dragging put it. Tasks sort by day, then time, then `sort`; subtasks sort by `sort`. Blank sorts last. |

Deleting a task deletes its subtasks. A subtask whose parent row is gone
shows as an ordinary task.

A subtask of a repeating task (a `repeat`, or a daily/weekly/monthly
`recurrence`) comes round with it: its tick counts for the parent's current
turn, so when the parent moves on to its next date the subtasks untick too.
A subtask with a `repeat` of its own keeps its own schedule.

Ticking a task ticks its open subtasks too, like Apple Reminders (for a
repeating task, they count for the turn just done). Unticking it leaves the
subtasks ticked. A subtask with a `repeat` of its own isn't ticked with it.

In the Hub, a task's subtasks fold under it like a reminder's: tap
"2 of 3 subtasks left" to hide or show them. Each device remembers which
tasks it has folded (nothing goes to the Sheet). Adding a subtask, or
dragging one in, opens its parent's fold.
