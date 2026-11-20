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

/** files: which .gs files to load, e.g. ["Code.gs"]. props: the Script Properties. */
export function appsScriptSim(files, props) {
  const tabs = {};
  const properties = Object.assign({ FAMILY_PIN: "4321", SHEET_ID: "sheet" }, props || {});
  const context = vm.createContext({
    console, JSON, Date, Math, Object, Array, String, Number, isNaN, Infinity,
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
    Utilities: { getUuid: () => randomUUID() },
    Session: { getScriptTimeZone: () => "America/New_York" },
  });
  files.forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), context, { filename: f }));
  return {
    tabs,
    /** Calls one of the script's functions by name. The result is copied out as plain data. */
    run: (fn, ...args) => {
      context.__args = args;
      const out = vm.runInContext(`JSON.stringify(${fn}.apply(null, __args))`, context);
      return out === undefined ? undefined : JSON.parse(out);
    },
  };
}
