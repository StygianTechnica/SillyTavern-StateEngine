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

1.14.1 Copy From Previous Chat Rule

On CHAT_CREATED (only - never CHAT_CHANGED), offerCopyFromPreviousChat()
(initialization-engine.js) looks for another stored chat belonging to the
same character (state.characterAvatar) or group (state.groupId) as the new
chat, with at least one stored variable. If one or more exist, the most
recently updated candidate is offered via a single confirm() dialog; on
acceptance, that source chat's variables are copied into the new chat one
at a time through setVar() - never by assigning the whole stored state
object wholesale, since that would also overwrite the new chat's own
characterAvatar/groupId/seeded stamps with the source chat's.

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
  identifier (DSL 9) and retains its previous value with a logged warning,
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

Per docs/TINY EXPRESSION DSL SPECIFICATION.md section 10.3 and this
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

macro-store.js
macro store operations (getMacroValue, setMacroValue, deleteMacroValue,
macroStore). Named "macro", not "var", deliberately - this is the
{{getvar}}/{{setvar}} mirror, never the source of truth, and nothing
outside chat-state.js should call these directly.

prompted-engine.js
classification of prompted variables

LLM‑driven updates

calling setVar / applyIncrement

deterministic-engine.js
deterministic increments

calling applyIncrement

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

never invent new fields

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