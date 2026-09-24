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
the exact namespace string an extension uses is whatever it claims with
`createNamespace()` (Section 8), and every claimed namespace is discoverable
through `getNamespaces()` and, once the owner declares it,
`getRegisteredExtensions()` / `getExtensionRegistration()`.

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
- **Activation is not a write to the preset.** `activatePreset` /
  `deactivatePreset` only bind a preset to a chat; they change nothing
  about the preset or its variables, so they are open to any registered
  caller for any namespace (Section 19). Everything that edits a
  definition stays owner-only.
- **Definition reads are namespace-scoped.** `getVariable()` /
  `listVariables()` remain scoped to the caller's own namespace(s).
  Cross-namespace *display* reads - every preset's variables, and current
  values - go through the Variable Value API (Section 19), which returns
  display fields only and can never be used to edit anything.

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

**Signature note (2026-09-18, Section 7.4):** every function listed below in
`preset-api.js`, `variable-api.js`, `event-api.js`, and
`independent-presets.js` takes `(extensionId, instanceId, ...)` as its first
two arguments - e.g. `createVariable(extensionId, instanceId, def)`. The
lists below show the remaining arguments only.

**Namespaces and Extension Registration** (`src/api/namespace-manager.js`,
`src/api/extension-registration.js`, `src/api/extension-registry.js` — full
specification in Section 8; this replaces the original
`registerExtension(info)` / array-returning `getRegisteredExtensions()`,
whose names now belong to the metadata-registration API)

```
createNamespace(extensionId, instanceId, namespace)   // claim a namespace (instance identity only)
getNamespaces()                                        // every claimed namespace
registerExtension(extensionId, instanceId, metadata)   // declare what the extension provides
getRegisteredExtensions()                              // { extensionId: registration }
getExtensionRegistration(extensionId)                  // registration | null
unregisterExtension(id)
```

**Extension Capability Graph** (`src/api/capability-graph.js` — full
specification in Section 9)

```
declareCapabilities(extensionId, instanceId, capabilities)   // what the extension provides
declareDependencies(extensionId, instanceId, capabilityList) // what the extension depends on
getCapabilityGraph()                                          // { extensionId: { capabilities, dependsOn } }
getExtensionsProviding(capability)                            // extensionId[]
getExtensionCapabilities(extensionId)                         // string[]
getExtensionDependencies(extensionId)                         // string[]
```

**Preset CRUD** (`src/api/preset-api.js`)

```
createPreset(def)                          // def.namespace determines ownership
updatePreset(namespace, name, patch)
deletePreset(namespace, name)
activatePreset(chatId, namespace, name)    // binds the preset to a chat - ANY namespace (Section 19)
deactivatePreset(chatId, namespace, name)  // ANY namespace (Section 19)
listPresets(namespace)
```

**Variable CRUD** (`src/api/variable-api.js`)

```
createVariable(def)              // def.namespace/def.presetName determine ownership
updateVariable(ref, patch)
deleteVariable(ref)
getVariable(ref)
listVariables(namespace, presetName)

// Variable Value API (added 2026-09-23, Section 19, src/api/variable-value-api.js):
listAllVariables(chatId?)                     // every namespace's presets + display defs, grouped by preset
getVariableValue(chatId, qualifiedName)       // { value, def } | undefined - any namespace
getVariableValues(chatId, qualifiedNames)     // { [name]: { value, def } | undefined }
getVariableImage(chatId, qualifiedName)       // the image an image/imageList/imageMap shows, safe src | null
setVariableValue(chatId, ref, value)          // OWN namespace only; refuses calculated

// Calculated-variable support (added 2026-09-10, Section 7.3):
validateCalculatedDefinition(def)      // def.type/def.expression/def.namespace/def.presetName -> { ok, deps } | { ok, error }
applyCalculatedDefinition(ref, def, deps)  // stores deps, evaluates, cascades, refreshes macros
```

`ref` in this module identifies one variable as
`{ namespace, presetName, variableName }` — `variableName` here is the
local, unqualified name (`"mood"`), not the stored `namespace__mood` form;
resolving `ref` to a definition is exactly what re-derives that qualified
name (Section 2). Enough to resolve to a single variable definition
without needing its internal id.

`createVariable(def)`/`updateVariable(ref, patch)` accept `def.type ===
'calculated'`/`def.expression`, and reject `def.value`/`patch.value`
outright (a variable's value is never set through its definition — see
Section 7.3 for the full calculated-variable creation pipeline).

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

**Introspection.** `getNamespaces()`, `getRegisteredExtensions()`,
`getExtensionRegistration()`, `listPresets()`, `listVariables()`,
`getDependencies()`, and `getDependents()` together form the read-only
introspection surface — everything a consumer needs to
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
  (keyed by namespace) is the registry. `unregisterExtension`/
  `validateNamespace`/`ownsNamespace` are real, and — as of Section 8
  (2026-09-18) — so are `createNamespace`/`getNamespaces` (they were empty
  stubs when this section was first written). The original
  `registerExtension(info)` and array-returning `getRegisteredExtensions()`
  that this bullet used to describe no longer exist in that form: Section 8
  replaced them. `unregisterExtension` deletes every preset
  whose `preset.namespace` matches (via `preset-manager.js`'s own
  `deletePreset`, never reimplemented) plus their stored variable values
  (`chat-state.js`'s `deleteVariableValueEverywhere`), then refreshes
  macros, and takes the extension's `registration` metadata with its record.
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

SECTION 7.3 — CALCULATED-VARIABLE CREATION THROUGH THE API (2026-09-10)

`createVariable`/`updateVariable` now accept `def.type === 'calculated'` +
`def.expression`, deriving the real dependency set directly from the
expression rather than requiring the caller to hand-supply a matching
`dependencies` array (the only prior source of a dependencies array in
this codebase was the manager-modal UI's own checkbox list —
`ui-events.js`'s dependency checkboxes — which this does not change or
replace).

**Three factual corrections to the request that specified this feature**,
verified against the real code rather than assumed, per this project's
standing instruction to report an instruction/reality mismatch instead of
silently forcing an implementation that doesn't match either the request
or reality:

1. **"Extract dependencies using the same logic used internally by
   calculated-engine.js"** — no such logic existed. `calculated-engine.js`
   has never auto-derived dependencies from an expression string; every
   caller (until now, only the manager-modal UI) supplies `dependencies`
   by hand. Implemented as a genuinely new capability rather than a reuse
   of something pre-existing: a new `extractIdentifiers(expression)`
   export was added to `expression-dsl.js`, walking the exact same
   AST `evaluateExpression()` already builds (same tokenizer, same
   parser — not a second, separately-maintained parser). "Same logic" is
   true in the sense that matters (one real grammar, one real parser,
   zero duplication) even though the *specific* dependency-extraction
   behavior itself is new.
2. **"Register dependency edges in the dependency graph. Register reverse
   edges."** — there is no persisted graph data structure in this
   codebase to register edges into. `calculated-engine.js`'s
   `buildCalculatedGraph`/`topoSortCalculated` (and this API layer's own
   `dependency-graph.js`, Section 6) recompute the graph fresh, every
   time, by reading each variable definition's own `dependencies` array —
   the array itself *is* the graph's storage, not a separate structure.
   Building a second, parallel "real" graph that the rest of the engine
   never reads would have been actively misleading, not a faithful
   implementation. "Registering an edge" here means exactly one thing:
   correctly setting `def.dependencies` on the stored definition —
   `applyCalculatedDefinition()` does this as its first action, and
   `dependency-graph.js`'s `getDependents()` (already existing, Section 6)
   picks up the reverse relationship automatically with no separate
   registration step, since it already scans `def.dependencies` on demand.
3. **"Enforce preset-local dependency rules (dependencies MUST exist in
   the same preset)"**, described as something the core engine "already
   enforces internally" — verified false by re-reading
   `calculated-engine.js` fresh: its dependency resolution
   (`buildCalculatedGraph`) is global-by-name across every preset active
   for the chat, not preset-scoped, and nothing there currently rejects a
   cross-preset dependency (a `blankDefinition()` comment states the
   *design intent* — "in the same preset" — but no code checks it).
   Enforcing this only at the new, stricter API entry point
   (`validateCalculatedDefinition`) — never touching
   `calculated-engine.js`'s existing, more permissive runtime behavior —
   keeps this purely additive rather than a backwards-incompatible
   tightening of what the manager-modal UI has always allowed.

**Pipeline, synchronous and atomic throughout** (`createVariable`): reject
`def.value` outright → validate namespace/preset/name-collision →
`validateCalculatedDefinition(def)` (parses the expression, derives
dependencies, checks preset-locality) → only on success, write the
definition into `preset.variables` and persist → `applyCalculatedDefinition`
(stores the derived `dependencies`, seeds if needed, evaluates the new
variable, cascades to dependents, refreshes macros). A rejected validation
touches no stored state at all — nothing is written until validation has
already passed. No `await` anywhere in this path; JS's single-threaded
execution model makes a synchronous call chain like this atomic from any
external observer by construction, not by any additional locking.

`updateVariable` re-runs validation/derivation only when the expression is
actually changing (or the variable is becoming calculated for the first
time) — an unrelated patch (label, description, `showInTracker`, …) to an
already-calculated variable falls through to the existing generic path,
which was already correct for it.

A caller-supplied `dependencies` array, if present, is silently
overridden by the expression-derived set — deliberate: the expression is
now the single source of truth, closing a real class of bug the
manual-checkbox UI has always been exposed to (a human forgetting to check
a box that the expression actually references), verified explicitly by a
test that supplies a wrong `dependencies` array and confirms it's ignored.

**Verified**, not just written: every requirement checked through the real
engine, not stored-string inspection — auto-derivation from an expression
with zero `dependencies` supplied, a wrong caller-supplied `dependencies`
array being overridden, a cross-preset dependency being rejected with
nothing partially created, a syntactically invalid expression being
rejected, `def.value`/`patch.value` rejected on both create and update
with the real stored value confirmed unchanged, an expression-changing
update re-deriving dependencies and actually re-evaluating to the new
result, a non-expression update leaving existing dependencies untouched,
and a real end-to-end cascade (changing a dependency's value and
confirming the calculated variable recomputes through its
auto-derived dependency chain).

SECTION 7.4 — CALLER IDENTITY (2026-09-18)

Every exported function in `preset-api.js`, `variable-api.js`,
`event-api.js`, and `independent-presets.js` now takes `(extensionId,
instanceId, ...)` first and calls `validateCallerIdentity(extensionId,
instanceId, targetNamespace)` (`src/api/identity.js`) before doing
anything. This closes the gap Section 6 #1 recorded: `ownsNamespace()` is
now actually used. A wrong `instanceId` throws `State Engine API call
rejected: wrong instance`; an extension that doesn't own the target
namespace throws `Extension '<id>' does not own namespace '<ns>'`. The
check runs outside each function's own try/catch (which otherwise converts
failures into warn-and-return-null), so a rejection can never silently
no-op. `runIndependentPreset` is deliberately a plain function that
checks synchronously and then returns the async pipeline's Promise - an
`async function` would have turned the throw into a rejected Promise.

Deviations from the request, each forced by what the code actually is:

1. **`validateCallerIdentity` takes a third argument, `targetNamespace`.**
   The request specified two parameters but also required an
   `ownsNamespace(extensionId, targetNamespace)` check, which needs one.
2. **`instanceId` did not exist anywhere.** The core migration that
   creates `settings.extensions.se` never wrote one and `src/core` was
   off-limits, so `ensureInstanceId()` creates it lazily on first use. It
   deliberately refuses (throws) if the `se` record doesn't exist yet
   rather than creating it: `migrateToBuiltinNamespace()` is gated on that
   record not existing, so a partial record made here would silently skip
   the whole migration. An unset instanceId can never match `undefined`.
3. **`listPresets`, `validateCalculatedDefinition`, and
   `applyCalculatedDefinition` were added to the guarded set** - they live
   in the named modules, and `listVariables`/`getVariable` (reads) were
   already on the list. The two calculated helpers are split into an
   unchecked internal function (what `createVariable`/`updateVariable`
   call, having already checked identity once) and an identity-checked
   exported wrapper.
4. **Not covered:** `dependency-graph.js`'s `getDependencies`/
   `getDependents`, and `unregisterExtension`/`validateNamespace`/
   `ownsNamespace`/`getNamespaces` remain unguarded (Section 8 added
   identity to `createNamespace` and `registerExtension` only).
   Dependency introspection is therefore still readable across namespaces.
5. **Manager-modal consequence.** The adapters always identify as `'se'`,
   so a preset owned by another namespace can no longer be renamed,
   deleted, or toggled from the manager modal. The adapters catch the
   rejection and report it through `setStatus` rather than throwing into
   click handlers that have no error handling.

**Honest limit:** `instanceId` is a token in settings, readable by any code
in the same page (and `identity.js` is importable by path). This stops
wrong-instance and wrong-namespace calls - mismatched wiring, an extension
reaching into another's namespace by mistake - it is not a security
boundary against hostile code in the same JS context. `identity.js` is
intentionally not re-exported from `src/api/index.js`/`stateEngine`, so
the token isn't handed out through the public facade.

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

SECTION 8 — EXTENSION REGISTRATION API (2026-09-18)

Lets an extension claim a namespace, declare what it provides there, and
lets other extensions discover both. Three modules: `namespace-manager.js`
(claiming and listing namespaces), `extension-registration.js` (the
metadata declaration and discovery), `extension-registry.js` (only
`unregisterExtension` remains there). All synchronous, like every other
CRUD call in this layer (Section 4).

**8.1 Namespace manager (updated)**

Namespaces are now *discoverable*: any caller can list every claimed
namespace, and see who declared what in it (8.2), with no identity.

**`createNamespace` is the prerequisite for everything that follows.**
`registerExtension` (8.2), `declareCapabilities` and `declareDependencies`
(Section 9) all act on the caller's *own* namespace record, which only
exists once `createNamespace` has run. Calling any of them for an
extension that owns no namespace throws (`registerExtension`: `Extension
'<id>' does not own namespace '<ns>'`; the two declare functions:
`Extension '<id>' does not own a namespace - call createNamespace() first`).
Unregistering an extension removes the namespace, so those calls are
rejected again afterwards.

```
createNamespace(extensionId, instanceId, namespace)   -> record { id, namespace, name, registeredAt }
getNamespaces()                                        -> string[]   (every claimed namespace, incl. built-in `se`)
validateNamespace(namespace)                           -> boolean
ownsNamespace(extensionId, namespace)                  -> boolean
```

- `createNamespace` checks the **instance** only (`validateInstanceId` in
  `identity.js`), not ownership: it runs before the caller owns anything,
  it is what creates the ownership. A wrong/missing/non-string `instanceId`
  throws `State Engine API call rejected: wrong instance`; the instance is
  checked before anything about the arguments.
- Adds a record to `settings.extensions`, **keyed by namespace**, in the
  same shape the core migration gives the built-in `se` record
  (`{ id, namespace, name, registeredAt }`), and persists. `id` is the
  `extensionId`. Ownership everywhere else (`ownsNamespace`,
  `validateCallerIdentity`) matches on that `id`.
- Uniqueness: a namespace already claimed by a *different* extension
  throws `Namespace '<ns>' is already taken` (this includes `se`). An
  extension owns **at most one** namespace - a second, different one
  throws `Extension '<id>' already owns namespace '<ns>'`. Re-creating the
  namespace an extension already owns is **idempotent**: it returns the
  existing record and writes nothing, because settings persist across page
  loads and an extension calling this on every startup must not fail on
  its second load.
- `namespace` must match `^[A-Za-z][A-Za-z0-9]*$`, else it throws
  `Namespace '<x>' is invalid: ...`. A namespace is a prefix of every
  qualified variable name (`pp__mood`, Section 2) and of every event name
  (`pp.roll`), so it may contain neither `_` nor `.`, and must start with a
  letter so the qualified name still tokenizes as one DSL identifier.
- `getNamespaces` needs no identity and returns a fresh array. It lists a
  namespace whether or not its owner ever called `registerExtension`.

**8.2 Extension registration**

```
registerExtension(extensionId, instanceId, metadata)   -> registration (a copy of what was stored)
getRegisteredExtensions()                               -> { [extensionId]: registration }
getExtensionRegistration(extensionId)                   -> registration | null
```

*Identity requirements.* `registerExtension` runs the full
`validateCallerIdentity(extensionId, instanceId, metadata.namespace)`
(Section 7.4) **before anything else**: a wrong instance throws `State
Engine API call rejected: wrong instance`; a missing `metadata.namespace`
throws `... no target namespace supplied ...`. `getRegisteredExtensions`
and `getExtensionRegistration` take no identity - discovery is open by
design, read-only, and returns copies.

*Namespace ownership requirements.* `extensionId` must own
`metadata.namespace` (it created it with `createNamespace`). Otherwise it
throws `Extension '<id>' does not own namespace '<ns>'` - so no extension
can register, overwrite, or blank another extension's registration, and an
unclaimed namespace can't be registered at all.

*Metadata schema.* Exactly these five fields; anything else is rejected
(`dependsOn` was added by Section 9, which also explains how
`capabilities`/`dependsOn` are stored and shared with the capability graph):

| field | type | required | default |
|---|---|---|---|
| `namespace` | non-empty string | yes | - |
| `variables` | array of strings | no | `[]` |
| `capabilities` | array of non-empty strings | no | `[]` |
| `dependsOn` | array of non-empty strings | no | `[]` |
| `description` | string | no | `''` |

*Validation rules.* Checked after identity; every failure throws an
`Error` whose message starts `Extension registration rejected: `, and
nothing is written:
- `metadata` must be an object; unknown fields are rejected (not silently
  dropped) with `unknown metadata field '<key>'`.
- **Variables must be fully qualified**: each entry must be exactly the
  stored form a variable takes in the caller's own namespace -
  `<namespace>__<localName>` - with a non-empty local part, and the whole
  name a single valid identifier. `mood`, `zz__mood` (another namespace),
  `pp__` (no local part), `pp.mood` (a dot breaks the expression DSL,
  Section 2) and `pp__a.b` are all rejected with `variable '<name>' is not
  fully qualified - expected '<ns>__<name>' in namespace '<ns>'`.
- **Capabilities and dependencies must be strings**: any non-string or
  empty-string entry in `capabilities` or `dependsOn` is rejected
  (`metadata.capabilities must contain only non-empty strings`, likewise
  `metadata.dependsOn`). Non-array `variables`/`capabilities`/`dependsOn`
  and a non-string `description` are rejected too.
- Declared variables **need not exist yet** - registration is a
  declaration, not a reference check.
- `variables`, `capabilities` and `dependsOn` are de-duplicated, first
  occurrence wins.

*Persistence.* The extension's own record in `settings.extensions` is the
only thing written, and is persisted (`persistSettings`, i.e. the
context's `saveSettingsDebounced`). The record's `registration` field holds
`namespace`, `variables` and `description`; `capabilities` and `dependsOn`
are written to the record itself, through `declareCapabilities` /
`declareDependencies` (Section 9), and merged back into every registration
that discovery returns - so they exist once, and can never disagree with
the capability graph. Registering **replaces** any previous registration
outright - it is not merged, and a field left out of the new call is
cleared, not kept; that includes `capabilities` and `dependsOn`, so a
registration that omits them clears the extension's capability graph
entry. A rejected call leaves the previous registration and graph entry
untouched (everything is validated before anything is written). What is stored and what is returned/discovered are
copies: mutating a caller's input object, a return value, or a discovery
result never changes the store. `unregisterExtension` removes the whole
record, registration included; a namespace re-created afterwards starts
with no registration.

*Discovery semantics.* `getRegisteredExtensions()` returns only extensions
that have called `registerExtension`, keyed by **extension id** (not
namespace). An extension that merely claimed a namespace appears in
`getNamespaces()` but not here, and `getExtensionRegistration(id)` returns
`null` for it, for an unknown id, and for any non-string id.

*No side effects.* Registration writes exactly one thing - the
extension's own record in `settings.extensions` (its `registration`,
`capabilities` and `dependsOn`). It does not create or
touch variables or presets, does not seed, write, increment, or delete
anything in chat-state, does not evaluate or recalculate anything or alter
any dependency edge, does not refresh macros, and neither registers nor
fires events. This is asserted by tests against the mocked chat-state,
preset-manager, calculated-engine, macro-registration and event-engine
(each mock's call history stays empty, and a before/after settings
snapshot differs only in the extension record's own `registration`,
`capabilities` and `dependsOn` fields).

**8.3 Deviations from the request, each forced by what the code was**

1. **Name collision.** `extension-registry.js` already exported
   `registerExtension(info)` (claim a namespace, no identity) and an
   array-returning `getRegisteredExtensions()`. Two star-exported
   functions of the same name cannot coexist in the facade, so those two
   were removed from `extension-registry.js` (only `unregisterExtension`
   remains). Their namespace-claiming role is now `createNamespace`, and
   the old array of records is `getNamespaces()` (names) plus the new
   `getRegisteredExtensions()` (declared metadata). An old-style
   `registerExtension({ namespace })` call now throws an identity error
   rather than silently claiming a namespace.
2. **`createNamespace` cannot use the full identity check.** The request
   asked for an identity check, but `validateCallerIdentity` includes
   `ownsNamespace`, which can never pass for a namespace that doesn't
   exist yet. It uses the new instance-only `validateInstanceId`
   (`validateCallerIdentity` now calls it internally - behaviour and
   messages unchanged).
3. **Storage key.** The request said
   `settings.extensions[extensionId].registration`. The store is keyed by
   *namespace* (the core-created `se` record already is, and
   `validateNamespace`/`ownsNamespace` read it that way), so the
   registration lives on the record found for that extension:
   `settings.extensions[<namespace>].registration`. When the extension id
   equals its namespace (the common case, and `se`) the two paths are the
   same. Lookups by extension id use `findExtensionRecord`.
4. **One namespace per extension, idempotent re-creation, namespace
   format** (8.1) are additions the request left open; each closes an
   ambiguity (which record holds `registration`? what happens on the
   second page load? what is a legal prefix?).
5. **Validation failures throw**, where `createPreset` and friends warn
   and return `null`. A registration is a one-time declarative call; a
   silent `null` would be easy to miss. Consistent with the identity
   layer's "never silently no-op".

**8.4 Honest limits**

- Anyone holding the shared `instanceId` (Section 7.4 - a token in
  settings, not a security boundary) can claim any free namespace string
  for any extension id they choose, i.e. namespace squatting is possible.
  The one-namespace-per-extension rule limits it to one squat per id.
- `getRegisteredExtensions`/`getExtensionRegistration` are open, so a
  registration's declared variables and capabilities are readable by every
  extension. That is the point of discovery, but don't put anything in
  `description` you would not want shown to all of them.
- `variables` is a declaration only; nothing checks it against the
  variables that actually exist, and nothing keeps it in sync when
  variables are created or deleted afterwards.

**8.5 Verification**

`tests/api/extension-registration.test.js` (91 tests), the updated
`namespace-manager.test.js` (49), `identity.test.js` and
`state-engine-api.test.js`; the full suite passes under `npm test`.
(Section 9 later changed where `capabilities` are stored and added
`dependsOn`; the registration tests were updated to match.)

SECTION 9 — EXTENSION CAPABILITY GRAPH (2026-09-18)

**9.1 What it is**

The capability graph is a global metadata layer over the extension records
in `settings.extensions`. It describes:

- the capabilities an extension **provides** (`record.capabilities`),
- the capabilities an extension **depends on** (`record.dependsOn`),
- and, derived from those two, the **relationships between extensions**:
  extension A relates to extension B when A depends on a capability B
  provides.

A capability is a plain non-empty string. Dotted, lowercase names are the
convention - `"ui.panel"`, `"data.inventory"`, `"world.location"`,
`"character.stats"` - but that is convention, not syntax: nothing parses,
namespaces, or validates the dots, and matching is exact string equality
(`"ui"` does not match `"ui.panel"`).

It is derived from **extension registration metadata**:
`metadata.capabilities` -> provided capabilities, `metadata.dependsOn` ->
required capabilities (9.3). `declareCapabilities` / `declareDependencies`
are the same two writes, available on their own.

It is a **separate layer from the variable dependency graph** (Section
7.3, `getDependencies`/`getDependents`): that graph links calculated
*variables* to the variables their expressions read; this one links
*extensions* to abstract capability names. Nothing here creates, removes
or evaluates a variable, and the two never share data.

**9.2 API**

```
declareCapabilities(extensionId, instanceId, capabilities)    -> string[]  (a copy of what was stored)
declareDependencies(extensionId, instanceId, capabilityList)  -> string[]
getCapabilityGraph()                                          -> { [extensionId]: { capabilities: string[], dependsOn: string[] } }
getExtensionsProviding(capability)                            -> extensionId[]
getExtensionCapabilities(extensionId)                         -> string[]
getExtensionDependencies(extensionId)                         -> string[]
```

*Storage.* `settings.extensions[<namespace>].capabilities` and
`settings.extensions[<namespace>].dependsOn` on the extension's own record,
persisted with `persistSettings` (the context's `saveSettingsDebounced`).
These two fields are the **single source of truth**: registration does not
keep a second copy (9.3), so a later `declareCapabilities` call can never
leave a registration showing stale capabilities.

*Semantics of the two writers.* Each **replaces** the whole list - it does
not merge. An empty array clears it. Duplicates collapse (first occurrence
wins). Each returns a copy of what was stored. The two lists are
independent: writing one never touches the other. Validation completes
before anything is written, so a rejected call leaves the previous list
untouched.

*Nothing requires a dependency to be satisfiable.* `declareDependencies`
does not check that any extension provides the capability - a provider may
simply not be installed yet. A consumer resolves a dependency with
`getExtensionsProviding(cap)`; `[]` means unmet.

*Discovery* - `getCapabilityGraph`, `getExtensionsProviding`,
`getExtensionCapabilities`, `getExtensionDependencies` - takes **no
identity**, is read-only, and always returns fresh copies (mutating a
result never touches the store).
- `getCapabilityGraph()` is keyed by **extension id** (not namespace) and
  contains **every** extension that has claimed a namespace, including the
  built-in `se`, with empty lists for one that has declared nothing. The
  relationships between extensions are deliberately *not* stored as a
  third field: they are derivable - for each capability in an extension's
  `dependsOn`, `getExtensionsProviding` names the providers - and so stay
  correct by construction.
- `getExtensionsProviding(capability)` returns the ids of every extension
  whose `capabilities` include that exact string, in namespace-claim
  order; `[]` for none or for a non-string argument.
- `getExtensionCapabilities` / `getExtensionDependencies` return the list,
  or `[]` for an extension that declared nothing, an unknown id, or a
  non-string id.

**9.3 Integration with extension registration**

`registerExtension(extensionId, instanceId, metadata)` (Section 8.2) now
accepts `metadata.dependsOn` alongside `metadata.capabilities`, and
writes both to the capability graph by calling `declareCapabilities` /
`declareDependencies` internally, after the whole `metadata` object has
been validated. Consequently:

- The registration schema is now five fields: `namespace`, `variables`,
  `capabilities`, `dependsOn`, `description`. **Unknown fields are still
  rejected** (`unknown metadata field '<key>' (allowed: ...)`), so a
  misspelling like `requires` or `provides` fails loudly instead of being
  silently dropped.
- The stored `registration` holds `namespace`, `variables` and
  `description`. `capabilities` and `dependsOn` are read from the record
  when a registration is returned, so `getExtensionRegistration(id)` and
  `getRegisteredExtensions()` always agree with the capability graph -
  including after a direct `declareCapabilities` call following
  registration.
- **A registration is the whole declaration.** Re-registering replaces the
  previous metadata cleanly, and a registration that *omits*
  `capabilities` or `dependsOn` **clears** them (exactly as it already
  cleared `variables` and `description`). That includes capabilities the
  extension had declared directly beforehand. An extension that wants to
  manage its graph entry directly should not also call `registerExtension`
  without them.
- Both registration and the declare functions validate through one shared
  function (`capability-rules.js`, internal - not exported from the
  facade), so they can never disagree about what a legal list is; error
  messages differ only in their prefix and label
  (`Extension registration rejected: metadata.capabilities must ...` vs
  `Capability declaration rejected: capabilities must ...`).
- A rejected registration - bad `dependsOn`, bad `capabilities`, bad
  `variables`, an unknown field, or failed identity - leaves both the
  registration and the capability graph exactly as they were.
- An extension that only ever called `declareCapabilities` /
  `declareDependencies` appears in `getCapabilityGraph()` but not in
  `getRegisteredExtensions()` (which lists only extensions that called
  `registerExtension`).
- `unregisterExtension` removes the whole record, so the extension leaves
  the graph; a namespace re-created afterwards starts empty.

**9.4 Validation rules**

- **Identity enforcement.** Both writers check the *instance* first
  (`validateInstanceId`: wrong/missing/non-string -> `State Engine API call
  rejected: wrong instance`) - before the extension is even looked up, so
  a wrong instance never reveals which extensions exist - and then run the
  real `validateCallerIdentity`. They throw; they never return `null`.
- **Namespace ownership enforcement.** Neither signature carries a
  namespace, so the target is the **caller's own record**, found by
  `findExtensionRecord(extensionId)`. An extension id that owns no
  namespace (unknown, empty, non-string, a namespace string mistaken for
  an id, or an extension since unregistered) is rejected with `Extension
  '<id>' does not own a namespace - call createNamespace() first`. An
  extension can therefore only ever write its own entry; there is no way to
  address another's. **`createNamespace` (Section 8.1) is the
  prerequisite** for any capability declaration.
- **Capabilities must be strings.** `capabilities` must be an array of
  non-empty strings (`capabilities must be an array of strings` /
  `capabilities must contain only non-empty strings`).
- **Dependencies must be strings.** Same rule for `capabilityList` /
  `metadata.dependsOn` (`dependencies must ...` / `metadata.dependsOn must
  ...`).
- **Unknown fields are rejected** wherever a metadata object is accepted -
  i.e. `registerExtension`. The two declare functions take a bare array, so
  there is no field to be unknown; passing an object is rejected as a
  non-array.
- **No side effects** on chat-state, presets, the variable dependency
  graph, macros, or events. Each write touches only
  `settings.extensions[<namespace>].capabilities` / `.dependsOn` (and, for
  `registerExtension`, `.registration`). Asserted by tests against the
  mocked chat-state, preset-manager, calculated-engine, macro-registration
  and event-engine (call histories stay empty; a before/after settings
  snapshot differs only in the extension record's own fields).

**9.5 Deviations from the request, each forced by what the code was**

1. **One copy, not two.** Since capabilities already lived inside
   `registration.capabilities`, also storing them at
   `settings.extensions[namespace].capabilities` would have created two
   copies that drift apart the first time `declareCapabilities` ran after
   `registerExtension`. The record fields are the single source of truth
   and `registration` is composed with them on read (9.3). Visible effect:
   the stored `registration` no longer contains `capabilities`, though every
   registration a caller *receives* does. This required updating the
   previous section's registration tests, which asserted the old stored
   shape.
2. **No namespace parameter.** The requested signatures give the identity
   check nothing to authorize against, so the target namespace is the
   caller's own record (9.4). "Wrong namespace ownership" therefore means
   "owns no namespace", and cross-extension writes are impossible rather
   than merely rejected.
3. **Omission clears.** "If `metadata.capabilities` exists, call
   `declareCapabilities`" was implemented so that a registration is a
   *complete* declaration: omitting a list clears it. The alternative (an
   omitted list leaves the old one) would make "re-registering overwrites
   previous metadata cleanly" false for exactly the case where an
   extension removes its last capability.
4. **`getCapabilityGraph()` lists every extension**, including the
   built-in `se` and extensions that declared nothing, with empty lists -
   the requested shape is a map over extensions, and omitting the empty
   ones would make "is `x` known?" indistinguishable from "does `x` provide
   nothing?".
5. **Relationships are derived, not stored** (9.2), which keeps the
   requested `{ capabilities, dependsOn }` shape exact.

**9.6 Honest limits**

- Capabilities are **self-declared and unverified**. Nothing checks that an
  extension that claims `"data.inventory"` actually provides anything, or
  that a `dependsOn` is satisfiable; a consumer must treat the graph as a
  hint. Anyone holding the shared `instanceId` (Section 7.4 - not a
  security boundary) can claim any free namespace and declare any
  capability strings for it.
- Capability discovery is open: every extension can read every other
  extension's capabilities and dependencies.
- There is no cycle detection, ordering, or transitive resolution - "A
  depends on `x`, B provides `x` and depends on `y`" is not followed. The
  graph only answers the direct questions above.

**9.7 Verification**

`tests/api/capability-graph.test.js` (112 tests: capabilities,
dependencies, discovery, registration integration, atomicity, and no side
effects), plus additions to `identity.test.js` and
`state-engine-api.test.js`; the full suite (579 tests) passes under
`npm test`.


SECTION 10 — CALENDAR FORMATTING API (2026-09-18)

**10.1 What it is**

Datetime variables (requirements spec 1.21) store scalar seconds. These four
functions let external apps - Pretty Panels, other extensions - read the
calendar definitions and ask for human-readable dates without reimplementing
any calendar arithmetic. They live in `src/api/variable-api.js` and are
exposed on `stateEngine`; the work is done by `src/core/calendar-engine.js`
(`listCalendars`, `getCalendarDefinition`, `format`, `formatPartial`), which
is the only official formatter (requirements spec 1.21.5).

**10.2 Functions**

```
getCalendarDefinitions(extensionId, instanceId)
  -> { calendarId: definition, ... }          the live settings.calendars

getCalendarDefinition(extensionId, instanceId, calendarId)
  -> definition, or null if there is no such calendar

formatDateTime(extensionId, instanceId, calendarId, scalarTime, options)
  -> string
  options.style    "full" (default) | "date" | "time" | "month" | "year" | "custom"
  options.pattern  custom only. Tokens: YYYY MM DD HH mm ss MMM MMMM
  options.locale   reserved, ignored

formatDateTimePartial(extensionId, instanceId, calendarId, scalarTime, fields)
  -> object with only the requested fields
  fields: any of "year", "month", "day", "hour", "minute", "second"
```

Examples, for scalar 2026-09-18 22:55:07 UTC:

```
formatDateTime(..., 'gregorian', t)                                   "2026-09-18 22:55:07"
formatDateTime(..., 'gregorian', t, { style: 'date' })                "2026-09-18"
formatDateTime(..., 'gregorian', t, { style: 'time' })                "22:55:07"
formatDateTime(..., 'gregorian', t, { style: 'month' })               "September"
formatDateTime(..., 'gregorian', t, { style: 'year' })                "2026"
formatDateTime(..., 'gregorian', t, { style: 'custom', pattern: 'MMM DD' })   "Sep 18"
formatDateTimePartial(..., 'gregorian', t, ['month', 'day'])          { month: "September", day: 18 }
```

**10.3 Behavior**

- Formatting is calendar-specific. Gregorian keeps its original output. Since
  the fantasy pass (Section 11, requirements spec 1.22) any valid calendar
  formats by its own `formattingRules`; an id that is not defined throws
  `Unknown calendar "<id>"` (this used to be `Formatting not implemented for
  this calendar`, which was the first-pass refusal of every non-Gregorian
  calendar).
- The macro store is unchanged: `{{name}}` / `getvar` still show scalar
  seconds. Formatting is something a consumer asks for, never something
  stored or substituted.
- `getCalendarDefinitions()` returns the live settings object, not a copy -
  treat it as read-only. Calendars are added and changed through Section 11.

**10.4 Errors, and how this differs from your request**

- **Identity.** The requested `validateCallerIdentity(extensionId,
  instanceId)` cannot be called with two arguments - it requires a target
  namespace and throws without one. These signatures carry none, so, like
  `declareCapabilities`/`notify`, they use `resolveCallerRecord`: the
  `instanceId` must match, and the extension must already own a namespace
  (`createNamespace()` first). Calendar data is not namespaced, so no
  further ownership is checked.
- Identity failures **throw**, and so do formatting failures (bad scalar,
  unknown style, unknown field, unknown or unusable calendar, `custom` without a
  pattern). Unlike this module's warn-and-null CRUD calls, a caller asking
  for a string is never handed a silent `null` in its place.

**10.5 Verification**

`tests/calendar-format.test.js`; the full suite passes under `npm test`.


SECTION 11 — CALENDAR DEFINITION API (2026-09-19)

**Numbering.** The request asked for this as "Section 10" with sub-sections
10.1 (assignment) and 10.2 (formatting). Section 10 already exists - it is the
Calendar Formatting API above, and other documents and tests refer to it by
that number - so this is Section 11 and Section 10 stays the formatting API
("10.2 Calendar Formatting API (already implemented)" = Section 10 itself).

**11.0 What it is**

Create, edit, delete and read the calendar definitions datetime variables use
(requirements spec 1.22). Same file and same identity rule as Section 10:
`src/api/variable-api.js`, exposed on `stateEngine`, backed by
`src/core/calendar-engine.js`. `resolveCallerRecord` identifies the caller (the
`instanceId` must match and the extension must already own a namespace).
Calendar data is not namespaced, so any registered extension may manage
calendars - the same trust level as reading them.

```
createCalendarDefinition(extensionId, instanceId, def)
  -> the stored definition (a copy, version 1)
updateCalendarDefinition(extensionId, instanceId, calendarId, patch)
  -> the stored definition (a copy, version + 1)
deleteCalendarDefinition(extensionId, instanceId, calendarId)
  -> true
listCalendarDefinitions(extensionId, instanceId)
  -> [definition, ...]            (getCalendarDefinitions() gives the same keyed by id)
getCalendarDefinition(extensionId, instanceId, calendarId)
  -> definition, or null          (Section 10)
generateRandomCalendarDefinition(extensionId, instanceId, options)
  -> a valid definition, NOT stored
```

**11.1 Calendar Assignment API**

```
assignCalendarToVariable(extensionId, instanceId, ref, calendarId)
  -> the updated variable definition
```

`ref` is `{ namespace, presetName, variableName }`, exactly what
`updateVariable` takes, and the caller must own `ref.namespace`. It sets the
datetime variable's `calendar`. Throws when the calendar does not exist, the
variable does not exist, or the variable is not a datetime. Stored values are
scalar seconds and are not converted - they are read through the new calendar
from then on.

**11.2 Calendar Formatting API (already implemented)**

`formatDateTime()` and `formatDateTimePartial()` - Section 10. Since 1.22
they format any valid calendar (fantasy ones by their `formattingRules`);
`formatDateTimePartial` also accepts `"season"`, `"cycle"` and `"cycleDay"`,
and `formatDateTime` accepts any style named in the calendar's
`formattingRules.patterns` besides the built-in ones.

**11.3 Definition shape**

```
{
  id: 'aldoria', label: 'Calendar of Aldoria', unit: 'seconds',
  secondsPerMinute: 50, minutesPerHour: 50, hoursPerDay: 20,
  months: [{ name: 'Frostwane', days: 30 }, ...],
  seasons: [{ name: 'Winter', startDay: 256, endDay: 30 }],   // wraps the year end
  cycles:  [{ name: 'Silver Moon', length: 28 }],
  leapYearRule: 'none',
  formattingRules: { era: 'AR', monthAbbreviationLength: 3,
                     patterns: { full: 'MMMM D, YYYY ERA HH:mm:ss' },
                     monthNames: [...], seasonNames: [...] },
  nlRules: { unitAliases: { moon: 'cycle' }, advanceVerbs: ['let time pass'] }
}
```

Full rules (validation, tokens, increment and natural-language behavior) are
in requirements spec 1.22 - 1.22.5.

**11.4 Errors and behavior**

- Every function here **throws** on failure - identity, an invalid definition
  (the message lists every problem), an id already in use, an unknown
  calendar, editing or deleting the built-in `"gregorian"` calendar, and
  deleting a calendar a datetime variable still uses. This differs from the
  warn-and-null CRUD in Sections 3-5 for the same reason as Section 10: the
  caller needs the reason. `getCalendarDefinition` is the read that returns
  `null`.
- `update` merges `patch` onto the stored definition and re-validates the
  merged result; a `null` value removes an optional field (`seasons`,
  `cycles`, `formattingRules`, `nlRules`, `leapYearRule`). `id` and `version`
  cannot be patched. Nothing is written when validation fails.
- The built-in calendars (`gregorian`, `faerun_inspired`, `three_moons`,
  `solar_cycle`) are listed by the read functions, can be assigned to
  variables and duplicated (create with a new id), but `update`/`delete` on
  them throws (requirements spec 1.22.7).
- Changing a calendar's clock constants or months changes what every datetime
  variable using it means (their stored seconds are unchanged). That is by
  design - the definition is the meaning of the number.
- Definitions are persisted in the settings blob on every change.
- `createCalendarDefinition` stores a copy; later edits to the object you
  passed do not change the calendar. Returned definitions are copies too.
  (`getCalendarDefinition`/`getCalendarDefinitions` still return the live
  settings objects, as in Section 10 - treat them as read-only.)

**11.5 Verification**

`tests/fantasy-calendar.test.js`; the full suite passes under `npm test`.


SECTION 12 — NOTIFICATION API (2026-09-21)

**12.0 What it is**

One notification surface for every extension. An extension registers an
ACTIONABLE notification - a message, a severity and (optionally) the id of a
callback it registered; State Engine shows all of them behind a single button in
the chat UI and lists them in a panel; clicking one runs the extension's callback
and then removes the notification. Files: `src/core/notification-core.js` (the
registry), `src/api/notification-api.js` (this API), `src/ui/notification-ui.js`
(button and panel). Requirements spec 1.24 has the storage and UI rules.

**12.1 Functions** (all on `stateEngine` and exported from `src/api/index.js`)

| Function | Identity | Returns |
|---|---|---|
| `registerNotificationCallback(extensionId, instanceId, callbackId, fn)` | yes | `true` |
| `unregisterNotificationCallback(extensionId, instanceId, callbackId)` | yes | whether one was removed |
| `notify(extensionId, instanceId, notification)` | yes | the notification's id |
| `clearNotification(extensionId, instanceId, id)` | yes | whether it existed |
| `getNotifications()` | no | copies, oldest first |
| `invokeNotificationCallback(id)` | no | a Promise (below) |

`notification` = `{ message, severity?, callbackId?, id? }`:

- `message` - required, non-empty text, trimmed, at most 500 characters. It is
  shown as text, never as HTML.
- `severity` - `"info"` (default), `"success"`, `"warning"` or `"error"`.
- `callbackId` - optional; must be a callback THIS extension already registered
  (`registerNotificationCallback`). With none, clicking just dismisses it.
- `id` - optional key of your own (letters, digits and `_ . : -`, up to 64).
  Notifying again with the same `id` REPLACES that notification (new text, fresh
  timestamp, moved to the end) instead of adding a duplicate. Omitted -> generated.

The stored id is `"<your namespace>::<key>"`; `notify` returns it. Unknown fields
are rejected.

A stored notification is `{ id, source, severity, message, timestamp,
callbackId }`. `source` is the caller's namespace - it is taken from the caller's
identity, never from the notification, so an extension cannot post as another.

**12.2 Callbacks**

A callback is an in-memory function registered under `callbackId`. Functions
cannot be saved, so a notification only stores the callback's ID, and the
extension must register its callbacks again on every page load. Until it has, its
stored notifications are still listed but their action reports "not available".
Registering an id again replaces the function. The callback is called with a copy
of the notification and may be async.

**12.3 `invokeNotificationCallback(id)`** (what the panel calls on a click)

Resolves `true` when the action ran (or there was none) and the notification is
gone; `false` when there is no such notification. It REJECTS - and keeps the
notification, so the user can try again - when the callback is not registered or
threw. Removal happens only after the callback succeeds. A second call while the
action is still running rejects rather than running it twice. It needs no
identity, like the other reads, because the panel is State Engine's own UI; use
`clearNotification` for your own cleanup.

**12.4 Behavior and limits**

- Nothing expires: a notification stays until it is cleared, dismissed (the x
  in the panel) or its callback has run. There is no cap on how many an extension
  may post - use a fixed `id` for anything that repeats.
- Every write throws on failure (identity, invalid notification, unregistered
  callback, clearing another extension's notification), like Sections 10-11.
  `clearNotification` on an id that is already gone returns `false`, not an error.
- `stateEngine` is not attached to `window`; an extension imports it from
  `src/api/index.js` like the rest of this API.
- Visibility toggles, Pretty Panels integration and auto-expiry are deliberately
  not part of this pass.

**12.5 Deviation from the request**

The request listed `notify(notification)`, `clearNotification(id)`,
`getNotifications()` and `invokeNotificationCallback(id)` without identity. Writes
take `(extensionId, instanceId, ...)` first because every other write in this API
layer does (Section 7.4), and `source` needs a verified namespace. The two reads
keep the requested signatures. `registerNotificationCallback` /
`unregisterNotificationCallback` are not in the list but the callback registry
needs an entry point ("extensions register callbacks by ID").

**12.7 Built-in user: extension updates**

State Engine itself posts through this API as the built-in `se` namespace: the
"One or more extensions have updates available." notification (requirements spec
1.25, `src/events/extension-updates.js`). Its key is `extension-updates`, its
callback id is `open-extension-manager`, and it is replaced, never duplicated.

**12.8 Image variables through the variable API**

`createVariable` / `updateVariable` accept `type: "image" | "imageList" | "imageMap"`
(requirements spec 1.26); there are no new functions. `defaultValue` is the way a value
is supplied: a string, an array of strings, or an object of strings (a JSON string is
accepted and stored parsed); it is '' / [] / {} when omitted. A wrong shape, a
non-string `currentKeyVariable`, or `behaviors.increment: true` on an `image` or
`imageMap` is refused with a warning and `null`, like any invalid definition. An
`imageList` may be incremented with `increment.operation` `"rotateNext"` or `"rotate"`.
Nothing is fetched or checked when one is created. Image variables cannot be used in
World Info conditions and are never asked of the prompted LLM.

**12.9 Presets with images**

`exportPresetWithImages(presetId)` and `importPresetWithImages(presetData)` in
`src/core/preset-export.js` are the async forms of `exportPreset` / `importPresetDetailed`
that carry a preset's image files (requirements spec 1.27). They are internal (used by the
manager modal); the existing synchronous functions are unchanged, except that a plain
import discards an embedded `stateEngineImages` block.

**12.10 Boolean flag mode (createVariable / updateVariable)**

`flagMode` (boolean, default false) is accepted on a `type: "boolean"` definition
through the existing create/update calls - no new API functions (requirements spec
1.28). It must be a real boolean or the call is rejected; `defaultValue` is always
normalized to `false` when `type` is `"boolean"` and `flagMode` is `true`. The
actual write-once ENFORCEMENT is not an API-layer concern - it lives in
chat-state.js's setVar()/applyIncrement(), the shared write path every value change
(including a future extension value-write API) already goes through.

**12.6 Verification**

`tests/api/notification-api.test.js` and `tests/notification-ui.test.js`; the full
suite passes under `npm test`.


SECTION 13 — INDEPENDENT PRESETS (2026-09-21)

**13.0 What changed from the Section 6 placeholder**

Section 6 described `independent-presets.js` as "a named placeholder... not a
description of existing batching/dispatch behavior (there is none yet)." This
pass gives it: a first-class `independentPreset` flag, per-preset enabled/
disabled, per-preset variable BATCH selection, the three independent-CONTEXT
modes, and per-preset run status - all still composed on top of the same
`runIndependentPreset` dispatcher from Section 6, unchanged in its core write
pipeline. `runIndependentPreset(chatId, presetRef)` / `configureIndependentPreset
(namespace, name, config)` keep exactly their Section-6 signatures.

**13.1 "Independent preset" is a flag, not a parallel storage system**

The request's Section 2 asks to "Add a new preset type: independent preset."
A preset already has everything one needs (variables, namespace, name, export/
import, tracker/dependency-graph integration) - duplicating all of that into a
second storage system would fragment every feature already built on top of
`settings.presets`, for no benefit. Deviation: `preset.independentPreset` is a
plain boolean field (default `false`, `preset-manager.js`'s `createPreset()`),
the same pattern `flagMode` used for booleans (1.28) and `itemType` uses for
arrays - present on any preset, meaningful only when `true`.

**13.2 CRUD** (`src/api/independent-presets.js`, all identity-checked)

```
createIndependentPreset(extensionId, instanceId, def)
updateIndependentPreset(extensionId, instanceId, namespace, name, patch)
deleteIndependentPreset(extensionId, instanceId, namespace, name)
listIndependentPresets(extensionId, instanceId, namespace)
toggleIndependentPreset(extensionId, instanceId, namespace, name, enabled)
```

None of these reimplement preset storage - they compose `preset-api.js`'s
already-tested `createPreset`/`updatePreset`/`deletePreset`/`listPresets` (the
SAME functions the manager modal's Presets tab already uses) with the
`independentPreset` flag and the config merge below. `def`/`patch` accept
`namespace`, `name` (patch only, renames), `description`, and the config
fields in 13.3. `update`/`delete`/`toggle` all require
`preset.independentPreset === true` first - "cannot modify other presets"
(request Section 2) is read here as "these independent-preset-scoped
operations only ever touch a preset that IS one." A regular preset passed to
any of them is refused (`null`/`false`), never silently touched.

**13.3 Config** (`preset.independentConfig`, `configureIndependentPreset`)

Unchanged fields from Section 6: `connectionProfileId`, `temperature`,
`maxTokens`, `promptedHeader`, `promptedRules` (per-preset overrides of the
matching global settings, composed onto `callBackgroundLLM` via a shallow
settings copy - the real settings object is never touched). New fields:

- ~~`batch`~~ **REMOVED (requirements spec 1.20, rewritten 2026-09-22).**
  Originally: which variable batch this preset's independent run operated
  on. The named-batch system itself was removed entirely - not just here -
  after the user who requested it clarified it was never what she'd asked
  for ("I wanted the variable prompts to 'batch' out the variables ... to
  avoid overloading the context ... I don't even know how it got turned
  into what it became"). `runIndependentPreset` now always operates on
  EVERY prompted/incrementable variable in the preset itself (its own
  membership is already a meaningful scope, needing no separate field), and
  automatically splits an oversized set into several sequential calls
  (`src/core/prompt-chunking.js`) instead of ever needing to be manually
  narrowed. See requirements spec 1.20 for the full account.
- `enabled` (boolean, default `true`) - request Section 7's toggle. `false`
  makes `runIndependentPreset` refuse immediately (before the concurrency
  lock, before any LLM call) whether triggered manually, by an extension, or
  (once built) by a schedule or an event.

`context` is deliberately NOT accepted through `configureIndependentPreset` /
create / update - see 13.4.

**13.4 Independent context** (request Section 3)

```
updateIndependentPresetContext(extensionId, instanceId, namespace, name, context)
getIndependentPresetStatus(namespace, name)          // read; includes contextMode
independentContextMode(config)                        // pure helper, exported for tests
isEmptyIndependentContext(context)                    // pure helper, exported for tests
```

`context: any | undefined`, stored verbatim on `independentConfig.context`,
**never interpreted, validated or mutated** (request Section 3.A, followed
literally - `describeIndependentContext()` only ever turns it into prompt TEXT,
a string used as-is or `JSON.stringify`'d, never inspected for shape). Mode is
derived at run time, not stored as a separate flag:

| Stored state | Mode | Prompt |
|---|---|---|
| `updateIndependentPresetContext` never called | chat-history (B) | the same transcript-building `runIndependentPreset` always had |
| called with `null`, `undefined`, or `{}` | empty (C) | no context section at all - "operates purely on variables" |
| called with anything else | extension (A) | `Independent context:\n<text>`, passed through untouched |

In modes A and C, `SillyTavern.getContext().chat` is not read or required to
exist at all - only mode B (chat-history) depends on the chat, matching
request Section 4's "cannot modify the main chat" read as "does not even
need it" outside the default mode.

Deviation: calling `updateIndependentPresetContext` **commits** the preset to
modes A/C from then on - there is no verb that returns it to "as if never
called" (mode B). The request's three rules describe "supplied" vs. "not
supplied," not "supplied, then un-supplied"; reading `undefined` as "go back
to chat-history" would collide with mode C already claiming `undefined` as
empty. If she wants an explicit reset-to-default verb, it is a small
follow-up (a fourth call, or a `deleteIndependentPresetContext`).

**13.5 Prompt construction** (request Section 6)

Verified, not just asserted: the prompt is built from ONLY the header/rules
text, the context section (13.4), and this preset's OWN variable lines
(requirements spec 1.20, rewritten 2026-09-22: every prompted/incrementable
variable in the preset, automatically chunked across several calls if too
large - no other preset's variables, ever) - no WI, calendar or image-
variable metadata, no SillyTavern chat system message (the independent
pipeline builds its own two-message `[system, user]` array, never reusing
anything from SillyTavern's own chat-completion prompt).

**13.6 Status** (request Sections 7/8)

`getIndependentPresetStatus(namespace, name)` -> `{ enabled,
contextMode, lastRunAt, lastOutcome, lastError, changedVariables }` or `null`
for a missing/non-independent preset. Read-only, no identity - same
convention as `getVariable()`/`getDependents()`. `lastOutcome` is one of
`never-run | updated | no-op | error | skipped-disabled |
skipped-in-progress | skipped-nothing-to-update | skipped-parse-error`,
written by `runIndependentPreset` on every exit path (`preset.
independentStatus`), including every early refusal - `getIndependentPresetStatus`
always has a meaningful, current answer, matching the request's "last output
summary" / "variable changes from last run."

**13.7 Export / import**

`independentPreset`, `independentConfig` (prompt/model/context - request
Section 9's own list, minus `batch`, removed 1.20 rewrite 2026-09-22) are
plain preset fields and round-trip through
`exportPreset`/`importPresetDetailed` with zero extra code, exactly like
`itemType` or `currentKeyVariable` already do. Two things are deliberately
NOT carried across:

- `independentStatus` is stripped on both export and import (defensively, in
  case a hand-edited or differently-sourced file still has one) - it is run
  HISTORY for what happened in THIS install's chats, not part of the request's
  own export list, and re-importing it would misrepresent a preset that has
  never run elsewhere as if it had.
- A non-JSON-serializable `independentConfig.context` (a function, a circular
  structure, a DOM node) is dropped from the export with a console warning;
  every other field still exports. `context` is `any`, and exporting to a
  JSON file is a hard boundary such a value cannot cross - not a gap in the
  "never interpreted, validated or mutated" rule (13.4), which is about
  RUNTIME behavior, not file portability.

**13.8 Deviation: `runIndependentPreset` is NOT gated on `independentPreset`**

Every CRUD/status function in 13.2/13.4/13.6 requires the flag; `runIndependentPreset`
itself deliberately does not. It is the same dispatcher extensions have been
calling on ANY preset since Section 6 (2026-09-10) - already tested, already
documented - and gating it now would silently break that behavior for no
benefit. "Cannot modify other presets" is about SCOPE (a run only ever
touches its OWN preset's variables), not about which presets may be run this
way. Manual execution (request Section 4.1) and extension-triggered execution
(4.4) share this one function; the manager modal's own Run Now button (13.9)
is simply its most visible caller.

**13.9 Manager modal UI (2026-09-21, built in a second pass)**

The Presets tab (`src/ui/manager-modal/`) gained two subtabs - "Regular
Presets" (unchanged) and "Independent Presets" - built the same way the
existing tab already is (`ui-templates.js` strings, `ui-render.js` fetches
data and calls them, `ui-events.js` wires clicks), reusing every existing
convention rather than inventing new ones:

- `manager-api.js` gained `independentPresetAdapters` (create/update/delete/
  toggle/run/status, `connectionProfiles`), the SAME presetId<->(namespace,
  name) translation and `callAsBuiltin()` error-to-status-bar convention the
  regular-preset adapters already use (Section 7).
- The subtab switch is session state (`managerState.presetsSubtab`), same
  lifetime and the same accepted drift-once-open behavior as the existing
  `managerState.currentPresetId` (manager-modal.js's own module-level copy
  only updates on a fresh build / chat change, exactly as before this pass).
- **Clone and Export need no independent-specific code at all**: both
  buttons on an independent-preset row are the SAME `.se-manager-clone-preset`/
  `.se-manager-export-preset` handlers a regular preset uses - `independentPreset`/
  `independentConfig` clone and export like any other preset field (13.1/13.7).
  One small matching fix: `clonePreset()` (`src/ui/manager-modal/preset-manager.js`)
  now also strips `independentStatus` on clone, for the identical reason
  `exportPreset()` already did (13.7) - a clone has never itself run.
- Editor fields: name (rename), description, enabled/disabled toggle, model
  (a live connection-profile `<select>`, via the new `listConnectionProfiles()`
  in `connection-profile-ui.js` - refactored out of that file's two existing
  jQuery-populated dropdowns so all three share one profile-reading function),
  temperature, max tokens, and a new **history limit** field
  (`independentConfig.historyLimit`, overriding the global message count in
  chat-history mode only - a small addition to `runIndependentPreset` itself,
  covered in 13.10's test count). Clearing a number field stores `null` (not
  omitting the field) - `pickConfigFields` only merges fields that are
  PRESENT, so leaving a field out of a patch means "untouched"; every numeric
  read site already treats a stored `null` the same as "not set" via `??`/`||`,
  so this reuses existing fallback behavior rather than adding new logic.
- **Deviation: the context field is a read-only INDICATOR, not an editable
  control** - "context indicator (extension-provided, chat-history, or
  empty)" (request Section 7) is read literally as a status display, matching
  "context is always extension-owned" (Section 8): a human using the manager
  modal is not the intended source of an extension's context, so there is
  nothing to edit here.
- **Deviation: triggers/schedule show an honest "not available yet" note**
  instead of a non-functional control - per Section 11, a fake dropdown that
  saves a value nothing reads yet would be worse than admitting the gap.
- Status (13.6) is shown inline: enabled/context mode/last outcome in
  the row's own summary line, and last-run time/error/changed-variables in
  the expanded editor, refreshed after every Run Now click.

**13.10 Deferred (still not built) - request Sections 4.2, 4.3, 7's triggers/schedule fields**

Reported per the request's own Section 11 rather than built at lower rigor to
check every box:

- **Scheduled execution** (run every N seconds/minutes/hours/days/ticks) -
  needs a new timer subsystem (interval management across the extension's
  lifecycle, persisted schedule config, pause-on-hidden-tab handling,
  cleanup on preset deletion) that does not exist anywhere in this codebase.
  Proposed design: `independentConfig.schedule = { unit: 'seconds'|'minutes'|
  'hours'|'days'|'ticks', interval: number }`; a single `setInterval` in
  `index.js` (not per-preset timers) ticks every independent preset with a
  schedule and calls `runIndependentPreset` when due, storing `nextRunAt` in
  `independentStatus` (already has a place to live - 13.6).
- **Event-driven execution** (a variable change, a flag flip, a calendar
  tick, a batch rule) - needs hooking into every write path (`setVar`,
  `applyIncrement`, calculated recalculation) to detect a matching change and
  fire a preset from there. This intersects `chat-state.js` - the codebase's
  highest-priority, most write-sensitive file (Section 6 / 1.28's own
  reasoning for not touching `prompted-engine.js` applies doubly here) -
  and deserves its own careful, separately-tested pass rather than being
  folded in alongside everything else in this one. Proposed design: a
  `subscribeToVariableChanges(chatId, varName, listener)` primitive in
  `chat-state.js` (additive, called from `setVar`/`applyIncrement` after a
  successful write, mirroring `notification-core.js`'s own `subscribeToNotifications`
  pattern - 1.24), with `independentConfig.triggers = [{ variable, batchRule?
  }]` driving which presets subscribe to what.

**13.11 Verification**

`tests/api/independent-presets.test.js` (54 tests as of this pass - later
grown further by 1.20's rewrite, below: the original Section-6 pipeline
tests plus CRUD, all three context modes, variable scoping, the history-limit
override, enabled/disabled, status, export/import, write-path/flag-mode
interaction, and compliance checks for 13.5) and `tests/independent-presets-ui.test.js`
(19 tests: subtabs, create/rename/delete, clone/export reuse, every editor
field, enabled/disabled, Run Now, and that a regular preset stays unreachable
through the independent-preset controls); the full suite passes under `npm
test`. Every rule above was also verified by deliberately breaking it and
confirming the suite catches the break (mutation testing), the same standard
every other pass in this document has been held to.

SECTION 14 — CALCULATED DATETIME EXTENSION (2026-09-21, consolidated 2026-09-22)

**14.0 What it is**

ONE new optional field on the EXISTING `datetime` type (requirements spec
1.31) - no new type, no new `stateEngine.*` function. A caller sets it
exactly like any other field, through `createVariable(extensionId, instanceId,
def)` / `updateVariable(extensionId, instanceId, ref, patch)` (Section 6/7),
which already accept `def`/`patch` as a bag of fields:

```
deltaSource: string       // default '' - the FULLY-QUALIFIED name (e.g.
                          // "ext__jump") of a type: 'string' variable in the
                          // SAME preset; same convention a calculated
                          // variable's `dependencies` already uses (7.3)
```

Superseded two earlier designs: a "new `calculatedDatetime` type" (rejected -
it would be written outside its own expression evaluation, contradicting
`calculated`'s own contract, calculated-engine.js's header comment), and a
second pass that added THREE more fields (`fixedIncrement`, `tickUnit`,
`accumulate`) as a parallel automatic-ticking mechanism for datetime
specifically. That second design is also gone: it turned out to duplicate
`behaviors.increment`/`increment.delta` (14.1 below), which every type,
datetime included, already had - a real redundancy, reported by the person
using the manager modal as confusing before it was caught here. See
requirements spec 1.31 for the full account of both revisions.

**14.1 Automatic advancement is `behaviors.increment`, not a datetime-specific field**

A datetime variable that should tick forward on its own uses the SAME
`behaviors.increment: true` + `increment.delta` (a calendar duration string,
e.g. `"1h"`, `"1d"`, `"1mo"`) + `increment.triggers` every other
incrementable type already has (Section 5/1.21) - nothing new here. The only
datetime-specific behavior layered on top is jump-suppression (14.2).

**14.2 deltaSource (narrative jumps) and its interaction with a tick**

Whenever the named `deltaSource` variable's value changes to a non-empty
string, its text (a duration - "3 days", "12 hours" - or a full instruction
like "advance 3 hours" or an absolute date) is parsed against the datetime
variable's OWN calendar via the SAME parser `resolveInstruction()` already
uses (Section 10/11), applied to the datetime's current value, and the
source is reset to `''`. This means the intended integration is: give an
extension's preset a plain `type: 'string', behaviors.prompted: true`
variable as the delta source, let the model (or any caller, including
`runIndependentPreset` - Section 13) write a duration into it, and the
datetime variable updates itself with no further code. `deltaSource` must
reference an existing `type: 'string'` variable in the same preset or
`createVariable`/`updateVariable` rejects the definition (same warn-and-null
convention as every other validation in this module). If the SAME datetime
also has `behaviors.increment: true` (14.1), a jump that lands the same
pass as its automatic tick suppresses that one tick (best-effort, not a hard
guarantee - see requirements spec 1.31) so the two never both land at once;
a PROMPTED increment (`behaviors.prompted: true`) is never suppressed this
way, since it only ever fires on the model's own answer, not a fixed pass.

**14.3 No new read/status surface**

Nothing new is exposed for reading "did a jump just happen" - `getVariable`/
`listVariables` (Section 2) return `deltaSource` like any other field, and
the datetime variable's own stored value (`getVar` internally, or a preset's
normal read path) is the only place to observe the result. The one-shot
jump-suppression flag (requirements spec 1.31) is purely internal to
`calculated-engine.js`/`deterministic-engine.js` and is not part of the
public API.

**14.4 Manager modal UI**

Not a new `stateEngine.*` function - 14.3 still holds. The datetime editor
in the manager modal (a caller of `createVariable`/`updateVariable` for
every other type, but one that writes `preset.variables` directly for its
own inline save, like the rest of that editor) has a `deltaSource` dropdown
next to the calendar picker, and re-implements checkedDatetime()'s
`deltaSource` validation locally, for the same reason it already duplicates
the calendar/defaultValue checks. Automatic advancement is configured
through the ordinary, shared "Incremented Behavior" section every type has -
no datetime-specific tick UI exists any more (removed in the consolidation;
see requirements spec 1.31, including a rendering bug found and fixed by
mutation testing during the original build, a stale/wrong-type stored
`deltaSource` not always being flagged).

**14.5 Verification**

`tests/calculated-datetime.test.js` (34 tests): schema/validation, automatic
ticking through the ordinary `behaviors.increment` mechanism, deltaSource
consumption (including fan-out to multiple datetime variables and a fantasy
calendar), the jump-suppresses-the-next-tick interaction (including that a
PROMPTED increment is never suppressed), the recursion/cycle guard
(including why a real infinite cycle cannot form through this mechanism),
end-to-end through both the main prompted update and `runIndependentPreset`,
and export. `tests/calculated-datetime-ui.test.js` (15 tests): the
manager-modal editor above, including that Incremented Behavior is what
actually ticks a datetime and that no separate tick UI exists. Every rule
across all revisions was verified by deliberately breaking it and confirming
the suite catches the break (mutation testing); the consolidation itself
surfaced a real regression on its first attempt - the new jump-suppression
check added to the shared deterministic-increment loop broke every OTHER
suite exercising a datetime increment, since the test harness's simplified
`calculated-engine.js` mock had no `consumeDatetimeJump` export at all -
caught by running the full suite (not just this feature's own tests) before
calling the change done, fixed by adding a no-op fallback to that mock.

SECTION 15 — INDEPENDENT PRESETS: SCHEDULING (2026-09-22)

**15.0 What it is**

Time-based automatic execution for independent presets (Section 13):
interval, atTime, delay and repeat modes. `src/core/schedule-engine.js`
(pure calendar math, no identity/preset concept at all) + two new
`stateEngine.*` functions in `src/api/independent-presets.js`.

```
updateIndependentPresetSchedule(extensionId, instanceId, namespace, name, schedule)
  -> the stored schedule (with nextRun), or null on a validation failure
checkAndRunDueSchedules(chatId)
  -> the number of presets that ran (engine-internal - not called by an
     extension in normal use; exposed on stateEngine only because every
     other independent-preset function already is)
```

`schedule`: `{ enabled?, mode?, value?, calendar?, repeat? }` - merges into
the stored schedule like `configureIndependentPreset`'s config patch
(Section 13.1) does, so disabling never requires repeating mode/value.
`nextRun` (ms since epoch) is never accepted from a caller - engine-managed,
the same reason `independentStatus` (13.7) is read-only.

**15.1 The four modes**

`mode`: `"interval"` (run every N units, always reschedules) | `"atTime"`
(run once at an absolute/relative moment, disables after unless `repeat:
true`) | `"delay"` (run once after a duration, always disables after) |
`"repeat"` (always stays enabled, always recomputes the next future
occurrence). `value` is an NL time expression, parsed through the SAME
calendar-engine functions Section 10/11 and requirements spec 1.22.4/1.31
already expose (`resolveInstruction`), fed `Date.now()` as the calendar's
own "current scalar" instead of a datetime variable's stored value - see
requirements spec 1.32 for the full reasoning, the confirmed
"dawn"/"midnight"/"sunrise"/"sunset" gap, and the per-mode `nextRun` rules.

**15.2 Execution**

`checkAndRunDueSchedules(chatId)` is what actually runs a due preset - an
extension never calls it directly in normal use; it is reached by
`src/events/event-engine.js` on every message and from a real 30-second
`setInterval` (`startIndependentPresetScheduler()`, started once from
`index.js`). Scheduling only ever runs for whichever chat is open in this
browser tab right now - there is no background or server-side execution in
this extension.

**15.3 Deferred: threshold mode**

The original request's fifth mode - run when a datetime VARIABLE crosses a
value ("when date >= harvestSeason") - is not built. It needs a small
variable-comparison expression language no field in this schema defines,
and it is the one mode with a real cycle risk (a run that writes the very
variable it watches could re-trigger itself through `recalculateDependents()`
- Section 13/requirements spec 1.31). Event-driven triggers (run on any
variable change) remain deferred from Section 13.10 for the same reasons.

**15.4 Verification**

`tests/schedule-engine.test.js` (28), `tests/api/independent-presets-
schedule.test.js` (22), `tests/independent-presets-schedule-ui.test.js` (8)
- see requirements spec 1.32 for what each covers. Every rule was verified
by deliberately breaking it and confirming the suite catches the break.

SECTION 16 — SEMANTIC TIME OF DAY (2026-09-22)

**16.0 What it is**

ONE new optional field on the EXISTING `datetime` type (requirements spec
1.35), the same shape of extension `deltaSource` (Section 14) already is -
set through `createVariable`/`updateVariable` like any other field:

```
timeSemanticMode: 'none' | 'semanticTimeOfDay'   // default 'none'
```

When `'semanticTimeOfDay'`, a prompted answer for THIS variable
(runPromptedStateUpdate's direct "update" mode only - Section 6) may use
morning/dawn/sunrise/noon/afternoon/evening/sunset/night/midnight (mapped
to 08:00/06:00/06:00/12:00/15:00/18:00/19:00/21:00/00:00) and "the next
<phrase>" to also move to the following day, resolved internally - never
described to the model (`describeConstraint()` is unchanged; the phrase
works because it also reads as ordinary natural language, same as any
other free-form answer).

**16.1 Scope: not deltaSource, not scheduling**

`resolveInstruction()` (Section 10/11) gained a 4th, optional `options`
parameter (`{ semanticTimeOfDay: boolean }`, default off) rather than
changing its behavior globally. Only `prompted-engine.js`'s direct write
passes `true` for it, and only when the variable being written has
`timeSemanticMode === 'semanticTimeOfDay'`. `deltaSource`'s own trigger
(Section 14.2) and Section 15's schedule-engine.js both call
`resolveInstruction()` without it and are completely unaffected - for
deltaSource this is by explicit design (the request that introduced this
field says so), not an oversight.

Note for a future pass, not acted on here: Section 15.1's own "CONFIRMED
GAP" (requirements spec 1.32) - that `atTime`/`repeat` scheduling could not
understand "dawn"/"midnight"/"sunrise"/"sunset" because no hour-of-day
vocabulary existed anywhere in calendar-engine.js - is exactly the
vocabulary this section adds. Wiring `{ semanticTimeOfDay: true }` into
`schedule-engine.js`'s own `resolveInstruction()` call would close that gap,
but doing so is out of scope for the request behind this section (which
only ever mentions datetime variables' own prompted answers) and was
deliberately left undone.

**16.2 Verification**

`tests/datetime.test.js` ("semantic time of day (spec 1.35)": the canonical
mapping, case/"the"-prefix tolerance, next-day variants generalized beyond
the request's three given examples, the same-day backwards-in-time case, an
incompatible calendar, the enable/disable gate, schema validation, and
end-to-end prompted-update integration including tracker display) and
`tests/calculated-datetime.test.js` (one test, using that file's real-
calculated-engine harness, confirming deltaSource text is never given
semantic interpretation even when the target datetime has it enabled).
Every rule was verified by deliberately breaking it and confirming the
suite catches the break (mutation testing).

SECTION 17 — DATETIME MODE (2026-09-22)

**17.0 What it is**

ONE new optional field on the EXISTING `datetime` type (requirements spec
1.36), the same shape of extension `deltaSource` (Section 14) and
`timeSemanticMode` (Section 16) already are:

```
datetimeMode: 'full' | 'dateOnly' | 'timeOnly'   // default 'full'
```

`dateOnly` normalizes the time-of-day to 00:00:00 after every write;
`timeOnly` normalizes the date to the calendar's own reference moment (day
0) after every write. `'full'` is a pure no-op, so an existing datetime
variable is completely unaffected.

**17.1 Nothing about parsing changed - only the write-side result**

Every existing input path - a relative delta (`incrementScalar`,
`resolveInstruction`'s advance/rewind), an absolute date/time answer, a
semantic time-of-day phrase (Section 16) - is unchanged by this field. The
result is normalized once, at `chat-state.js`'s `setVar()` (the single
choke point every write path already shares) and, separately, at
`applyIncrement()` (which writes its own `entry.value` directly rather than
through `setVar()`). A caller of the public API never needs to know which
mode a datetime variable is in to write to it correctly - the engine always
produces the right half of the value regardless.

**17.2 Semantic time of day interaction**

`dateOnly` never interprets a semantic phrase (Section 16) at all -
`checkedDatetime()` forces `timeSemanticMode` to `'none'` whenever
`datetimeMode` is `'dateOnly'`, on both `createVariable`/`updateVariable`.
`timeOnly` and `'full'` may combine freely with `timeSemanticMode`.

**17.3 Tracker display**

`formatValueForDisplay` (used by any caller building its own read-only view
of a variable's value) picks the calendar's `'date'`/`'time'`/`'full'`
format style from `datetimeMode` automatically - no separate read call is
needed to get a mode-appropriate string.

**17.4 Verification**

`tests/datetime.test.js` ("datetime mode (spec 1.36)"),
`tests/calculated-datetime-ui.test.js` (a new describe block for the
manager-modal save path), `tests/calculated-datetime.test.js` (one
deltaSource-interaction test). Every rule was verified by deliberately
breaking it and confirming the suite catches the break (mutation testing).

SECTION 18 — AUTOMATIC PROMPT CHUNKING (2026-09-22)

**18.0 What changed, and why**

Section 13.3 originally documented `independentConfig.batch` (a per-preset
variable-scoping field), on top of a whole separate `src/api/batching.js`
surface (`assignBatch`, `removeBatch`, `getBatch`, `getBatches`,
`batchPrompt`) requirements spec 1.20 specified. Both are REMOVED. Asked
directly why, after this document described the batching system as settled:
"I had suggested that I wanted the variable prompts to 'batch' out the
variables (in other words chunking) to avoid overloading the context. I
don't even know how it got turned into what it became." The system that got
built - manual, named, per-variable tagging, with no relationship to actual
prompt size - was never what was asked for. See requirements spec 1.20 for
the full account.

**18.1 What replaced it: nothing to call**

There is no new API surface for a caller to learn. `createVariable`/
`updateVariable` no longer accept or return a `batch` field at all (it is
simply gone from the definition shape); `independentConfig` no longer has a
`batch` field either (Section 13.3). The main prompted update and
`runIndependentPreset` (Section 13) both now operate on their full,
unscoped variable pool automatically - the main update across every active
preset for the chat, an independent preset across its own preset's
variables only (replacing the old batch-selection with the preset's own,
already-meaningful membership) - and silently split that pool into several
sequential LLM calls if it would be too large for one, governed by
`settings.maxPromptedVariableChars` (a plain settings field, not part of the
namespaced API surface - there is no `stateEngine.*` call to read or write
it).

**18.2 For an extension that called `assignBatch`/`getBatch`/etc.**

There is no migration path or compatibility shim - the functions are gone.
An extension that depended on excluding some of its own variables from the
main prompted update has no direct replacement for that specific behavior;
the closest available lever is `behaviors.prompted: false` (excluding a
variable from prompted updates entirely) or moving it to its own
independent preset (Section 13), which now always gets its own preset's
full variable set with no further configuration.

**18.3 Verification**

`tests/prompt-chunking.test.js` (the pure packer, `chunkPromptUnits`, and
the settings-default derivation), `tests/prompted-engine-chunking.test.js`
(the main update), and `tests/api/independent-presets.test.js`'s own
"1.20 automatic scoping and chunking" describe block. Every rule was
verified by deliberately breaking it and confirming the suite catches the
break (mutation testing) - including a genuine gap this pass found and
closed in its own tests, not assumed: a partially-successful multi-chunk
independent-preset run must report `'updated'` with its real
`changedVariables`, never `'skipped-parse-error'`, just because one OTHER
chunk among several failed to parse.

SECTION 19 — VARIABLE VALUE API AND CROSS-NAMESPACE ACTIVATION (2026-09-23)

**19.0 What changed, and why**

Pretty Panels - the first external consumer - needs to show the user's own
variables on HUD panels and switch on the presets a layout displays. The
API had no way to read a value at all (`getVariable`/`listVariables` return
definitions, own namespace only), no way to write one (`def.value` is
refused, correctly), no change notification, and refused
`activatePreset` on any preset the caller did not own - which is every
user preset, since those live in `se`.

Write isolation was always meant to stop one extension changing another's
DEFINITIONS. Binding a preset to a chat changes no definition, so it was
wrongly caught by the ownership check; that is corrected here rather than
worked around.

**19.1 Cross-namespace activation** (`src/api/preset-api.js`)

`activatePreset` / `deactivatePreset` now check `resolveCallerRecord`
(right instance, caller owns SOME namespace) instead of ownership of the
target namespace. A wrong instance or an unregistered caller still throws
before anything happens. Everything else in the module is unchanged and
owner-only.

**19.2 Variable Value API** (`src/api/variable-value-api.js`)

```
listAllVariables(extensionId, instanceId, chatId?)
  -> [{ id, namespace, name, description, active?, variables: [def...] }]
getVariableValue(extensionId, instanceId, chatId, qualifiedName)
  -> { value, def } | undefined
getVariableValues(extensionId, instanceId, chatId, qualifiedNames)
  -> { [name]: { value, def } | undefined }
setVariableValue(extensionId, instanceId, chatId, ref, value) -> boolean
```

- Reads are open to any registered caller and span every namespace. They
  return copies and only DISPLAY fields of a definition (`name`, `label`,
  `description`, `type`, `scope`, `min`, `max`, `enumValues`, `itemType`,
  `calendar`, `datetimeMode`, `currentKeyVariable`) - never behaviours,
  prompts, defaults or anything else.
- `listAllVariables` is grouped by preset and sorted by namespace, then
  preset name. With a `chatId`, each preset carries `active`.
- `getVariableValue` is `undefined` when the chat holds no value for the
  name (e.g. its preset was never activated there). `def` is `null` when no
  preset defines that name any more.
- `setVariableValue` is owner-only (`validateCallerIdentity` on
  `ref.namespace`), writes through `chat-state.js` `setVar()` - the same
  sanitizing and macro mirroring as any engine write - then runs
  `recalculateDependents`. Calculated variables are refused.

**19.3 Change notification** (`src/core/variable-change-signal.js`)

Every value write funnels through `chat-state.js` `saveChatState()` (and
`deleteVariableValueEverywhere()`), which now call
`notifyVariablesChanged(chatId)`. That emits
`VARIABLES_CHANGED_EVENT` (`'state_engine_variables_changed'`) on
SillyTavern's own `eventSource`, with the chatId as its only argument
(`null` = possibly every chat). Emits are coalesced per microtask: a burst
of saves for one chat produces one event. Listeners re-read what they
display; no per-variable diff is carried. The name is re-exported from
`src/api/index.js`.

**19.4 Verification**

`tests/api/variable-value-api.test.js`, `tests/variable-change-signal.test.js`
(against the REAL `chat-state.js` via `vi.importActual`), and the
`(cross-namespace)` activation block plus updated manager-modal adapter
cases in `tests/api/identity.test.js`.

SECTION 20 — NUMBER LIMITS AND IMAGE RESOLUTION (2026-09-24)

**20.0 Number limits (`def.min` / `def.max`)**

The two fields always existed on a number definition (`blankDefinition()`:
`null`) and were already applied by `clampNumber()` to manual tracker edits
and the macro-store mirror - but the manager editor never offered them, and
the isolated store (what `getVar()`, calculated variables and extensions
read) was never clamped on the prompted and increment paths. Now:

- The inline editor shows optional **Min** and **Max** inputs for number
  variables. Blank = no limit (`null`); there is no default. Saving with
  Min above Max is refused.
- `chat-state.js` `setVar()` keeps a number with limits within them (and
  stores numeric text such as a prompted `"15"` as the number), and
  `applyIncrement()`'s numeric branch clamps `current + delta`. A number
  without limits is untouched.

**20.1 `getVariableImage(extensionId, instanceId, chatId, name)`**

Part of the Variable Value API (Section 19): resolves the image an image
variable is showing through `image-variables.js` `activeImageRef()` (the
tracker's rules, including an image map's `currentKeyVariable`) and
`safeImageSrc()`. Any namespace; returns a source string or `null`.

**20.2 Verification**

`tests/number-limits.test.js` (editor, collection, and enforcement against
the REAL `chat-state.js`), and a `getVariableImage` block in
`tests/api/variable-value-api.test.js`.
