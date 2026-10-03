# Apps Script backend

The Hub reads from and writes to this Google Apps Script web app. The live
copy runs in Google's Apps Script editor; this folder is the tracked copy.
Change it here, then paste it into the editor and publish a new version.

| File | What it does |
|------|--------------|
| `Code.gs` | The web app: tasks, meals, calendar, check-ins |
| `Notify.gs` | Notifications: what to send, to whom, and when |
| `Reminders.gs` | Jon's Apple Reminders, read from his daily snapshot email |
| `appsscript.json` | Project settings (time zone, web app access, the permissions the script asks for, the Gmail service) |

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
| `PUSH_WORKER_URL`  | The push relay's address, e.g. `https://harper-family-hub.<name>.workers.dev` |
| `PUSH_SECRET`      | The shared secret from `push-worker/keys.html`         |
| `VAPID_PUBLIC_KEY` | The public key from `push-worker/keys.html`            |
| `REMINDERS_HIDE_LISTS` | Optional. Reminders lists the Hub never receives, comma separated. Left unset it hides `Work` (student names). Set it to a different list to change that, e.g. `Work, Finance` |

A calendar whose property is missing is left out of the Hub.
`NOTIFY_STATE` appears there too once notifications run. It's the
notifications' own bookkeeping, so leave it alone.

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
morning summary (Jon's also lists his Apple Reminders that are due today or
overdue, minus any ticked in the Hub; nobody else's does), the dinner nudge, the Family Huddle and Weekly Check-In
reminders, new to-dos, the meal plan being ready, and quiet hours. Quiet
hours hold back new to-do and meal-plan alerts until they end. The
scheduled reminders go at the times each person picks.

The meal-plan alert goes once every day has a dinner and the plan has sat
unchanged for 10 minutes (`MEALS_SETTLE_MIN` in `Notify.gs`). It isn't
sent to whoever saved the plan in the Hub. A plan changed straight in the
Sheet goes to everyone.

## Reminders

Apple Reminders has no public API and lives only on Jon's iPhone, so the Hub
reads the **REMINDERS SNAPSHOT** email an iPhone Shortcuts automation sends
(daily around 4:40 AM Eastern, plus any manual runs). `Reminders.gs` finds it
with the Gmail API, **read-only**, and keeps the newest snapshot.

- **One way, phone to Hub.** Nothing flows back to Apple Reminders, and the Hub
  never writes to Gmail. Each snapshot is every open reminder, so it replaces
  the last one: what was ticked off or deleted on the phone leaves the Hub at the
  next sync.
- **No credentials in the repo.** The script runs as the account that deployed
  it, so Google's own consent screen grants the `gmail.readonly` permission.
  Snapshot bodies are never logged or sent anywhere but the Hub, and the saved
  copy lives only in Script Properties.
- **Freshness.** The first line of the email says when it was generated. If the
  newest snapshot is not from today (Eastern), the Hub keeps showing it, says
  when it was generated, and never calls it current.
- **Which email.** `subject:"REMINDERS SNAPSHOT" from:me newer_than:1d`. The
  `from:me` stops anyone else from mailing the same subject line onto the Hub.
  If the Shortcut ever sends from another address, change `REMINDERS_QUERY`.

### Setup

1. Replace `Code.gs` and `appsscript.json` with this folder's copies, and add a
   script file named `Reminders` (**+ → Script**) with `Reminders.gs` pasted in.
   To edit `appsscript.json`, turn on **Project Settings → Show
   "appsscript.json" manifest file in editor**. Its `oauthScopes` list names every
   permission the project uses, Gmail read-only included.
2. Check **Services** (the **+** beside it) lists **Gmail API** (v1). The
   manifest adds it; add it by hand if it isn't there.
3. Pick **setupReminders** in the function menu and press **Run**. Google asks
   for permission once ("View your email messages and settings" is the
   read-only Gmail permission). It then sets a daily timer shortly after 4:45 AM and an
   hourly one for manual re-runs, and syncs once. The execution log says what
   it found, for example `Reminders: updated (snapshot 10/1/26, 9:40 AM, 42 open)`.
   Run it **before** publishing: a web app can't ask for new permissions itself.
4. Publish a new version (above).
5. On each device, open ⚙ Settings → **Reminders** and choose what that device shows.

If the log says `no_email`, check the Gmail filter still labels
"Reminders Snapshot" and that the Shortcut ran. A filter that skips the inbox is
fine: the search covers all mail.

### Who sees what

Reminders go only to a device that asks for them. A device belonging to Jon or
Maggie shows them until switched off; Clayton's and Heidi's devices don't.
That is a per-device choice in Settings, plus a per-list one, and a family
member can change it on their own device, so it is a courtesy, not a lock.
What *is* a lock is `REMINDERS_HIDE_LISTS`: those lists never leave the script.
`Work` is hidden by default because its reminders name students. The email also
carries financial reminders (HOA dues, tithe); to keep a whole list off every
phone, add it to `REMINDERS_HIDE_LISTS`.

New lists appear on their own, since list names are free text.

### What the Hub shows

Reminders sit among the Hub's own tasks, each row naming its list. On
**Today**, those due today or overdue join the to-dos. On **Tasks**, dated
ones sort into Overdue, Today, Next 7 days and Later; undated ones get a
folded section per list, at the bottom.

**Subtasks.** The Shortcut writes a subtask with its parent in the title:
`Counters (Subtask of Tuesday)`. The Hub splits that off and folds each subtask
under its parent (Tuesday, Fall…), so only the parent sorts by date. A parent
due today or overdue shows its subtasks open; later ones start folded. Each
subtask has its own tick. A subtask whose parent isn't in the snapshot is
shown as a row of its own, saying what it belongs to. A tick in the
Hub hides a reminder on every device, but the iPhone has the final say. The
tick lasts until the next snapshot. If the reminder is gone from it, it was
done on the phone and the tick is dropped. If it is still there in a snapshot
made after the tick, it comes back, as a nudge to tick it on the phone. Nothing
goes back to Apple Reminders. Titles repeat in Reminders ("Counters" more than once), so the Hub never merges
or de-duplicates them.

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
