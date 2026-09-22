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

1.20 Variable Batching System (2026-09-18)

Batching controls WHICH VARIABLES APPEAR IN A PROMPT. It exists so that a
large set of variables does not bloat the one prompt the main prompted update
sends, and so independent presets can build small prompts of their own
instead of inheriting everything.

Rules:

- Every variable belongs to exactly one batch. The default batch is "core".
- Batch membership is variable metadata: `batch` on the variable definition
  (variable-schema.js). blankDefinition() sets `batch: 'core'`, and
  variable-schema.js exports DEFAULT_BATCH ('core') and batchOf(def).
  batchOf() returns def.batch when it is a non-empty string and "core"
  otherwise, so a definition that predates batching - no `batch` field at all
  - is in "core" with NO data migration, and every existing variable behaves
  exactly as it did. getDefaultValue(), clampNumber() and every other schema
  helper never read or alter `batch`.
- Batch membership is snapshotted per chat, inside entry.def in chat-state.js,
  like every other definition field (Section 6: entry.def is a per-write
  snapshot for inspection only and must never source a live decision).
  Because setVar() and resetValueIfTypeChanged() snapshot the whole def they
  are handed, `batch` travels with it automatically. The one gap this closes:
  a caller that hands over a def with NO `batch` field (a legacy def, or the
  minimal { name, type } stand-in applyIncrement() falls back to) would
  replace the snapshot and silently drop the batch it previously recorded.
  chat-state.js's keepSnapshotBatch() carries the previous snapshot's batch
  forward in exactly that case, and only that case - a def that has its own
  batch is stored as the very same object it always was, and the caller's def
  is never copied or altered. The snapshot changes when the variable is next
  WRITTEN, not when its batch is reassigned.
- Batches are NOT presets. A preset is an arbitrary folder a user groups
  variables into; a batch is a prompt scope. One preset's variables can sit in
  any mix of batches, and a batch spans every preset (and every extension's
  namespace) active in a chat. Nothing about batching creates, renames,
  moves or binds a preset.
- Which batch a prompt uses is decided from the LIVE definitions of the
  presets active for the chat (getPresetsForChat / getAllVariablesFromPresets),
  never from entry.def.

Main prompted update (prompted-engine.js):

- The main prompted update asks the model only about variables in batch
  "core" (and, since 1.21, "time" - where datetime variables live).
  prompted-engine.js's selectBatchVariables(variables, batch = 'core') picks
  them (`batch` may be a name or a list of names), and the existing classification (update / prompted increment /
  deterministic) runs over that selection unchanged. A prompted variable in
  any other batch is left out of the prompt, and is never updated by that
  update even if the model answers for it. When every prompted variable is in
  another batch, no LLM call is made at all.
- Batching governs prompts only. It does not affect deterministic increments,
  calculated-variable evaluation, macros, or seeding.
- The main prompt is NOT assembled from batchPrompt("core"), and this is
  deliberate. batchPrompt emits value-only lines (`name = JSON`), but each
  line the main prompt sends the model also carries that variable's
  constraint description, its current value, its instructions, and - for a
  prompted increment - the "[true or false]" framing the response parsing
  depends on. Swapping in batchPrompt would drop all of that and change what
  the model is told, i.e. regress the prompted update, which 1.5 forbids. Only
  the SELECTION of variables uses batching; the per-variable wording is
  untouched. batchPrompt is for callers that want a compact state view -
  independent presets are the intended consumer.
- Independent presets (Section 3 / src/api/independent-presets.js) are what
  batching is for: each is meant to build its prompt from batchPrompt() of its
  own batch rather than from all variables. They do not do so yet.

API (src/api/batching.js; exposed on stateEngine):

  assignBatch(extensionId, instanceId, variableName, batchName)
  removeBatch(extensionId, instanceId, variableName)
  getBatch(batchName, chatId)
  getBatches(chatId)
  batchPrompt(batchName, chatId)

- assignBatch moves one of the caller's variables into batchName and returns
  the stored (whitespace-trimmed) name. removeBatch puts it back in "core".
  Both replace the variable's definition object with a copy carrying the new
  batch (never mutating it in place - the same rule updateVariable follows,
  since a chat's entry.def can be the same object) and persist settings.
- Validation, all before anything is written, all thrown as errors (never a
  silent null): identity is enforced (a wrong, missing or non-string
  instanceId throws `State Engine API call rejected: wrong instance`, checked
  first); neither signature carries a namespace, so the target is the
  caller's OWN namespace, and an extension that owns none throws `Extension
  '<id>' does not own a namespace - call createNamespace() first`; the
  variable must exist in the caller's namespace (given as the local name or
  the stored `namespace__name`) - a variable in another namespace does not
  exist as far as the caller is concerned, so one extension can never move
  another's; batchName must be a non-empty string that is not whitespace-only
  and contains no line break (it is written into a prompt heading, and a line
  break would let a name start a new prompt line).
- The same batch-name rule applies when `batch` arrives inside a definition
  passed to createVariable() or a patch passed to updateVariable(); there an
  invalid batch fails the call the way that module's other bad payloads do
  (warn, return null) and nothing is written.
- getBatch(batchName, chatId) returns [{ name, value, def }] for every
  variable in that batch that is active for the chat - value is the stored
  value (getVar), or the type default if it has not been seeded, and def is a
  copy. getBatches(chatId) returns { batchName: [variableName, ...] } for
  every active variable; only non-empty batches appear, and every active
  variable appears in exactly one. batchPrompt(batchName, chatId) returns
  `### <BATCH NAME>` (upper-cased) followed by one `name = JSON.stringify(value)`
  line per variable in definition order - no chat transcript, no instructions,
  and no variable from any other batch - or '' when the batch is empty so a
  caller can skip it. A JSON-encoded value can never contain a raw line
  break, so a value cannot start a new prompt line. Invalid arguments return
  []/{}/'' rather than throwing.
- The three read functions take no identity and are keyed by chat, not by
  namespace: they expose every active variable's name and value, across all
  namespaces, to any caller. That is inherent to a per-chat prompt scope and
  differs from getVariable()/listVariables(), which are namespace-scoped.
- No side effects: assigning, removing or reading a batch does not touch the
  variable dependency graph (no recalculation, no edge changes), presets
  (nothing created, renamed, deleted, bound or moved), chat-state values
  (no setVar/seed/increment/delete; stored values and existing snapshots are
  unchanged), macros, events, extension registration, or the capability
  graph. The only change is one variable definition's `batch` field.

Manager modal (src/ui/manager-modal/ui-events.js):

- The inline editor has no batch field, and the definition it saves is built
  as blankDefinition() plus the form's values - which would set `batch` back
  to "core" on every edit and silently pull a variable that was assigned
  elsewhere into the main prompt. The save handler therefore carries the
  stored definition's batch over onto the rebuilt one. Batches are assigned
  through the API; the editor neither shows nor changes them.

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
  only unit this engine stores). Both fields exist on every definition,
  exactly as `batch` does, and mean nothing for any other type. The default
  calendar is "gregorian".
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
- Batch: datetime variables belong to batch "time" (variable-schema.js
  TIME_BATCH). createVariable() puts them there unless the caller names a
  batch, updateVariable() does so when a variable BECOMES a datetime without
  the patch naming one, and the inline editor does the same for a variable
  that becomes a datetime while still in "core".
  CHANGE TO 1.20: 1.20 said the main prompted update asks only about batch
  "core", which would have left every prompted datetime variable (in "time")
  unreachable by the main update and made the prompted-increment rule above
  pointless. The main update now selects batches "core" AND "time"
  (selectBatchVariables accepts a batch name or a list of them; its default is
  still just "core"). Any other batch is still excluded, so a datetime the
  caller moved to another batch is left out.
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
  unit field - the stored one is carried over on save, the same way `batch`
  is. Since 1.22 it has a calendar selector while the type is datetime.

Fantasy calendars (bones only in 1.21, implemented in 1.22):

- Calendar definitions are pluggable objects: anything registered under
  settings.calendars with the fields above. The shape (months with their own
  lengths, leapYearRule, clock constants) is what a fantasy calendar fills in.
- 1.21 implemented ONLY "gregorian" and refused every other leapYearRule. That
  is superseded: see 1.22 for fantasy calendars, their editor UI and the
  calendar CRUD API. A leapYearRule the engine does not implement is still
  refused (throws), never converted with the wrong rules.

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

carrying a snapshot's batch forward when a def with no batch replaces it
(keepSnapshotBatch, 1.20) - nothing else about batching lives here

macro-store.js
macro store operations (getMacroValue, setMacroValue, deleteMacroValue,
macroStore). Named "macro", not "var", deliberately - this is the
{{getvar}}/{{setvar}} mirror, never the source of truth, and nothing
outside chat-state.js should call these directly.

prompted-engine.js
selecting only batch "core" and "time" variables for the main prompted update
(selectBatchVariables, 1.20/1.21)

turning a datetime variable's answer into a scalar via calendar-engine.js
(1.21)

classification of prompted variables

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