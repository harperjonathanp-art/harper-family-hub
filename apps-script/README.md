# Apps Script backend

`Code.gs` is the Google Apps Script web app the Hub reads from and writes to.
The live copy runs in Google's Apps Script editor; this is the tracked copy.
Change it here, then paste it into the editor and publish a new version.

## Script Properties

Anything private stays out of this public repo. Add these under
**Project Settings → Script Properties**:

| Property     | What it is                                             |
|--------------|--------------------------------------------------------|
| `FAMILY_PIN` | The PIN the Hub sends with every request               |
| `SHEET_ID`   | The Google Sheet that holds tasks, meals and check-ins |
| `CAL_JON`    | Jon's calendar ID (his Google account email)           |
| `CAL_MAGGIE` | Maggie's calendar ID (her Google account email)        |
| `CAL_FAMILY` | The shared Family calendar (`…@group.calendar.google.com`) |
| `CAL_MCHS`   | The MCHS school calendar                               |

A calendar whose property is missing is left out of the Hub.

## Publishing a change

Editing the code does not change the live Hub until you publish a new version:
**Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.**
Editing the existing deployment keeps the same web app URL, so the Hub's
Settings don't need to change. **New deployment** would create a new URL.
