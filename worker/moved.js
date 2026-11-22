/**
 * Which features this Worker keeps itself, instead of passing them to Apps Script.
 * Adding a name here moves that feature; taking it out moves it back.
 * See README.md, "Moving a feature", before changing it.
 */
export const MOVED = ["groceries", "core", "calendar"];
// "core" replaced "shadow" (its rehearsal) on 21 Nov 2026, after 55 clean rehearsal runs.
// "calendar" joined on 22 Nov 2026, after 214 comparisons with Apps Script's events, all the same.
// With all three, nothing asks Apps Script for anything.
