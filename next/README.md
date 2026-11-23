# The redesign's preview

`next/` is the Hub being redesigned, one stage at a time (the build plan lives
in Claude Docs as "Family Hub Redesign Build Plan"). GitHub Pages publishes it
beside the live Hub, at `…/harper-family-hub/next/`. It uses the same Worker,
sign-in and data as the live Hub, so a signed-in phone can open it straight away.

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
| `manifest.json` | Lets the preview be added to a home screen as its own icon |

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
file here changes, so a phone never runs a new page with an old file. When the
preview is promoted, the live `sw.js` cache version goes up too.

## Before each preview

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

## Becoming the live Hub

When the preview replaces the live page:

1. Move `index.html`, `css/`, `js/`, `icons/` and `manifest.json` up to the
   repo root, in place of the old `index.html`, `manifest.json` and root icons.
2. In `js/boot.js`, register `sw.js` rather than `../sw.js`; in
   `manifest.json`, drop "(preview)" from the name and point `start_url`
   and the icons at the root; in `index.html`, drop `next/` from the
   link-preview addresses and the `noindex` line.
3. In `sw.js`, raise `CACHE` and list every file (with its `?v=`) for
   offline use, and cache the root page again.
4. Run `node tools/page-check.cjs .` against the root page.
5. iPhones keep the old home-screen icon until the app is removed and added
   again; Android updates it on its own.
