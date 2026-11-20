/**
 * Which features this Worker keeps itself, instead of passing them to Apps Script.
 * Adding a name here moves that feature; taking it out moves it back.
 * See README.md, "Moving a feature", before changing it.
 */
export const MOVED = ["groceries", "shadow"];
// "shadow" is the rehearsal for "core": copy everything from Apps Script, compare, serve nobody from it.
// To move: replace "shadow" with "core".
