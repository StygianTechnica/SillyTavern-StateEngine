# Changelog

## Unreleased — World Info gap-resolution pass

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
