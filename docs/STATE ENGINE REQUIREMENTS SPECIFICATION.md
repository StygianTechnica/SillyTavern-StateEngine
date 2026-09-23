STATE ENGINE REQUIREMENTS SPECIFICATION
Version 1.1 — Authoritative Architectural Rules
This document defines the non‑negotiable invariants, module boundaries, lifecycle rules, and error‑handling requirements for the SillyTavern State Engine.
Claude must read and obey this document before performing any modification, refactor, or code generation.

SECTION 1 — ARCHITECTURAL INVARIANTS (MUST NEVER BE VIOLATED)
1.1 Single Source of Truth
The isolated variable store is the only authoritative location for variable values:

Code
context.extensionSettings.stateEngine.variableStore.chats[chatId].variables
Claude must not:

write variable values directly to macro store

write variable values directly to chat metadata

create secondary or shadow stores

bypass setVar or applyIncrement

All variable writes must go through the designated write‑path.

1.2 Macro Store Mirror Rule
Macro store ({{getvar::name}}) is a mirror, not a source of truth.

Claude must ensure:

macro store is updated only via setMacroValue

macro store is cleared on:

engine disable

Macro store is NOT cleared on chat change or chat creation. SillyTavern's
own local-scope macro variables live in chat_metadata.variables, which is
already chat-scoped and swaps automatically when the active chat changes -
there is nothing to manually clear. Deliberately clearing it on every chat
switch, only to immediately repopulate it via hydrateMacroStoreForChat(),
was pointless churn and the surface where the store.delete-vs-store.del
bug actually showed up.

macro store is never seeded directly

macro store is never used to determine variable values

1.3 No Chat Metadata Rule
Chat metadata is forbidden for State Engine variables.

Claude must not use:

readVarFromChatStorage

writeVarToChatStorage

deleteVarFromChatStorage

syncVarStoreToChat

any chat metadata API

This prevents prompt poisoning, 502 errors, and lifecycle corruption.

1.4 Default Value Rule
Preset variable definitions store defaults under:

Code
defaultValue
Claude must:

seed using def.defaultValue

ignore def.default entirely

never invent new default fields

1.4.1 Default Value Type Coercion (2026-09-09)

"seed using def.defaultValue" means the field, not the raw JS value sitting
in it untouched: the manager-modal inline editor's defaultValue input is a
plain text field regardless of type (jQuery .val() always returns a
string), so a number-type variable's def.defaultValue could be the string
"5" rather than the number 5. Root-caused via a pasted stored-state dump
(2026-09-09): a "constitution" variable created through the inline editor
had value: "5" and def.defaultValue: "5" (both strings) in its isolated-
store entry, which made a calculated variable summing it with another
number fail with "Operator '+' requires numeric operands" -
expression-dsl.js's arithmetic requires a real `typeof === 'number'`
operand (DSL spec section 4.1) and performs no implicit coercion (DSL spec
section 9), by design.

Two places fixed to close this:

- Read side: chat-state.js's seedVariablesForChat() and
  resetValueIfTypeChanged() now seed via getDefaultValue() (variable-
  schema.js's existing type-aware coercion - the same function
  getMacroValue()'s fallback already used) instead of raw
  `def.defaultValue ?? null`. tracker-panel-ui.js's reset-to-default button
  fixed the same way. This heals the read path for any already-stored
  variable definition, not just newly-created ones.
- Write side: variable-ui-schema.js's normalizeCollectedValues() now
  coerces a number-type variable's collected defaultValue to a real Number
  before it's saved onto the definition, so a newly-created or edited
  number variable's def.defaultValue is never a string to begin with.

Neither change touches def.defaultValue's meaning or introduces a new
field - both read def.defaultValue exactly as before, just through the
correct type-aware accessor. A variable that already has a bad string
value stored *before* this fix (like "constitution" above) is not
retroactively healed by either change - seeding/reset only apply to
variables that don't yet have an entry, or whose type just changed. The
Tracker Runtime Value Edit (1.14.2) is the correct way to fix an
already-bad stored value by hand: it already runs the input through
coerceValue() before calling setVar(), so re-entering the value there
writes a real number.

1.5 Behavior Preservation Rule
Variable definitions include:

Code
behaviors.prompted
behaviors.increment
Claude must:

preserve behaviors during seeding

never overwrite behaviors

never omit behaviors

never alter classification logic without explicit instruction

1.6 Write‑Path Rule
All variable writes must go through:

setVar(chatId, varName, value, def)

applyIncrement(chatId, varName, delta, def)

Claude must not:

write directly to state.variables[varName]

write directly to macro store

write directly to isolated store

bypass validation or metadata

1.7 Error‑Handling Rule
All engine operations must fail gracefully.

Claude must ensure:

try/catch around external APIs

warnings instead of crashes

no unhandled promise rejections

no thrown errors inside update engines

1.8 Dead Chat Cleanup Rule [REMOVED]
cleanupDeadChats() and fetchExistingChatIdsForAvatar() have been removed
entirely from chat-state.js, and no longer run from anywhere (they were
previously invoked once from runStartupOnce() in initialization-engine.js).

This automated cleanup went through several rounds of hardening in this
document's history (an unreliable context.chatList property, then a
context.characters-not-yet-loaded race that made every character look
"no longer exists" and deleted every chat's isolated-store entry on every
page load - including whatever chat the user had open at the time) and was
ultimately judged not worth the risk: any automated pass that can delete a
user's chat data based on an inference about app-readiness timing is a
liability, no matter how many edge cases get patched. Claude must not
reintroduce automatic dead-chat deletion.

In its place, chat data cleanup is now a manual, explicit, per-chat action
the user performs themselves via the Variable Management tab (1.14) -
Delete never runs automatically, only on a user's own button click, on
exactly the chat they clicked it for.

state.characterAvatar and state.groupId (stamped on a chat's isolated-store
entry at creation time - see loadChatState) still exist and are still
maintained; they are just no longer consumed by an automatic cleanup pass.
They are now used by offerCopyFromPreviousChat (1.14.1) to find candidate
source chats for the same character/group. clearMacroVarsForChat (used on
engine disable) is unaffected by this removal.

1.9 Pseudocode Declaration Rule
Claude must:

explicitly label pseudocode as pseudocode

avoid assuming field names

ask for real code before referencing structures

avoid hallucinating schema fields

1.10 Prompt Size Limitation Rule

The prompted-engine must enforce a hard cap on the number of chat messages
included in prompted updates. This cap is defined by the user-configurable
setting maxPromptHistoryMessages, which defaults to a value derived from
SillyTavern's configured context size.

Claude must ensure:

- The prompt builder never exceeds maxPromptHistoryMessages.
- The cap is applied before assembling the LLM prompt.
- Oversized individual messages may be trimmed if maxMessageLength is set.
- No other module may override or bypass this cap.
- The cap must not be implemented using chat metadata.
- The cap must not modify stored chat messages; only the prompt copy.

1.11 Enum Definition Rule

Enum variables must define their allowed values using the enumValues array.
Claude must ensure:

- enumValues is always an array of strings.
- The inline editor must allow adding, removing, and editing enum values.
- defaultValue must be validated against enumValues.
- No module outside the manager modal may modify enumValues.
- No computed enum behavior may be implemented at this stage.
- No new schema fields may be invented for enum support.
- Increment behavior for enums must cycle through enumValues in order.

1.11.1 Enum Increment Engine Rule

The deterministic increment engine must cycle enum variables through their enumValues array in order.

- Incrementing an enum must never coerce the value to a number.
- If the current value is not present in enumValues, the first element must be used.
- If enumValues is empty, the increment must be a no-op.
- The increment engine must not modify enumValues.
- The increment engine must not modify defaultValue.
- The increment engine must not write numeric values into enum variables.

1.11.2 Enum UI Rule

Enum variables must use a compact multi-line text field for editing enumValues.

- enumValues must be represented as newline-separated strings.
- The UI may use either a compact multi-line text field or a structured row-based list editor (see 1.11.3), as long as it serializes into enumValuesMultiline for the existing normalization pipeline.
- The normalization layer must split on newline, trim whitespace, remove empty lines, and remove duplicates.
- The UI must remain compact and must not expand vertically beyond reasonable limits.

1.11.3 Enum List Editor Rule

Enum variables may use a structured list editor with:
- a single "Add new entry" button,
- inline editable rows,
- per-row delete controls,
- drag-and-drop reordering using a handle icon,
- automatic removal of blank rows on save.

The list editor must serialize its rows into enumValuesMultiline so the existing normalization pipeline remains unchanged.

1.12 Hydration Stability Rule

Preset changes must not reset stored variable values.

- Saving a preset, editing a variable definition, renaming a variable, or changing behaviors must NOT re-seed or reset values for existing variables.
- Seeding must only initialize variables that do not yet exist in a chat's isolated store.
- Hydration must only mirror already-stored values into the macro store; it must never invent or seed new values.
- When a variable's type changes, its stored value for that chat must be reset to the new type's defaultValue immediately upon variable-definition save.
- No module may trigger full-store reseeding on preset save.

1.12.1 First-Seed Persistence Bug (root-caused and fixed 2026-09-10)

seedVariablesForChat() (chat-state.js) loaded a chat's state once at the
top of the function, then in its loop called setVar() per variable - which
does its own separate loadChatState()/saveChatState() round-trip - and
finally re-saved the function's own original, stale snapshot. For a chat
that had never been seeded before (nothing yet in
variableStore.chats[chatId]), loadChatState() returns a fresh, unpersisted
object on every call until something actually exists in the store - so the
loop's setVar() calls built real data into one disconnected object chain,
while the function's own final save silently overwrote all of it with the
empty pre-loop snapshot.

In real usage this meant: the very first preset activation on a genuinely
new chat (no prior setVar() call for it from any other path, e.g.
offerCopyFromPreviousChat) could seed nothing into the real isolated
store - invisible for a plain variable (the macro-store mirror write
inside setVar() is unaffected and still looked correct) but fatal for any
calculated variable depending on it, since calculated-engine.js's getVar()
call for that dependency returned undefined. Root-caused via a written
test that activated a preset for a never-before-touched chatId and checked
the isolated store directly (not the macro mirror) - not by inspection.

Fixed by having seedVariablesForChat() persist its loaded state
immediately, before the loop runs, so every loadChatState() call for the
rest of that function invocation (direct, or via setVar()/
resetValueIfTypeChanged()) returns the same already-stored object instead
of a series of disconnected fresh defaults. This does not change 1.12's
own rule (seeding still only initializes variables that don't yet exist) -
it fixes a bug in how the *result* of that seeding got persisted, for the
one case (a chat's first-ever seed) where it previously didn't.

1.14 Manual Variable Management Rule

The Manager Modal has a "Variable Management" tab (manager-modal.js /
ui-templates.js / ui-render.js / ui-events.js, all under
src/ui/manager-modal/) listing every chat's stored isolated-store entry,
independent of which chat is currently open. Each row shows the chatId, its
variable count, a truncated JSON preview, and three actions:

- Export: copies that chat's full stored entry (JSON.stringify(state, null,
  2)) to the clipboard, via the same navigator.clipboard.writeText pattern
  already used by the Debug tab's "Copy JSON" button. Read-only.
- Import: prompts for pasted JSON (window.prompt, matching this codebase's
  existing preset rename/clone dialogs) and, after validating it has a
  `variables` object and confirming if it would overwrite existing data,
  replaces settings.variableStore.chats[chatId] with the parsed object
  outright. Only re-mirrors into macro store (hydrateMacroStoreForChat) when
  the imported chatId is the currently active chat (context.chatId) -
  context.variables.local only ever reflects the chat SillyTavern currently
  has open (1.2), so hydrating any other chatId would be a no-op at best.
- Delete: removes settings.variableStore.chats[chatId] outright, after a
  confirm(). This is the replacement for the automated cleanup removed in
  1.8 - the same destructive action, but user-initiated and scoped to
  exactly the chat they clicked, never inferred from app-readiness timing.

All three actions target whichever chatId is on the clicked row, never
"whichever chat happens to be open" - a user managing this tab may be
looking at many chats at once.

1.14.1 New Chat Start Rule (2026-09-20; replaces the copy-only prompt)

A new chat starts with NO presets and NO data. Nothing is carried over from
another chat silently. On CHAT_CREATED or GROUP_CHAT_CREATED (never
CHAT_CHANGED), offerNewChatStart() (initialization-engine.js; still exported
as offerCopyFromPreviousChat) looks for another stored chat belonging to the
same character (state.characterAvatar) or group (state.groupId) as the new
chat that had active presets or stored variables. If one exists, the most
recently updated candidate is offered and the user chooses how the new chat
starts, BEFORE it proceeds (SillyTavern awaits CHAT_CREATED listeners):

  1. Same presets, no data - the source chat's active presets are activated,
     in its load order; their variables start at their defaults.
  2. Same presets AND data - as 1, then the source chat's values are copied
     (a continuation of that chat).
  3. Clean slate - no presets, no data. Closing the dialog, Escape or an
     error is also a clean slate.

The dialog is SillyTavern's Popup with three buttons (no OK/Cancel); without
Popup it falls back to two confirm() questions. It is asked once per chat per
session. Activating the presets goes through addPresetToChat(), so their
variables are seeded as for any manual activation (this is a preset-add
trigger, not seeding on CHAT_CREATED, which 3.1 still forbids). Values are
copied one variable at a time through setVar() - never by assigning the whole
stored state object, since that would overwrite the new chat's own
characterAvatar/groupId/seeded stamps - and only for variables the newly
active presets define, so no hidden values are stored for variables nothing
shows; calculated variables are recalculated once afterwards. The source chat
is never changed.

Order note: SillyTavern emits CHAT_CHANGED before CHAT_CREATED, so the
lorebook preset prompt (1.23) can appear first. A preset activated there
stays active whichever start is chosen.

This is a new-chat convenience only, not automatic hydration, and must not
be confused with seeding: 3.1 still forbids seeding on CHAT_CREATED, and
this function never invents values or reads from preset defaults - it only
ever copies values that were already stored for a different, real chat.

1.14.2 Tracker Runtime Value Edit Rule (2026-09-09)

Root cause: a variable with neither behaviors.prompted nor
behaviors.increment set (informally "static" - not a distinct schema type,
see 1.16's type table) has no write-path at all after seeding. The
manager-modal inline editor (ui-events.js) only ever edits preset
*definitions* (name/type/dependencies/defaultValue/etc), never a chat's
stored value - confirmed by inspection, not changed by this rule. Without a
runtime edit surface, such a variable is frozen at its seeded defaultValue
for the rest of the chat, and any calculated variable depending on it can
never reflect a value the user actually wants to set by hand (e.g. a
character sheet stat like "strength" that isn't meant to be prompted or
incremented, only set once and read by other calculated variables).

tracker-panel-ui.js is the fix, not ui-events.js: the Tracker is the
runtime-state surface, so it - not the schema editor - gets the edit
affordance. For every displayed variable where isStaticVariable(def) is
true (type !== "calculated" AND behaviors.prompted !== true AND
behaviors.increment !== true - true for number/string/boolean/enum/array
alike; "calculated" itself is always excluded per 1.17.3, and a
prompted/incremented variable already has its own owner), a pencil-icon
button swaps the value span for a type-appropriate inline control
(checkbox for boolean, a <select> of enumValues for enum, a text input -
JSON for arrays - for number/string/array), committed on Enter/blur/change
and discarded on Escape.

On commit: the raw input is coerced via coerceValue() (variable-
validation.js - the same per-type coercion already used elsewhere, not new
logic), written through setVar(chatId, def.name, coerced, def) - the
existing write-path (1.6), nothing bypassed - then
recalculateDependents(chatId, def.name) (calculated-engine.js) so any
calculated variable depending on it updates immediately, then the tracker
re-renders. This never touches defaultValue, never calls
seedVariablesForChat() (no new seeding trigger), and only ever affects the
current chat's stored value - fully consistent with 1.12: it is a value
write like a prompted update or a manual reset-button click already were,
not a reseed.

1.15 Typed Arrays

type "array" variables carry a declared itemType, constraining what the
array may contain. This is additive schema, not a new top-level type -
"array" already existed; itemType and the fields below just make it
strict instead of accepting anything.

Schema fields (variable-schema.js blankDefinition()):

- itemType: "string" | "number" | "boolean" | "enum" | "object" | "any".
  Missing/falsy itemType is always treated as "any" - every itemType check
  in this codebase reads `def.itemType || 'any'`, never assumes itemType is
  set.
- itemEnumValues: string[]. Only consulted when itemType === "enum".
- itemSchema: `{ fieldName: { type: "string"|"number"|"boolean"|"enum", enumValues?: [...] }, ... }`.
  Only consulted when itemType === "object". Per-field type checking, not
  presence-only.
- maxLength: number | null. null means no limit.
- unique: boolean.
- sorted: boolean.

Validation and constraints (chat-state.js, private helpers
isValidArrayItem/sortArrayItems/sanitizeArrayValue, unit-tested against the
rules below before being wired in):

- Backward compatibility: a raw value that isn't an array, and isn't a
  JSON-array string, becomes [] - a variable that previously stored a
  non-array value resets to [] rather than being reinterpreted or thrown on.
- Item validation, invalid items dropped (never thrown on): string ->
  typeof === "string"; number -> typeof === "number" and finite; boolean ->
  typeof === "boolean"; enum -> a string present in itemEnumValues; object
  -> a plain object where every field named in itemSchema is present and
  matches its declared type (enum fields checked against that field's own
  enumValues); any -> everything passes.
- unique: deduplicated via a Set (strict/SameValueZero equality). Object
  items are compared by reference, not content - two content-identical but
  distinct object instances (e.g. independently parsed from two JSON
  payloads) will NOT be deduped against each other. This is a direct
  reading of "deduplicate using strict equality" with no per-type exception
  carved out for objects.
- sorted, applied after unique: number -> ascending numeric; string ->
  lexicographic; enum -> by each item's position in itemEnumValues (not
  alphabetic); boolean -> false before true; object and any -> lexicographic
  by JSON.stringify(item).
- maxLength, applied last: excess items truncated from the end
  (`items.slice(0, maxLength)`).
- setVar() runs every array-typed value through this sanitization before it
  reaches the isolated store (the source of truth, 1.1) - never only on the
  macro-store mirror. applyIncrement()'s array branch (below) does the same
  to its own operation result before storing.

Deterministic increment operations (chat-state.js applyArrayOperation(),
used exclusively by applyIncrement() - never called from anywhere in
prompted-engine.js; the model never sees or produces operation vocabulary,
per 1.15.2's corrected prompted-update rules. This one function serves both
ways applyIncrement() itself gets triggered: a purely deterministic tick
(deterministic-engine.js, itself needing no changes - array operations are
implemented inside applyIncrement(), the same precedent enum-cycling
already set in 1.11.1) and a prompted true/false decision
(isPromptedIncrement, 1.15.2)). Configured via increment.operation and
increment.operand (increment.operand is a fixed, static value - a
deterministic trigger fires the same way on every tick, so there is no
per-tick input value to push/toggle other than whatever this field is set
to):

- push(operand): append to the end.
- unshift(operand): insert at the start.
- pop(): remove the last element.
- shift(): remove the first element.
- rotate(): move the LAST element to the front.
- clear(): set to [].
- toggle(operand) - enum arrays only: remove operand if present, else
  append it.
- cycle() - enum arrays only: replace the array with a single-element array
  holding the next itemEnumValues entry after the array's own last element
  (indexOf + 1, modulo itemEnumValues.length); an empty array, or a last
  element not found in itemEnumValues, starts at itemEnumValues[0].
- incrementField / toggleField (object arrays): stub only, not implemented
  - an inert no-op, exposed in the editor UI as "(coming soon)" so a preset
    author can select them without the save path rejecting the value, but
    they do nothing until a later pass defines the semantics.
- No operation configured (increment.operation falsy) -> the whole
  increment is a no-op, matching the "if def.increment.operation is
  missing -> do nothing" requirement exactly.

Prompted update rules (prompted-engine.js). The model is never asked to
perform an increment-style operation (push/pop/shift/unshift/rotate/clear/
toggle/cycle) itself, for arrays or any other type - that would put
arithmetic/rearrangement reasoning on a model that may be lightweight, and
operation semantics belong to applyIncrement() alone. Instead, exactly the
same two-tier classification every other type already uses applies to
arrays without exception:

- isPromptedUpdate (prompted true, increment false): the model receives a
  plain-language description of the array (via describeConstraint()) and
  must reply with a full JSON array of items - never anything else. A
  response that isn't an array for this key is skipped entirely rather than
  written; the model failing to follow the required shape must never
  corrupt the stored array.
- isPromptedIncrement (prompted true AND increment true): the model
  receives only a plain "true or false" prompt line, identical in shape to
  every other incrementable type's boolean prompt (no array-specific
  wording at all - the user's own prompted.instructions/description text is
  what tells the model what the true/false question means). A "true"
  answer runs applyIncrement(), which performs whichever
  increment.operation/operand was configured in the editor - a fixed,
  author-configured operation, never something the model specifies or
  constructs itself.

describeConstraint() (formatting-utils.js) only ever describes the full-
array-replacement shape for an array-typed variable (its itemType,
itemEnumValues when itemType is "enum", and the active
maxLength/unique/sorted constraints) - it is never used for incrementVars
at all (they get the plain true/false line above), and it must never
mention operation objects, "op", or any operation name; doing so caused the
model to intermittently return operation-shaped JSON for a variable that
had increment.behaviors === false and no operation configured for it to
even mean anything.

World Info condition operators (wi-conditions.js CONDITION_OPERATORS,
wi-condition-ui.js). Array-aware operators, available whenever the
selected condition variable's type is "array": contains, not_contains
(array.includes(value), not a substring check - falls back to the original
substring behavior when the variable isn't an array, so this is backward
compatible for existing string-type conditions), length_gt
(array.length > Number(value)), length_eq (array.length === Number(value)),
and index_eq (array[index] === value) - offered for every itemType except
"any", per spec. index_eq has no dedicated index field in the stored
condition shape ({variable, operator, value}), so its condValue is encoded
as the string "<index>:<value>" (e.g. "0:sword"), split back apart by the
operator itself; the condition-editor UI (wi-condition-ui.js) presents this
as two separate inputs (an index field shown only for index_eq) and joins
them on save - this encoding is a judgment call, not something either
requirements pass specified. When itemType is "enum", the value input
becomes a dropdown of itemEnumValues instead of free text; when itemType is
"object", it's a placeholder pending a future field-selector. Every other
(non-array) variable type keeps the original, unchanged operator list.

Fixing this required correcting two pre-existing bugs in wi-conditions.js,
found while wiring the above (new array operators would have been equally
broken otherwise, running through the same code):
(a) evaluateCondition() called `getMacroValue(varName)` with one argument,
but getMacroValue(context, def) requires two - every WI condition
evaluation was throwing internally on `def.scope` and silently fail-opening
to true via the surrounding catch, meaning WI conditional display has never
actually filtered anything. Fixed by looking up the variable's real def
(via getAllVariablesFromPresets) and calling getMacroValue(context, def)
correctly.
(b) getAvailableVariablesForConditions() read `context.chat.id` - context.chat
is the chat MESSAGES array and has no .id property, so this was always
undefined and fell back to the literal string 'unknown', meaning the
condition editor's variable dropdown was always populated from the wrong
chat's presets. Fixed to use context.chatId, the same real chat-id source
every other module in this codebase already uses.

Variable Management tab: no structural changes. The snippet preview and
expanded JSON view already display arrays correctly, since both are plain
JSON.stringify(state.variables) / JSON.stringify(state.variables, null, 2)
with no per-type branching - typed-array data serializes the same way any
other array always did.

Import/export: Export is unaffected - it copies a chat's whole stored
entry as-is via JSON.stringify, arrays included, exactly as it already did
before typed arrays existed. Import, however, does NOT sanitize array
contents against itemType/maxLength/unique/sorted: it replaces
settings.variableStore.chats[chatId] wholesale from pasted JSON (one write,
for a whole chat's worth of variables at once), never per-variable through
setVar() - the one function that actually knows how to sanitize an array
for its specific def. Section 7 of this feature's own requirements said
"no structural changes needed" for the Variable Management tab, and adding
per-variable, per-def sanitization to the bulk-import path would be exactly
such a structural change, so it was deliberately not added. Pasting
malformed array data into a variable via Import will sit unsanitized in the
isolated store until that variable is next written through setVar() or
applyIncrement() (an ordinary prompted update, deterministic tick, or
manual edit), at which point it's sanitized like any other write. This is
a known, deliberate limitation, not an oversight - a broader spec/product
call, not one this feature-level task should make unilaterally.

1.15.1 Array Editor, Sorted/Increment Exclusivity, and Tracker Column Fix

Sorted and increment are mutually exclusive for array variables (sorted +
rotate scrambles the array; sorted + push/unshift is contradictory; sorted
+ pop/shift is ambiguous about which end "sorted" means). Enforced in both
directions: turning on "Keep sorted" forces behaviors.increment off,
turning on "Incremented Behavior" forces sorted off, and each control is
disabled (with a "Sorted arrays cannot use increment operations." tooltip)
while the other is active, so a user can't re-enable one without first
turning the other off. This is a manager-modal UI rule only - it doesn't
change what chat-state.js does if a preset already on disk somehow has both
set; sanitizeArrayValue() still runs unique -> sorted -> maxLength as
documented in 1.15 regardless.

The array-default-value editor is row-based (add/remove/reorder, mirroring
the enum list editor's UI and drag-and-drop pattern), not a raw-JSON text
field. Rows serialize into defaultValue itself as a JSON array string on
save - this is a different field than itemEnumValuesMultiline (1.15's
schema-level "what values are allowed" editor, still a textarea and
unaffected by this section); the row editor is about the array's actual
default *contents*. getDefaultValue() (variable-schema.js) already accepted
a JSON-string array default before this change, so no new schema field was
needed - only the UI and defaultValue's own row->JSON serialization
changed. itemType "enum" rows use a <select> of itemEnumValues; itemType
"object" rows are placeholders ("Object item editor coming soon") that
still support add/remove/reorder and serialize as `{}` per row, pending a
real per-field object item editor.

Tracker panel column layout (style.css): the name column
(.se-tracker-label) now has a fixed 160px width instead of flex:1, and the
value column (.se-tracker-value) now flexes and wraps instead of having no
sizing rules at all - previously an unusually long value had nothing
stopping it from squeezing the name column toward unreadability. The
tracker (tracker-panel-ui.js) already exclusively rendered values through
formatValueForDisplay() (which already returns "[]" for an empty array) -
that part of this fix's premise was already true, verified rather than
redundantly re-applied.

The actual source of an array ever rendering as a bare "0" was not the
tracker at all: applyIncrement()'s fresh-entry-creation path (chat-state.js)
built `{ value: 0, def }` unconditionally, regardless of def.type. If
def.increment.operation was still unconfigured on that same first call, the
function returned before the array branch ever got a chance to correct
entry.value - leaving a real number sitting in the isolated store under an
array-typed def. The tracker itself never showed this (getMacroValue()'s
array-aware getDefaultValue() fallback masks it), but anything reading
state.variables directly - the Variable Management tab's JSON preview,
notably - would have shown it verbatim. Fixed by making the fresh-entry
default type-aware (`[]` for def.type === 'array', `0` otherwise).

sortArrayItems()'s enum case (1.15) now explicitly returns the array
unsorted when itemEnumValues is empty, rather than relying on
`indexOf` always returning -1 for every comparison (which already left the
array in its original order via a stable sort, but only as a side effect,
not a deliberate check) - same outcome, now an intentional code path.
prompted-engine.js was already confirmed to pass def into every setVar()
call for every updateVars entry (array and non-array alike); no change was
needed there.

1.15.2 Prompted/Increment Classification for Arrays (corrected), and Delete
Cleanup

An earlier revision of this document and prompted-engine.js special-cased
array variables with both behaviors.prompted and behaviors.increment
checked into isPromptedUpdate (full-array-or-operation-object JSON),
reasoning that a plain "true or false" prompt line couldn't communicate
array content. That reasoning was itself the bug: it is not the model's job
to communicate array content changes as operations at all. This has been
reverted. Arrays now use exactly the same classification as every other
type, with no exception:

- isPromptedUpdate (prompted true, increment false): full JSON array only.
- isPromptedIncrement (prompted true AND increment true): the model
  receives only a true/false prompt line and never sees operation
  vocabulary; a "true" answer runs the CONFIGURED increment.operation/
  operand through applyIncrement(), the same mechanism a purely
  deterministic array increment already uses. The model is never asked to
  choose or perform push/pop/rotate/toggle/cycle/etc itself, for arrays or
  any other type - only ever a yes/no question, exactly per 1.15's
  corrected prompted-update rules above.

The concrete bug this reversal fixes: describeConstraint() (formatting-
utils.js) is called for every isPromptedUpdate array regardless of whether
increment is configured, and its old text unconditionally described the
operation-object shape - so a variable with behaviors.increment === false
and no increment.operation configured at all was still being told about an
operation format that meant nothing for it, on top of the (correct)
full-array instructions. The two contradictory instruction sets in the same
prompt caused the model to intermittently return operation-shaped JSON
instead of a plain array. Fixed by removing all operation-object language
from describeConstraint() outright (1.15, corrected above) - prompted
arrays now only ever see full-array-replacement instructions, full stop.

The sorted/increment exclusivity handler ([data-field="sorted"], added in
1.15.1) must re-render on every change, not only when sorted is being
checked. An early return on uncheck left the increment toggle's disabled
attribute stuck from the last render, since nothing recomputes it without a
fresh render.

Deleting a variable from a preset (deleteVariable(), manager-modal's
preset-manager.js) also clears its stored value from every chat's isolated
store (chat-state.js's deleteVariableValueEverywhere()), not just the
preset definition. Without this, a variable recreated under the same name
would resurrect the deleted variable's old stored value:
seedVariablesForChat()'s hasOwnProperty check (1.12) exists so seeding
never resets an existing variable's value, and has no way to tell "this
name was never seeded" apart from "this name belonged to a deleted
variable" once the deleted variable's stored entry is left behind. This is
scoped to the explicit delete action only - 1.12 still forbids resetting a
value merely because a definition was edited or redefined.

1.15.3 Enum List Parsing Must Tolerate a Pasted JSON Array, and Prompted
Write Isolation

Root-caused via direct evidence (temporary SE_SANITIZE_DIAG/
SE_PROMPTED_WRITE_DIAG logging, since removed): a sorted-enum array's prompted
update was sanitizing to [] even though every returned name was a genuinely
valid itemEnumValues entry. The stored itemEnumValues was
`['["John", "Elizabeth", ..., "Michael"]']` - a one-element array whose sole
element was the entire allowed-values list typed as one line of literal
bracketed text, not 12 separate names. Every real name then failed
`allowed.includes(item)` because it was being compared against the whole
string, not against any of its members.

Cause: the "Allowed values"/"Allowed item values" multiline editors
(enumValuesMultiline, itemEnumValuesMultiline) split their textarea content
on newlines only. Pasting a JSON-array-formatted list as a single line
(easy to do by accident - it's literally what this same UI's own Variable
Management JSON export produces) collapses into one bogus "line" containing
the whole bracketed text verbatim.

Fix: variable-ui-schema.js's splitMultilineList() (used by
normalizeCollectedValues() for both enumValuesMultiline and
itemEnumValuesMultiline, and by ui-templates.js/ui-events.js for the same
fields' live-editor rendering) now detects a trimmed value that looks like
a JSON array (starts with `[`, ends with `]`), parses it, and uses its
elements as the individual entries; anything else - including bracketed
text that isn't valid JSON - falls back to the original newline-split
behavior unchanged. One value per line remains the documented, primary
format; a pasted JSON array is now also tolerated rather than silently
producing an unusable single entry.

Independently, and uncovered by the same investigation: the entire
updateVars/incrementVars write loop in prompted-engine.js shared one
try/catch around the whole batch. One variable's write throwing for any
reason would have silently prevented every variable after it in iteration
order from ever being written, in violation of 1.7 ("no thrown errors
inside update engines"). Each variable's write is now wrapped in its own
try/catch, logged by name on failure, so one bad entry can never take out
the rest of a prompted update's batch.

1.15.4 Item-Enum Allowed Values Is Now a Row Editor, Not a Textarea

The "Allowed item values" editor (array itemType === 'enum') is now a
row-based list - add/remove/drag-to-reorder, one input per value -
structurally identical to the top-level enum list (1.11.3) and the array
default-value editor (1.15.1), under its own class namespace
(.se-manager-itemenum-*) and field (itemEnumValuesMultiline, unchanged) so
its row-collection never conflates with the top-level enum list's despite
sharing the same serialize-into-a-newline-string approach. It replaces the
free-text "one value per line" textarea that caused 1.15.3's bug: pasting
an entire list as a single line silently produced one bogus entry instead
of real separate values. splitMultilineList() (1.15.3) still runs in the
save pipeline as a second line of defense, but the row editor is the actual
fix - there is no longer a single shared text field a whole list can be
pasted into by mistake, matching how the other two allowed-values editors
already made that mistake structurally impossible.

1.16 Variable Type Reference

| Type | Value source | Behaviors available |
|---|---|---|
| number | manual / prompted / incremented | prompted, increment |
| string | manual / prompted | prompted |
| boolean | manual / prompted / incremented (toggles) | prompted, increment |
| enum | manual / prompted / incremented (cycles enumValues) | prompted, increment |
| array | manual / prompted (full replace) / incremented (operations, 1.15) | prompted, increment |
| calculated | evaluated automatically from dependencies via the Tiny Expression DSL - never manual, prompted, or incremented | none (behaviors.prompted and behaviors.increment always false) |

1.17 Calculated Variables

A calculated variable (type: "calculated") is read-only: its value is
derived deterministically from other variables via the Tiny Expression DSL
(docs/TINY EXPRESSION DSL SPECIFICATION.md), never from the LLM, never from
a manual edit, never from applyIncrement. Implemented in
expression-dsl.js (tokenizer/parser/evaluator) and calculated-engine.js
(evaluation + re-evaluation triggers).

Schema fields (variable-schema.js blankDefinition(), additive - no existing
field renamed or repurposed):

- dependencies: string[]. The other variable names (in the same preset)
  this variable's expression may reference. An identifier used in the
  expression but absent from dependencies causes evaluation to fail (DSL
  spec 3.1/9).
- expression: string. A single-line Tiny Expression DSL expression.
- defaultValue: the value seeded before this variable's first evaluation
  (1.4) - never manually editable in the UI (1.17.3) since the variable's
  real value is always evaluated immediately after seeding (below).
- behaviors.prompted and behaviors.increment are always false for a
  calculated variable (1.5) - enforced both by the inline editor never
  rendering those toggles for type "calculated" and by an explicit force in
  the save handler (ui-events.js), so a stale or hand-edited working copy
  can never persist true for either.

1.17.1 Storage Rule

Per 1.1, a calculated variable's evaluated value is stored in
state.variables[varName].value like any other variable's, through setVar()
- never a separate location. It mirrors into the macro store via
setMacroValue() the same way (1.2). validateValueStrict()
(variable-validation.js) passes a calculated variable's value through
as-is (its real type - number, string, or boolean; the DSL has no
array-producing operation) rather than the generic string-coercion
fallback every other unrecognized type gets, so the macro-store mirror
never silently stringifies a numeric or boolean calculated result.

1.17.2 Evaluation Timing

Calculated variables are re-evaluated when:

- a dependency variable's value changes (deterministic increment, prompted
  update or increment, manual reset-on-new-chat, or a copy-from-previous-
  chat), via calculated-engine.js's recalculateDependents(chatId, varName)
- the preset definition changes (a variable is created, edited, or renamed
  in the manager modal), via seedVariablesForChat(chatId) (2026-09-09 - see
  3.1's fourth seeding trigger) immediately followed by
  recalculateAllForChat(chatId) in the same save handler. The seed call is
  required here: a variable created while its preset is already active for
  the chat has no state.variables entry through any other path, so without
  it a calculated variable's dependency reads undefined via getVar() and
  every evaluation attempt fails silently (root-caused 2026-09-09).
- a dependency variable is deleted, via recalculateDependents(chatId,
  deletedName) - the calculated variable then fails to resolve that
  identifier (DSL section 10) and retains its previous value with a logged warning,
  per 1.17.4
- seeding completes (engine enable, preset add/remove, new-chat variable
  copy, or a variable save - the four seeding triggers in 3.1), via
  recalculateAllForChat(chatId) run immediately after
  seedVariablesForChat(chatId). This is a distinct lifecycle step from
  hydration/chat-load, so it does not conflict with 1.12's
  hydration-stability rule below - it only ever runs at the same moments
  seeding itself is already permitted to run.

1.17.2a Hydration and Editing Stability

Calculated variables must not be evaluated during:

- chat hydration / load
- macro-store mirroring

(nor during LLM prompting or UI rendering - neither of those is a trigger
listed above either). hydrateMacroStoreForChat() only ever mirrors whatever
value is already stored, calculated variables included - it never calls
evaluateCalculatedVariable()/recalculateDependents()/recalculateAllForChat().

Editing operations (preset editing, variable editing in the manager modal)
must not reseed other variables' stored values or reset defaultValue - that
is what 1.12's hydration-stability rule actually forbids: a sweeping,
careless reseed-to-default sweep triggered by an unrelated edit. They may
trigger calculated-variable re-evaluation (the "preset definition changes"
and "a dependency variable is renamed" triggers above) - that
re-evaluation reads already-stored dependency values through getVar() and
writes through setVar() like any other write, the same as a deterministic
increment or a prompted update would. It never reads or writes
defaultValue, and never reseeds any variable other than the calculated one
being evaluated. 1.12 and this section are therefore not in tension: 1.12
forbids reseeding-from-default on edit, and calculated-variable
re-evaluation is a different operation (deriving from current values) that
1.12 never mentions.

Per spec-clarification decision (2026-09-09): every write-path caller
(deterministic-engine.js, prompted-engine.js, ui-events.js,
preset-manager.js, initialization-engine.js, settings-panel-ui.js) calls
recalculateDependents()/recalculateAllForChat() itself, immediately after
its own setVar()/applyIncrement()/seedVariablesForChat() call.
calculated-engine.js is never called from inside chat-state.js's setVar/
applyIncrement - chat-state.js is the write-path module (1.6) and already
existed; having it call back into calculated-engine.js (which itself needs
setVar/getVar from chat-state.js) would be a circular trigger. Each caller
owning its own trigger avoids that, the same way deterministic-engine.js
already owns triggering applyIncrement on its own schedule.

1.17.3 Dependency Model and UI Rules

A calculated variable's dependencies may include other calculated variables
(chaining is explicitly allowed by spec-clarification decision, 2026-09-09)
- e.g. a "total_score" calculated variable may depend on a "danger_score"
calculated variable. calculated-engine.js topologically sorts every active
calculated variable so each is evaluated only after everything it depends
on. A dependency cycle (A depends on B depends on A) is detected and every
variable in the cycle is excluded from evaluation - treated as an
evaluation failure per 1.17.4, not a crash.

Manager-modal inline editor (ui-templates.js buildInlineVariableEditor,
ui-events.js): selecting type "calculated" replaces the default-value input
with a dependency checkbox list (every other variable in the same preset,
including other calculated variables) and an expression textarea, and hides
- entirely, not merely disables - the prompted toggle/section, the
increment toggle/section (already implied by canIncrement() excluding
"calculated"), the enum editor, and the typed-array editor, since none of
those are conditionally rendered for any type other than their own. Renaming
a dependency does NOT auto-rewrite other variables' dependencies/expression
text that reference the old name (spec-clarification decision, 2026-09-09)
- the rename simply triggers re-evaluation, which then fails to resolve the
now-missing identifier per 1.17.4 until the preset author manually updates
the expression.

Preset Manager: calculated variables may be renamed, deleted, and reordered
through the same generic preset-variable operations every other type
already uses (moveVariable, deleteVariable in
src/ui/manager-modal/preset-manager.js - no special-casing needed there).
They may not be manually edited (beyond dependencies/expression), toggled
prompted, or toggled increment - enforced by the editor never rendering
those controls for this type, plus an explicit
`behaviors = { prompted: false, increment: false }` force in the save
handler as a second line of defense.

Tracker (tracker-panel-ui.js): a calculated variable's row shows a
calculator-icon badge (title "Calculated variable (read-only, derived from
other variables)") before its label, and never shows the reset-to-default
button (already implied - that button only renders when
behaviors.increment is true, which a calculated variable's is never).

1.17.4 Failure Behavior

Per docs/TINY EXPRESSION DSL SPECIFICATION.md section 11.3 and this
instruction's own section 6: on any evaluation failure (an identifier not
in dependencies, a missing/null dependency value, a type mismatch, division
by zero, a syntax error, or a dependency-cycle member per 1.17.3), the
calculated variable's stored value is left untouched, a warning is logged
via console.warn, and nothing throws past evaluateExpression()'s own
boundary (expression-dsl.js) or evaluateCalculatedVariable()'s own boundary
(calculated-engine.js) - consistent with 1.7's error-handling rule.

1.17.4a Visible Evaluation Errors (2026-09-09)

calculated-engine.js now tracks each calculated variable's most recent
evaluation failure in-memory (lastEvaluationErrors, keyed by
"chatId::varName", never persisted - meaningless across a reload), cleared
on the next successful evaluation. getCalculatedVariableError(chatId,
varName) exposes it. Surfaced in two places, since a console-only warning
was not enough for the user to actually find and fix the problem:

- tracker-panel-ui.js: a calculated variable currently in a failed state
  gets a warning-triangle icon (tooltip = the error) next to its calculator
  badge, plus a full-width red banner row underneath it in the tracker
  list - not just a hover tooltip.
- ui-events.js's save handler: if saving a calculated variable's
  expression/dependencies results in a failed evaluation, the inline editor
  is NOT closed (hideInlineVariableEditor is skipped) and the error is
  shown inside the editor itself (.se-manager-calc-eval-error). The
  variable's preset definition, seeding, and recalculation attempt still
  happen normally - only closing the editor is withheld, so the user can
  fix the expression/dependencies and re-save without losing their place.

1.18 Variable Name Uniqueness (2026-09-09)

Root cause: variable *identity* within a preset is by id (genId()/
generateUUID() - already always unique, nothing to validate there), but
the isolated store (state.variables[name]) and the macro-store mirror
(context.variables.local/global, keyed by def.name) are both keyed by
*name*. Two variables sharing a name, even across two different presets
(active or not - an inactive preset can be activated later), silently
collide in both stores: whichever one seeds/writes most recently wins,
which looks like a variable randomly showing another preset's default
value. Confirmed against a real repro: a user-created "weather" variable
colliding with the built-in "Location and Time" starter preset's own
"weather" variable.

preset-manager.js's isVariableNameTaken(name, excludeVarId) checks every
preset (not just active ones, not just the current one) for another
variable with the same name. generateUniqueVariableName(baseName,
excludeVarId) appends/increments a numeric suffix ("_2", "_3", ...) until
unique. Both exposed through managerApi (manager-api.js) for the UI layer.

ui-events.js's save handler blocks a colliding name with a confirm()
dialog offering the auto-suffixed alternative (accept it, or cancel and
edit the name manually) - the same pattern already used for preset
rename/clone. A live, non-blocking warning (.se-manager-name-warning) also
appears under the name field as the user types, via the same
isVariableNameTaken() check - not the authoritative check, just early
feedback.

1.19 Variable Value Macros - {{identifier}} (2026-09-09)

SillyTavern's macro engine exposes context.registerMacro(key, valueOrFn,
description) / context.unregisterMacro(key) as a public, documented
extension point (verified against the real running instance's source,
public/scripts/st-context.js binding these to MacrosParser.registerMacro/
unregisterMacro; MacrosParser.registerMacro accepts a function as the
value, resolved live at substitution time - exactly how {{getvar::name}}'s
own handler already reads ctx.variables.local.get(name) live, per public/
scripts/macros/definitions/variable-macros.js). No pre-macro interception
is needed or implemented: SillyTavern's own {{...}} matching already
handles it once a key is registered.

macro-registration.js's refreshVariableMacros() registers {{name}} for
every variable in a preset currently active for the chat, each resolving
live via getMacroValue() at substitution time (so it always reflects the
current value with no re-registration needed on every write).
unregisterAllVariableMacros() removes everything this module registered.
Refreshed on CHAT_CREATED/CHAT_CHANGED (event-engine.js), engine enable/
disable (settings-panel-ui.js - unregistered entirely on disable, so
{{name}} does not silently keep resolving once the engine is off, matching
clearMacroVarsForChat's existing on-disable behavior per 3.2), and every
variable save/preset add-remove (ui-events.js, preset-manager.js).

Scoped to variables in currently-active presets only - a variable in an
inactive preset has no current value for this chat to macro-substitute, so
its {{name}} macro is not registered until that preset is activated.
Reserved-name protection is inherited from variable creation itself
(isReservedVariable already blocks creating a variable named after a known
SillyTavern built-in), not re-validated here.

1.20 Automatic Prompt Chunking (2026-09-18, rewritten 2026-09-22)

REWRITE, not a revision: the named-batch system this section originally
specified (every variable manually assigned to a "batch", the main update
reading only "core"/"time", an assignBatch/removeBatch/getBatch/getBatches/
batchPrompt API) is REMOVED entirely. Asked directly why, in plain language,
after noticing the built docs described it as settled: "I had suggested that
I wanted the variable prompts to 'batch' out the variables (in other words
chunking) to avoid overloading the context. I don't even know how it got
turned into what it became." The two designs solve visibly different
problems - one is automatic, size-driven splitting with nothing to
configure; the other is a manual, per-variable tagging system a user (or
extension) has to maintain by hand, with no relationship to how large a
prompt actually is - and the built one was explicitly not what was asked
for. See docs/API SPECIFICATION.md Section 9 (rewritten to match) and
src/api/batching.js / src/api/batch-rules.js (deleted).

What replaces it: every prompted/incrementable variable is now classified
with NO manual scoping at all - the main update reads every one across every
active preset for the chat (exactly the full pool "core" used to mean, with
no "time" special-case needed - see 1.21's own updated entry below), and an
independent preset reads every one in its OWN preset (replacing its former
"batch" config field with the preset's own membership, already a meaningful
scope that needs no separate field). When that pool would produce a single
LLM call too large for the model's context, it is automatically split into
several right-sized, SEQUENTIAL calls instead - never named, never assigned,
never configured per variable.

- src/core/prompt-chunking.js: chunkPromptUnits(units, maxChars) - the one
  pure, shared size-packing primitive. `units` is an array of
  { def, kind: 'update'|'increment', line, size }; `size` is whatever the
  caller measured (both current callers use their own rendered line's
  character length). Greedy first-fit-in-order: fills the current chunk
  until the NEXT unit would push it over budget, then starts a new one.
  Never reorders units and never drops one - a single unit larger than the
  whole budget still gets its own (oversized) chunk. Deliberately NOT the
  one place that also builds the prompt-line TEXT: prompted-engine.js and
  independent-presets.js keep their own separate, deliberately-duplicated
  line-rendering (per this codebase's existing "don't share classification/
  write logic between the two" convention - see independent-presets.js's own
  header comment), each building its own `units` array and handing it to
  this one shared packer.
- The budget: settings.maxPromptedVariableChars (settings-core.js), the
  character budget for ONE call's variable list. null means "not yet
  computed" - getSettings() backfills it via
  computeDefaultMaxPromptedVariableChars(context), which derives a default
  from SillyTavern's configured context size exactly the way
  computeDefaultMaxPromptHistoryMessages already does for chat-history
  length (context.maxContext, tokens, converted with a rough ~4 chars/token
  heuristic; only a THIRD of the window is budgeted to the variable list
  itself, since chat history/header/rules/the model's own response share the
  rest), clamped to [2000, 20000] characters so a tiny or huge context size
  still yields something usable. A user override, once set, is never
  recomputed.
- Main prompted update (prompted-engine.js): classifyPromptedVariables()
  (exported; the SAME update/increment/deterministic classification 1.20
  used to gate by batch, now gating on nothing but the variable's own
  behaviors) replaces selectBatchVariables() entirely - there is no batch
  filter of any kind left. chunkPromptedVariables() builds the units, chunks
  them, and runPromptedChunksSequentially() awaits each chunk's LLM call
  before starting the next (never in parallel, avoiding several concurrent
  background calls per message and keeping a predictable order). A chunk
  that fails (a network error, an unparseable response) is logged and
  contributes nothing to the totals, but never stops the remaining chunks
  from still running. The overwhelming common case - everything fits in one
  chunk - behaves byte-for-byte like the single-call flow always has: the
  exact same status text, no "part 1 of 1" framing; that framing
  ("Updating state (part N of M)…") only appears once chunking actually
  produces more than one chunk, alongside one combined final status covering
  every chunk's totals.
- Independent presets (src/api/independent-presets.js): the SAME chunking
  primitive, built from this file's own (deliberately still-separate) line
  format. `config.batch` is gone from CONFIG_FIELDS and
  getIndependentPresetStatus()'s returned shape; a run now reads
  `Object.values(preset.variables || {})` - every variable in the preset
  itself, unfiltered - instead of `selectBatchVariables(preset.variables,
  batch)`. A genuine, incidental improvement this consolidation surfaced:
  independent-presets.js's own classification never excluded image types
  the way prompted-engine.js's always has, so an image variable with
  behaviors.prompted somehow set (unreachable through the manager-modal UI,
  which always forces it off for image types, but reachable through the raw
  API) could previously have been asked about by an independent preset's
  run and never by the main one - independent-presets.js's classification is
  still its own separate copy (untouched, per the "don't share
  classification" convention above), so this asymmetry was not fixed here
  and remains a known, pre-existing gap, not something this pass closed.
- No effect on anything else: deterministic increments, calculated-variable
  evaluation, macros, and seeding are all untouched - chunking only ever
  changes how many LLM calls a prompted update's variable pool becomes, never
  which variables exist or how their values are written.
- Manager modal: the independent-preset editor's "Batch" text field is
  removed (src/ui/manager-modal/ui-templates.js), along with the status
  line's `batch "..."` fragment - there is nothing left to configure.

Tests: tests/prompt-chunking.test.js (the pure packer, plus
computeDefaultMaxPromptedVariableChars and getSettings()'s backfill of it),
tests/prompted-engine-chunking.test.js (the main update: single-chunk
fidelity, splitting, sequential ordering, per-chunk failure isolation,
interim/final status text, increment variables chunking alongside update
variables, the setting actually driving the split point), and a new describe
block in tests/api/independent-presets.test.js (preset-scoped selection, no
cross-preset leakage, the same chunking/isolation guarantees, including a
genuine gap this pass found and closed in its OWN tests: a partially-
successful multi-chunk run must report 'updated' with its real
changedVariables list, never 'skipped-parse-error', just because one OTHER
chunk among several failed - caught by mutation testing, not assumed).
Every rule was verified by deliberately breaking it and confirming the
suite catches the break (mutation testing) before being called done.

1.21 Datetime Variables (2026-09-18)

A datetime variable holds a real date and time. Its stored value is SCALAR
TIME - one number, in seconds - and a CALENDAR DEFINITION turns that number
into a year/month/day/hour/minute/second and back. Everything that only needs
a value (the isolated store, the macro mirror, the expression DSL,
comparisons) sees a plain number; only the increment path, the prompted-update
path and the UI ever look through the calendar.

Rules:

- type is "datetime". The stored value is a number of seconds. Scalar 0 is
  1970-01-01 00:00:00 in the (proleptic) Gregorian calendar; negative scalars
  are earlier dates.
- A datetime variable references its calendar by ID: `calendar` on the
  definition (blankDefinition() sets "gregorian"). `unit` is "seconds" (the
  only unit this engine stores). Both fields exist on every definition, and
  mean nothing for any other type. The default calendar is "gregorian".
- Calendar definitions live in settings.calendars (settings-core.js,
  DEFAULT_CALENDARS), keyed by id. getSettings() guarantees the "gregorian"
  entry exists, so the default reference can never dangle. A definition
  carries: id, label, unit, secondsPerMinute, minutesPerHour, hoursPerDay,
  months ([{ name, days, leap? }] - `leap` is that month's length in a leap
  year), leapYearRule.
- Calendar definitions describe HOW to convert scalar time to structured time.
  src/core/calendar-engine.js is the only module that does it:

    getCalendar(calendarId)                    -> settings.calendars[id] or null
    toStructured(calendarId, scalar)           -> { year, month, day, hour, minute, second }
    fromStructured(calendarId, structured)     -> scalar
    incrementScalar(calendarId, scalar, delta) -> scalar

  plus the helpers the rest of the extension needs to stay out of the
  arithmetic: parseDateTime (ISO text -> scalar), toScalar (number | numeric
  string | ISO text -> scalar, or null), formatScalar (scalar ->
  "2026-09-18 22:55:00", or null), isValidDelta, and resolveInstruction
  (natural-language instruction -> scalar, or null). Months and days in
  structured time are 1-based (ISO). fromStructured() rejects an impossible
  date (month 13, Feb 30, hour 24) rather than rolling it over.
- Increments. A datetime variable's `increment.delta` is a duration STRING:
  "1h", "1d", "1mo", "1y", or several ("1d 2h", "1y, 2mo and 3d"), with
  s/m/h/d/w/mo/y and their long forms; a bare number is seconds; a negative
  amount steps back. ("m" is minutes and "mo" is months.) Fixed units are
  exact seconds (1h = 3600, 1d = 86400). 1mo and 1y follow the calendar: a
  month is 28-31 days and a year 365 or 366, and the result keeps the
  day-of-month and time of day, clamped to the target month's length (Jan 31
  + 1mo = Feb 28, or Feb 29 in a leap year; Feb 29 + 1y = Feb 28). Months and
  years must be whole numbers. All of this is calendar.incrementScalar(); a
  datetime is NEVER incremented by numeric addition.
- Deterministic increments: runDeterministicIncrements() (deterministic-
  engine.js) checks the delta with isValidDelta() - an unparseable one is
  logged by variable name and skipped - then writes through applyIncrement()
  like every other type. applyIncrement() (chat-state.js) has the datetime
  branch that calls calendar.incrementScalar() on the stored scalar and writes
  the result. Deterministic and prompted increments share that single
  implementation on purpose (1.6: applyIncrement is the increment write path)
  rather than the deterministic engine doing the arithmetic a second time.
- Prompted increments and updates: the model answers a datetime variable in
  words or with a date, never in raw seconds. prompted-engine.js hands the
  answer to calendar.resolveInstruction(), which understands "advance 3
  hours", "move forward 1 day" (also skip ahead, add, ...), "rewind 2 days" /
  "go back 1 hour", "set time to 2026-09-18 22:00", and a bare date or number.
  Relative phrases go through calendar.incrementScalar(); absolute ones
  through calendar.fromStructured(). The result is written with setVar(). An
  answer that is not understood is skipped and logged, never written. A
  prompted INCREMENT (the boolean-conditional kind) simply calls
  applyIncrement(), i.e. incrementScalar() with the configured delta. The
  prompt shows the model the current value as "YYYY-MM-DD HH:MM:SS".
- No separate scope: a prompted or prompted-increment datetime variable is
  reachable by the main update on exactly the same terms as any other type
  (1.20, rewritten 2026-09-22 - there is no "batch" concept left at all for
  a datetime, or anything else, to belong to or be excluded from).
- Validation and coercion (variable-validation.js): validateValueStrict() and
  coerceValue() accept a finite number, a numeric string ("3600" - the
  tracker's text field supplies numbers as text) as that number, and an ISO
  date or date-time ("2026-09-18", "2026-09-18 22:00", "2026-09-18T22:00:05")
  converted through the variable's calendar. Everything else is rejected,
  including a date that does not exist. As with every type, the strict
  validator reports the error and returns the default; coerceValue() returns
  the default.
- Defaults: getDefaultValue() returns a numeric defaultValue as-is, converts
  an ISO string through the calendar, and otherwise returns 0.
- API (variable-api.js): createVariable() with type "datetime" requires the
  calendar to exist in settings.calendars, `unit` to be "seconds", and
  defaultValue to be convertible to scalar time; a violation warns and
  returns null with nothing written. The stored defaultValue is the converted
  scalar (an ISO default is converted once, at creation). updateVariable()
  applies the same rules to the merged definition.
- Type change: resetValueIfTypeChanged() (chat-state.js) normally resets a
  changed variable to its new type's default. When the new type is datetime
  it first tries to CONVERT the stored value (a number or ISO string becomes
  its scalar) and only falls back to the default when it cannot.
- Macros: the {{name}} macro and getvar carry the scalar, in seconds, like
  every other stored value; the calendar is not consulted for macros.
- DSL: the expression DSL sees a datetime as a number. There are no datetime
  operators or functions; `a - b` is a difference in seconds.
- UI: the tracker shows a datetime through calendar.toStructured() (via
  formatValueForDisplay), e.g. "2026-09-18 22:55:00". Editing it in the
  tracker takes an ISO date/date-time or a number of seconds; anything else
  is refused with a status message and NOTHING is written (unlike the other
  types, where bad input falls back to the default - resetting a clock to 1970
  on a typo would be a silent loss). The manager-modal inline editor shows the
  default as an ISO string and saves it as scalar seconds; it offers a "Date
  & time" type and an "Advance by" field for the delta. The editor has no
  unit field - the stored one is carried over on save. Since 1.22 it has a
  calendar selector while the type is datetime.

Fantasy calendars (bones only in 1.21, implemented in 1.22):

- Calendar definitions are pluggable objects: anything registered under
  settings.calendars with the fields above. The shape (months with their own
  lengths, leapYearRule, clock constants) is what a fantasy calendar fills in.
- 1.21 implemented ONLY "gregorian" and refused every other leapYearRule. That
  is superseded: see 1.22 for fantasy calendars, their editor UI and the
  calendar CRUD API. A leapYearRule the engine does not implement is still
  refused (throws), never converted with the wrong rules.

BUG FIX (2026-09-22): a real report - typing a date like "2026-09-22" (or
with a time) into the manager modal's default-value box was refused as "not
a date-time," with no visible reason. Root-caused by reproducing the exact
input, not assumed: the "-" had silently become a Unicode lookalike (a
non-breaking hyphen, U+2011, in the reported case - almost certainly
autocorrect/smart-typography somewhere upstream of the keystroke reaching
the browser) that ISO_DATETIME (calendar-engine.js) only ever matched as a
literal ASCII hyphen. Visually indistinguishable from "-" in essentially
every font, so a user has no way to notice before saving. Fixed in
toScalar() - the one root every real caller of date/time text already goes
through (the manager modal, prompted LLM answers, deltaSource jumps - 1.31,
World Info conditions, tracker editing) - by normalizing seven Unicode
dash/minus lookalikes (hyphen, non-breaking hyphen, figure dash, en dash,
em dash, horizontal bar, minus sign) to a plain "-" before parsing, rather
than patched separately in each caller. parseDateTime() itself is
deliberately left unchanged (still a strict ISO matcher); only toScalar,
the forgiving public entry point, normalizes. Confirmed while investigating:
a bare date with no time ("2026-09-22") already worked and always had -
the time portion of ISO_DATETIME was already optional; the user's separate
question ("does it have to be 00:00:01?") no - midnight (00:00:00) was
never special-cased or rejected either; the dash was the only actual cause.
Test: tests/datetime.test.js's "toScalar normalizes Unicode dash
lookalikes" - all seven lookalikes, date-only and date+time, the incidental
minus-sign benefit, and that parseDateTime itself is unaffected. Verified
by mutation testing (removing the normalization call) before calling it done.

BUG FIX (2026-09-22): a second real report, same shape as the one above -
a deltaSource string variable (1.31) prompted with natural phrasing like
"One Month" or "one day" never advanced the datetime it targeted, at all.
Root-caused by reproducing the exact reported input through the real
resolveInstruction()/applyDatetimeDeltaTriggers() path, not assumed:
DELTA_TOKEN (calendar-engine.js), the low-level duration-string tokenizer
every calendar delta already goes through, only ever accepted a literal
digit sequence (`\d+`) as an amount - a spelled-out number is letters, so
it never matched, and the delta silently failed to parse (console.warn'd
and discarded - both the datetime value and the source left untouched,
exactly like an unparseable delta always has) with no visible reason.
Fixed in parseDeltaFor() - normalizing spelled-out cardinal numbers (one
through nineteen, the tens twenty/thirty/.../ninety, simple compounds like
"twenty-five" or "twenty five", and "a"/"an" as 1) to digits before
DELTA_TOKEN ever runs, the same "normalize before the strict parser" shape
as the dash fix above, at the one root every duration-string caller
(deltaSource jumps, a legacy increment.delta "Advance by", independent-
preset interval/delay/repeat schedule values - 1.32) already shares.
Compounds are normalized before their own standalone words, so "twenty"
is never replaced out from under its own "-five" first; "a"/"an" only
ever match as complete words, so "and" (the delta list's own separator,
"1y, 2mo and 3d") and any longer word merely containing "a"/"an" (e.g.
"advance" itself) are never touched. Test: tests/datetime.test.js's
"accepts spelled-out cardinal numbers" (and two related tests confirming
"and"/"advance" survive, and that real gibberish is still rejected) plus
an end-to-end reproduction of the exact reported phrasing in
tests/calculated-datetime.test.js. Verified by mutation testing (removing
the normalization call, and reordering compound-vs-standalone matching,
and loosening the a/an word-boundary) before calling it done.

1.21.5 Calendar Formatting (2026-09-18)

- Datetime variables store scalar seconds. That does not change.
- Anything that shows a datetime to a person - the tracker, Pretty Panels,
  any external app - must call calendarEngine.format() to get the text. It is
  the ONLY official formatting mechanism; no consumer does its own date math
  or string-building from a scalar.
- The macro store continues to show scalar seconds ({{name}} and getvar are
  not formatted and not affected).
- calendarEngine.format(calendarId, scalarTime, options = {}) returns a
  string. options.style is "full" (default, "YYYY-MM-DD HH:mm:ss"), "date"
  ("YYYY-MM-DD"), "time" ("HH:mm:ss"), "month" (the calendar's month name),
  "year" (the year) or "custom", which needs options.pattern and supports the
  tokens YYYY, MM, DD, HH, mm, ss, MMM (short month name) and MMMM (full month
  name); other pattern characters are kept as written. options.locale is
  reserved and ignored.
- calendarEngine.formatPartial(calendarId, scalarTime, fields = []) returns
  an object holding only the requested fields (year, month, day, hour, minute,
  second) - month as its NAME, the rest as numbers: ["month", "day"] gives
  { month: "September", day: 18 }. It covers month-only, day-only, time-only
  and so on.
- Calendar definitions are readable through the API layer: getCalendarDefinitions,
  getCalendarDefinition, formatDateTime and formatDateTimePartial
  (docs/STATE ENGINE API SPECIFICATION.md, Section 10), backed by
  calendarEngine.listCalendars() and getCalendarDefinition().
- First pass (superseded by 1.22.2): only "gregorian" was formatted and any
  other calendar id threw "Formatting not implemented for this calendar".
  Fantasy calendars were to override formatting rules later - they now do
  (1.22.2); an id that is not defined throws "Unknown calendar".
- The tracker displays a datetime with calendarEngine.format(def.calendar,
  scalar, { style: "full" }). formatScalar() remains as a never-throws
  wrapper over format(...full) for display code that wants null on failure.

1.22 Fantasy Calendar Definitions (2026-09-19)

Second pass of the datetime system. 1.21 built the scalar-seconds model with
one implemented calendar; 1.22 makes calendars user- and API-definable, so a
datetime variable can run on a fantasy calendar. Everything in 1.21 still
holds - stored values are scalar seconds, only calendar-engine.js does date
math, Gregorian behavior is unchanged.

- Calendar definitions are global objects stored under settings.calendars,
  keyed by id.
- Each calendar definition has:
  - id (string; letters, digits, "-" and "_", starting with a letter/digit)
  - label (string)
  - unit ("seconds")
  - secondsPerMinute
  - minutesPerHour
  - hoursPerDay
  - months: [{ name, days }]  (Gregorian-rule calendars may add `leap`)
  - seasons: optional [{ name, startDay, endDay }]  (1-based day of the year,
    inclusive; a start after the end wraps the year end; seasons may not
    overlap; fixed-length-year calendars only)
  - cycles: optional [{ name, length }]  (a repeating period measured in DAYS)
  - leapYearRule: optional string - "gregorian", or "none"/absent
  - formattingRules: optional object
  - nlRules: optional object (natural language parsing rules)
  - version: a positive whole number. createCalendarDefinition() stores 1 and
    every update increments it.
- Two arithmetic models exist, chosen by leapYearRule. "gregorian" is the
  real Gregorian calendar (12 months, leap years, scalar 0 = 1970-01-01). A
  FANTASY calendar ("none"/absent) has fixed-length years - the sum of its
  months' days - and scalar 0 is year 1, month 1, day 1, 00:00:00. Any other
  leapYearRule is refused (validation, and at use). Fantasy leap rules are not
  implemented; a fixed-length year is the only fantasy model.
- Calendar definitions must be editable via API and UI.
- Variables reference calendars via def.calendar. The manager modal's
  datetime editor has a calendar selector (`data-field="calendar"`, filled
  from listCalendars()); its choice is validated (it must exist) and is
  carried over on save. The stored values are NOT converted when the calendar
  changes - the same seconds are simply read through the new calendar.
- Calendar definitions must be versioned and persisted. They live in the
  extension's settings blob and are saved on every create/update/delete.
- Calendar definitions must be validated before saving
  (validateCalendarDefinition(def) -> { valid, errors }): known fields only,
  positive whole clock constants, a non-empty list of uniquely named months
  with positive whole days, non-overlapping seasons inside the year, uniquely
  named cycles with a positive length, well-formed formattingRules and
  nlRules. A failing definition is refused and nothing is written.
- Calendar definitions must be accessible via API for external apps
  (docs/STATE ENGINE API SPECIFICATION.md, Section 11).
- The built-in "gregorian" calendar cannot be updated or deleted (it is what
  every datetime variable falls back to); it can be duplicated. A calendar
  that a datetime variable still uses cannot be deleted.

1.22.1 Calendar CRUD Rules

- createCalendarDefinition()
- updateCalendarDefinition()
- deleteCalendarDefinition()
- listCalendarDefinitions()
- getCalendarDefinition()
- assignCalendarToVariable() points a datetime variable at another calendar.
- The API functions are thin, identity-checked wrappers over calendar-engine.js
  (createCalendar, updateCalendar, deleteCalendar, listCalendars,
  getCalendarDefinition, validateCalendarDefinition).
- create refuses an invalid definition or an id already in use. update merges
  a patch onto the stored definition, re-validates the merged result, and
  increments `version`; the id cannot be patched, and a null patch value
  removes an optional field. Failures THROW (like the formatting API) so the
  caller gets the reason.
- The Calendars tab of the manager modal lists, creates, edits, deletes,
  duplicates, exports (JSON to the clipboard) and imports (pasted JSON; an
  id already in use is never overwritten - the import gets a free id)
  calendars, and generates random ones. Its editor covers label, the three
  clock constants, months, seasons, cycles, formattingRules and nlRules, and
  previews the DRAFT (a formatted date, an increment, a natural-language
  instruction) through the real engine before anything is saved
  (previewCalendarDefinition()).

1.22.2 Calendar Formatting Rules

- calendarEngine.format() must dispatch to calendar-specific formattingRules.
- Gregorian formatting remains default: its output, tokens and padding are
  exactly what 1.21.5 specified.
- Fantasy calendars may override:
  - month names (formattingRules.monthNames, else the month's own name)
  - season names (formattingRules.seasonNames, else the season's own name)
  - cycles (the first cycle's name and day are available as tokens)
  - custom patterns (formattingRules.patterns: style name -> pattern, which
    replaces a built-in style's default or adds a new named style)
  - formattingRules.era (the ERA token) and monthAbbreviationLength (MMM)
- Fantasy calendars add the pattern tokens D (day, unpadded), SEASON, CYCLE,
  CDAY (1-based day within the first cycle) and ERA to the 1.21.5 set; their
  YYYY is not zero-padded. Their default styles are full "MMMM D, YYYY
  HH:mm:ss", date "MMMM D, YYYY", time "HH:mm:ss", month "MMMM".
- formatPartial() also accepts "season", "cycle" and "cycleDay" (null when the
  calendar has none).
- The tracker displays a datetime through calendarEngine.format(def.calendar,
  scalar, { style: "full" }); for a calendar with seasons or cycles it adds a
  second line, e.g. "Deepfrost · Silver Moon day 5". Its edit box starts with
  the numeric ISO form, which every calendar can read back. The prompted
  update shows the model calendarEngine.format()'s text.
- format() throws "Unknown calendar" for an id that is not defined; a stored
  definition it cannot convert with (unsupported leapYearRule, a "gregorian"
  rule without the twelve Gregorian months) throws too.

1.22.3 Calendar Increment Rules

- calendarEngine.incrementScalar() must dispatch to calendar-specific month
  lengths, year lengths, cycles.
- Units: everything in 1.21 ("1s", "1h", "1d", "1w", "1mo", "1y") plus
  "1season" and "1cycle". "1mo"/"1y" follow the calendar's own months (a
  fantasy year is its months' total); the clamp rule is unchanged (day 30 of a
  30-day month + 1mo into a 20-day month lands on day 20).
- "1cycle" is the first cycle's length in days (an exact, fixed step).
- "1season" keeps the position within the season - the same number of days
  into the next season, and the same time of day - clamped to the target
  season's length, the season analogue of the month rule. It counts whole
  seasons only, follows the order of the seasons by startDay and rolls into the
  next year after the last. A date outside every season cannot be stepped by
  season (an error; nothing is written).
- "1season" on a calendar without seasons, and "1cycle" on one without cycles,
  are invalid deltas: isValidDelta() is false, so a deterministic increment
  skips the variable with a warning (deterministic-engine.js needs no
  calendar-specific code - it asks the calendar).
- A calendar's nlRules.unitAliases add unit words ("moon = cycle",
  "tenday = day * 10") to the delta grammar as well as to natural language.

1.22.4 Calendar Natural Language Rules

- calendarEngine.resolveInstruction() must dispatch to calendar-specific
  nlRules.
- Understood for every calendar: everything in 1.21 ("advance 3 hours",
  "rewind 2 days", "set time to 2026-09-18 22:00", a bare date or number) plus
  "advance 1 season", "next cycle" / "next month" (also "following"),
  "previous season" (also "prior", "last"), and "move to Stormfall 17" /
  "set to the 17th of Stormfall" / a bare "Stormfall 17". A month-and-day
  target keeps the CURRENT year unless one is written ("Stormfall 17, 1203")
  and the time of day is 00:00:00 unless one is written ("... at 14:30"); a
  calendar's own written full date ("Stormfall 17, 1203 12:00:00") reads back
  exactly (toScalar() accepts it, year required).
- nlRules (all optional): unitAliases { word: unit | { unit, multiplier } },
  advanceVerbs, rewindVerbs, setVerbs (extra phrases, e.g. "let time pass").
- The prompted engine needs no calendar-specific code: it already calls
  resolveInstruction(def.calendar, ...), so a variable's own calendar's nlRules
  apply. An answer it does not understand is skipped, never guessed.

1.22.5 Random Calendar Generator

- generateRandomCalendarDefinition() must produce a valid calendar definition.
- options: seed (number or string - the same seed always gives the same
  calendar), id, label, monthCount (3-24), seasonCount (0-7), includeCycle.
  The result is validated before it is returned and is NOT stored; pass it to
  createCalendarDefinition() to keep it. The Calendars tab's "Random" button
  opens one in the editor unsaved.

1.22.6 Preset cloning

- Cloning a preset preserves each variable's `calendar` (and `unit`) - a
  cloned datetime variable reads its seconds through the same calendar.

1.22.7 Built-in Fantasy Calendars (2026-09-19)

- settings-core.js DEFAULT_CALENDARS holds four built-in calendars: "gregorian"
  and three fantasy ones - "faerun_inspired" (12 x 30 days, 5 seasons, cycles
  Lunar 28 / Astral 60), "three_moons" (10 x 36 days, cycles Red Moon 18 /
  Blue Moon 24 / White Moon 30, no seasons) and "solar_cycle" (100x100x30
  clock, 6 x 50 days, 4 seasons of 75 days, no cycles). getSettings() copies
  any that is missing into settings.calendars (an existing entry is left
  alone). BUILTIN_CALENDAR_IDS lists them.
- Built-ins cannot be updated or deleted (API and UI); they can be duplicated
  and the duplicate is an ordinary editable calendar. They appear in the
  Calendars tab (marked "built in", no Edit/Delete button) and in the variable
  editor's calendar dropdown. A datetime variable whose calendar is missing
  gets a warning and a "(missing)" option in that dropdown, and the save is
  refused until another calendar is chosen.
- Seeds use the 1.22 schema: season days are 1-based; formattingRules.patterns
  holds full/date/time. A pattern containing "{" is a brace template:
  {monthName} {month} {day} {year} {HH} {mm} {ss} {season} {dayOfSeason}
  {era} {cycle} and {cycle:<name>} (the day in the cycle whose name is, or
  starts with, <name>; "{cycle:red}" = Red Moon). Unknown placeholders are
  left as written.
- nlRules may also hold phrase lists: nextSeason, nextCycle, moveToDay,
  moveToSeason, and next<CycleName> (nextRedMoon...). nextSeason/nextCycle
  are exact phrases (one season / the first cycle); next<CycleName> advances
  that cycle's length in days; moveToSeason "<phrase> <season>" goes to
  midnight on that season's first day this year; moveToDay "<phrase> <month>
  <day>" behaves as "move to".

1.23 Conditional World Info, Lorebook Bindings and Bundles (2026-09-19)

Conditional World Info (docs/WORLD_INFO_INTEGRATION.md) hides a lorebook entry
unless its conditions on State Engine variables hold. This section records
what runs and the additions built on it.

- Persistence: setWICondition, updateWICondition, deleteWICondition and
  clearWIConditionsForEntry call persistSettings() when they change something.
- Entry keys are "<world>.<uid>", the world being normalizeWorldName(entry):
  entry.world, else entry.book, else entry.folder, else "default". Conditions
  stored under the old fallback world "unknown" still apply to a world-less
  entry (looked up, edited and deleted through the old key; nothing is
  migrated on disk).
- FILTERING RUNS ON WORLDINFO_ENTRIES_LOADED (wi-filtering.js
  filterLoadedWorldInfo, registered in event-engine.js). It fires before
  SillyTavern's scan with { globalLore, characterLore, chatLore, personaLore }
  arrays that ST reads afterwards, and entries are removed from them in place.
  The previous hook could not filter and is no longer registered:
  getWorldInfoPrompt() is async (its result was a Promise, so
  `.outletEntries` was always undefined), calling it is a full activation scan
  that re-emits WORLD_INFO_ACTIVATED, and WORLD_INFO_ACTIVATED itself fires
  after activation with a copy of the entries. (Verified against SillyTavern
  1.18: world-info.js, events.js, st-context.js.)
- Fail-open: a condition whose variable is not defined in any active preset of
  the chat is treated as met. Operator evaluation (evaluateCondition) is
  unchanged.
- Lorebook -> preset bindings: settings.lorebookPresetBindings =
  { [worldName]: { [lorebookId]: [presetId] } }, managed by
  src/core/lorebook-bindings.js (getPresetsForLorebook, bindPresetToLorebook,
  unbindPresetFromLorebook, getLorebookBindings). In ST a lorebook is its book
  name, which is also every entry's `world`, so worldName and lorebookId are the
  same string for a real lorebook (lorebookId defaults to the world). Bind and
  unbind persist; reads do not. A deleted preset is skipped on read.
- Auto-activation: on CHAT_CHANGED, offerLorebookPresets(chatId)
  (initialization-engine.js) looks at the lorebooks attached to the chat (the
  chat's, the character's or each group member's, and the globally selected
  ones) and, per lorebook with bound presets that are not active, asks "This
  lorebook requires presets X, Y. Activate them?". Yes -> addPresetToChat.
  No -> nothing is activated and the choice is remembered per chat
  (settings.lorebookPresetDeclines) so the question is not repeated on every
  chat load; the lorebook's conditions on the missing variables are then met
  (fail-open, above).
- Tester round 1 (2026-09-21): (1) a condition on a DATETIME variable is written
  as a date ("2022-05-11 00:00:00", the same form as the variable's default; the
  editor labels the box "Date" and refuses text the variable's calendar cannot
  read) and converted to seconds through that variable's calendar when it is
  evaluated (equals / not equals / greater / less / >= / <=); plain seconds still
  work. Reason: nothing in the visible UI shows a variable's stored seconds, so
  asking for them was unusable. (2) evaluateCondition finds the variable by id OR
  name (before, a name-keyed condition read a stand-in string variable).
  (3) getActiveLorebookNames() now includes a character's ADDITIONAL lorebooks
  (SillyTavern's world_info.charLore, read through a background import of
  world-info.js; unavailable = not seen), and the lorebook-preset offer is asked
  again after a new chat's start-choice (CHAT_CREATED), where it only asks about
  presets still missing and not declined. (4) There is no global scope in the UI:
  WIF-TY-11 removed from the test plan.
- Object arrays and World Info (2026-09-21, replaces the earlier "disabled with a note"
  behaviour): an array whose items are objects is left OUT of the condition editor's
  variable list (getAvailableVariablesForConditions, wi-conditions.js), because there
  is no field to compare. This is a World Info restriction only: object arrays stay
  fully supported in State Engine, storage and the API. evaluateCondition() treats a
  stored condition on one as met with a console warning, so old or hand-edited data
  never breaks filtering (entryConditionsMet therefore fails open for it). The
  manager's variable editor notes it on the Object item type. WI conditions are
  primitive-only.
- Object arrays are created through the API only (2026-09-21). The manager modal is
  for narrative-facing variables: its Item type dropdown no longer offers "Object".
  It is listed (as "Object (created through the API)") only while editing a variable
  that already is an object array, so opening one does not silently change its type;
  once switched away it cannot be switched back in that editor. On save,
  protectObjectArray() (variable-ui-schema.js) turns any object array that was not
  one before into item type "any", and for one that already was, keeps its
  itemSchema and default items - the editor has no object item editor and would
  otherwise replace them with empty {} placeholders. Nothing in the core, the API,
  array operations, sanitizing or schema validation changed; API-created object
  arrays load and work as before.
- Preset export/import (src/core/preset-export.js): exportPreset(presetId) is a
  deep copy; importPreset(data) always creates a NEW preset (never overwrites),
  with a fresh id, a unique display name, fresh variable ids and variable names
  unique across all presets (the name-keyed stores require it), calculated
  variables re-pointed at renamed siblings, and a namespace this install does
  not know moved into "se" (swapping the "<ns>__" name prefix). The manager
  modal's Presets tab has an Import button and each preset an Export button
  (JSON files).
- Lorebook bundles (src/core/lorebook-bundle.js): { lorebook, lorebookName,
  stateEngine: { presets, wiConditions, lorebookPresetBindings } }.
  exportLorebookBundle(world, lorebookId) loads the lorebook, collects the
  conditions whose keys start with "<world>.", the bound presets and the
  binding. importLorebookBundle(bundle, { name }) saves the lorebook into ST
  (asking before overwriting one of the same name), imports the presets (an
  identical preset - same name and variable names - is reused, so importing
  twice does not pile up copies), re-keys the conditions to the imported name
  and re-points their variables at the imported ones, merges conditions and
  bindings, and offers to activate the presets for the open chat.
- window.StateEngineWI exposes getWIConditions, setWICondition,
  deleteWICondition, shouldDisplayWIEntry, getPresetsForLorebook,
  bindPresetToLorebook, unbindPresetFromLorebook, exportPreset, importPreset,
  exportLorebookBundle and importLorebookBundle.
- Settings panel (settings.html): a "Lorebook Preset Bindings" section - a
  lorebook dropdown, a preset list with checkboxes, Bind / Unbind, and bundle
  Export / Import.

1.24 Notification Core (2026-09-21)

A single notification surface for every extension (API: docs/STATE ENGINE API
SPECIFICATION.md Section 12).

- Registry: settings.notifications is a list of { id, source, severity, message,
  timestamp, callbackId }, persisted with the settings and repaired on load
  (settings-core.js drops anything that is not an object with an id and a
  message). It never holds a function: a notification only NAMES its callback.
- Callback registry: src/core/notification-core.js keeps an in-memory Map of
  "<namespace>::<callbackId>" -> function. It is rebuilt every page load by each
  extension registering again, so after a reload a stored notification is listed
  but cannot run its action until its extension has registered the callback.
- Ids are "<source namespace>::<key>"; source is the caller's namespace, taken
  from its verified identity. Notifying again with the same id replaces that
  notification (fresh timestamp, moved to the end).
- Nothing expires. A notification is removed when the user clicks it AFTER its
  callback succeeded, when the user dismisses it (x), or when its extension
  clears it. A callback that is missing or throws leaves the notification in
  place and the panel shows the reason on it; a double click cannot run an
  action twice.
- UI (src/ui/notification-ui.js): one bell button appended to SillyTavern's send
  bar (#leftSendForm, beside the wand) - grey (dimmed) with no badge when there
  are none, highlighted with a count badge ("99+" above 99) when there are. It
  is restored on CHAT_CHANGED in case SillyTavern rebuilt the bar. Clicking it
  toggles a panel (newest first: severity icon, message, source and age, and an
  x); Escape or a click elsewhere closes it; it redraws live while open and stays
  open, showing "No notifications.", after the last one is gone. Rows are also
  operable from the keyboard (Enter / Space). All stored text is escaped.
- Deliberately not included yet: visibility toggles, Pretty Panels integration,
  auto-expiry.

1.25 Extension Update Notification (2026-09-21)

State Engine posts ONE notification through the Notification Core (1.24) when any
installed extension has an update available. Code: src/events/extension-updates.js.

- Data source: the same endpoints the extension manager uses (verified against
  SillyTavern 1.18): GET /api/extensions/discover for the list and POST
  /api/extensions/version { extensionName, global } per third-party extension;
  isUpToDate === false means outdated. Only ENABLED extensions are checked:
  ids in extension_settings.disabledExtensions ("third-party/Name", the names
  discover returns) are skipped, as SillyTavern's own startup check skips them - a
  disabled extension is not running, so its update is not worth nagging about, and
  skipping it saves a request each. Enabling one includes it in the next check; a
  notification caused only by an extension that has since been disabled is cleared
  by the next check. The endpoint runs "git fetch origin"
  itself; State Engine never touches git and never updates anything (no
  auto-update).
- The notification: source "se" (State Engine's built-in namespace), severity
  "warning", message "One or more extensions have updates available.", key
  "extension-updates" (stored id "se::extension-updates"), callback
  "open-extension-manager". Several outdated extensions still make one
  notification. Posting again with the same key REPLACES it, so it never
  duplicates. Nothing is posted when nothing is outdated, and a leftover one is
  cleared when a later check finds everything current.
- A check that cannot answer (list unreadable, every version request failed) leaves
  the notification exactly as it was. One extension failing to answer is ignored,
  never counted as outdated. At most 5 version checks run at once (as SillyTavern
  does); overlapping triggers share one run.
- Clicking it runs the callback - it clicks SillyTavern's "Manage extensions"
  button (#extensions_details) - and, once that succeeds, the notification is
  removed (1.24). The manager then checks every extension itself and shows an
  Update button on each outdated one. It cannot open a filtered "updates only"
  view because SillyTavern's manager has none. If the button is missing the
  notification stays and says why.
- When it runs (never on a timer, never per message): once per page load
  (startup, from index.js); when the extension manager draws its list
  (SillyTavern re-draws it after every extension update and emits no event, so a
  MutationObserver watches for the popup - a <dialog> containing .extensions_info
  - and checks after 1 second); and after State Engine itself is updated, through
  SillyTavern's manifest hook (manifest.json "hooks": { "update":
  "onStateEngineUpdate" }, exported from index.js; it starts the check without
  waiting, since hooks get 5 seconds).
- Deliberate differences from the request: severity is "warning" (the Notification
  Core's name for it; "warn" is rejected), and the source is "se" - the source is
  the caller's verified namespace, and a namespace name cannot contain an
  underscore, so "state_engine" is not possible.

1.26 Image Variables (2026-09-21)

Three variable types that store REFERENCES to images for UI, display logic and
extension back ends. Code: src/core/image-variables.js (pure rules),
src/ui/image-preview.js (safe thumbnails).

- Types and storage: "image" - a string; "imageList" - an ordered array of strings;
  "imageMap" - an object of string keys to string values. A reference is a URL, an
  asset path, a resource id or a base64 data URL. No image data is stored and nothing
  is ever fetched, prefetched or validated: an <img> is created only when a thumbnail
  is drawn on screen (lazily), and the enlarged hover copy only on hover.
- Validation (variable-validation.js, checkImageValue): image must be a string;
  imageList an array of strings; imageMap an object whose values are strings (a JSON
  string is parsed for the list and the map). A wrong shape is refused - default value
  used, error reported. What setVar stores (sanitizeImageValue) is kept to strings so
  one bad item does not wipe a whole list (non-string list items / map values are
  dropped), exactly as array items are filtered. Defaults are '' / [] / {}.
- Serialization: all three are plain JSON and round-trip through presets. A blank
  definition gains currentKeyVariable ('').
- Not for narrative logic: image variables never appear in World Info conditions
  (getAvailableVariablesForConditions leaves them out; a stored condition on one is
  treated as met, with a console warning) and the prompted LLM update never asks for
  their value, even if marked prompted. A prompted INCREMENT on an image list is still
  possible (explicit rotation).
- Computed variables: an image behaves like a string, an image list like an array
  (.length, .contains(), [n]) and an image map like an object. The expression
  language gained lookups, target[index] (DSL spec 6.4): an array by whole number,
  an object by key (a string, or a number/boolean read as its text) it owns, e.g.
  portraits[currentEmotion]. A missing index or key is an error (the variable keeps its
  previous value) - never a guessed default. A lookup must produce a number, string or
  boolean.
- Rotation: only an imageList rotates (increment behavior). Operations rotateNext
  (first image to the end) and rotate (last image to the front); the first element is
  the active image, so rotating changes it. An image and an imageMap cannot be
  incremented (createVariable/updateVariable and the modal refuse it; applyIncrement
  leaves the value alone). Nothing rotates unless an extension, a computed variable
  or the user's configured increment does it.
- Which image the tracker shows: image - its value; imageList - the first element;
  imageMap - the image under the CURRENT KEY. The key is the resolved value of the
  variable named in def.currentKeyVariable, read as a string: a string or enum as is,
  a number or boolean (a calculated result) as its text, an array's current value
  (its first element) as its text. A key that is not in the map, no current-key
  variable, or a variable that is not active -> a neutral placeholder. There is no
  default or fallback key. Only the map's own keys count.
- Manager modal: the type dropdown has Image, Image list and Image map. image - a text
  input with a thumbnail preview; imageList - the array editor with a thumbnail per row,
  drag-grip plus up/down buttons to reorder, add/remove; imageMap - a key / reference
  table with a thumbnail per row, add/remove, and a "Current key comes from variable"
  choice (any other variable in the preset except another image map). A repeated or
  missing key is refused on save. Image variables have no prompted behavior; only an
  image list has increment (rotation). Switching the type to or from an image type
  starts the default blank. No World Info condition editing anywhere in it. (The
  editor's explanation text is now HTML-escaped - it was not, for any type.)
- Tracker: a thumbnail of the one active image (hover or focus to enlarge), or the
  placeholder; never the whole list or map; no editing from the tracker. Values are
  read from the isolated store, because SillyTavern's variable store would turn a
  numeric-looking reference ("12345") into a number. The tracker redraws as soon as a
  deterministic increment changes something (2026-09-21 fix: it used to stay stale until
  something else redrew it, because only the prompted update redrew it and only when it
  had prompted variables): runDeterministicIncrements() returns how many variables it
  incremented and the user/AI message handlers call refreshPanelIfOpen() when that is
  more than 0 - not on every message, so a tracker edit in progress is not wiped. This
  covers an image list rotating, a counter, and a key variable that feeds an image map.
- Previews are safe: a reference becomes an <img src> only if it is an http(s) URL, a
  data:image/... URL or a path (contains "/" or ends in an image extension) with no
  other URL scheme; javascript:, data:text/html, bare resource ids and anything else
  show the placeholder with the reference as escaped text. Every attribute is
  escaped, images carry referrerpolicy="no-referrer", and a broken image becomes the
  placeholder.
- API: createVariable / updateVariable accept the three types with no new functions.
  The default must be valid for the type (normalized on store; the blank definition's
  numeric default is replaced by the empty value when none is given, and a variable that
  becomes an image type starts empty); currentKeyVariable must be a string; increment
  behavior on an image or an imageMap is refused. {{name}} for an image map gives its
  JSON.
- Decisions to confirm (not specified): the image map's key variable is a NAME field
  (currentKeyVariable), not a fixed key, because a portrait map is only useful when the
  key follows a variable such as an emotion; an array key variable uses its FIRST
  element; a reference with no scheme is treated as a path only if it contains "/" or
  ends in an image extension.

1.27 Portable Image Import (drag and drop) (2026-09-21)

Image files can be dragged into an image, imageList or imageMap editor in the manager
modal. Code: src/core/image-import.js (rules, upload, export/import of the files),
the drop handlers in src/ui/manager-modal/ui-events.js. No change to the image
variable rules (1.26), the expression language or the tracker.

- Core rule: what a drop stores is ALWAYS a portable, reload-safe relative path -
  never an absolute OS path, a blob: URL, another temporary browser URL or a data:
  URL - and it is escaped wherever it is drawn.
- Where the copy goes - a deliberate difference from the request: NOT
  SillyTavern/public/state-engine-images/. A browser extension cannot write into
  public/, and a browser never reveals where a dropped file lives, so "is it already
  inside public/?" cannot be asked (a dropped File carries a name, not a path). What
  SillyTavern does provide is POST /api/images/upload (the route other extensions,
  e.g. Doom's Enhancement Suite, use), which writes into the user's image folder and
  serves the file at a relative path. State Engine's folder is
  data/<user>/user/images/state-engine-images/ and the stored reference is
  user/images/state-engine-images/<file> - one relative path, the same on every
  install, valid for every chat and after any reload. Every dropped file is copied
  there; nothing is stored from where it came from.
- The pipeline: (1) each file is checked - refused if it is not an image (MIME type),
  SVG (an SVG opened directly can run scripts), empty, over 20 MB, or if its first
  bytes are not really PNG / JPEG / GIF / WEBP / BMP (the bytes decide, not the name;
  a JPEG named .png is saved as .jpg); (2) the base name is kept as far as possible
  (letters, digits, space, _ and -; dots are replaced, because SillyTavern would read
  them as an extension); (3) a name already in the folder gets a numeric suffix
  (name-1.png, name-2.png...) - the server overwrites silently, so the folder is listed
  first, and a timestamp is used if it cannot be listed; (4) the file is uploaded and
  the server's answer must be a path inside the folder, otherwise nothing is stored (the
  real server answers WITH a leading slash - "/user/images/state-engine-images/a.png",
  checked against a live SillyTavern - and the stored form drops it); (5) the preview updates at once from the new relative path.
- Editor behavior: image - the reference is replaced (extra files are ignored with a
  warning); imageList - each file appends a row; imageMap - dropped on a row it
  updates that row's reference (its key is kept; further files become new rows), dropped
  anywhere else it adds a row with an empty key (which must be filled in before saving).
  The editor is highlighted while a file is dragged over it (the row under the pointer
  too, in a map); "Image imported" (or "N images imported") is shown as a toast,
  errors per file; previews have hover-to-enlarge like every image variable. The
  browser is always stopped from opening a dropped file, in any editor. SillyTavern has
  its own page-wide drop handler that imports ANY dropped file as a character card, so a file
  dragged over the modal is stopped from reaching it: editors handle their own, and a file
  dropped anywhere else in the modal is swallowed with a hint ("To import an image, open an
  Image, Image list or Image map variable and drop the file on its editor").
- Saving refuses a typed or pasted reference that is not portable: a blob: URL, or a
  path on this computer (file:, C:\..., \\server\..., /Users/..., /home/...), with a
  message pointing at drag-and-drop. http(s) URLs, relative paths and data: URLs typed by
  hand are still allowed (1.26); only the drop pipeline never produces them.
- Export / import: exporting a preset (manager modal, and each preset of a lorebook
  bundle) embeds the image files its image variables reference in State Engine's folder,
  as stateEngineImages: { "<file name>": "<base64>" } - only files actually referenced,
  each verified to be a real image; one that cannot be read is reported and left as a
  reference. A preset with no such images exports exactly as before. Importing puts the
  files back into the same folder first: a free name is used as is, a name held by an
  IDENTICAL file is reused (no duplicates on re-import), a name held by a DIFFERENT file gets
  a numeric suffix and the preset's references are rewritten to match (arrays, objects and
  JSON-text defaults keep their shape). Embedded entries with an unsafe name or bytes that are
  not an image are refused and reported. The pictures are never stored in settings (a plain
  synchronous import discards stateEngineImages). References to anything outside the folder
  (URLs, other paths) are left alone.
- Not handled: a dropped file cannot be matched to a file already in public/ or
  elsewhere, so it is always copied; images are not deleted when a variable or preset is
  removed (they stay in the folder); a shared preset without its embedded files keeps
  its paths, which show the placeholder until the files exist.

1.28 Boolean "Flag Mode" (write-once booleans) (2026-09-21)

An optional property on boolean variables, def.flagMode (default false, blankDefinition()).
No new variable type. Code: variable-schema.js (schema + forced-false default),
chat-state.js (the enforcement - setVar/applyIncrement, the ONE write path every
caller shares), prompted-engine.js + independent-presets.js (leaving a fired flag
out of the prompt), tracker-panel-ui.js (the one authorized manual reset path),
variable-api.js (createVariable/updateVariable validation).

- flagMode is only meaningful for type "boolean"; present on any other type it is
  simply inert (every runtime check gates on type === 'boolean' too), the same
  tolerance itemType gets on a non-array definition.
- Starts false: getDefaultValue() forces a flag-mode boolean's default to false
  UNCONDITIONALLY, ignoring whatever defaultValue says - the API layer
  (createVariable/updateVariable) also normalizes the STORED defaultValue field to
  false whenever type is boolean and flagMode is true (not just when no default was
  given), so the definition never shows a "true" default it will never actually use.
- The rule, enforced in chat-state.js's setVar()/applyIncrement() (never anywhere
  else - every write path funnels through them): once the stored value is true, an
  AUTOMATIC write (prompted update, prompted/deterministic increment toggle, seeding,
  new-chat continuation, a future extension value-write API) that would flip it back
  to false is silently refused (a console warning names the variable) and the value
  stays true. A write attempting true, or any write while the value is not yet true,
  is never affected - "starts false, becomes true, stays true" is the whole rule.
  setVar() takes a new options.manual flag (default false); applyIncrement() is
  never called manually (only the two prompted/deterministic engines call it) so it
  has no such flag - its boolean branch just unconditionally refuses to flip a
  true flag back off.
- Deviation from "except manually in the manager modal": the manager modal's own
  inline editor only ever edits DEFINITIONS (name/type/behaviors/...), never a
  variable's runtime VALUE - there is no value-edit surface there at all, confirmed
  by reading every setVar/getVar call site in src/ui/manager-modal/*.js (none). The
  ONE place in the running UI that edits a variable's stored value is the
  tracker panel's edit pencil (and its "Reset to default" button, shown when
  increment is on) - tracker-panel-ui.js's own header comment already calls this
  "the runtime state edit surface". Both call setVar with { manual: true }, and
  isStaticVariable() is given one exception: a flag-mode boolean is ALWAYS offered
  the edit pencil, even when it is also prompted and/or incremented (the normal
  case - a flag that only an LLM or an engine ever sets true would otherwise have
  no way to be manually reset at all, since isStaticVariable ordinarily hides the
  pencil whenever prompted/increment owns the value). An ordinary (non-flag)
  prompted/incremented boolean keeps the old behavior - no pencil.
- "Extensions may set true but may not set false unless explicitly allowed by the
  user": there is currently no API function for an extension to write a variable's
  runtime VALUE at all (only its definition, and updateVariable already refuses
  patch.value); the write-path gate lives at the shared choke point (setVar/
  applyIncrement) specifically so this rule applies automatically to such an API
  the moment one exists, with zero further changes needed.
- Prompted updates: a flag-mode boolean that is already true is left out of BOTH
  prompt categories entirely (updateVars and incrementVars) in prompted-engine.js
  AND independent-presets.js's own duplicated classification (Section 6 of the
  API doc already documents that duplication) - not merely write-blocked but never
  asked about again, since the answer can no longer change anything and re-asking
  wastes tokens / could read as an invitation to "turn it back off". A still-false
  flag's prompt line uses a one-way-flag wording (describeConstraint,
  formatting-utils.js) telling the model to only ever answer true.
- World Info conditions (is_true/is_false) and the expression language treat a
  flag-mode boolean exactly like any other boolean - flagMode is a write-path-only
  concept neither of them is even aware of. The tracker displays it normally (no
  badge); it is otherwise an ordinary boolean row, editable through the exception
  above.
- Export/import: flagMode is a plain definition field with no special handling
  needed - exportPreset/importPresetDetailed already clone every field of a
  definition untouched, so it round-trips like any other (itemType,
  currentKeyVariable, ...).
- Manager modal editor: a boolean-type editor gains a "Flag mode (write-once)"
  checkbox (data-field="flagMode", picked up by the existing generic field
  collector - no new event wiring needed) with the requested explanatory text;
  describeVariable()'s explanation box and the increment description both note a
  flag's one-way nature when it is set.

1.29 Independent Presets (2026-09-21)

Formalizes "independent preset" (a preset whose prompted update runs on its own
call, `runIndependentPreset`, instead of the per-message trigger flow) with a
first-class flag, per-preset enabled/disabled, variable scoping, the
independent-context modes, and run status. Code: src/api/independent-presets.js.
Full design, every deviation from the request, and what is deferred:
docs/STATE ENGINE API SPECIFICATION.md Section 13.

- preset.independentPreset (boolean, default false) - a plain flag, not a
  parallel storage system; a preset already has everything one needs.
- preset.independentConfig gains enabled (false suspends every execution
  path, checked before the concurrency lock). It originally also gained
  `batch` (which named batch - 1.20's ORIGINAL design - this preset's run
  selected from); 1.20's 2026-09-22 rewrite removed batching entirely, and
  with it this field - a run now always operates on EVERY prompted/
  incrementable variable in the preset itself, with nothing to configure.
- Independent context (context: any | undefined, request Section 3): three
  modes derived from whether/how updateIndependentPresetContext() was called -
  never called -> chat-history (the existing transcript, unchanged); called
  with null/undefined/{} -> empty (no context section, purely variables);
  called with anything else -> extension-provided, passed through to the
  prompt UNTOUCHED (never interpreted, validated or mutated). Modes A/C do
  not read or require SillyTavern's chat array at all.
- CRUD (createIndependentPreset/updateIndependentPreset/
  deleteIndependentPreset/listIndependentPresets/toggleIndependentPreset) all
  require preset.independentPreset === true and compose preset-api.js's
  existing, already-tested preset CRUD - never a second implementation.
  getIndependentPresetStatus() (open read) reports enabled/contextMode/
  lastRunAt/lastOutcome/lastError/changedVariables, written on every exit path
  of runIndependentPreset (including early refusals), not just a successful run.
- Deviation: runIndependentPreset itself is NOT gated on independentPreset -
  it is the same dispatcher any preset has been runnable through since
  2026-09-10; gating it now would break that already-tested behavior. "Cannot
  modify other presets" is enforced as scope (a run only touches its own
  preset), not as a type restriction on which presets this function accepts.
- Export/import: independentPreset/independentConfig (including context) are
  plain fields and round-trip with zero extra code; independentStatus (run
  history) is stripped on both export and import, and a non-JSON-serializable
  context is dropped from an export with a warning rather than failing it.
- Manager modal UI (2026-09-21, second pass, API spec Section 13.9): the
  Presets tab gained "Regular Presets" / "Independent Presets" subtabs. Each
  independent-preset row shows its enabled state, context mode and
  last-run summary; its editor has enabled toggle, model (a live connection-
  profile picker), temperature, max tokens, a new per-preset history-limit
  override, a prompt textarea, a READ-ONLY context indicator (context
  is extension-owned - not something the UI lets a human set), an honest
  "not available yet" note where triggers/schedule will go, Run Now, and the
  status block. Clone and Export reuse the regular-preset buttons unchanged -
  independentPreset/independentConfig already clone/export like any field.
- Deferred, still not built (reported per the request's own deviation rule
  rather than rushed): scheduled execution (needs a new timer subsystem) and
  event-driven execution (needs hooking every variable write path -
  chat-state.js, the codebase's most write-sensitive file, deserving its own
  careful pass). A concrete design sketch for both is in the API spec Section 13.10.

1.30 Manager Modal: Fixed Tab Height (2026-09-21)

Pure CSS/layout fix, no business logic or API surface change. Request: switching
top-level tabs (and the Independent Presets subtabs from 1.29) visibly resized
and repositioned the modal window, since .se-manager-window only had a
max-height and otherwise sized itself to whichever tab's content was active.
Code: src/ui/manager-modal/manager-modal.css.

- .se-manager-window now sets a fixed height: 80vh (90vh at the <=768px
  responsive breakpoint) alongside the existing max-height of the same value,
  instead of relying on max-height alone. Every tab and subtab pane renders
  inside .se-manager-content, which was already flex: 1 with
  overflow-y: auto, so this was the one place a fixed size needed to be
  established - no other file needed to change.
- Effect: the window is now always the same size regardless of which tab or
  Presets subtab is active - option 1 from the request (consistent height),
  not option 2 (fixed top position, variable height). Shorter tabs (e.g.
  Calendars) leave blank space below their content instead of shrinking the
  window; taller tabs (e.g. Debug, Variable Management with many chats)
  scroll within .se-manager-content instead of growing it past 80vh, which
  is unchanged from the prior behavior for those tabs.
- Not verified with a live screenshot in real SillyTavern: the browser tool
  in this environment cannot screenshot local/out-of-scope files, and this
  session's UI verification has relied on jsdom tests throughout, which
  cannot assert real layout/height. Verified only that the CSS change is
  syntactically sound and that the existing 1737-test suite (unaffected by
  a pure CSS change) still passes; she should confirm visually once pulled.

1.31 Calculated Datetime Extension (2026-09-21, consolidated 2026-09-22)

Extends the EXISTING `datetime` type with ONE new optional field, deltaSource,
instead of introducing a new variable type or a special datetime category -
a plain datetime variable that sets none of them behaves exactly as it
always has (1.21/1.22). Code: variable-schema.js (the field),
variable-api.js (validation), calculated-engine.js (the delta trigger),
deterministic-engine.js (the tick-suppression hook into the EXISTING
increment loop). Superseded two earlier designs before reaching this shape:
a proposed new `calculatedDatetime` type (collided with `calculated`'s own
contract - never written outside its own expression evaluation,
calculated-engine.js's header comment) and, per the request's own original
phrasing, folding datetime fully into the general prompted-variable pool
(would have lost variable, model-chosen jump magnitude, which the boolean-
increment path cannot express - only a fixed, preconfigured delta) - AND a
third round, described below, that walked back a real design mistake in the
second pass rather than a request-vs-architecture conflict.

- The field (blankDefinition(), only meaningful when type === 'datetime'):
  deltaSource (string, default ''). Validated by checkedDatetime()
  (variable-api.js): a non-empty deltaSource must name an existing, type:
  'string' variable in the SAME preset (same same-preset scoping
  validateCalculatedDefinitionInternal() already uses for a calculated
  variable's dependencies, including that it is given by its fully-qualified
  stored name, e.g. "ext__jump", not its local name) and may not be the
  datetime variable's own name (unreachable in practice - see the "dead
  code" note further down).
- A datetime's own automatic advancement is NOT a separate field or
  mechanism - it is the SAME behaviors.increment/increment.delta every
  other type already has (1.5). A datetime variable that wants to tick
  forward on its own turns on "Incremented Behavior" and sets "Advance by"
  (a duration string, "1h"/"1d"/"1mo"/"1y", calendar-aware, unchanged since
  before this feature existed) exactly like a number or boolean would.
- Delta consumption (calculated-engine.js's applyDatetimeDeltaTriggers,
  called from inside recalculateDependents() - the one function every write-
  path caller already invokes after any write, so every caller gets this for
  free with no change to any of its 11 call sites): when deltaSource's value
  changes to a non-empty string, that text is parsed via the SAME calendar
  NL parser prompted-engine.js's direct "update" mode already uses
  (resolveInstruction, 1.22.4) against the datetime variable's OWN calendar
  and current value, applied via setVar, and deltaSource is reset to ''
  - so the same answer is never re-applied on a later, unrelated write. A
  bare duration ("3 days", the example phrasing this feature's own request
  gives) has no verb, so resolveInstruction (built for "advance 3 hours"
  phrasing) does not parse it on its own; retried with an implicit "advance "
  prefix before being treated as unparseable - a phrase that already has a
  verb, or an absolute date/scalar, resolves on the first attempt exactly as
  it always has and is never re-prefixed. A source whose text fails to parse
  either way leaves BOTH the datetime value and the source untouched (visible
  for the console and the next write to correct, never silently discarded).
  Two or more datetime variables may share one deltaSource; each applies
  independently, and the source resets once, after the loop, only if at
  least one actually applied it.
- Combined behavior / no double-stepping: a delta jump and an automatic
  tick never both land on a variable in the same pass.
  applyDatetimeDeltaTriggers records a one-shot "just jumped" flag
  (consumeDatetimeJump(), in-memory, keyed "chatId::varName") whenever a
  jump applies to a datetime that has an active deterministic tick
  configured (behaviors.increment === true, behaviors.prompted !== true -
  a prompted increment is gated on the model's own answer, not a fixed
  per-pass tick, so it is never suppressed this way); deterministic-
  engine.js's SAME increment loop every type already runs through consumes
  (reads and clears) that flag, for a datetime specifically, right before
  applying its own increment, and skips it if the flag was set. Best-
  effort, not a hard guarantee: the prompted update that writes a
  deltaSource is fire-and-forget (prompted-engine.js never awaits its
  background LLM call), so a jump can resolve either before or after that
  round's deterministic pass already ran - one that lands after cannot
  retroactively suppress a tick that already fired.
- Cycle guard: recalculateDependents(chatId, varName, _visited) gained a
  third, internal-only parameter (a Set, fresh by default on every external
  two-argument call) so it can recurse into a delta trigger's own dependents
  - both ordinary calculated variables and, via deltaSource chaining,
  another datetime trigger - without re-entering a name already in its own
  recursion chain (capped at 25 regardless). A genuine infinite cycle cannot
  actually form through this trigger in practice - applyDatetimeDeltaTriggers
  only treats a STRING, non-empty value as a pending delta, and every
  successful apply both writes the target a NUMBER and resets the source to
  '' - so this is defense-in-depth for that check ever being bypassed, not a
  scenario reachable through the validated create/update path.
- Export/import, independent presets: the field is plain data (preset-
  export.js's whole-preset clone() already carries it, no special-casing)
  and an independent preset's own write path already calls
  recalculateDependents() (1.29) at its two write sites, so a deltaSource
  answered by an independent preset run triggers the identical cascade with
  no independent-presets.js changes at all.
- UI (manager-modal/ui-templates.js's buildInlineVariableEditor): a
  deltaSource dropdown ("Narrative jump source"), shown only for
  type === 'datetime', right after the calendar picker - offering only this
  preset's other type: 'string' variables, never the variable being edited
  itself (otherVars already excludes it, the same guarantee that made the
  engine-layer self-reference check dead code, below). The datetime's
  "Advance by" field, further down in the ordinary Incremented Behavior
  section, carries an explanatory note about the deltaSource interaction so
  the two controls read as related rather than as two unrelated features.
  This editor writes preset.variables directly rather than through
  createVariable()/updateVariable(), so variable-api.js's checkedDatetime()
  validation never runs for it (same reason the calendar/defaultValue checks
  already duplicate that module's rules locally) - re-implemented here too:
  a deltaSource that no longer exists or is not a String variable is refused
  with an alert and nothing is written.
- Bug found and fixed while building the UI pass (not assumed - caught by
  mutation testing): the "flag a stale/invalid stored deltaSource" fallback
  option checked only whether a variable of that NAME still existed, not
  whether it was still type: 'string' - a deltaSource pointing at a variable
  that still exists but was retyped away from String rendered as blank
  (matching no `<option>` at all) instead of the flagged fallback, so
  editing and re-saving without touching the dropdown would have silently
  resubmitted the invalid value with no visible warning in the UI (the
  save-time alert still caught it, but only after the fact). Fixed by
  checking existence AND type together.
- Consolidation (2026-09-22, third round - a real UX and design mistake,
  not a request/architecture conflict like the other two): the second UI
  pass had added fixedIncrement (boolean), tickUnit (string, default
  "1 day") and accumulate (boolean) as a SEPARATE tick mechanism just for
  datetime, positioned in its own section right after the calendar picker -
  ABOVE, and visually disconnected from, the ordinary "Incremented
  Behavior" toggle every other type already has further down, which does
  functionally the same thing (step forward by a fixed, preconfigured
  amount on a configured trigger). Reported by the user as "very very
  confusing" - unable to tell the difference between the two controls, and
  put off by one being positioned as if it were something special. On
  investigation this was a real redundancy, not just a labeling problem:
  the only actual differences were (a) the new mechanism always ticked on
  both 'user' and 'ai' with no trigger selector, and (b) only the new one
  was deltaSource-jump-suppression-aware - accumulate was, in effect, just
  a second on/off switch duplicating what behaviors.increment already was.
  Fix: fixedIncrement/tickUnit/accumulate were removed entirely;
  deltaSource-jump suppression was moved onto the EXISTING
  behaviors.increment path instead (above), and the UI's separate tick
  section was removed, leaving deltaSource as the only datetime-specific
  field and "Incremented Behavior" as the one and only way any type,
  including datetime, ticks automatically.
- Tests: tests/calculated-datetime.test.js (34 tests: schema/validation,
  automatic ticking through the ordinary legacy increment mechanism, delta
  consumption, tick-suppression - including that a PROMPTED increment is
  never suppressed - cycle guard, end-to-end, export) and
  tests/calculated-datetime-ui.test.js (15 tests: template rendering,
  normalizeCollectedValues, the dropdown's type filter and stale-option
  fallback, save-time validation, self-reference exclusion, that
  Incremented Behavior is what actually ticks a datetime, and that no
  separate "automatic time flow" toggle exists any more). Every rule across
  all three rounds was verified by deliberately breaking it and confirming
  the suite catches the break (mutation testing); consolidating from
  fixedIncrement/accumulate onto behaviors.increment also surfaced a real
  regression the FIRST time it was attempted - the new jump-suppression
  check inside the main deterministic-increment loop had no fallback in the
  test harness's simplified calculated-engine.js mock, breaking every OTHER
  suite that exercises a datetime increment without opting into the real
  module - fixed by adding a no-op consumeDatetimeJump to that mock, caught
  by running the full suite (not just this feature's own tests) before
  calling the change done.

1.32 Independent Presets — Scheduling (2026-09-22)

Time-based automatic execution for independent presets (1.29): interval,
atTime, delay and repeat modes. Code: src/core/schedule-engine.js (pure
calendar math), src/api/independent-presets.js (schedule CRUD + the due-
check runner), src/events/event-engine.js (a real timer + a message-driven
check). A fifth mode the request specified, "threshold" (run when a
datetime VARIABLE crosses a value, evaluated inside recalculateDependents()),
is deliberately NOT built - see below for why, and docs/STATE ENGINE API
SPECIFICATION.md Section 15 for the full design.

- Fields (preset.independentConfig.schedule, all optional): enabled
  (boolean), mode ("interval" | "atTime" | "delay" | "repeat"), value
  (string, an NL time expression), calendar (string, defaults to Gregorian),
  repeat (boolean - see below), nextRun (number, ms since epoch - engine-
  managed, never accepted from a caller). Its own entry point,
  updateIndependentPresetSchedule(), same reason independentConfig.context
  has one (1.29): a blind config-merge must never be able to set nextRun.
- "Now" is REAL wall-clock time (Date.now()), treated as the chosen
  calendar's own running scalar clock, fed into the SAME calendar-engine
  functions (resolveInstruction/incrementScalar) already used to advance a
  stored datetime VARIABLE (1.21/1.22/1.31) - unchanged, just given the real
  clock instead of a variable's stored value. This needs no new parsing
  (request Section 5) and is the only definition of "now" that makes "every
  10 minutes" mean anything: nothing in this codebase tracks one global
  "story time" independent of a specific datetime variable, and the request
  names no variable for these four modes to read "now" from. A bare
  duration ("10 minutes", the request's own interval example) has no verb,
  so it is retried with an implicit "advance " prefix first - the exact
  fallback 1.31's deltaSource trigger already uses, reused verbatim.
- CONFIRMED GAP, not guessed around: "dawn", "midnight", "sunrise" and
  "sunset" (the request's own atTime/repeat examples) are not phrases any
  calendar's NL rules understand - there is no hour-of-day vocabulary
  anywhere in calendar-engine.js, only relative durations, absolute dates,
  and "next season"/"next cycle"/"move to <season/cycle>" (when the
  calendar defines them). Inventing one would be the "new parsing
  subsystem" the request's own Section 5 forbids, so these phrases are
  honestly unsupported and refused like any other unparseable value - a
  user can still express an exact time, a duration, or a season/cycle name.
- Per-mode nextRun rules (schedule-engine.js's scheduleAfterRun(), followed
  from the request's own Section 3 per-mode text, which is more specific and
  authoritative than Section 2's summary that `repeat` applies to "interval/
  repeat modes" - a genuine inconsistency between the two, not silently
  resolved either way without saying so): interval ALWAYS reschedules
  (repeat is inert for it - Section 3A never checks it); delay ALWAYS
  disables after running (one-shot, repeat inert - Section 3C); atTime
  disables unless repeat is explicitly true (Section 3B - the one mode
  where the field does anything); repeat mode always stays enabled and
  always recomputes a fresh future occurrence (recurrence is the mode
  itself - repeat is inert here too). An unparseable schedule at recompute
  time (a deleted calendar, for instance) disables rather than throwing.
- atTime uses whatever it resolves to, even if already past (a one-shot
  time already missed is simply overdue - fires on the next check). repeat
  mode requires a genuine FUTURE occurrence: if resolving once lands at or
  before "now", it is resolved again using its own prior answer as the new
  "now" - every phrase this system understands is inherently relative, so
  this walks forward one real occurrence at a time with no phrase-specific
  period logic needed - capped at MAX_REPEAT_ADVANCE_STEPS (1000) rather
  than trusting every calendar definition to be well-formed. An absolute
  date has no sensible "next occurrence" this way (re-resolving it returns
  the identical fixed point every time, since toScalar ignores the "current"
  argument) and is correctly refused in repeat mode rather than pretended to
  advance - caught by the test suite itself, not assumed.
- Execution (checkAndRunDueSchedules(chatId), src/api/independent-
  presets.js): scans every independent preset's schedule (open, not
  identity-checked - engine-internal housekeeping, the same convention
  getIndependentPresetStatus() already uses), and for each due one
  (nextRun <= now), updates nextRun/enabled for the NEXT run BEFORE
  awaiting this one's LLM call - not after - so a slow-resolving run can
  never look "still due" to the next periodic check while it is in flight.
  Due presets run ONE AT A TIME (never concurrently): independentRunInProgress
  (1.29's existing lock, shared by the whole module) is a second, independent
  line of defense against the same overlap, not the only one. Respects
  settings.enabled, the same gate runPromptedStateUpdate()/
  runDeterministicIncrements() already apply and runIndependentPreset()
  itself still does not (a pre-existing gap from 1.29, flagged again here,
  not silently fixed outside this request's scope).
- Reached from two places (src/events/event-engine.js), because a message-
  driven check alone cannot deliver "every 10 minutes" when messages are
  sparse: once per message-driven pass (USER_MESSAGE_RENDERED/
  CHARACTER_MESSAGE_RENDERED - the request's own "add a scheduler pass to
  deterministic-engine," Section 4A, reached from the events layer instead
  of deterministic-engine.js itself so src/core/ never imports src/api/ -
  same effect, correct layering, exactly the boundary calculated-engine.js's
  own header comment already documents for a different pair of modules) and
  a REAL setInterval, 30 real seconds, started once at page load
  (startIndependentPresetScheduler(), called from index.js the same way
  extension-updates.js's initExtensionUpdateNotifier() already is) -
  genuinely new: nothing else in this codebase runs on a wall-clock
  interval at all. Both call the SAME function for whichever chat is
  currently open (SillyTavern.getContext().chatId, read fresh each time,
  never cached) - scheduling only ever runs for the currently open chat,
  in this open browser tab; there is no background/server-side execution
  in this extension at all, a real, stated limitation, not a silent gap.
- Cycle protection: NOT the same guard as calculated variables (request
  Section 4C asked for this, but it does not apply here - see below). A
  genuine preset-triggers-itself loop is prevented structurally: nextRun
  is always pushed into the future (or the schedule disabled) before the
  run is even awaited, so the same due check can never re-fire the same
  preset twice, and nothing in this pass wires a preset's run back into
  triggering another schedule check synchronously. independentRunInProgress
  additionally serializes every run, scheduled or manual.
- Export/import: enabled/mode/value/calendar/repeat are plain, portable
  config and export like anything else; nextRun is engine-managed (this
  install's real clock - meaningless, and often already in the past,
  anywhere else) and is stripped on export, the same pattern
  independentStatus already uses. An enabled schedule gets a FRESH nextRun computed
  for the importing install's own clock; one whose mode/value/calendar
  cannot be parsed there (e.g. a fantasy calendar this install lacks)
  imports disabled instead of silently enabled-but-never-firing, with a
  console warning. clonePreset() (manager-modal, same-install) does NOT
  strip/recompute nextRun - the clock does not change within one install,
  so an already-computed nextRun stays exactly as valid as it was.
- UI (manager-modal/ui-templates.js's buildIndependentPresetRow): a
  "Scheduling" section (replacing the "not available yet" placeholder) -
  Enable Schedule, Mode, Value, Repeat, read-only Next Run, and a Calendar
  dropdown shown only when a fantasy calendar exists ("optional... if
  fantasy calendars exist," Section 6 - the harness/app ship built-in
  fantasy calendars by default, so this is effectively always true in
  practice, confirmed while testing). One field, one on-change save (this
  editor's existing per-field convention, 1.29), through its own field
  class/CRUD entry point (updateIndependentPresetSchedule), never the
  generic config patch - a rejected save (bad mode/value) writes nothing,
  so the re-render reverts the field to its last-good stored value.
- Deferred, per the request's own deviation rule (Section 9), not rushed:
  threshold mode. It needs a small variable-comparison expression language
  ("date >= harvestSeason") the request's own schema (Section 2) never
  defines a field for - inventing one would be a guess at unspecified
  syntax and semantics, the "new parsing subsystem" Section 5 forbids, and
  it is the one mode with a REAL, non-hypothetical cycle risk (a threshold
  run that writes the very variable it watches could re-fire itself through
  recalculateDependents() - unlike the four modes here, which cannot
  re-enter themselves by construction). Event-driven triggers (run when
  ANY variable changes) remain deferred from 1.29 for the same reasons as
  before.
- Tests: tests/schedule-engine.test.js (28 tests - the pure calendar math),
  tests/api/independent-presets-schedule.test.js (22 tests - CRUD/merge
  rules, checkAndRunDueSchedules including the in-flight/overlap and
  settings.enabled cases, export/import), tests/independent-presets-
  schedule-ui.test.js (8 tests - the manager-modal section, including the
  Calendar dropdown's presence/absence tested at the template level since
  the built-in fantasy calendars cannot be fully cleared from live settings,
  which self-heal them back). Every rule was verified by deliberately
  breaking it and confirming the suite catches the break (mutation
  testing); one such attempt (recomputing nextRun even when time had passed
  but mode/value had not changed) was not caught by the first version of
  its test, which had picked an absolute-date example insensitive to the
  mutation - fixed by choosing a relative-duration example instead, not by
  weakening the mutation.

1.33 Manager Modal: Variables Tab Preset Picker (2026-09-22)

The Variables tab's preset dropdown had no ordering (raw Object.keys() =
creation order) and no way to find one once there were more than a
handful. First pass: alphabetic sort + a separate text box that filtered a
plain `<select>`'s `<option>` list. Reported as not what was wanted - a
plain select can only jump to an option by its first letter, not be typed
into; the request was "open the dropdown and type a few characters to
limit the options," i.e. an actual searchable combobox. Rebuilt as one
(src/ui/manager-modal/ui-templates.js/ui-render.js/ui-events.js) - no
external UI library is loaded anywhere in this codebase, so hand-rolled
like everything else in the manager modal:

- A text `<input>` (`#se-manager-preset-combobox-input`) shows the
  currently selected preset's NAME (never its id). Focus/click selects the
  text (browser-address-bar style - typing immediately replaces it) and
  opens a row list showing every preset, unfiltered; typing filters the
  list live, in place (no re-render, same technique
  filterAndSortVariables() already used for the variable list); Escape,
  or a mousedown outside the combobox, closes the list and reverts the
  input to the actually-selected preset's name (a half-typed, unpicked
  search would otherwise no longer match what the variable list below is
  showing). ArrowUp/ArrowDown move a highlight among the currently visible
  rows; Enter picks the highlighted row, or the first visible one if
  nothing is highlighted.
- Picking a row (click or Enter->click) is wired in ui-events.js, since it
  needs managerState to actually switch the active preset - everything
  else (open/filter/keyboard-nav/close) is self-contained DOM manipulation
  in ui-render.js, needing no shared state.
- Real regression found and fixed while rewriting the tests for this (not
  assumed - the full suite catches it): manager-modal.js's
  renderChatDependentTabs() had its own, SEPARATE way of asking "which
  preset is selected right now" - reading the old `<select>` element's
  `.val()` directly, as a bridge to a DIFFERENT state variable
  (managerState.currentPresetId, only visible to ui-events.js) than this
  module's own managerCurrentPresetId, which the click handler never
  touched. Removing the `<select>` silently broke that bridge - the
  preset selected via the combobox would revert to whatever was first
  shown the moment a chat change (or reopening the modal) triggered a
  redraw. Fixed by stamping the actually-selected preset's id as
  data-selected-id on the combobox input on every render (ui-templates.js/
  ui-render.js) and having renderChatDependentTabs() read that instead -
  same bridge role the old select's own .val() used to serve, just moved
  to the new element.
- Two jsdom-only bugs surfaced while writing the tests, both root-caused
  by reproducing them rather than assumed: jQuery's `:visible` pseudo-
  selector (used to find which rows the keyboard nav should move among,
  and which row Enter should pick) depends on real layout - jsdom never
  computes it, so it silently matched nothing at all, breaking arrow-key
  navigation and Enter. Replaced with a direct `style.display !== 'none'`
  check, which is both what was actually meant (rows are only ever
  toggled that way) and layout-independent. Separately, `scrollIntoView`
  does not exist in jsdom at all - guarded with `?.` rather than assumed
  present, since real embedding contexts could plausibly lack it too.
- Tests: tests/variables-tab-preset-picker.test.js (16 tests, fully
  rewritten for the combobox - ordering, opening/filtering, picking a row
  by click or keyboard, and closing without picking) and
  tests/manager-modal-chat.test.js's existing chat-follows test, updated
  to drive the combobox instead of a `<select>` (this is the test that
  caught the data-selected-id regression above). Every behavior was
  verified by deliberately breaking it and confirming the suite catches
  the break (mutation testing), including the regression fix itself.

1.34 "Most Recent Roleplay Message" Labeling (2026-09-22)

Reported: a datetime variable's deltaSource (1.31) prompted with natural
phrasing like "One Month"/"one day" never advanced anything at all - a
SEPARATE, genuine bug (see 1.21's BUG FIX notes for that one: DELTA_TOKEN,
calendar-engine.js, never accepted spelled-out numbers, only digits - fixed
independently of this entry). While reproducing it, a second, unrelated
problem surfaced: the state-tracking LLM call's `messages` array
(prompted-engine.js's runPromptedStateUpdate()/independent-presets.js's
runIndependentPresetInternal()) always ends with a SEPARATE, synthetic
instruction turn (`{ role: 'user', content: 'Output the JSON object
now...' }`) appended AFTER the whole system prompt. A variable's own
prompted instructions naturally say things like "only evaluate the latest
message" - with no explicit, consistently-named field for "the latest
message" anywhere in the prompt, the model has no reliable way to know
that means the actual last roleplay line buried in the "Recent
conversation" transcript, rather than that trailing wrapper turn, which
genuinely is the literal last message in the API call.

- Fix: the actual last chat message is now explicitly, separately labeled
  "Most recent roleplay message" in the context section, distinct from
  "Recent conversation" (everything before it) - not just folded into one
  undifferentiated transcript block. `DEFAULT_PROMPTED_HEADER`
  (settings-core.js) gained two lines establishing the term: that the
  model will be given a "Most recent roleplay message," and that a
  variable's own instructions referring to "the latest message" mean that
  field specifically, never the trailing JSON-request instruction. A user
  who has already customized settings.promptedHeader keeps their own text
  unchanged, as any override always has - this only updates the built-in
  default.
- Shared, not duplicated: `formatting-utils.js`'s new
  `buildRecentMessagesSection()` is used by BOTH prompted-engine.js and
  independent-presets.js, replacing each file's own near-identical inline
  transcript-building block. independent-presets.js's own header comment
  documents this as the one deliberate exception to that module's
  "duplicate rather than extract from prompted-engine.js" rule (1.29) - a
  pure, read-only piece of prompt TEXT assembly is not the write/
  classification logic that rule protects, and keeping it duplicated would
  have meant this exact fix drifting apart between the two call sites
  instead of being fixed, and tested, once.
- A genuine, separate bug found and fixed while extracting this (not
  assumed - caught by this function's own tests): the ORIGINAL inline
  logic filtered "blank" messages by checking the trimmed length of the
  ALREADY-PREFIXED line ("Speaker: ") - which always has non-zero length
  even when the message text itself is empty (an image-only message, a
  blank system/OOC entry, HTML that strips to nothing), so a blank message
  was never actually filtered out at all; it just became a bare "Speaker:
  " line inside the transcript. Harmless before this feature (a stray
  blank line sat unlabeled in the middle of "Recent conversation"), but
  would have actively mislabeled a blank trailing message as the "Most
  recent roleplay message" here. Fixed by checking the message's own
  stripped text, before the speaker prefix is added.
- Result: "Recent conversation" only appears when there is real history
  before the last message (never an empty section); "Most recent roleplay
  message" always appears whenever there is at least one real message; a
  chat with nothing real at all (or only blank/whitespace messages) still
  says "No conversation yet." exactly as before.
- Tests: tests/formatting-utils.test.js (11 tests - the function's own unit
  coverage: empty/blank input, the one-message-only case, multi-message
  splitting, which message counts as "most recent" regardless of who sent
  it, the blank-trailing-message fix, HTML stripping, truncation without
  mutating the stored message, and speaker-name fallbacks) plus integration
  tests in tests/datetime.test.js (the main prompted update) and
  tests/api/independent-presets.test.js (independent presets) confirming
  the label actually appears in the real system prompt, and that the
  literal last API message is a different, synthetic turn entirely. Every
  rule was verified by deliberately breaking it and confirming the suite
  catches the break (mutation testing).

1.35 Semantic Time of Day (2026-09-22)

Extends the EXISTING `datetime` type with ONE new optional field,
timeSemanticMode ('none' | 'semanticTimeOfDay', default 'none'), the same
shape of extension deltaSource (1.31) already is - a plain datetime that
leaves it at 'none' behaves exactly as it always has. Code:
variable-schema.js (the field), variable-api.js's checkedDatetime()
(validation), calendar-engine.js (resolveSemanticTimeOfDay() and
resolveInstruction()'s new options.semanticTimeOfDay parameter), prompted-
engine.js (the one call site that actually turns it on), manager-modal/
ui-templates.js (the editor field).

- The field (blankDefinition(), only meaningful when type === 'datetime'):
  timeSemanticMode: 'none' | 'semanticTimeOfDay'. Validated by
  checkedDatetime() the same way deltaSource is - a fixed choice, not free
  text, so validation is really just "did a caller send garbage"; the
  manager-modal editor only ever offers the two real values via a <select>.
- Canonical phrases and hours (minute/second always 0): morning 08:00, dawn
  06:00, sunrise 06:00, noon 12:00, afternoon 15:00, evening 18:00, sunset
  19:00, night 21:00, midnight 00:00 - exactly the request's own table.
  "The next X" (or bare "next X", generalized to every phrase above, not
  just the three the request gave as examples - "the next dawn"/"next
  noon" work too) advances the date by one day first, then applies the
  canonical hour; a bare phrase ("morning") applies the canonical hour to
  the CURRENT day - which can move the clock backwards within that day if
  the current time is already past it (a literal reading of the request's
  own mapping table, not inferred as "always forward"; covered by its own
  test).
- Where it applies: ONLY the datetime's own direct prompted answer
  (prompted-engine.js's runPromptedStateUpdate(), the one place a def is on
  hand to check timeSemanticMode against) - resolveInstruction() gained a
  4th, optional `options` parameter (`{ semanticTimeOfDay: boolean }`,
  default `{}`) so every other existing caller (deltaSource's own
  applyDatetimeDeltaTriggers in calculated-engine.js, schedule-engine.js,
  the calendar-manager preview) is completely unaffected without being
  touched at all. Per the request's own explicit instruction ("DeltaSource
  prompts do not need to handle semantic time phrases"), deltaSource text
  is deliberately NEVER given semantic interpretation, even when the
  TARGET datetime has timeSemanticMode enabled - confirmed by its own test
  in tests/calculated-datetime.test.js, not assumed from the reading of the
  request alone.
- Precedence ("semantic time phrases override duration based deltas"):
  resolveSemanticTimeOfDay() is checked FIRST in resolveInstruction(),
  before the absolute-date parse, phrase rules, and the advance/rewind
  verb grammar - in practice a bare phrase like "morning" never collides
  with any of those anyway (none of them would ever match it), so this is
  precedence as specified rather than a fix for an actual conflict that
  could otherwise arise.
- Not described to the model: describeConstraint() (formatting-utils.js) is
  UNCHANGED - the request is explicit that "the engine must perform all
  semantic time interpretation internally," never mentioning the phrases in
  the prompt. A semantic phrase understood here works simply because it
  also reads as ordinary natural language, the same way the model already
  free-writes "advance 3 hours" without that literal phrase appearing
  anywhere in its instructions either.
- Tracker display: no new code needed - a semantic phrase is resolved to an
  ordinary scalar and written through the SAME setVar() path any other
  resolved datetime answer already uses, so the tracker (which always reads
  the stored scalar, never the text that produced it) shows the normalized
  result "for free." Confirmed by a test that reads the resolved value back
  through formatValueForDisplay(), not merely assumed from the shared code
  path.
- A calendar that cannot represent a canonical hour (e.g. a fantasy
  calendar with fewer than 22 hoursPerDay, asked for "night" -> 21:00)
  fails through fromStructured()'s own range check, caught by
  resolveInstruction's existing top-level try/catch and returned as null -
  "recognised, but not applicable to this calendar" is treated the same as
  "not understood," consistent with every other unresolvable instruction.
- UI (manager-modal/ui-templates.js's buildInlineVariableEditor): a
  "Semantic time of day" <select> (Off / On), shown only for type ===
  'datetime', right after the deltaSource section - a plain select value
  needing no special collection or normalization (same pattern as
  deltaSource and currentKeyVariable: ui-events.js's generic
  .se-manager-var-field loop already collects it, and
  normalizeCollectedValues() passes it through untouched).
- Tests: tests/datetime.test.js ("semantic time of day (spec 1.35)" - the
  canonical mapping, the "the"/case tolerance, next-day variants including
  the generalization beyond the three given examples, the same-day
  backwards-in-time case, the calendar-cannot-represent-the-hour case, that
  it is completely inert unless explicitly enabled, schema defaults and
  validation, and end-to-end prompted-update integration including the
  tracker-display check) and tests/calculated-datetime.test.js (one test
  confirming deltaSource text is never given semantic interpretation, using
  that file's own real-calculated-engine harness - tests/datetime.test.js
  uses the simplified calculated-engine mock every other suite there
  relies on, so that specific interaction cannot be exercised from it).
  Every new rule was verified by deliberately breaking it (the canonical
  hour table, the enable/disable gate, the next-day-advance step, the
  save-time validation, the prompted-engine.js wiring, the UI template's
  selected-option rendering) and confirming the suite catches each break
  (mutation testing) before being called done.

1.36 Datetime Mode (2026-09-22)

Extends the EXISTING `datetime` type with ONE new optional field,
datetimeMode ('full' | 'dateOnly' | 'timeOnly', default 'full'), restricting
which HALF of a moment is meaningful. Code: variable-schema.js (the field),
variable-api.js's checkedDatetime() (validation, default normalization),
calendar-engine.js (normalizeForDatetimeMode()), chat-state.js's setVar()/
applyIncrement() (where it is actually applied), prompted-engine.js (the
dateOnly/timeSemanticMode gate), ui-templates.js/ui-events.js/variable-ui-
schema.js (the editor field), formatting-utils.js/tracker-panel-ui.js (mode-
aware display and editing).

- Design choice, and why: the request's own bullets for dateOnly read, taken
  literally, as two different rules ("apply all numeric time deltas
  including hours, minutes, and seconds" vs "apply only day, week, month,
  and year deltas directly"). Reconciled as ONE coherent design rather than
  picked between: every existing delta/answer/semantic-phrase path
  (resolveInstruction, incrementScalar, deltaSource, the deterministic tick)
  is left COMPLETELY UNCHANGED - no unit-level restriction was added to the
  parser, which cannot currently tell "3 days" from "72 hours" apart once
  parsed (parseDeltaFor collapses both into the same `parsed.seconds`; only
  months/years/seasons are tracked separately, because they need calendar-
  aware arithmetic). Instead, the RESULT of applying any delta/answer is
  normalized afterward: dateOnly truncates the time-of-day to 00:00:00,
  timeOnly truncates the date back to the calendar's own reference moment
  (day 0 - 1970-01-01 for Gregorian, year 1 month 1 day 1 for a fantasy
  calendar). This single post-processing step, applied once at the write-
  path choke point (below), satisfies every bullet as an OUTCOME rather than
  an input restriction: "apply all numeric deltas" is true (nothing is
  rejected), "roll the date forward when accumulated time exceeds 24 hours"
  falls out for free from ordinary scalar arithmetic (30 hours added, THEN
  truncated, already lands on day+1 - no special-cased rollover logic
  exists), and "apply only day/week/month/year deltas directly" describes
  which units have a GUARANTEED effect after truncation (an hour-only delta
  on a dateOnly variable is silently absorbed unless it crosses a day
  boundary). timeOnly's own bullets ("apply only hour/minute/second deltas,
  ignore day/week/month/year deltas") read the same way under this design: a
  pure date-unit delta changes the date, which is then thrown away by the
  truncation, so it has no visible effect - "ignored" as an outcome, not a
  parse-time rejection.
- normalizeForDatetimeMode(calendarId, scalarTime, datetimeMode)
  (calendar-engine.js): 'full' (or anything unrecognized) is a pure no-op.
  Never throws - a bad scalar or calendar falls back to the value unchanged.
- Applied at chat-state.js's setVar() - the single choke point every
  write path already shares (its own header comment) - so a
  dateOnly/timeOnly variable's value is normalized "after each update" (the
  request's own words) for EVERY caller with zero changes needed at any of
  them: prompted-engine.js's direct write, calculated-engine.js's
  deltaSource jump (1.31 - untouched by this feature at all, the
  normalization is entirely on the write side), the tracker's manual edit,
  seeding. applyIncrement() writes entry.value directly rather than through
  setVar() (its own header comment), so the SAME normalization is repeated
  there for the one write path that bypasses it (the automatic per-message
  tick, behaviors.increment) - confirmed as a real gap by mutation testing,
  not assumed identical to setVar's coverage.
- The default itself is normalized too, at save time (checkedDatetime(),
  variable-api.js, and variable-ui-schema.js's normalizeCollectedValues() for
  the manager-modal's own inline-save path, which bypasses checkedDatetime
  the same way deltaSource's validation is already duplicated there) - a
  dateOnly/timeOnly variable never even STARTS with an inconsistent stored
  default.
- Semantic time of day (1.35) interaction: "Add optional semantic time of
  day support for timeOnly and full modes" - dateOnly never interprets a
  semantic phrase at all (not merely a no-op after truncation): gated at
  prompted-engine.js's one call site (`def.datetimeMode !== 'dateOnly' &&
  def.timeSemanticMode === 'semanticTimeOfDay'`) AND forced to
  timeSemanticMode: 'none' at save time (checkedDatetime() and the
  manager-modal's own inline-save handler, same duplication reason as
  above) - belt and suspenders, since without the save-time force a
  dateOnly variable could still show an "on" toggle that can never actually
  fire. timeOnly keeps semantic phrases fully: "the next morning" resolves
  its canonical hour normally, then has its (irrelevant) day-advance
  component silently dropped by the same truncation as any other delta.
- Tracker display and editing ("suppress time/date display in the
  tracker"): formatValueForDisplay() (formatting-utils.js) and the tracker's
  own datetimeText()/datetimeEditText() (tracker-panel-ui.js, kept as a
  dedicated formatter rather than routed through formatValueForDisplay - see
  that file's own header comment on why) pick style 'date'/'time'/'full'
  from datetimeMode - calendar-engine.js's format() and formatScalar()
  already supported both styles for every calendar (1.21.5/1.22.2); only
  formatScalar() needed a new (default-'full', backward compatible) style
  parameter. datetimeDetail() (the season/cycle line) is suppressed
  entirely for timeOnly - its date is always the same fixed reference
  moment, so a season/cycle for it would never be meaningful. The tracker's
  edit box for timeOnly shows and accepts a bare "HH:mm:ss" - toScalar()/
  parseDateTime() both require a date prefix (ISO_DATETIME), so
  resolveTrackerEdit() completes a bare time with the calendar's own
  reference date (formatIsoScalar at scalar 0) before handing it to the
  ordinary, unmodified parser; the date is discarded again anyway by
  setVar()'s own normalization once written. A full ISO date/time is still
  accepted unchanged for any mode - normalization always happens on write,
  never by restricting what can be typed.
- UI (manager-modal/ui-templates.js's buildInlineVariableEditor): a
  "Datetime mode" <select> (Full / Date only / Time only) right after the
  calendar picker. The "Semantic time of day" section (1.35) is not
  rendered at all when datetimeMode is 'dateOnly' - there is no live field
  that re-renders the editor when datetimeMode itself changes (only the
  `type` field does, an existing, unrelated mechanism), so switching modes
  within one edit session can leave a stale, still-visible
  timeSemanticMode control in the DOM; the save handler's own force-to-
  'none' (above) does not depend on the DOM having already hidden it -
  confirmed directly, not assumed, by a test that leaves the stale control
  visibly "on" and checks what gets SAVED regardless.
- Tests: tests/datetime.test.js ("datetime mode (spec 1.36)" -
  normalizeForDatetimeMode including a fantasy calendar's own reference
  moment and the natural 24h-rollover case, schema defaults/validation
  including the dateOnly-forces-timeSemanticMode-none rule and its
  prompted-engine.js defense-in-depth gate (checked structurally, the same
  way this codebase's calendar-format.test.js/fantasy-calendar.test.js
  already check source-level guarantees), write-path normalization through
  both setVar and the real applyIncrement, end-to-end prompted-update
  integration for both modes including their interaction with semantic
  phrases, tracker display, and the timeOnly bare-time edit round-trip) and
  tests/calculated-datetime-ui.test.js (a new describe block: saving
  datetimeMode and its default-normalization, and the stale-DOM-control
  case above) and tests/calculated-datetime.test.js (one test confirming a
  deltaSource jump normalizes for the target's datetimeMode exactly like any
  other write, since deltaSource's own code is completely untouched by this
  feature). tests/harness/chat-state.mock.js (the standard mocked chat-state
  every OTHER suite in this codebase uses) was updated to mirror the same
  normalization the real module now does - found as a real gap, not assumed
  fixed: the first version of this feature's tests all failed against the
  unmodified mock, the same class of issue as 1.31's consumeDatetimeJump
  mock gap earlier in this project. Every rule was verified by deliberately
  breaking it (the truncation targets, both write-path call sites, the
  save-time validation and forcing rule, the prompted-engine.js gate, the
  display/edit formatting, the UI template's field and its stale-DOM
  handling, the default-normalization on the manager-modal's own save path)
  and confirming the suite catches each break (mutation testing) before
  being called done.

SECTION 2 — MODULE BOUNDARIES
Claude must respect the following module responsibilities:

Renamed for clarity: variable-store.js is now chat-state.js,
variable-storage.js is now macro-store.js, variable-definition.js is now
variable-schema.js (canonical engine schema), and the UI-only schema
helpers under src/ui/manager-modal/ moved from variable-schema.js to
variable-ui-schema.js. References below use the current names.

chat-state.js
isolated store management

seeding

cleanup

write‑path (setVar, applyIncrement)

macro mirroring

datetime mode normalization on write (normalizeForDatetimeMode, 1.36)

macro-store.js
macro store operations (getMacroValue, setMacroValue, deleteMacroValue,
macroStore). Named "macro", not "var", deliberately - this is the
{{getvar}}/{{setvar}} mirror, never the source of truth, and nothing
outside chat-state.js should call these directly.

prompted-engine.js
classifying every prompted/incrementable variable across the chat's active
presets, with no batch/scope filtering of any kind (classifyPromptedVariables,
1.20 rewritten 2026-09-22), and splitting an oversized set into several
sequential LLM calls (chunkPromptedVariables, prompt-chunking.js, 1.20)

turning a datetime variable's answer into a scalar via calendar-engine.js
(1.21)

LLM‑driven updates

calling setVar / applyIncrement

deterministic-engine.js
deterministic increments

calling applyIncrement

calendar-engine.js
scalar time <-> structured time and datetime increments (getCalendar,
toStructured, fromStructured, incrementScalar, 1.21). Reads calendar
definitions from settings.calendars; imports only settings-core.js. Owns ALL
calendar arithmetic - no other module does its own date math.
Since 1.22 it also owns calendar definition validation and CRUD
(validateCalendarDefinition, createCalendar, updateCalendar, deleteCalendar,
listCalendars, getCalendarDefinition), the fantasy formatting / increment /
natural-language rules (format, formatPartial, incrementScalar,
resolveInstruction), the draft preview (previewCalendarDefinition) and the
random generator (generateRandomCalendarDefinition).

calendar-ui-schema.js (src/ui/manager-modal)
pure conversion between a calendar definition and the Calendars tab editor's
flat form values (1.22.1). No DOM, no settings access.

expression-dsl.js
Tiny Expression DSL tokenizer/parser/evaluator for calculated variables
(1.17). Pure - no imports from any other State Engine module, no state,
never throws past evaluateExpression()'s own boundary.

calculated-engine.js
calculated-variable evaluation (evaluateCalculatedVariable) and
re-evaluation triggers (recalculateDependents, recalculateAllForChat, 1.17).
Calls setVar/getVar (chat-state.js) and getPresetsForChat/
getAllVariablesFromPresets (preset-manager.js). Never called from inside
chat-state.js itself - every write-path caller triggers it explicitly,
per 1.17.2.

macro-registration.js
registers/unregisters {{name}} macros (1.19) for variables in presets
active for the current chat, via context.registerMacro/unregisterMacro
(SillyTavern's own public extension point) - never reimplements macro
substitution itself.

event-engine.js
chat lifecycle events

calling seeding and cleanup functions

Claude must not move logic across modules unless explicitly instructed.

SECTION 3 — LIFECYCLE RULES
3.1 Seeding

CHAT_CHANGED must NOT seed.  It must load stored values only.

CHAT_CREATED must NOT seed. New chats will not have any presets active in them so there is no need.

Seeding must occur only on:

engine enable

preset add/remove

variable save (manager modal inline editor, ui-events.js
.se-manager-save-variable-inline handler) - added 2026-09-09. Root-caused
via direct code trace (not inference): a variable created while its preset
is already active for the chat never gets a state.variables entry through
any other path - resetValueIfTypeChanged() only touches variables that
already have an entry (chat-state.js, `if (!entry) return;`), and the three
seeding triggers already listed above don't fire from a plain variable
save. This is invisible for an ordinary variable (getMacroValue()'s
default-value fallback shows defaultValue regardless of whether anything
was ever actually stored) but broke calculated variables outright: a
calculated variable's dependency resolution reads the real stored value via
getVar(), which returns undefined for an unseeded dependency, so evaluation
fails every time and the calculated variable never produces a value.
seedVariablesForChat() is safe to call unconditionally here - it already
only fills in variables that don't yet have an entry (1.12), never resets
one that does.

Seeding must not occur inside update engines.

3.2 Macro Cleanup
Macro cleanup (clearMacroVarsForChat) must occur only on engine disable.

It must NOT occur on CHAT_CREATED or CHAT_CHANGED. Local-scope macro
variables live in chat_metadata, which SillyTavern already swaps per-chat
automatically - there is nothing to clear on a chat switch, and doing so
anyway just to immediately repopulate it via hydrateMacroStoreForChat()
was pure churn (see 1.2).

3.3 Update Engines
Update engines must run only when:

the engine is enabled

the variable store is already seeded

classification returns non‑empty sets

SECTION 4 — ERROR HANDLING
Claude must:

wrap external API calls in try/catch

log warnings instead of throwing

ensure update engines never crash

ensure cleanup never crashes

ensure seeding never crashes

SECTION 5 — CODE STYLE & STRUCTURE RULES
Claude must:

preserve naming conventions

preserve import/export patterns

avoid duplicated logic

avoid side effects outside designated modules

avoid modifying unrelated code

SECTION 6 — SCHEMA RULES
Claude must:

use defaultValue for defaults

preserve type, behaviors, increment

never invent new fields (`batch`, 1.20, is a sanctioned field - added to
blankDefinition() with default 'core'; this rule still forbids inventing any
other)

calendar-engine.js now owns all formatting logic for datetime variables
(format, formatPartial - 1.21.5).

never rename schema fields

setVar() and applyIncrement() (chat-state.js) snapshot the caller's live
def onto the stored entry as entry.def, so a later read always has the
canonical schema that was live at write time instead of hand-copied
individual fields that could drift out of sync with variable-schema.js.
This is additive to the existing value write, not a replacement of it.

entry.def must never be used to source applyIncrement()'s delta or any
other live increment decision. delta is always the caller's argument,
read fresh from the current preset definitions (getAllVariablesFromPresets)
before the call - entry.def exists for snapshot/inspection purposes only,
and using it to drive live behavior would reintroduce the exact schema
staleness this snapshot exists to avoid.

SECTION 7 — CLAUDE EXECUTION RULE
Before performing any modification, Claude must:

Read this requirements document.

Confirm adherence to all invariants.

Apply changes without violating any rule.

Validate output against this document.

Should you keep this in source control?
Yes. Absolutely.

Here’s why:

1. Claude can reference it by filename
You can say:

“Claude, load and obey /docs/state-engine-requirements.md before making changes.”

Claude will treat it as authoritative.

2. It prevents architectural drift
Every refactor stays aligned with your rules.

3. It becomes part of your project’s governance
Anyone working on the engine must obey it.

4. It protects you from hallucinations
Claude will not invent fields or violate invariants if the doc is always present.

5. It stabilizes long‑term development
Your architecture becomes durable and predictable.