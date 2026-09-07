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
import { setVarValue } from './variable-storage.js';

const SCHEMA_VERSION = 1;

function defaultChatState() {
    return {
        variables: {},
        lastUpdated: Date.now(),
        version: SCHEMA_VERSION,
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
        return { value: entry.value, def: entry };
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
        // 1. Update the separate State Engine store.
        const state = loadChatState(chatId);
        state.variables[varName] = {
            ...(state.variables[varName] || {}),
            value,
            type: def?.type || state.variables[varName]?.type || typeof value,
            behaviors: def?.behaviors || state.variables[varName]?.behaviors || {},
            increment: def?.increment || state.variables[varName]?.increment || null,
        };
        saveChatState(chatId, state);

        // 2. Mirror into the macro-visible var store ({{getvar::name}}).
        // This uses the existing varStore/setVarValue mechanism, never chat
        // metadata or chat storage.
        setVarValue(SillyTavern.getContext(), def || { name: varName, type: state.variables[varName].type }, value);
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
        const entry = state.variables[varName];

        if (!entry || typeof entry.value !== 'number') {
            console.warn(LOG_PREFIX, `applyIncrement: no numeric value for "${varName}"`);
            return;
        }

        const next = entry.value + delta;
        entry.value = next;
        saveChatState(chatId, state);

        // Mirror into macro-visible var store
        setVarValue(SillyTavern.getContext(), def || { name: varName, type: 'number' }, next);
    } catch (err) {
        console.warn(LOG_PREFIX, 'applyIncrement failed (gracefully handled)', err);
    }
}
