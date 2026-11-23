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
| `js/shell.js` | Shared helpers, the screen list, drawing the current screen, the overlay |
| `js/today.js`, `calendar.js`, `dinner.js`, `tasks.js`, `checkins.js` | One file per screen |
| `js/settings.js` | Sign-in, Settings (including Look & feel), devices, notifications |
| `js/boot.js` | Starts the Hub; always loaded last |
| `manifest.json` | Lets the preview be added to a home screen as its own icon |

The scripts are plain files that share one scope, loaded in order with
`defer`, so the `onclick="…"` handlers in the page keep working. There is no
build step.

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
