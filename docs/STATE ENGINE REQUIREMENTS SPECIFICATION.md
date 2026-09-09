STATE ENGINE REQUIREMENTS SPECIFICATION
Version 1.0 — Authoritative Architectural Rules
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

Deterministic increment operations (chat-state.js
applyArrayOperation(), shared with the prompted-update path below;
deterministic-engine.js itself needed no changes - array operations are
implemented inside applyIncrement(), the same precedent enum-cycling
already set in 1.11.1). Configured via increment.operation and
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

Prompted update rules (prompted-engine.js). An array-typed updateVars
entry accepts exactly two JSON shapes for its key in the model's response,
auto-detected (an array is shape A, an object is checked against shape B,
anything else is skipped rather than written):

A. Full replacement: `"varName": ["a", "b"]` - written via setVar(), which
   sanitizes it per the rules above.
B. Operation object: `` "varName": { "op": "push"|"pop"|"shift"|"unshift"|"rotate"|"clear"|"toggle", "value": <item> } ``
   - applied via the same applyArrayOperation() the deterministic path
   uses, then written via setVar() (so it's sanitized too). "value" is
   required for push/unshift/toggle and ignored otherwise. "cycle" is
   deterministic-only, not offered to the model - it advances a fixed
   sequence rather than expressing anything about conversation content, and
   isn't in the accepted `op` set for prompted updates.
   An unrecognized `op`, or a value that is neither an array nor a
   recognized operation object, is skipped entirely rather than written -
   the model failing to follow the required shape must never corrupt the
   stored array.

describeConstraint() (formatting-utils.js) tells the model, for every
array-typed variable in the prompt: that it's an array, its itemType,
itemEnumValues when itemType is "enum", the active maxLength/unique/sorted
constraints, and the exact two accepted shapes above (including the
allowed `op` values) - this is what actually keeps the model from mixing
formats or replying with anything besides the JSON value for that key.

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

1.15.2 Prompted/Increment Classification for Arrays, and Delete Cleanup

An array-typed variable with both behaviors.prompted and behaviors.increment
checked is always classified as isPromptedUpdate (full-array/operation-
object JSON, 1.15), never isPromptedIncrement (a plain "true or false"
prompt line, meaningless for array content) - regardless of what
increment.operation happens to be configured. Checking "Incremented
Behavior" is disabled in the editor whenever an array already has "Prompted
Behavior" on (mirroring the sorted/increment exclusivity above), and
turning prompted on for an array forces increment off live, not just via
the disabled attribute - a disabled checkbox that stays visually checked
would otherwise still be collected and saved as true by
collectInlineVariableValues(). Before this, such a variable's array content
was silently handed to applyIncrement's deterministic operation/operand
instead of whatever the model actually returned.

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