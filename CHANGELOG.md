# Changelog

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
