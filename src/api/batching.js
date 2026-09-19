// Variable Batching System
//
// Every variable belongs to exactly one BATCH (def.batch, default "core" -
// variable-schema.js). A batch is a PROMPT SCOPE: it decides which variables
// appear together in a prompt. It is not a preset - a preset is an arbitrary
// folder a user groups variables into, and one preset's variables can sit in
// any mix of batches. The main prompted update (prompted-engine.js) only
// asks about batch "core"; anything an extension assigns elsewhere stays out
// of that prompt, which is what stops a large preset from bloating it, and
// is what independent presets will build their own prompts from
// (batchPrompt). See docs/STATE ENGINE REQUIREMENTS SPECIFICATION.md 1.20.
//
// Writes (assignBatch / removeBatch) change one definition field and
// persist. Reads (getBatch / getBatches / batchPrompt) are pure. Nothing here
// touches the variable dependency graph, presets, chat-state VALUES,
// registration, the capability graph, macros or events.

import { getSettings, persistSettings } from '../core/settings-core.js';
import { DEFAULT_BATCH, batchOf, getDefaultValue } from '../core/variable-schema.js';
import { getPresetsForChat, getAllVariablesFromPresets } from '../core/preset-manager.js';
import { getVar } from '../core/chat-state.js';
import { resolveCallerRecord } from './identity.js';
import { normalizeBatchName } from './batch-rules.js';

function reject(reason) {
    throw new Error(`Batch assignment rejected: ${reason}`);
}

// The caller's own variable named `variableName` - accepted as either the
// local name ("mood") or the stored qualified name ("pp__mood") - or null.
// Only presets in the caller's OWN namespace are searched, so a variable
// that exists in another namespace is, to this caller, simply not there.
function findOwnedVariable(namespace, variableName) {
    if (typeof variableName !== 'string' || !variableName) reject('variableName must be a non-empty string');
    const prefix = `${namespace}__`;
    const qualified = variableName.startsWith(prefix) ? variableName : `${prefix}${variableName}`;

    for (const preset of Object.values(getSettings().presets || {})) {
        if (preset?.namespace !== namespace) continue;
        for (const [varId, def] of Object.entries(preset.variables || {})) {
            if (def?.name === qualified) return { preset, varId, def };
        }
    }
    return null;
}

function setBatch(extensionId, instanceId, variableName, batchName, { normalize }) {
    const record = resolveCallerRecord(extensionId, instanceId);
    const batch = normalize(batchName);

    const found = findOwnedVariable(record.namespace, variableName);
    if (!found) reject(`variable '${variableName}' does not exist in namespace '${record.namespace}'`);

    // A NEW definition object, not a mutation - the same rule updateVariable()
    // follows: chat-state.js's entry.def snapshot can be the very same object
    // as this one, and a snapshot is meant to change when the variable is next
    // WRITTEN (setVar), not silently underneath a chat that isn't being touched.
    found.preset.variables[found.varId] = { ...found.def, batch };
    persistSettings();
    return batch;
}

// Moves one of the caller's variables into `batchName`. Returns the stored
// (trimmed) batch name. Throws on: a wrong instance, an extension that owns
// no namespace, a variable that doesn't exist in the caller's namespace, or
// a batchName that isn't a non-empty string without line breaks. Validation
// finishes before anything is written.
export function assignBatch(extensionId, instanceId, variableName, batchName) {
    return setBatch(extensionId, instanceId, variableName, batchName, {
        normalize: (value) => normalizeBatchName(value, reject),
    });
}

// Puts the variable back in the default batch ("core"). Returns "core".
export function removeBatch(extensionId, instanceId, variableName) {
    return setBatch(extensionId, instanceId, variableName, DEFAULT_BATCH, { normalize: (value) => value });
}

// ---- reads: no identity, pure, always copies ------------------------------
//
// These are keyed by chat, not by namespace: a batch spans every extension's
// variables that are active in that chat, because a prompt is assembled per
// chat. That also means they expose those variables' names and VALUES to any
// caller - unlike getVariable()/listVariables(), which are namespace-scoped.

// The variables active for `chatId` (in a preset bound to that chat), in
// preset load order. Live definitions, not chat-state snapshots: entry.def is
// a per-write snapshot for inspection and is never used to make a live
// decision (requirements spec, Section 6).
function activeDefinitions(chatId) {
    if (!chatId) return [];
    return Object.values(getAllVariablesFromPresets(getPresetsForChat(chatId))).filter((def) => def?.name);
}

// The stored value, or the type's default if the variable hasn't been seeded
// into this chat yet - the same fallback prompted-engine.js's own prompt uses.
function currentValue(chatId, def) {
    const stored = getVar(chatId, def.name);
    return stored ? stored.value : getDefaultValue(def);
}

// Every variable in batch `batchName` that is active for `chatId`:
// [{ name, value, def }], where `def` is a copy of the definition.
// [] for an unknown batch, an empty batch, or invalid arguments.
export function getBatch(batchName, chatId) {
    if (typeof batchName !== 'string' || !batchName) return [];
    return activeDefinitions(chatId)
        .filter((def) => batchOf(def) === batchName)
        .map((def) => ({ name: def.name, value: currentValue(chatId, def), def: JSON.parse(JSON.stringify(def)) }));
}

// { [batchName]: [variableName, ...] } for every variable active for
// `chatId` - only batches that have at least one variable appear.
export function getBatches(chatId) {
    const batches = {};
    for (const def of activeDefinitions(chatId)) {
        (batches[batchOf(def)] ??= []).push(def.name);
    }
    return batches;
}

// The prompt segment for one batch:
//
//     ### CORE
//     pp__hp = 10
//     pp__mood = "calm"
//
// One `name = JSON` line per variable in that batch, nothing else - no chat
// transcript, no instructions, no variable from any other batch. '' if the
// batch has no variables active for this chat, so a caller can skip it.
export function batchPrompt(batchName, chatId) {
    const variables = getBatch(batchName, chatId);
    if (variables.length === 0) return '';
    return [`### ${batchName.toUpperCase()}`, ...variables.map((v) => `${v.name} = ${JSON.stringify(v.value)}`)].join('\n');
}
