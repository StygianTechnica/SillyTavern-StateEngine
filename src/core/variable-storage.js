// State Engine — reading/writing variable values in SillyTavern's native
// chat/global variable store.

import { LOG_PREFIX } from './settings-core.js';
import { getDefaultValue } from './variable-definition.js';
import { validateValueStrict } from './variable-validation.js';
import { getPresetsForChat, getAllVariablesFromPresets } from '../core/preset-manager.js';
import { getSettings } from '../core/settings-core.js';
import { shouldSkipPromptedRefresh } from './prompted-engine.js';

export function varStore(context, def) {
    return def.scope === 'global' ? context.variables.global : context.variables.local;
}

export function getVarValue(context, def) {
    const store = varStore(context, def);
    try {
        if (store.has(def.name)) {
            return store.get(def.name);
        }
    } catch (err) {
        console.warn(LOG_PREFIX, `could not read variable "${def.name}"`, err);
    }
    return getDefaultValue(def);
}

export function setVarValue(context, def, rawValue) {
    const store = varStore(context, def);
    const validation = validateValueStrict(def, rawValue);

    if (!validation.valid && validation.error) {
        console.warn(LOG_PREFIX, `Type validation for "${def.name}": ${validation.error}`);
    }

    try {
        store.set(def.name, validation.value);
    } catch (err) {
        console.error(LOG_PREFIX, `could not write variable "${def.name}"`, err);
    }
    return validation.value;
}

// ---------------------------------------------------------------------------
// Persistent per-chat variable storage (chat metadata)
// ---------------------------------------------------------------------------

export function readVarFromChatStorage(context, varName) {
    try {
        const store = context.chatExtensions?.stateEngine?.variables;
        if (!store) return undefined;
        return store[varName];
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        return undefined;
    }
}

export function writeVarToChatStorage(context, varName, value) {
    try {
        if (!context.chatExtensions) {
            context.chatExtensions = {};
        }
        if (!context.chatExtensions.stateEngine) {
            context.chatExtensions.stateEngine = {};
        }
        if (!context.chatExtensions.stateEngine.variables) {
            context.chatExtensions.stateEngine.variables = {};
        }
        context.chatExtensions.stateEngine.variables[varName] = value;
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

export function deleteVarFromChatStorage(context, varName) {
    try {
        const store = context.chatExtensions?.stateEngine?.variables;
        if (store) {
            delete store[varName];
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

export function listVarsInChatStorage(context) {
    try {
        const store = context.chatExtensions?.stateEngine?.variables;
        return store ? Object.keys(store) : [];
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        return [];
    }
}

// Sync must always run, independent of any State Engine LLM work — it is
// never called from inside a promise chain, and every failure here is
// caught and logged rather than thrown, so chat metadata read/write and
// variable persistence are never blocked by an unrelated State Engine error.
export function syncVarStoreToChat(context) {
    try {
        const chatId = context.chatId;
        const activePresetIds = getPresetsForChat(chatId);

        if (activePresetIds.length === 0 && getSettings().defaultPresetForNewChats) {
            activePresetIds.push(getSettings().defaultPresetForNewChats);
        }

        const variables = getAllVariablesFromPresets(activePresetIds);

        const definedNames = new Set(
            Object.values(variables)
                .filter(def => def.name && !shouldSkipPromptedRefresh(def))
                .map(def => def.name)
        );

        // 1. Load chat-stored values into global varStore
        for (const def of Object.values(variables)) {
            if (!def.name || shouldSkipPromptedRefresh(def)) continue;

            // Read from chat storage first
            const storedValue = readVarFromChatStorage(context, def.name);

            // If chat storage has a value, use it
            if (storedValue !== undefined) {
                setVarValue(context, def, storedValue);
                continue;
            }

            // Otherwise apply default
            setVarValue(context, def, def.defaultValue);
        }

        // 2. Remove stale global entries
        const localStore = context.variables.local;
        const globalStore = context.variables.global;

        // Normalize keys for both Map-like and object-like stores
        const localKeys = localStore instanceof Map
            ? Array.from(localStore.keys())
            : Object.keys(localStore);

        const globalKeys = globalStore instanceof Map
            ? Array.from(globalStore.keys())
            : Object.keys(globalStore);

        // Remove stale local variables
        for (const key of localKeys) {
            if (!definedNames.has(key)) {
                if (localStore instanceof Map) {
                    localStore.delete(key);
                } else {
                    delete localStore[key];
                }
                deleteVarFromChatStorage(context, key);
            }
        }

        // Remove stale global variables
        for (const key of globalKeys) {
            if (!definedNames.has(key)) {
                if (globalStore instanceof Map) {
                    globalStore.delete(key);
                } else {
                    delete globalStore[key];
                }
                deleteVarFromChatStorage(context, key);
            }
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}