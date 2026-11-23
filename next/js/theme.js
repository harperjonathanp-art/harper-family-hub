// The Hub's look: which theme, light or dark, and that theme's fonts.
// Loaded in <head>, before the page draws, so it never opens in the wrong colors.
// The choice is kept on this device (fd_theme, fd_scheme); the colors are in css/themes.css.
"use strict";

const THEMES = {
  fridge: {
    name: "Fridge Door",
    fonts: "family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700;12..96,800",
    bg: { light: "#f3f0e8", dark: "#101114" },
  },
  evergreen: {
    name: "Evergreen",
    fonts: "family=Schibsted+Grotesk:wght@400;500;600;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400",
    bg: { light: "#eef1ea", dark: "#0e1411" },
  },
  journal: {
    name: "Home Journal",
    fonts: "family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,400&family=Instrument+Sans:wght@400;500;600;700",
    bg: { light: "#f4eee4", dark: "#1b1613" },
  },
};
const SCHEMES = ["auto", "light", "dark"];
const DARK_QUERY = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function themeChoice() {
  let theme = "", scheme = "";
  try { theme = localStorage.getItem("fd_theme") || ""; scheme = localStorage.getItem("fd_scheme") || ""; } catch (e) {}
  return { theme: THEMES[theme] ? theme : "fridge", scheme: SCHEMES.includes(scheme) ? scheme : "auto" };
}

/* Puts the chosen theme on the page: the colors (by attribute), its fonts, and the color of the
   bar at the top of the phone's screen. Safe to call again whenever the choice or the phone's
   light/dark setting changes. */
function applyTheme() {
  const { theme, scheme } = themeChoice();
  const dark = scheme === "dark" || (scheme === "auto" && !!DARK_QUERY && DARK_QUERY.matches);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.scheme = dark ? "dark" : "light";

  const href = "https://fonts.googleapis.com/css2?" + THEMES[theme].fonts + "&display=swap";
  let link = document.getElementById("themeFonts");
  if (!link) {
    link = document.createElement("link");
    link.id = "themeFonts";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);

  let bar = document.querySelector('meta[name="theme-color"]');
  if (!bar) {
    bar = document.createElement("meta");
    bar.name = "theme-color";
    document.head.appendChild(bar);
  }
  bar.content = THEMES[theme].bg[dark ? "dark" : "light"];
}

function setTheme(theme, scheme) {
  try {
    if (theme && THEMES[theme]) localStorage.setItem("fd_theme", theme);
    if (scheme && SCHEMES.includes(scheme)) localStorage.setItem("fd_scheme", scheme);
  } catch (e) {}
  applyTheme();
}

applyTheme();
// "Auto" follows the phone: switch the moment it goes light or dark.
if (DARK_QUERY) {
  const follow = () => { if (themeChoice().scheme === "auto") applyTheme(); };
  if (DARK_QUERY.addEventListener) DARK_QUERY.addEventListener("change", follow);
  else if (DARK_QUERY.addListener) DARK_QUERY.addListener(follow);
}
