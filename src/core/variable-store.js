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
import { setVarValue, deleteVarValue } from './variable-storage.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';

const SCHEMA_VERSION = 1;

function defaultChatState() {
    return {
        variables: {},
        lastUpdated: Date.now(),
        version: SCHEMA_VERSION,
        seeded: false
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
            return defaultChatState();
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
// the existing setVarValue()/varStore() mechanism from variable-storage.js.
// That mechanism is context.variables.local/global, not chat metadata, so
// this mirroring does not reintroduce chat storage.
//
// `def` is optional and not part of the originally specified 3-argument
// signature; when a caller passes it (a preset variable definition), it's
// used both to snapshot type/behaviors/increment into the stored entry and
// to route the macro-store mirror write to the right def.name/def.scope.
// Omitting it falls back to whatever type/behaviors/increment were already
// stored, or sane defaults, and mirrors into the macro store as a
// chat-scoped variable named varName.
export function setVar(chatId, varName, value, def) {
    try {
        const state = loadChatState(chatId);

        // 1. Update the isolated store: VALUE ONLY
        const existing = state.variables[varName] || {};
        state.variables[varName] = {
            value
        };

        saveChatState(chatId, state);

        // 2. Mirror into macro store ({{getvar::name}})
        // Use the preset definition (def) for type/scope, NOT stored metadata.
        const macroDef = def || { name: varName, type: 'string' };
        setVarValue(SillyTavern.getContext(), macroDef, value);

    } catch (err) {
        console.warn(LOG_PREFIX, 'setVar failed (gracefully handled)', err);
    }
}


// Reads the current value, adds delta, writes it back — AND mirrors the
// resulting value into the macro-visible var store the same way setVar
// does. Numeric only, per spec ("read current value, add delta, write
// back") - this does not reproduce the boolean-toggle / enum-cycle behavior
// that increment-engine.js's (separate, varStore-based) applyIncrement has.
export function applyIncrement(chatId, varName, delta, def) {
    try {
        const state = loadChatState(chatId);
        console.log(LOG_PREFIX, "****************************");
        console.log(LOG_PREFIX, '[DEBUG] state id:', state);
        console.log(LOG_PREFIX, "state.variables (frozen snapshot): ", JSON.stringify(state.variables));
        console.log(LOG_PREFIX, "state.variables: ", state.variables);
        console.log(LOG_PREFIX, "variables keys: ", Object.keys(state.variables));
        console.log(LOG_PREFIX, "Variables has this key: ", state.variables.hasOwnProperty(varName));
        // Ensure entry exists
        let entry = state.variables[varName];
        console.log(LOG_PREFIX, "Applying increment to: ", varName);
        console.log(LOG_PREFIX, "variables keys: ", Object.keys(state.variables));
        console.log(LOG_PREFIX, "Variables has this key: ", state.variables.hasOwnProperty(varName));
        console.log(LOG_PREFIX, "state.variables[", varName, "]: ", state.variables[varName]);
        console.log(LOG_PREFIX, "Variable Entry: ", entry);
        if (!entry) {
            state.variables[varName] = { value: 0 };
            entry = state.variables[varName];
        }

        // Convert current value to number safely
        let current = Number(entry.value);
        if (Number.isNaN(current)) {
            console.log(LOG_PREFIX, "non-numeric value detectied!!!");
            console.warn(LOG_PREFIX, `applyIncrement: non-numeric value for "${varName}", defaulting to 0`);
            current = 0;
        }

        const next = current + delta;
        console.log(LOG_PREFIX, "Variable next: ", next);

        entry.value = next;
        saveChatState(chatId, state);
        console.log(LOG_PREFIX, "****************************");

        // Mirror into macro-visible var store
        setVarValue(
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

export function seedVariablesForChat(chatId) {
    try {
        if (!chatId) return;
        const activePresetIds = getPresetsForChat(chatId);
        const variables = getAllVariablesFromPresets(activePresetIds);
        const state = loadChatState(chatId);

        for (const def of Object.values(variables)) {
            try {
                if (!def.name) continue;
                if (state.variables[def.name]) continue;

                const value = def.defaultValue ?? null;
                setVar(chatId, def.name, value, def);
                
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
// var store ({{getvar::name}}) via setVar() - never setVarValue() directly.
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
// about, via deleteVarValue() (the same varStore mechanism setVar/
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
                deleteVarValue(context, { name: varName });
            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

// Removes isolated-store entries for chats SillyTavern no longer has.
//
// NOTE: context.chatList is not a confirmed SillyTavern context API from
// anything verifiable in this environment - if it doesn't exist, or has a
// different shape than [{ chatId }], the try/catch below turns that into a
// warning and a no-op rather than a crash, but this should be checked
// against a live SillyTavern console before being relied on.
//
// clearMacroVarsForChat() is called before the isolated entry is deleted
// (reversed from the literal step order given) because it needs that
// entry's variable names to know what to delete - deleting the entry first
// would leave it nothing to clear. In practice, for a genuinely dead chat
// (chatId not in `live`), that chat is essentially never SillyTavern's
// currently active chat either, so this call is a safe no-op most of the
// time (see clearMacroVarsForChat's own active-chat guard) - it's kept for
// the rare case chatId does match, and for symmetry with the spec.
export function cleanupDeadChats() {
    try {
        const context = SillyTavern.getContext();
        console.log(LOG_PREFIX, 'cleanupDeadChats fired. chatList:', context.chatList, 'stored chats:', Object.keys(getStore().chats));

        // NOTE: context.chatList is assumed to be [{ chatId }]. 
        // If SillyTavern changes this structure, update comparison logic accordingly.

        const live = new Set((context.chatList || []).map(c => c.chatId));
        const store = getStore();

        for (const chatId of Object.keys(store.chats)) {
            if (live.has(chatId)) continue;

            try {
                clearMacroVarsForChat(chatId);
            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }

            delete store.chats[chatId];
        }

        persistSettings();
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
