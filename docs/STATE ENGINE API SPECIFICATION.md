STATE ENGINE API SPECIFICATION
Version 0.1 — Scaffold / Forward-Looking Design Document

Status (2026-09-10): `src/api/` is implemented — namespace/extension
registration, namespaced preset and variable CRUD, namespaced event
registration/dispatch, dependency-graph introspection, and an independent-
preset dispatcher foundation are all real, working code (see Section 6 for
exactly what each module delegates to vs. implements itself, and this
pass's known limitations). `src/ui/manager-modal/manager-api.js` is now
wired onto this layer for preset CRUD (Section 7), and the manager modal's
own presets/variables live under the reserved `se` namespace, including a
one-time historical migration of everything that existed before this
change. See Section 7 for exactly what changed, what didn't, and the one
real, irreversible consequence (existing `{{name}}` macro references in
character cards/World Info need manual updating).

This document does not override `docs/STATE ENGINE REQUIREMENTS
SPECIFICATION.md`. Every invariant in that document (single source of
truth, macro-mirror-is-not-source-of-truth, no chat metadata, synchronous
CRUD, etc.) still applies to whatever eventually implements the functions
described here — the API layer is a new *surface* on top of the existing
engine, not a replacement for any of its rules.

SECTION 1 — PURPOSE

The API layer (`src/api/`) is the public interface for code that wants to
read or drive State Engine state without reaching into `src/core/*`
directly. It sits above `src/core/*` and `src/events/*`, and below
`src/ui/*`:

```
src/ui/*        (manager modal, tracker panel, wand UI, settings panel)
   |
   v
src/api/*       (this layer — the only supported entry point for external code)
   |
   v
src/core/*, src/events/*   (engines, isolated store, macro mirror, event wiring)
```

Intended consumers, in the order they're expected to arrive:

- **This extension's own UI** (`src/ui/manager-modal/manager-api.js`) — the
  first consumer, once the corresponding API functions have real
  implementations (see Section 5).
- **Other SillyTavern extensions** that want to read or write State Engine
  variables/presets without depending on this extension's internal module
  layout — referred to below by their working names: Pretty Panels,
  Scenario Builder, Curator.
- **World info modules** (`src/world-info/*`) — currently import
  `src/core/*` directly; a future pass may route them through this layer
  the same way UI code will.
- **Future external integrations** not yet named or built.

None of the named consumers (Pretty Panels, Scenario Builder, Curator)
exist in this repository as of this document's authoring — they are
referenced here only to explain why the API layer is namespaced (Section
2) rather than assuming a single caller.

SECTION 2 — NAMESPACE MODEL

**Format.** Every preset is *addressed* as the tuple `(namespace, name)`
(two separate arguments everywhere in Section 3's API — `activatePreset(chatId,
namespace, name)`, not a single concatenated string). Written as prose,
that's `namespace.presetName`.

Every variable's *stored* name (its real `def.name`, the literal string
`chat-state.js`/`macro-store.js` key values by, and the literal identifier
a calculated variable's `dependencies`/`expression` must use to reference
it) is the CONCATENATED string `namespace__variableName` — double
underscore, not a dot. This is a real, load-bearing difference from preset
addressing, not a typo: the Tiny Expression DSL's tokenizer
(`src/core/expression-dsl.js`) treats `.` as property-access syntax
(`arr.length`, `s.upper()`) — `se.mood` tokenizes as `ident("se")` +
`op(".")` + `ident("mood")`, two tokens, not one identifier, so a
calculated variable depending on it can never evaluate. `se__mood`
tokenizes as one atomic identifier (`__` is a normal identifier character)
and works correctly with zero changes to that module. Root-caused
2026-09-10 by actually evaluating an expression through the real engine,
not just checking that a dependency string matched — see Section 7's
report for the full incident.

```
namespace.presetName        (two-argument address, prose form)
namespace__variableName     (the real, stored, single-string name)
```

`namespace` identifies which extension owns the thing being addressed.
This extension's own presets/variables use the namespace `se` (State
Engine). A hypothetical Pretty Panels preset would use `pp`, and so on —
the exact namespace string an extension uses is whatever it registers with
`registerExtension()` (Section 3).

**Ownership rules:**

- An extension owns exactly the namespace(s) it registered.
- A variable's namespace is inherited from the preset that contains it — a
  variable does not carry its own separate namespace, since it cannot
  exist outside a preset (`src/core/preset-manager.js`: `preset.variables`
  is keyed by variable id, and every variable definition lives inside
  exactly one preset's `variables` map).
- **Write isolation is strict.** An extension may create, update, or
  delete only presets/variables in namespaces it owns. A write attempt
  against a namespace the caller does not own must fail (return an error /
  rejected result) rather than silently succeed or silently no-op —
  silent failure here would reproduce the exact class of bug documented in
  `preset-manager.js`'s `isVariableNameTaken` comment (a same-named
  variable in a different preset silently colliding in the isolated
  store).
- **Read access is namespace-scoped by default.** Cross-namespace *reads*
  (e.g. Curator reading a Pretty Panels variable to display it) are an
  explicitly optional, future capability — not part of this initial
  surface. Until it's designed and implemented, `getVariable()` /
  `listVariables()` calls are scoped to the caller's own namespace(s) only.

**Events are namespaced the same way**, using `namespace.eventName`:

```
pp.rollDice
se.combatTick
```

An event source registered under a namespace can only be fired under that
namespace (`fireEvent()`, Section 3) — this mirrors the write-isolation
rule for presets/variables so namespacing is consistent across the whole
API surface, not just CRUD.

SECTION 3 — API SURFACE

All modules below live in `src/api/` and are re-exported through
`src/api/index.js` and the `stateEngine` façade in
`src/api/state-engine-api.js`. Signatures here are the target contract;
current bodies are empty stubs (Section 5 status note applies).

**Extension Registration** (`src/api/extension-registry.js`)

```
registerExtension(info)          // info: { namespace, name, ... } — claims a namespace
unregisterExtension(id)
getRegisteredExtensions()
```

**Preset CRUD** (`src/api/preset-api.js`)

```
createPreset(def)                          // def.namespace determines ownership
updatePreset(namespace, name, patch)
deletePreset(namespace, name)
activatePreset(chatId, namespace, name)    // binds the preset to a chat
deactivatePreset(chatId, namespace, name)
listPresets(namespace)
```

**Variable CRUD** (`src/api/variable-api.js`)

```
createVariable(def)              // def.namespace/def.presetName determine ownership
updateVariable(ref, patch)
deleteVariable(ref)
getVariable(ref)
listVariables(namespace, presetName)
```

`ref` in this module identifies one variable as
`{ namespace, presetName, variableName }` — `variableName` here is the
local, unqualified name (`"mood"`), not the stored `namespace__mood` form;
resolving `ref` to a definition is exactly what re-derives that qualified
name (Section 2). Enough to resolve to a single variable definition
without needing its internal id.

**Events** (`src/api/event-api.js`)

```
registerEventSource(info)        // info: { namespace, eventName, ... }
fireEvent(chatId, eventName)     // eventName must be namespace-qualified
```

**Dependency Graph** (`src/api/dependency-graph.js`)

```
getDependencies(ref)             // calculated-variable dependencies (see engine spec 1.17)
getDependents(ref)               // inverse of getDependencies
```

**Independent Presets** (`src/api/independent-presets.js`)

```
runIndependentPreset(chatId, presetRef)
configureIndependentPreset(namespace, name, config)
```

"Independent" presets are presets whose update cycle runs outside the
normal per-message trigger flow (`src/core/deterministic-engine.js`,
`src/core/prompted-engine.js`) — the dispatcher this module scaffolds is
meant to eventually support:

- Alternate LLM support (routing a preset's prompted updates to a
  different connection profile than the extension's default one).
- A sequential dispatcher (running independent presets one at a time
  rather than concurrently, where ordering matters).
- Batching rules (grouping multiple independent presets' updates into a
  single LLM call rather than one call each).

None of the three are designed in detail yet — this module is a named
placeholder for where that design will live, not a description of
existing batching/dispatch behavior (there is none yet).

**Introspection.** `getRegisteredExtensions()`, `listPresets()`,
`listVariables()`, `getDependencies()`, and `getDependents()` together
form the read-only introspection surface — everything a consumer needs to
discover what exists without mutating anything.

SECTION 4 — INVARIANTS

- **CRUD is synchronous.** Every function in Section 3 returns
  synchronously (no Promises, no async/await) — this matches
  `src/core/preset-manager.js` and `src/core/chat-state.js` today, which
  are synchronous throughout because `context.extensionSettings` +
  `saveSettingsDebounced()` (the only persistence substrate available to a
  browser extension with no filesystem access) are themselves synchronous.
- **Calculated variables cannot be externally set.** `updateVariable()` /
  `createVariable()` must reject (or ignore, per whatever error-handling
  convention is chosen when implemented) an attempt to set a value on a
  variable whose `def.type === 'calculated'` — its value is always
  produced by `calculated-engine.js`'s expression evaluation, never by a
  direct write, matching engine spec 1.17.
- **Namespaces are isolated**, per Section 2 — a write outside the
  caller's own namespace(s) must fail, never silently apply or silently
  no-op.
- **Extensions may only modify their own presets/variables** — the
  practical consequence of namespace isolation applied to Section 3's
  preset/variable CRUD specifically.
- **Events never mutate foreign namespaces.** `fireEvent()` dispatches a
  namespaced event; any state change that event triggers must land only
  in the firing extension's own namespace, never another extension's,
  even if the receiving handler was registered by a different extension
  listening for that event.

SECTION 5 — INTEGRATION POINTS

**`src/core/*` engines.** The API layer is a caller of the core engines,
never a reimplementation of them. `preset-api.js` / `variable-api.js`
functions, once implemented, are expected to delegate to
`preset-manager.js` (preset/variable CRUD), `chat-state.js` (`setVar`,
`getVar`, `applyIncrement`, seeding), and `calculated-engine.js`
(recalculation triggers) rather than duplicating their logic — the same
"don't move logic across modules" rule from engine spec Section 2 applies
here: the API layer adds a namespaced, access-controlled entry point in
front of the engines, it does not relocate what the engines do.

**`src/events/*`.** `event-api.js`'s `fireEvent()` is expected to route
through `src/events/event-engine.js`'s existing dispatch (or a namespaced
extension of it) rather than calling `eventSource.emit` directly, so
State Engine's own lifecycle rules (engine spec Section 3 — seeding only
on enable/preset-add-remove/variable-save, never inside update engines)
stay centralized in one place instead of being re-derived by every API
consumer.

**`src/ui/*`.** `src/ui/manager-modal/manager-api.js` is the API layer's
first intended internal consumer — see Section 6 (Current API status) for
why that wiring has not happened yet in this pass.

**Macro registration.** Variable CRUD that changes a variable's name,
preset membership, or active/inactive state has downstream effects on
`src/core/macro-registration.js`'s `{{name}}` macro registration (engine
spec 1.19). An implemented `variable-api.js` / `preset-api.js` is expected
to call `refreshVariableMacros()` after any such change, the same way
`preset-manager.js`'s `addPresetToChat` / `removePresetFromChat` do today
— this is not optional cleanup, it's required to keep macro availability
in sync with what the API layer just changed.

**Chat-state persistence.** All persistence continues to go through
`src/core/settings-core.js`'s `getSettings()` / `persistSettings()`
(`context.extensionSettings.state_engine`, saved via
`saveSettingsDebounced()`) exactly as documented in engine spec 1.1 and
1.3. The API layer introduces no new storage location — namespace
ownership (Section 2) is metadata *about* presets/variables already
stored in the existing `settings.presets` structure, not a second store.

SECTION 6 — CURRENT API STATUS (this pass)

`src/api/*` is implemented and verified against a mocked SillyTavern
context (registerExtension → createPreset → createVariable →
activatePreset → updateVariable → deleteVariable → deletePreset →
unregisterExtension, plus dependency-graph and independent-preset checks —
see this pass's implementation report for what was exercised).
`src/ui/manager-modal/manager-api.js` was **not** touched, per this pass's
own explicit instruction to leave UI rewiring for a later pass.

**Real implementation, by module:**

- `namespace-manager.js` / `extension-registry.js` — `settings.extensions`
  (keyed by namespace) is the registry. `registerExtension`/
  `unregisterExtension`/`getRegisteredExtensions`/`validateNamespace`/
  `ownsNamespace` are all real. `unregisterExtension` deletes every preset
  whose `preset.namespace` matches (via `preset-manager.js`'s own
  `deletePreset`, never reimplemented) plus their stored variable values
  (`chat-state.js`'s `deleteVariableValueEverywhere`), then refreshes
  macros. `createNamespace`/`getNamespaces` remain empty stubs — not in
  this pass's required-implementation list.
- `preset-api.js` — `createPreset`/`updatePreset`/`deletePreset`/
  `activatePreset`/`deactivatePreset`/`listPresets` all delegate to
  `preset-manager.js` (`createPreset`, `renamePreset`, `deletePreset`,
  `addPresetToChat`, `removePresetFromChat`) and address presets by
  `(namespace, name)`, stamping a new `preset.namespace` field onto
  presets created through this layer. `updatePreset`'s patch strips
  `id`/`namespace` (no moving a preset to another namespace via patch) and
  routes a `name` change through `renamePreset()` rather than a direct
  field write.
- `variable-api.js` — full CRUD, delegating seeding/reset/recalc/macro
  refresh to `chat-state.js`/`calculated-engine.js`/`macro-registration.js`
  exactly as those modules already work. **Storage key is namespace-
  qualified** (`namespace__localName`, e.g. `"pp__mood"`, delimiter "__" not
  "." — see Section 2/4 note below for why) — `createVariable`/`updateVariable` reuse
  `preset-manager.js`'s existing `isVariableNameTaken()` collision check
  against the qualified name.
- `event-api.js` — `registerEventSource` stores metadata in a new
  `settings.eventSources` map, keyed by qualified event name. `fireEvent`
  validates the namespace prefix and dispatches through a new, additive
  `dispatchNamespacedEvent()` export added to `src/events/event-engine.js`
  (emits on the same `eventSource` instance every built-in listener in
  that file is registered on — zero existing lines in that file changed).
- `dependency-graph.js` — pure reads over `def.dependencies`; `getDependents`
  is scoped to `ref.namespace`'s own presets only, matching a dependency
  target qualified the same way `variable-api.js` stores names.
- `independent-presets.js` — `configureIndependentPreset` stores a config
  bag on `preset.independentConfig`. `runIndependentPreset` is a real,
  working async pipeline (transcript build → LLM call → parse → write),
  built by composing already-exported pieces
  (`callBackgroundLLM`/`stripHtml`/`extractJsonObject`/
  `describeConstraint`/`shouldSkipPromptedRefresh` from
  `src/core/prompted-engine.js`/`background-llm.js`/
  `src/ui/formatting-utils.js`) rather than by modifying
  `prompted-engine.js` itself — see the module's own header comment and
  the limitations below for why.

**Known limitations, reported rather than silently forced:**

1. **No true per-caller ownership.** None of the CRUD signatures specified
   for `preset-api.js`/`variable-api.js`/`event-api.js`/
   `independent-presets.js` carry a caller/extension identity, so "validate
   namespace ownership" in this pass can only mean `validateNamespace()`
   (the namespace is registered by *someone*) — not "this specific caller
   owns it." `ownsNamespace(extensionId, namespace)` is fully implemented
   and correct, it's just unused by the rest of the layer today. Real
   enforcement needs a caller-identity parameter threaded through every
   CRUD function — a signature change beyond this pass's scope.
2. **Qualified storage names, not a permission veneer.**
   `chat-state.js`/`macro-store.js` key every variable by bare `def.name`
   globally (see `preset-manager.js`'s `isVariableNameTaken` comment for
   the already-fixed bug this caused once). Namespace metadata that lived
   only at the API layer would not have prevented the same collision
   between two namespaces — it would have just added a permission check in
   front of the exact bug that was already root-caused. So
   `variable-api.js` stores the qualified name (`namespace__localName`)
   as the real `def.name`, making it collision-proof with zero core-store
   changes. This is a real design decision, not just scaffolding — flagged
   here explicitly since it goes beyond a literal reading of "apply
   namespace + name mapping." (Delimiter corrected from "." to "__" on
   2026-09-10, same day — see Section 7 for the incident that found why "."
   doesn't work.)
3. **`fireEvent` dispatch mechanism.** `event-engine.js` had no existing
   generic named-event dispatch facility (only fixed built-in-event
   wiring). Added one small additive export rather than bypassing the file
   entirely.
4. **`runIndependentPreset` duplicates ~15 lines of transcript/
   classification logic from `prompted-engine.js`** instead of extracting
   a shared helper out of that file. Deliberate: `prompted-engine.js` is
   the project's highest-priority, already-stabilized area, and this pass
   prioritized zero changes to it over avoiding this small duplication.
5. **No true mutual exclusion with the standard prompted-engine flow.**
   `independent-presets.js` only guards against two independent-preset
   runs overlapping each other (an in-module flag). Preventing overlap
   with `prompted-engine.js`'s own fire-and-forget updates would require
   adding new shared in-flight-tracking state to that file — avoided for
   the same reason as #4.
6. **Renaming a variable via `updateVariable` doesn't migrate its stored
   per-chat value** to the new key. This matches an existing gap in
   `chat-state.js` itself (no rename-migration path exists there for
   *any* caller, including the manager-modal inline editor) — not a new
   limitation this pass introduced, just one now reachable through a new
   entry point.

SECTION 7 — UI REWIRE (2026-09-10, same day as Section 6)

`src/ui/manager-modal/manager-api.js`'s preset CRUD
(`createPreset`/`renamePreset`/`deletePreset`/`addPresetToChat`/
`removePresetFromChat`) now routes through `stateEngine.*` (Section 3)
instead of calling `src/core/preset-manager.js` directly. Since the UI
still addresses presets by `presetId` everywhere (`ui-render.js`,
`ui-events.js`), and the API layer addresses them by `(namespace, name)`,
`manager-api.js` translates: it resolves a `presetId`'s
`preset.namespace`/`preset.name` and calls the namespaced function. A
reserved namespace, `BUILTIN_NAMESPACE = 'se'` (`src/core/settings-core.js`),
is auto-registered for this — it's the manager modal's own namespace, not
something the user registers.

**Auto-uniquify, not silent no-op.** `preset-manager.js`'s original
`createPreset`/`renamePreset` never enforced name uniqueness (only
`presetId` was unique) — `stateEngine.createPreset`/`updatePreset` DO
require `(namespace, name)` to be unique, since that pair is the address.
Rather than let a duplicate name silently fail (a real behavior
regression, verified against a test that create-on-duplicate must still
produce a new preset), the adapters auto-uniquify (`"My Preset"` →
`"My Preset (2)"`) — preserving "create/rename always succeeds," same as
before.

**Historical migration (`settings-core.js`'s `migrateToBuiltinNamespace`,
called from the existing `migrateAllSettings`/`runStartupOnce` path).**
Every pre-existing preset is stamped `namespace: 'se'`, and every one of
its variables is renamed from its old bare name (`"mood"`) to the
namespace-qualified name (`"se__mood"`) — the same storage-key scheme
`variable-api.js` already uses for API-created variables (Section 6's #2),
now applied uniformly. The isolated per-chat store, `wiConditions`
references, and — critically — any OTHER calculated variable's
`dependencies`/`expression` that referenced a just-renamed sibling are all
rewritten to match (the latter was a second bug found in the same
incident as the delimiter fix; see the note below). Runs at most once ever
(gated on `settings.extensions.se` already existing), and is idempotent if
re-triggered by accident.

**Known, irreversible, and reported rather than silently absorbed:** any
character card, World Info entry, or Author's Note that references one of
these variables' OLD bare `{{name}}` macro will stop resolving once this
migration runs, because that content lives entirely in SillyTavern's own
chat/character data, outside this extension's settings — engine spec 1.3
forbids reaching into it, so there is no way to migrate those references
automatically. The full old→new name map is logged to the console
(`console.warn`) the one time migration runs, specifically so it can be
found and fixed by hand.

**Kept consistent going forward, not just historically:**
`preset-manager.js`'s `restoreDefaultPresets`/`seedExamplePresets` now also
stamp `namespace: 'se'` and qualify variable names when (re)creating the
starter presets, so deleting-and-restoring defaults doesn't reintroduce
bare-named content. `ui-events.js`'s variable-save flow (the inline
editor's "Save" button and the live name-typing collision warning) now
qualifies the user-typed name into `se__<name>` right before the existing
uniqueness check (`isVariableNameTaken`) and the final
`preset.variables[id] = ...` write — two small, surgical edits, not a
rewrite of that flow's logic/UX. The reserved-name check
(`isReservedVariable`) still runs against the raw, unqualified name the
user typed, unchanged, so it still correctly blocks e.g. naming a variable
`"time"`.

**Deliberately NOT changed:** every place that *displays* a variable's
name (delete-confirmation dialogs, status messages, the dependency-name
clipboard-copy button, the Variable Management tab) now shows the
qualified form (`"se__mood"`) as-is — no display-layer stripping was added.
This was a deliberate simplification (Section 6-style tradeoff, not an
oversight): the alternative was auditing and touching every render call
site across `ui-templates.js`/`ui-render.js`/`tracker-panel-ui.js`/
`manager-modal-ui.js`, none of which was necessary for correctness — the
qualified name showing through is cosmetic, and the calculated-variable
dependency-copy feature specifically *requires* the qualified form to
paste correctly into an expression (`calculated-engine.js` resolves
dependencies by the literal `def.name` string), so this also avoids a
second, separate bug that stripping would have introduced.

**Pre-existing bug, found and — in a follow-up pass the same day — fixed
(Section 7.1):** `src/ui/manager-modal/preset-manager.js`'s `clonePreset()`
deep-cloned a preset's variables with their names AND ids untouched, so
cloning had always produced duplicate variable names (and ids) across the
two presets — a real violation of the "names must be unique across all
presets" invariant this same codebase enforces everywhere else
(`isVariableNameTaken`). Initially just flagged here, not fixed, per this
project's standing rule not to fix unrelated bugs unprompted — the user
asked for it to be fixed in the very next message, see Section 7.2.

**Verified**, not just written: a fresh-install seeding pass, a
constructed pre-migration settings blob run through the real migration
(preset/variable/isolated-store/`wiConditions` renaming, plus
idempotency-on-rerun), and every adapter (`createPresetAdapter` including
the duplicate-name path, `renamePresetAdapter` including a colliding
rename, `deletePresetAdapter`, `addPresetToChatAdapter`/
`removePresetFromChatAdapter`), plus a restore-defaults-twice regression
check and a full re-run of Section 6's earlier test suite to confirm no
regression there.

**Still not done — Part 3's original ask was never fully literal.**
`getPresetsForChat`, `restoreDefaultPresets`, `isVariableNameTaken`,
`generateUniqueVariableName`, and `blankDefinition` remain direct imports
in `manager-api.js` — none has a namespaced equivalent in Section 3, and
`isVariableNameTaken`/`generateUniqueVariableName` work correctly regardless
of whether the names they compare are qualified or not, so there was
nothing to gain by adding one. Variable creation/update in `ui-events.js`
still writes directly into `preset.variables[id]` rather than calling
through `stateEngine.createVariable`/`updateVariable` — qualifying the name
string before that write achieves the same storage-correctness outcome
with dramatically less blast radius than rerouting the whole flow through
the API layer would have required.

SECTION 7.1 — CRITICAL BUG FOUND AND FIXED AFTER SECTION 7 SHIPPED (same day)

While investigating an unrelated, requested fix (`clonePreset()`'s
duplicate-variable-name bug, Section 7's "pre-existing bug" note above),
inspecting what it would take to correctly rewrite a cloned calculated
variable's dependencies led to actually running one through
`evaluateExpression()` — which failed. That is the first time in this
entire multi-pass effort a qualified variable name was evaluated through
the real expression engine rather than only checked as a stored string,
and it surfaced two real bugs in the namespace-qualification work Section
6/7 had already shipped:

1. **The delimiter was wrong.** Every qualified variable name used `.`
   (`"se.mood"`). `expression-dsl.js`'s tokenizer treats `.` as
   property-access syntax — `se.mood` tokenizes as `ident("se")` +
   `op(".")` + `ident("mood")`, not one identifier. Any calculated
   variable depending on a namespace-qualified variable could never
   evaluate — a total, silent break (DSL section 11.3: retain previous
   value, log a warning) of an existing, documented, working feature
   (engine spec 1.17), for every variable in the `se` namespace after the
   Section 7 migration ran. **Fixed** by changing the delimiter to `__`
   (`"se__mood"`) everywhere a variable name is qualified
   (`variable-api.js`, `dependency-graph.js`, `settings-core.js`'s
   migration, `preset-manager.js`'s starter-preset seeding, `ui-events.js`'s
   qualification helper) — `__` is a normal identifier character, so this
   needed zero changes to `expression-dsl.js` itself, which stays exactly
   as pure/self-contained as its own header comment requires. Preset
   addressing (`namespace.presetName`, a two-argument tuple, never a
   literal concatenated string in the real code) and event names
   (`namespace.eventName`, never evaluated by the DSL) were NOT changed —
   this was scoped specifically to the one thing that actually flows
   through the expression engine.
2. **The historical migration didn't rewrite cross-references.** Renaming
   a variable's own `def.name` does nothing to fix a *sibling* calculated
   variable's `dependencies` array or `expression` string still referencing
   the old name — `migrateToBuiltinNamespace()` only did the former.
   **Fixed** by adding a second pass that rewrites both, using a
   word-boundary-safe (`\b`, matching the DSL's `[A-Za-z0-9_]` identifier
   class) replace so a partial match inside a longer identifier is never
   possible. One known, accepted remaining edge case: an old variable name
   that happens to also appear, coincidentally, as a substring inside a
   *string literal* within the expression — `expression-dsl.js`'s
   tokenizer/parser aren't exported for a proper token-level rewrite, and
   this is a one-time best-effort migration over the user's own data, not
   a live code path.

Confirmed with the user before fixing: nothing had been deployed against
live SillyTavern settings yet, so this was a clean code fix with no
already-migrated data to reconcile. Re-verified end-to-end afterward,
including a real `evaluateExpression()` call through
`recalculateAllForChat()` producing the correct numeric result for a
calculated variable depending on a qualified sibling — not just that the
dependency string matched, which is exactly the gap that let this ship in
the first place.

SECTION 7.2 — clonePreset() FIX AND AN INDEPENDENT chat-state.js BUG FOUND WHILE TESTING IT (same day)

**`clonePreset()` fixed.** Every cloned variable now gets a fresh id
(`genId()`) and a fresh, globally-unique name
(`generateUniqueVariableName()`, called with no `excludeVarId` — the
source preset's own identically-named variable must register as "taken,"
since it still exists unrenamed, so every clone variable reliably gets
renamed rather than only ones that happen to also collide with some
unrelated third preset). A calculated variable's `dependencies`/
`expression` referencing a just-renamed sibling within the same clone are
rewritten to match, using the identical word-boundary-safe approach as
`migrateToBuiltinNamespace()` (Section 7.1) and for the identical
reason — without it, a cloned calculated variable would silently keep
pointing at the SOURCE preset's variables instead of its own copies.
Preset-level name collisions (two presets in the same namespace sharing a
display name) were deliberately left alone — out of scope for the reported
bug, and consistent with the fact that preset names were never
uniqueness-enforced anywhere in this codebase to begin with (only
`manager-api.js`'s own adapters, Section 7, add that — and `clonePreset()`
is called directly from `ui-events.js`, bypassing those adapters entirely,
exactly as it did before this fix).

**Independent bug found and fixed while writing the test for the fix
above:** `chat-state.js`'s `seedVariablesForChat()` loads a chat's state
once at the top (`const state = loadChatState(chatId)`), then in its loop
calls `setVar()` per variable — which does its own, separate
`loadChatState()`/`saveChatState()` round-trip — and finally re-saves the
function's own original, stale `state` snapshot. For a chat that has
*never been seeded before* (nothing yet in
`variableStore.chats[chatId]`), `loadChatState()` returns a fresh,
unpersisted object on every call until something exists — so the loop's
`setVar()` calls build real data into one disconnected object, while the
function's final save overwrote all of it with the empty pre-loop
snapshot. Net effect in real usage: the very first preset activation on a
genuinely new chat (no prior `setVar()` call for it from any other path,
e.g. `offerCopyFromPreviousChat`) could silently seed nothing into the
real isolated store — invisible for a plain variable (the macro store's
own write, inside `setVar()`, isn't affected by this and still looks
correct) but fatal for a calculated variable depending on it, which is
exactly the symptom that surfaced it: `evaluateExpression()` failing with
"variable is null or undefined" for a dependency that had, moments
earlier in the same function call, appeared to be written successfully.

Not related to namespacing or this pass's other changes — a genuinely
independent, pre-existing defect in code nobody had touched this entire
session before this fix. **Fixed** by persisting `state` immediately after
the initial `loadChatState()` call, before the loop runs, so
`store.chats[chatId]` exists from that point on and every subsequent
`loadChatState()` call anywhere in the function (direct, or via
`setVar()`/`resetValueIfTypeChanged()`) returns the same shared object —
one consistent accumulation instead of several silently-discarded ones.

**Verified**, not just written: a real end-to-end clone test — creating a
source preset with a plain and a calculated variable via the namespaced
API, cloning it, confirming the clone's variables have fresh ids/names,
activating BOTH the source and the clone for the same chat, and confirming
they evaluate to genuinely independent values (changing the clone's
dependency does not affect the source's calculated variable, and vice
versa) — not just that the stored definition strings looked right.

**Bug found and fixed during this pass's own testing** (not present in any
existing file): an early version of `updateVariable` applied a patch via
`Object.assign(def, patch)` directly onto the live definition object.
Because `preset-manager.js`'s `getAllVariablesFromPresets()` never clones
— `chat-state.js`'s stored `entry.def` snapshot is the *same object
reference* as `preset.variables[id]` — mutating in place also mutated the
stored snapshot before `resetValueIfTypeChanged()` ran, so it could never
see the old type to compare against a changed one. Fixed by building a new
object and replacing `preset.variables[varId]` wholesale, mirroring how
`src/ui/manager-modal/ui-events.js`'s inline editor already avoids this
exact trap. Caught by this module's own functional smoke test, not by
inspection.
