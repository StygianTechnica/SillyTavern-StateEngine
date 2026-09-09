// State Engine — isolated per-chat variable store
//
// This extension runs entirely in the browser (a SillyTavern front-end UI
// extension), which has no filesystem access - there is no `fs`, no Node
// runtime, and no build step in this project to provide one. A literal
// extensions/state-engine/data/chats/<chatId>.json layout with temp-file
// atomic writes is therefore not something this code can implement.
//
// Instead, this module backs the exact same API/schema shape onto
// context.extensionSettings[MODULE_NAME] - the same persistence substrate
// this extension already uses for its own settings and presets, saved via
// the existing getSettings()/persistSettings() (SillyTavern's
// saveSettingsDebounced()). That storage bucket is completely separate
// from SillyTavern's chat metadata, so State Engine variable values can
// never leak into or corrupt the chat prompt/request.
//
// This module is the single source of truth for State Engine variable
// *values*. It never reads or writes SillyTavern chat storage/metadata.

import { LOG_PREFIX, getSettings, persistSettings } from './settings-core.js';
import { setMacroValue, deleteMacroValue } from './macro-store.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Typed-array validation, constraints, and operations
// ---------------------------------------------------------------------------

// One array item's validity against def.itemType (and, for object items,
// def.itemSchema's per-field type checks). Never throws - an item that
// can't be checked safely (e.g. a malformed itemSchema) is just rejected.
function isValidArrayItem(item, itemType, def) {
    switch (itemType) {
        case 'string':
            return typeof item === 'string';
        case 'number':
            return typeof item === 'number' && Number.isFinite(item);
        case 'boolean':
            return typeof item === 'boolean';
        case 'enum': {
            const allowed = Array.isArray(def?.itemEnumValues) ? def.itemEnumValues : [];
            return typeof item === 'string' && allowed.includes(item);
        }
        case 'object': {
            if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
            const schema = (def?.itemSchema && typeof def.itemSchema === 'object') ? def.itemSchema : {};
            return Object.entries(schema).every(([fieldName, fieldSpec]) => {
                if (!Object.prototype.hasOwnProperty.call(item, fieldName)) return false;
                const fieldValue = item[fieldName];
                switch (fieldSpec?.type) {
                    case 'string': return typeof fieldValue === 'string';
                    case 'number': return typeof fieldValue === 'number' && Number.isFinite(fieldValue);
                    case 'boolean': return typeof fieldValue === 'boolean';
                    case 'enum': {
                        const allowedField = Array.isArray(fieldSpec.enumValues) ? fieldSpec.enumValues : [];
                        return allowedField.includes(fieldValue);
                    }
                    default:
                        return true; // Unrecognized/unspecified field type - presence check only.
                }
            });
        }
        case 'any':
        default:
            return true;
    }
}

// Ordering used when def.sorted is true. Each itemType has an explicit rule
// (never a generic fallback that could silently misorder a type it wasn't
// designed for):
//   number  -> ascending numeric
//   string  -> lexicographic
//   enum    -> by position in itemEnumValues (not alphabetic)
//   boolean -> false before true
//   object, any -> lexicographic by JSON.stringify(item)
function sortArrayItems(items, itemType, def) {
    const copy = [...items];
    switch (itemType) {
        case 'number':
            return copy.sort((a, b) => a - b);
        case 'string':
            return copy.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        case 'enum': {
            const order = Array.isArray(def?.itemEnumValues) ? def.itemEnumValues : [];
            // A missing/empty itemEnumValues has no ordering to sort by -
            // skip explicitly rather than relying on indexOf always
            // returning -1 (which happens to leave the array untouched via
            // a stable sort anyway, but only by accident).
            if (order.length === 0) return copy;
            return copy.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        }
        case 'boolean':
            return copy.sort((a, b) => (a === b ? 0 : a ? 1 : -1));
        case 'object':
        case 'any':
        default:
            return copy.sort((a, b) => {
                const sa = JSON.stringify(a);
                const sb = JSON.stringify(b);
                return sa < sb ? -1 : sa > sb ? 1 : 0;
            });
    }
}

// Coerces rawValue into a real array (backward compatibility: anything that
// isn't an array, or a JSON-array string, becomes [] - never reinterpreted,
// never thrown on), validates every item against def.itemType, then applies
// unique/sorted/maxLength in that order. This is the single place array
// values get sanitized - setVar() and applyIncrement() both funnel through
// it, so the isolated store (the source of truth, spec 1.1) never holds an
// unsanitized array even transiently.
function sanitizeArrayValue(def, rawValue) {
    let arr;
    if (Array.isArray(rawValue)) {
        arr = rawValue;
    } else if (typeof rawValue === 'string' && rawValue.trim()) {
        try {
            const parsed = JSON.parse(rawValue);
            arr = Array.isArray(parsed) ? parsed : [];
        } catch {
            arr = [];
        }
    } else {
        arr = [];
    }

    const itemType = def?.itemType || 'any';
    let items = arr.filter((item) => isValidArrayItem(item, itemType, def));

    if (def?.unique) {
        // Strict-equality dedup (a Set's membership check is SameValueZero,
        // effectively === for these purposes). Object items are compared by
        // reference, not content - two content-identical-but-distinct
        // objects (e.g. freshly parsed from separate JSON payloads) will not
        // be deduped against each other. This is a direct, literal reading
        // of "deduplicate using strict equality" with no per-type exception.
        const seen = new Set();
        items = items.filter((item) => {
            if (seen.has(item)) return false;
            seen.add(item);
            return true;
        });
    }

    if (def?.sorted) {
        items = sortArrayItems(items, itemType, def);
    }

    if (Number.isFinite(def?.maxLength) && def.maxLength >= 0 && items.length > def.maxLength) {
        items = items.slice(0, def.maxLength);
    }

    return items;
}

// Applies one array operation to a copy of currentArray and returns the
// (unsanitized) result - every caller (applyIncrement below, and
// prompted-engine.js for LLM-issued operation objects) writes the result
// through setVar(), which runs it through sanitizeArrayValue() before it
// ever reaches the isolated store. Unrecognized operations (including the
// object-array incrementField/toggleField stubs, not yet implemented) are a
// no-op - never throws.
export function applyArrayOperation(currentArray, operation, value, def) {
    const arr = Array.isArray(currentArray) ? [...currentArray] : [];

    switch (operation) {
        case 'push':
            arr.push(value);
            return arr;
        case 'unshift':
            arr.unshift(value);
            return arr;
        case 'pop':
            arr.pop();
            return arr;
        case 'shift':
            arr.shift();
            return arr;
        case 'rotate':
            // Move the last element to the front.
            if (arr.length > 1) arr.unshift(arr.pop());
            return arr;
        case 'clear':
            return [];
        case 'toggle': {
            // Enum arrays only: if value is present, remove it; else add it.
            const idx = arr.indexOf(value);
            if (idx === -1) arr.push(value);
            else arr.splice(idx, 1);
            return arr;
        }
        case 'cycle': {
            // Enum arrays only: replace the array with a single-element
            // array containing the next enum value. "currentValue" for the
            // indexOf lookup is the array's own last element - this
            // operation is meant to maintain a single-element array, so an
            // array that already has more than one element (e.g. from a mix
            // of push and cycle) still resolves against whichever element is
            // last. An empty array starts at itemEnumValues[0].
            const list = Array.isArray(def?.itemEnumValues) ? def.itemEnumValues : [];
            if (list.length === 0) return arr;
            const current = arr.length > 0 ? arr[arr.length - 1] : undefined;
            const idx = list.indexOf(current);
            const next = idx === -1 ? list[0] : list[(idx + 1) % list.length];
            return [next];
        }
        default:
            return arr;
    }
}

function defaultChatState(characterAvatar, groupId) {
    return {
        variables: {},
        lastUpdated: Date.now(),
        version: SCHEMA_VERSION,
        seeded: false,
        // Which character or group this chat belongs to, so
        // cleanupDeadChats() can tell chats apart when deciding what's safe
        // to delete. Exactly one of these is ever set - a chat is either a
        // solo chat (characterAvatar) or a group chat (groupId). Only known
        // for certain at the moment a chat's entry is first created (see
        // loadChatState below) - both null when that can't be determined.
        characterAvatar: characterAvatar ?? null,
        groupId: groupId ?? null,
    };
}

function getStore() {
    const settings = getSettings();
    if (!settings.variableStore || typeof settings.variableStore !== 'object') {
        settings.variableStore = { chats: {} };
    }
    if (!settings.variableStore.chats || typeof settings.variableStore.chats !== 'object') {
        settings.variableStore.chats = {};
    }
    return settings.variableStore;
}

// Reads <chatId>'s state, or an empty default state if none has been saved
// yet. Never throws.
export function loadChatState(chatId) {
    try {
        if (!chatId) return defaultChatState();
        const store = getStore();
        const state = store.chats[chatId];
        if (!state || typeof state !== 'object') {
            const context = SillyTavern.getContext();
            if (context.groupId) {
                return defaultChatState(null, context.groupId);
            }
            const characterAvatar = context.characters?.[context.characterId]?.avatar ?? null;
            return defaultChatState(characterAvatar, null);
        }
        return state;
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        return defaultChatState();
    }
}

// Writes the full state object back for <chatId>. Never throws.
export function saveChatState(chatId, state) {
    try {
        if (!chatId) return;
        const store = getStore();
        store.chats[chatId] = state;
        persistSettings();
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

// Returns { value, def } for a stored variable, or undefined if it has
// never been written for this chat. `def` here is whatever
// type/behaviors/increment metadata was captured alongside the value (see
// setVar's optional def argument below) - it is a snapshot, not a live
// preset lookup.
export function getVar(chatId, varName) {
    try {
        const state = loadChatState(chatId);
        const entry = state.variables[varName];
        if (!entry) return undefined;

        // Look up the preset definition fresh
        const presetIds = getPresetsForChat(chatId);
        const defs = getAllVariablesFromPresets(presetIds);
        const def = defs[varName];

        return { value: entry.value, def };
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        return undefined;
    }
}


// Updates variables[varName].value and writes the state back — AND mirrors
// the same value into the macro-visible var store ({{getvar::name}}) via
// the existing setMacroValue()/macroStore() mechanism from macro-store.js.
// That mechanism is context.variables.local/global, not chat metadata, so
// this mirroring does not reintroduce chat storage.
//
// `def` is optional and not part of the originally specified 3-argument
// signature; when a caller passes it (a preset variable definition), it's
// snapshotted onto the stored entry as entry.def (the canonical schema at
// write time, never hand-copied individual fields that could drift out of
// sync with variable-schema.js) and used to route the macro-store mirror
// write to the right def.name/def.scope. Omitting it falls back to
// whatever def was already stored, and mirrors into the macro store as a
// chat-scoped variable named varName.
export function setVar(chatId, varName, value, def) {
    try {
        const state = loadChatState(chatId);

        // 1. Update the isolated store: the value, plus a snapshot of the
        // canonical schema (def) that produced it.
        const existing = state.variables[varName] || {};
        const effectiveDef = def ?? existing.def ?? null;

        // Array values are validated/sanitized here (itemType, maxLength,
        // unique, sorted) so the isolated store - the source of truth, spec
        // 1.1 - never holds an unvalidated array, not even transiently
        // before the macro-store mirror below.
        const storedValue = effectiveDef?.type === 'array'
            ? sanitizeArrayValue(effectiveDef, value)
            : value;

        state.variables[varName] = {
            value: storedValue,
            def: effectiveDef,
        };

        saveChatState(chatId, state);

        // 2. Mirror into macro store ({{getvar::name}})
        // Use the preset definition (def) for type/scope, NOT stored metadata.
        const macroDef = def || { name: varName, type: 'string' };
        setMacroValue(SillyTavern.getContext(), macroDef, storedValue);

    } catch (err) {
        console.warn(LOG_PREFIX, 'setVar failed (gracefully handled)', err);
    }
}


// Reads the current value and writes back the next one — AND mirrors the
// result into the macro-visible var store the same way setVar does. For
// def.type === 'enum' this cycles through def.enumValues instead of adding
// delta (enum values are never coerced to numbers); every other type keeps
// the original numeric "read current value, add delta, write back" behavior.
export function applyIncrement(chatId, varName, delta, def) {
    try {
        const state = loadChatState(chatId);
        // Ensure entry exists
        let entry = state.variables[varName];
        if (!entry) {
            // Type-aware: a bare `0` here for an array-typed def would sit in
            // the isolated store as a real type mismatch if this call's own
            // operation turns out to be unconfigured (see the array branch
            // below, which returns before ever touching entry.value in that
            // case) - visible verbatim wherever something reads state.variables
            // directly rather than through getMacroValue's array-aware fallback
            // (e.g. the Variable Management tab's JSON preview).
            state.variables[varName] = { value: def?.type === 'array' ? [] : 0, def: def ?? null };
            entry = state.variables[varName];
        } else if (def) {
            // Keep the stored schema snapshot current. This never sources
            // delta itself - delta is always the caller's live argument,
            // read fresh from the current preset definitions before this
            // call, never from this (or any) stored snapshot.
            entry.def = def;
        }

        let next;
        if (def?.type === 'enum') {
            const list = Array.isArray(def.enumValues) ? def.enumValues : [];
            if (list.length === 0) {
                // Nothing to cycle through - leave the value untouched.
                saveChatState(chatId, state);
                return;
            }
            const idx = list.indexOf(entry.value);
            next = idx === -1 ? list[0] : list[(idx + 1) % list.length];
        } else if (def?.type === 'array') {
            const operation = def.increment?.operation;
            if (!operation) {
                // No operation configured - do nothing, per spec.
                saveChatState(chatId, state);
                return;
            }
            const currentArr = Array.isArray(entry.value) ? entry.value : [];
            const result = applyArrayOperation(currentArr, operation, def.increment?.operand, def);
            next = sanitizeArrayValue(def, result);
        } else {
            // Convert current value to number safely
            let current = Number(entry.value);
            if (Number.isNaN(current)) {
                console.warn(LOG_PREFIX, `applyIncrement: non-numeric value for "${varName}", defaulting to 0`);
                current = 0;
            }
            next = current + delta;
        }

        entry.value = next;
        saveChatState(chatId, state);

        // Mirror into macro-visible var store
        setMacroValue(
            SillyTavern.getContext(),
            def || { name: varName, type: 'number' },
            next
        );
    } catch (err) {
        console.warn(LOG_PREFIX, 'applyIncrement failed (gracefully handled)', err);
    }
}



// Seeds any preset variable that doesn't yet have an entry in this chat's
// isolated state, so the store (and the macro mirror) is never empty for a
// chat that has active presets. Writes exclusively through setVar() - never
// mutates state.variables directly - so the isolated store and the macro
// mirror stay in sync through the one write path.
//

// If a stored variable's snapshotted def.type no longer matches the
// variable's current type, its value is stale (a number left over from a
// number/boolean/enum definition, say) and must be reset to the new type's
// default rather than being reinterpreted. Never touches enumValues or
// defaultValue - only the stored value/def snapshot for this one chat.
export function resetValueIfTypeChanged(chatId, def) {
    try {
        if (!chatId || !def?.name || !def?.type) return;
        const state = loadChatState(chatId);
        const entry = state.variables[def.name];
        if (!entry) return;

        const oldType = entry.def?.type;
        const newType = def.type;
        if (!oldType || oldType === newType) return;

        const next = def.defaultValue ?? null;
        state.variables[def.name] = {
            value: next,
            def,
        };
        saveChatState(chatId, state);

        // Mirror into macro store
        setMacroValue(SillyTavern.getContext(), def, next);
    } catch (err) {
        console.warn(LOG_PREFIX, 'resetValueIfTypeChanged failed (gracefully handled)', err);
    }
}

// Removes one variable's stored value from every chat's isolated-store
// entry (and its macro mirror, for whichever chat is currently open - the
// only chat context.variables.local can ever reach). Used when a variable
// is deleted from a preset: without this, its stored value simply outlives
// the deletion, and seedVariablesForChat()'s hasOwnProperty check (which
// exists precisely so seeding never resets an EXISTING variable's value,
// per 1.12) can't distinguish "this name was never seeded" from "this name
// belonged to a since-deleted variable" - so a new variable recreated under
// the same name would silently resurrect the old one's value instead of
// seeding its own default. This is scoped to an explicit delete action, not
// a general "reset on definition change" - 1.12 still forbids resetting a
// value just because a variable was edited/renamed/redefined.
export function deleteVariableValueEverywhere(varName) {
    try {
        if (!varName) return;
        const store = getStore();
        const context = SillyTavern.getContext();
        let changed = false;

        for (const state of Object.values(store.chats)) {
            if (!state?.variables || !Object.prototype.hasOwnProperty.call(state.variables, varName)) continue;
            delete state.variables[varName];
            changed = true;
        }

        if (changed) persistSettings();

        try {
            deleteMacroValue(context, { name: varName });
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'deleteVariableValueEverywhere failed (gracefully handled)', err);
    }
}

export function seedVariablesForChat(chatId) {
    try {
        if (!chatId) return;
        const activePresetIds = getPresetsForChat(chatId);
        const variables = getAllVariablesFromPresets(activePresetIds);
        const state = loadChatState(chatId);

        for (const def of Object.values(variables)) {
            try {
                if (!def.name) continue;
                if (Object.prototype.hasOwnProperty.call(state.variables, def.name)) continue;

                const value = def.defaultValue ?? null;
                setVar(chatId, def.name, value, def);

            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        }

        for (const def of Object.values(variables)) {
            try {
                if (!def.name) continue;
                resetValueIfTypeChanged(chatId, def);
            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        }

        state.seeded = true;
        saveChatState(chatId, state);
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

// Mirrors this chat's already-stored isolated values into the macro-visible
// var store ({{getvar::name}}) via setVar() - never setMacroValue() directly.
// Used on CHAT_CHANGED, where (per spec 3.1) seeding is forbidden: this only
// republishes what's already in the isolated store, and skips any preset
// variable that has no stored entry yet - no defaults, no seeding, no new
// isolated-store entries are created.
export function hydrateMacroStoreForChat(chatId) {
    try {
        if (!chatId) return;
        const state = loadChatState(chatId);
        const activePresetIds = getPresetsForChat(chatId);
        const variables = getAllVariablesFromPresets(activePresetIds);

        for (const def of Object.values(variables)) {
            try {
                if (!def.name) continue;
                const stored = state.variables[def.name];
                if (!stored) continue; // not seeded yet - do not invent a value

                setVar(chatId, def.name, stored.value, def);
            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

// Deletes every macro-visible variable this chat's isolated state knows
// about, via deleteMacroValue() (the same macroStore mechanism setVar/
// applyIncrement already mirror through) - never chat metadata.
//
// context.variables.local only ever reflects the chat SillyTavern currently
// has open (it swaps automatically on chat switch); there is no API this
// extension can use to reach a *different* chat's macro variables. So this
// can only actually delete anything when chatId is the chat that's active
// right now - for any other chatId it safely no-ops (see cleanupDeadChats).
export function clearMacroVarsForChat(chatId) {
    try {
        if (!chatId) return;
        const context = SillyTavern.getContext();
        if (context.chatId !== chatId) return;

        const state = loadChatState(chatId);
        for (const varName of Object.keys(state.variables || {})) {
            try {
                deleteMacroValue(context, { name: varName });
            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

export function migrateStateStore() {
    const store = getStore();
    for (const chatId of Object.keys(store.chats)) {
        const state = loadChatState(chatId);
        for (const name of Object.keys(state.variables)) {
            const value = state.variables[name].value;
            state.variables[name] = { value };
        }
        saveChatState(chatId, state);
    }
}
