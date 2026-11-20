// Runs the real apps-script/*.gs files outside Google, over a pretend Sheet, so the
// Worker's version of a feature can be checked against the code it replaces.
// Only the Google services those files actually use are imitated, and only as
// far as the tests need. Cells keep exactly what is written to them: a real
// Sheet also turns text that looks like a date or number into one.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../apps-script");

class Sheet {
  constructor() { this.rows = []; }
  getDataRange() { return { getValues: () => this.rows.length ? this.rows.map(r => r.slice()) : [[""]] }; }
  getLastRow() { return this.rows.length; }
  appendRow(r) { this.rows.push(r.slice()); }
  deleteRow(n) { this.rows.splice(n - 1, 1); }
  clearContents() { this.rows = []; }
  getRange(row, col, numRows, numCols) {
    const sheet = this, n = numRows || 1, m = numCols || 1;
    const cell = (r, c) => { while (sheet.rows.length < r) sheet.rows.push([]); const x = sheet.rows[r - 1]; while (x.length < c) x.push(""); return x; };
    const range = {
      getValues: () => Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => { const v = cell(row + i, col + j)[col + j - 1]; return v === undefined ? "" : v; })),
      setValues: vals => { vals.forEach((r, i) => r.forEach((v, j) => { cell(row + i, col + j)[col + j - 1] = v; })); return range; },
      setValue: v => { cell(row, col)[col - 1] = v; return range; },
      setNumberFormat: () => range,
    };
    return range;
  }
}

/** Utilities.formatDate, for the patterns the scripts use. */
function formatDate(date, tz, pattern) {
  const p = {};
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "long", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date).forEach(x => { p[x.type] = x.value; });
  const H = Number(p.hour), months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const out = { yyyy: p.year, MMM: months[Number(p.month) - 1], MM: p.month, dd: p.day, d: String(Number(p.day)),
    HH: p.hour, H: String(H), h: String((H % 12) || 12), mm: p.minute, m: String(Number(p.minute)), ss: p.second,
    a: H < 12 ? "AM" : "PM", EEEE: p.weekday, u: String(days.indexOf(p.weekday) + 1) };
  return pattern.replace(/yyyy|MMM|MM|dd|d|HH|H|h|mm|m|ss|EEEE|a|u/g, t => out[t]);
}

/**
 * files: which .gs files to load, e.g. ["Code.gs"]. props: the Script Properties.
 * opts.clock: { now } in milliseconds, read whenever the script asks the time.
 * opts.uuid: makes the ids, so a test can give the Worker's version the same ones.
 * opts.globals: extra names the scripts can see (see eval below).
 * The scripts use a Date's local time as Apps Script's time zone, so tests that
 * depend on the day must run with TZ=America/New_York (set at the top of the test).
 */
export function appsScriptSim(files, props, opts) {
  opts = opts || {};
  const clock = opts.clock;
  class ScriptDate extends Date {
    constructor(...a) { if (a.length === 0 && clock) super(clock.now); else super(...a); }
    static now() { return clock ? clock.now : Date.now(); }
  }
  const tabs = {};
  const properties = Object.assign({ FAMILY_PIN: "4321", SHEET_ID: "sheet" }, props || {});
  const context = vm.createContext({
    console, JSON, Date: ScriptDate, Math, Object, Array, String, Number, isNaN, Infinity,
    SpreadsheetApp: { openById: () => ({
      getSheetByName: name => tabs[name] || null,
      insertSheet: name => (tabs[name] = new Sheet()),
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in properties ? properties[k] : null),
      setProperty: (k, v) => { properties[k] = String(v); },
      getProperties: () => Object.assign({}, properties),
      deleteProperty: k => { delete properties[k]; },
    }) },
    Utilities: { getUuid: opts.uuid || (() => randomUUID()), formatDate },
    Session: { getScriptTimeZone: () => "America/New_York" },
  });
  Object.assign(context, opts.globals || {}); // stand-ins a test wants the scripts to see
  files.forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), context, { filename: f }));
  return {
    tabs,
    props: properties,
    /** Runs a line of script, e.g. to swap a function that needs a Google service for a stand-in. */
    eval: code => vm.runInContext(code, context),
    /** Calls one of the script's functions by name. The result is copied out as plain data. */
    run: (fn, ...args) => {
      context.__args = args;
      const out = vm.runInContext(`JSON.stringify(${fn}.apply(null, __args))`, context);
      return out === undefined ? undefined : JSON.parse(out);
    },
  };
}
