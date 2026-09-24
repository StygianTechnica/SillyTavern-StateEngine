// Variable Value API
//
// The VALUE side of variables, for UI extensions that display State Engine
// state (Pretty Panels) - variable-api.js only ever deals in definitions.
//
//   listAllVariables    every preset in every namespace, each with its
//                       variables - read-only discovery, grouped by preset
//   getVariableValue    one variable's current value in one chat
//   getVariableValues   several at once (one store read)
//   setVariableValue    write a value - OWNER-ONLY, like every other write
//
// Reads are open to any registered caller (resolveCallerRecord: right
// instance, owns SOME namespace) and span every namespace - a display
// extension has to be able to show the user's own `se` variables. They
// return copies; nothing here can mutate a definition or a stored value.
//
// Change notification is not a function here: every value write already
// emits VARIABLES_CHANGED_EVENT on SillyTavern's event bus (see
// src/core/variable-change-signal.js), re-exported below for callers that
// prefer importing the name to hard-coding the string.

import { LOG_PREFIX, getSettings } from '../core/settings-core.js';
import { validateCallerIdentity, resolveCallerRecord } from './identity.js';
import { validateNamespace } from './namespace-manager.js';
import { findPresetEntry } from './preset-api.js';
import { getPresetsForChat } from '../core/preset-manager.js';
import { getVar, setVar } from '../core/chat-state.js';
import { recalculateDependents } from '../core/calculated-engine.js';

export { VARIABLES_CHANGED_EVENT } from '../core/variable-change-signal.js';

// The definition fields a display needs to label and format a value -
// never behaviours, prompts, or anything that would let a caller infer it
// may edit the definition.
const DISPLAY_FIELDS = [
    'name', 'label', 'description', 'type', 'scope',
    'min', 'max', 'enumValues', 'itemType', 'calendar', 'datetimeMode', 'currentKeyVariable',
];

function displayDef(def) {
    const out = {};
    for (const key of DISPLAY_FIELDS) {
        if (def[key] !== undefined) out[key] = structuredClone(def[key]);
    }
    return out;
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

// Finds a variable definition by its fully-qualified name across every
// preset. Returns { preset, presetId, def } or null.
function findDefinition(qualifiedName) {
    for (const [presetId, preset] of Object.entries(getSettings().presets || {})) {
        for (const def of Object.values(preset?.variables || {})) {
            if (def?.name === qualifiedName) return { presetId, preset, def };
        }
    }
    return null;
}

// Every preset in every namespace, each with its variables, sorted by
// namespace then preset name. `chatId` is optional: when given, each
// preset carries `active` - whether it is bound to that chat.
//   [{ id, namespace, name, description, active?, variables: [displayDef...] }]
export function listAllVariables(extensionId, instanceId, chatId) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        const activeIds = chatId ? new Set(getPresetsForChat(chatId)) : null;
        return Object.entries(getSettings().presets || {})
            .filter(([, preset]) => preset && typeof preset === 'object')
            .map(([id, preset]) => ({
                id,
                namespace: preset.namespace ?? '',
                name: preset.name ?? '',
                description: preset.description ?? '',
                ...(activeIds ? { active: activeIds.has(id) } : {}),
                variables: Object.values(preset.variables || {})
                    .filter((def) => def && typeof def.name === 'string')
                    .map(displayDef),
            }))
            .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
    } catch (err) {
        console.warn(LOG_PREFIX, 'listAllVariables failed (gracefully handled)', err);
        return [];
    }
}

// One variable's value in one chat, by fully-qualified name (`se__hp`).
//   { value, def } - def is the display subset of the CURRENT definition
//   (null if no preset defines it any more), or undefined if the chat
//   holds no value for it (never seeded - e.g. its preset isn't active).
export function getVariableValue(extensionId, instanceId, chatId, name) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        if (!chatId || typeof name !== 'string' || !name) return undefined;
        const entry = getVar(chatId, name);
        if (!entry) return undefined;
        const found = findDefinition(name);
        return { value: clone(entry.value), def: found ? displayDef(found.def) : null };
    } catch (err) {
        console.warn(LOG_PREFIX, 'getVariableValue failed (gracefully handled)', err);
        return undefined;
    }
}

// getVariableValue() for several names: { [name]: { value, def } | undefined }.
export function getVariableValues(extensionId, instanceId, chatId, names) {
    resolveCallerRecord(extensionId, instanceId);
    const out = {};
    for (const name of Array.isArray(names) ? names : []) {
        out[name] = getVariableValue(extensionId, instanceId, chatId, name);
    }
    return out;
}

// Writes a value for a variable in the CALLER'S OWN namespace, addressed
// like every other variable call ({ namespace, presetName, variableName }).
// Goes through chat-state.js setVar() - so the same sanitizing, macro
// mirroring and change signal as any engine write - then recalculates
// dependents. Calculated variables are refused (their value only ever
// comes from their expression). Returns true on success, false otherwise.
export function setVariableValue(extensionId, instanceId, chatId, ref, value) {
    validateCallerIdentity(extensionId, instanceId, ref?.namespace);
    try {
        if (!chatId || !ref?.presetName || !ref?.variableName) return false;
        if (!validateNamespace(ref.namespace)) {
            console.warn(LOG_PREFIX, `setVariableValue: namespace "${ref.namespace}" is not registered`);
            return false;
        }
        const entry = findPresetEntry(ref.namespace, ref.presetName);
        if (!entry) {
            console.warn(LOG_PREFIX, `setVariableValue: preset "${ref.namespace}.${ref.presetName}" not found`);
            return false;
        }
        const qualified = `${ref.namespace}__${ref.variableName}`;
        const def = Object.values(entry[1].variables || {}).find((d) => d?.name === qualified);
        if (!def) {
            console.warn(LOG_PREFIX, `setVariableValue: "${qualified}" not found in "${ref.presetName}"`);
            return false;
        }
        if (def.type === 'calculated') {
            console.warn(LOG_PREFIX, `setVariableValue: "${qualified}" is calculated - its value comes from its expression`);
            return false;
        }
        setVar(chatId, qualified, clone(value), def);
        recalculateDependents(chatId, qualified);
        return true;
    } catch (err) {
        console.warn(LOG_PREFIX, 'setVariableValue failed (gracefully handled)', err);
        return false;
    }
}
