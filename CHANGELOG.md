# Changelog

## Unreleased — Image API

**Added**

- `stateEngine.importImageFile(extensionId, instanceId, file, { folder })`: other extensions
  store images through State Engine's own image-variable pipeline (same checks, same
  SillyTavern upload, unique names) into a folder of their choosing, and get back the relative
  path `user/images/<folder>/<file>`. Throws with the reason on failure. The existing import
  functions take an optional folder that defaults to `state-engine-images`, so State Engine's
  own drops and preset import/export are unchanged.

## Unreleased — Weekdays and clock time primitives

**Added**

- **Weekdays, only for calendars that define them.** Calendar definitions take three optional
  fields: `daysPerWeek`, `weekdayNames` and `weekdayShortNames` (null or absent = not defined).
  With names, the week is `weekdayNames.length` days; with only `daysPerWeek`, weekdays are
  numbered but unnamed; with neither, the calendar has no weekday concept. Fantasy calendars
  count days from their epoch (year 1, month 1, day 1 is weekday 0). Gregorian-rule calendars
  use Tomohiko Sakamoto's algorithm (0 = Sunday); the built-in `gregorian` calendar now names
  its weekdays Sunday..Saturday (Sun..Sat) - saved settings are updated automatically.
- Built-in fantasy calendars: **Faerûn-Inspired** has 10-day tendays (Firstday..Tenthday,
  1st..10th); **Three-Moon** (lunar-driven) and **Solar-Cycle** (season-driven) explicitly have
  no weekday concept.
- Validation: `weekdayNames` needs `daysPerWeek` and exactly that many entries;
  `weekdayShortNames` must match `weekdayNames` in length; a Gregorian-rule calendar's week
  must be 7 days.
- **Calendar editor**: a Weekdays section - Days per week (blank = no weekdays), weekday names
  and short names (disabled until a week length is set). The preview shows the weekday.
- Structured dates (`toStructured`, `formatPartial`) carry `weekdayIndex`, `weekdayName` and
  `weekdayShortName` (each may be null). Brace patterns take `{weekday}`, `{weekday_short}`
  and `{weekday_index}`, which output nothing when null.
- `getDateTimeParts(extensionId, instanceId, calendarId, scalarTime)`: the structured date plus
  `time: { hour, minute, second, fraction }` and
  `calendar: { id, hoursPerDay, minutesPerHour, secondsPerMinute, daysPerWeek }` - what an
  analog clock needs to place its hands for any calendar.

## Unreleased — "Date only" datetimes keep advancing

**Changed**

- **Datetime mode "Date only" is now display-only.** It used to truncate the stored value to
  midnight after every write, so a small tick ("1h" per message) or a prompted "advance 2 hours"
  was thrown away and the date never moved. The stored moment now keeps its time-of-day and
  accumulates normally; the tracker, `{{getvar}}` display and extensions show just the date.
  "Time only" is unchanged (its date is still pinned to the calendar's reference day).
- "Semantic time of day" is now offered for "Date only" variables too ("the next morning" moves
  to the next day).
- The tracker's edit box for a "Date only" variable shows the full date and time, so an edit
  never silently drops the hidden time.

## Unreleased — Number limits in the editor; image resolution API

**Added**

- **Min / Max for number variables** in the manager's variable editor. Both are optional
  (blank = no limit) and use the existing `min` / `max` definition fields - nothing is renamed
  and no limits are added to existing variables.
- `getVariableImage(extensionId, instanceId, chatId, name)` in the Variable Value API: the
  image an image / image list / image map variable is showing, by the tracker's rules.

**Fixed**

- **Limits were not applied to the stored value on increments and prompted updates** (only
  the `{{getvar}}` mirror was clamped). Now every write keeps a limited number within its
  min/max; a prompted numeric answer given as text is stored as a number.

**Tests:** 43 files, 1832 tests (new: `tests/number-limits.test.js`, `getVariableImage` cases).

## Unreleased — Variable Value API, cross-namespace activation

**Added**

- **Variable Value API** (`src/api/variable-value-api.js`; API Reference 6.5, spec Section 19),
  for extensions that display State Engine state:
  - `listAllVariables(extensionId, instanceId, chatId?)` — every preset in every namespace,
    grouped, with display-only variable definitions and (given a chat) whether each preset is
    active there.
  - `getVariableValue` / `getVariableValues` — current values by qualified name, any namespace.
  - `setVariableValue` — write a value for one of your OWN variables (refuses calculated ones).
- **`state_engine_variables_changed`** is emitted on SillyTavern's `eventSource` whenever
  variable values are saved (one event per chat per burst of writes), so displays can stay
  live without polling.

**Changed**

- **`activatePreset` / `deactivatePreset` work on any namespace's preset.** Binding a preset to
  a chat changes nothing about the preset, so it no longer requires owning its namespace — only
  a registered caller on the right instance. Editing presets and variables stays owner-only.

**Tests:** 42 files, 1811 tests (new: `tests/api/variable-value-api.test.js`,
`tests/variable-change-signal.test.js`; identity tests updated for cross-namespace activation).

## Unreleased — Choose how a new chat starts

**Changed**

- When you create a new chat with a character (or group) you have chatted with before,
  State Engine now asks how it should start, before the chat proceeds:
  1. **Same presets, no data** — the earlier chat's presets are activated; variables start at
     their defaults.
  2. **Continue (presets + data)** — same presets and the earlier chat's variable values.
  3. **Clean slate** — no presets, no data (also what closing the dialog does).
  Previously the only question was whether to copy the values, which left the presets off.
  A new chat still starts empty unless you choose otherwise; nothing carries over silently.
- The question is also asked for brand-new **group** chats (they emit a different event).
- Only variables the activated presets define are copied.

**Tests:** 20 files, 1362 tests (31 new in `tests/new-chat-start.test.js`).

## Unreleased — Manager modal showed the previous chat

**Fixed**

- **Re-opening the manager after creating or switching chats showed the OLD chat's active
  presets.** Only the Variable Management tab was redrawn on open; the Presets tab (and
  the Variables and World Info tabs) kept whatever was drawn last, so a brand-new chat
  appeared to have the previous chat's presets active. Opening the manager now redraws all
  chat-dependent tabs, and an open manager redraws when the chat changes (not on every
  update, so an editor in use is not discarded).
- **Activate / Deactivate acted on the chat the button was drawn for.** It now always acts
  on the chat that is open at the time of the click.
- No stored data was wrong: presets are stored per chat and a new chat starts with none.

**Tests:** 19 files, 1331 tests. New `tests/manager-modal-chat.test.js` (10 tests, jsdom +
jquery dev dependencies); 6 of them fail against the previous code.

## Unreleased — World Info editor box fix

**Fixed**

- **The "State Engine Conditions" box never appeared in the World Info editor.** The
  injector looked for markup SillyTavern does not have (`.world-info-entry-fields`,
  `.ui-world-info-edit-form`, `.form-inline`). It now targets SillyTavern's real entry
  forms: one box per expanded entry (`.world_entry_edit` inside `.world_entry[uid]`),
  added as ST builds each form, and never in the hidden template ST clones.
- **Conditions are keyed by the lorebook being edited** (the selected book in
  `#world_editor_select`), not by the hidden character-linked lorebook input the old
  code read by mistake. If the book or uid cannot be determined, Save refuses instead
  of storing a key the filter would never match.
- Several entries can be expanded at once; each keeps its own list, and only one
  condition editor exists at a time. Clicks go through one delegated listener.

**Tests:** 18 files, 1321 tests. New `tests/wi-editor-dom.test.js` (26 tests) runs the
editor in a real DOM (jsdom, now a dev dependency) against markup copied from
SillyTavern 1.18; it fails against the old injector. One documentation test now
tolerates Windows (CRLF) checkouts.

## World Info gap-resolution pass

Fixes for the gaps found while testing conditional World Info, lorebook bindings and
bundles. No new features, no change to the operators, the bundle format or the
core architecture.

**Fixed**

- **Enable State Engine** now also switches off World Info filtering. Untick it and
  every entry passes through untouched; the hook stays registered.
- A **damaged condition list** no longer stops filtering: only that entry is skipped
  (kept visible, with a warning) and every other entry is still checked.
- The World Info editor **escapes** everything it shows (variable, preset and operator
  names, values, entry keys), so text can no longer be interpreted as HTML.
- **Arrays of objects:** the value field is disabled with an explanation, no operators
  are offered, and Save refuses instead of throwing.
- The variable dropdown and the condition list show **variable names** (with the preset
  name), not ids. Stored conditions still hold the id, so existing ones keep working.
- Conditions can be **edited in place** (Edit button; Save replaces, Cancel leaves it).
- **Declined activation prompts** are cleared by a new **Clear Declines** button and
  automatically when the lorebook's presets change, the lorebook is removed from the
  chat, or the preset is activated manually.
- **`window.StateEngineWI`** now checks the caller exactly as `stateEngine.*` does, with
  the same errors. **Breaking:** every function now takes `(extensionId, instanceId, ...)`
  first. Bad callers are rejected synchronously, including for the async functions.
- **`shouldDisplayWIEntry`** now gives the same answer as the runtime filter (missing
  variable, unknown operator, bad regex or damaged data all show the entry; errors are
  logged, not thrown).
- World names go through `normalizeWorldName` everywhere (including lorebook bindings).
- **Bundle import** no longer leaves orphans: conditions for entries or variables that
  don't exist are skipped; presets are imported only if bound or used by a kept
  condition; bindings are made only to presets that exist; dangling ids in a merged
  binding are removed. The import result reports what was skipped.
- **Bundle export** leaves out empty preset lists, condition lists and bindings.
- The World Info editor box, editor and rows use SillyTavern's theme colours, so they
  are readable on dark and light themes.

**Tests:** 17 files, 1295 tests (116 new in `tests/world-info-gap-fixes.test.js`).
**Docs:** `WORLD_INFO_TEST_PLAN.md` (v1.1, gaps marked FIXED, new §14) and
`WORLD_INFO_COMPATIBILITY_NOTES.md` updated.

**Still open (unchanged):** persona lorebooks are not checked for activation prompts;
renaming a lorebook orphans its conditions and bindings; numeric operators on
non-numeric values hide the entry; preset import accepts a variable with no name.
