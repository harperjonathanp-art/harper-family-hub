# Harper Family Hub

What today asks of four people: the day, the calendar, dinners and recipes,
tasks, and the weekly check-ins, for Jon, Maggie, Clayton and Heidi.

This folder is the page: GitHub Pages publishes it from `main` at
`https://harperjonathanp-art.github.io/harper-family-hub/`. Everything it
reads and saves goes through the Hub's Worker (`worker/`, with its own
README), which Cloudflare deploys from `main` too. `privacy.html` is the
privacy page. `apps-script/` is where the Hub came from, kept for reference.

The current look was built in stages from a redesign plan (in Claude Docs as
"Family Hub Redesign Build Plan"), each tried at a preview page first. That
preview lived in `next/`; it's now this page, and `next/` only sends a phone
that still has the preview on its home screen here.

## Files

| File | What's in it |
|------|--------------|
| `index.html` | The page frame, and the order the files load in |
| `css/themes.css` | Every color, font and corner size, for each theme in light and dark |
| `css/app.css` | Layout and components |
| `js/theme.js` | Applies the chosen theme before the page draws (loaded in `<head>`) |
| `js/data.js` | Who's signed in, talking to the Worker, drafts |
| `js/shell.js` | Shared helpers, the screen list and floating tab bar, sliding between screens, row and tick motion, and the panel that rises from the bottom |
| `js/today.js`, `calendar.js`, `dinner.js`, `tasks.js`, `checkins.js` | One file per screen |
| `js/recipes.js` | Recipes under Dinner: browse and search, a recipe's page, cooking a step at a time, adding to groceries |
| `js/settings.js` | Sign-in, Settings (including Look & feel), devices, notifications |
| `js/boot.js` | Starts the Hub; always loaded last |
| `manifest.json` | Lets the Hub be added to a home screen as its own app |
| `sw.js` | Offline use (the page and this release's files) and notifications |
| `icons/` | The icon in every size, and the link-preview image |

The scripts are plain files that share one scope, loaded in order with
`defer`, so the `onclick="…"` handlers in the page keep working. There is no
build step.

Motion follows one rule: only what someone does moves (switching screens, ticking,
adding, deleting, opening a panel). The refresh every minute, a drag in progress
and typing never animate, and the phone's Reduce Motion setting turns it all off.

## Phones and computers

One page for both. Wider than 900 px (`wide()` in `js/shell.js`, and the
`@media (min-width: 900px)` block at the end of `css/app.css`), the tab bar
becomes a sidebar (with New task, the sync pill, Settings and who's signed
in), Today, Tasks, Dinner, Calendar and a recipe page use two columns, and
panels open as windows in the middle. Resizing across 900 px switches at once.
The sections come first for the keyboard, after a "Skip to content" link.

## Release numbers

Every file link in `index.html` ends in `?v=<release>`. Raise it whenever any
file here changes, so a phone never runs a new page with an old file, and set
`RELEASE` in `sw.js` to match, so a new install can open offline straight away
(the page check fails if they differ). Raise `CACHE` in `sw.js` when `sw.js`
itself changes.

## Before each change goes live

```
node tools/page-check.cjs
```

Opens every screen in every theme with sample data, fails on any script error
or text below 4.5:1 contrast, and saves screenshots to `tools/page-check/out/`.

## Icons

`icons/` holds the Fridge Door icon in every size the app uses, and the
link-preview image. They're all drawn from one design by
`node tools/icons.cjs` (Playwright), so a change to the design is one edit
and one run.

## Home-screen icons

iPhones keep the home-screen icon they were given until the Hub is removed
from the home screen and added again; Android updates it on its own.
