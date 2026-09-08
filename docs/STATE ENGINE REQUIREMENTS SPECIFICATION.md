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

1.8 Dead Chat Cleanup Rule
Dead chat IDs must be removed from both isolated store and macro store.

context.chatList does not exist. It was never a real SillyTavern API -
confirmed absent from a live getContext() dump, and from SillyTavern's own
st-context.js source. Claude must not reference context.chatList or treat
its absence as "no chats are live" - doing so previously wiped the entire
isolated store on every page reload, since every stored chat looked dead
the moment that property was undefined.

The only real way to verify a chat still exists is
POST /api/characters/chats (headers: context.getRequestHeaders(), body:
{ avatar_url, simple: true }), which is scoped to a single character's
avatar_url - there is no global "every chat that exists" endpoint. A
non-ok response or a thrown error from this call means "could not verify"
and must never be treated as "no chats exist for this character."

cleanupDeadChats must run only once, on extension load/startup - NOT on
CHAT_CREATED or CHAT_CHANGED. Now that verification makes real network
calls (one per distinct character/group represented in the store), running
it on every chat switch is repeated, unnecessary work for a check whose
result does not change between chat switches within the same session.

"On extension load" means only after SillyTavern's own app state - in
particular context.characters - has actually populated, not merely as soon
as this extension's own script has finished evaluating. Calling
cleanupDeadChats() bare, synchronously, at the top of registerEvents() ran
it while context.characters was still empty, which made knownAvatars an
empty Set, which made every character in the store look "no longer exists"
and deleted every chat's isolated-store entry outright on every single
page load - including the chat the user had open.

Moving the call into runStartupOnce() (initialization-engine.js) does NOT
by itself fix this. index.js calls registerEvents() (which subscribes
runStartupOnce to APP_READY) and then, in the same synchronous startup,
unconditionally calls runStartupOnce() directly right after - with no check
for whether APP_READY has actually fired yet. Because runStartupOnce's
startupRan guard is a plain boolean with no timing awareness, whichever
call reaches it first consumes the guard; if this extension's own async
setup (registerTemplates/initPanel) resolves before SillyTavern's core
getCharacters() does, the direct call runs everything - including
cleanupDeadChats - just as early as the original bare call did, and the
APP_READY listener never gets to run it at all (startupRan is already
true). So this is still not a reliable readiness signal on its own.

The actual fix is inside cleanupDeadChats() itself: treat an empty/missing
context.characters the same way a failed /api/characters/chats response is
already treated - as "cannot verify right now," never as "confirmed no
characters exist" - and skip the entire pass rather than deleting anything.
This is always safe, not just safe in the race case: if a character list
is genuinely, permanently empty, nothing in store.chats could have a real
characterAvatar stamped on it anyway, so there is nothing a skipped pass
could have correctly cleaned up. The tradeoff is that a pass which bails
out this way never runs again this session (runStartupOnce only fires
once) - dead chats simply accumulate until a future session's startup
happens to run after context.characters is populated. That is an
acceptable cost against the alternative of deleting live, in-use chat
data.

Claude must:

record which character a chat belongs to at the moment its isolated-store
entry is first created (state.characterAvatar), since the store itself is
not otherwise scoped by character

delete a stored chat's entry when either: (a) its recorded character no
longer appears in context.characters at all (that chat can never again be
reached or re-verified, so retaining it serves no purpose), or (b) its
recorded character still exists and a successful /api/characters/chats
call confirms that chat id is no longer present

leave a stored chat's entry untouched when its liveness cannot currently
be verified (fetch failure, non-ok response), and retry on a future
cleanup pass rather than deleting on incomplete information

clear macro variables for a chat before deleting its isolated store entry

Group chats follow the same rule via a separate field, state.groupId,
stamped instead of state.characterAvatar when the chat's entry is first
created while context.groupId is set. Verification needs no server call:
context.groups[i].chats is already the group's authoritative chat-id list,
and context.groups is refreshed on the same cadence as context.characters
(both driven by SillyTavern's getCharacters()), so "group id no longer in
context.groups" is exactly as reliable a "this group is gone, purge its
chats" signal as the character case. A chat entry has exactly one of
characterAvatar or groupId set, never both.

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