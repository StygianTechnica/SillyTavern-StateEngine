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