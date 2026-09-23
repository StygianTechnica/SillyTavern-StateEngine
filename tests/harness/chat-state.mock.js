// Stand-in for src/core/chat-state.js: the isolated per-chat variable store
// (settings.variableStore.chats[chatId].variables) plus the macro-store
// mirror (context.variables.local). One consistent state object per chat -
// none of the real module's array sanitizing, type coercion, or
// characterAvatar/groupId stamping.

import { vi } from 'vitest';
import { getSettings, persistSettings } from '../../src/core/settings-core.js';
import { getDefaultValue } from '../../src/core/variable-schema.js';
import { incrementScalar, normalizeForDatetimeMode } from '../../src/core/calendar-engine.js';
import context from './context.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.mock.js';

function store() {
    const s = getSettings();
    s.variableStore ??= { chats: {} };
    s.variableStore.chats ??= {};
    return s.variableStore;
}

export function loadChatState(chatId) {
    const chats = store().chats;
    chats[chatId] ??= { variables: {}, lastUpdated: Date.now(), version: 1, seeded: false, characterAvatar: null, groupId: null };
    return chats[chatId];
}

export function saveChatState(chatId, state) {
    store().chats[chatId] = state;
    persistSettings();
}

export function getVar(chatId, varName) {
    const entry = loadChatState(chatId).variables[varName];
    return entry ? { value: entry.value, def: entry.def } : undefined;
}

export const setVar = vi.fn((chatId, varName, value, def) => {
    const state = loadChatState(chatId);
    const previous = state.variables[varName]?.def;
    const snapshot = def ?? previous ?? null;
    // Datetime mode (requirements spec 1.36): mirrors the real setVar()'s own
    // normalization, the same reason incrementScalar (below) already mirrors
    // the real applyIncrement()'s datetime branch - every OTHER suite that
    // uses this standard mock (not just datetime.test.js, which also tests
    // the real module directly via realChatState) needs dateOnly/timeOnly to
    // actually behave, not silently no-op.
    const storedValue = snapshot?.type === 'datetime'
        ? normalizeForDatetimeMode(snapshot.calendar || 'gregorian', value, snapshot.datetimeMode)
        : value;
    state.variables[varName] = { value: storedValue, def: snapshot };
    persistSettings();
    context.variables.local.set(varName, storedValue);
});

export const applyIncrement = vi.fn((chatId, varName, delta, def) => {
    const entry = loadChatState(chatId).variables[varName];
    const current = entry ? entry.value : (def?.type === 'datetime' ? getDefaultValue(def) : 0);
    // Datetime steps through the REAL calendar engine, like the real module
    // (whose own applyIncrement is tested directly in datetime.test.js).
    const next = def?.type === 'datetime'
        ? incrementScalar(def.calendar || 'gregorian', Number(current), delta)
        : def?.type === 'boolean' ? !current : Number(current) + Number(delta);
    setVar(chatId, varName, next, def);
});

export const seedVariablesForChat = vi.fn((chatId) => {
    if (!chatId) return;
    const state = loadChatState(chatId);
    const defs = getAllVariablesFromPresets(getPresetsForChat(chatId));
    for (const def of Object.values(defs)) {
        if (!def.name || Object.prototype.hasOwnProperty.call(state.variables, def.name)) continue;
        setVar(chatId, def.name, getDefaultValue(def), def);
    }
    state.seeded = true;
    persistSettings();
});

export const resetValueIfTypeChanged = vi.fn((chatId, def) => {
    if (!chatId || !def?.name || !def?.type) return;
    const entry = loadChatState(chatId).variables[def.name];
    if (!entry || !entry.def?.type || entry.def.type === def.type) return;
    setVar(chatId, def.name, getDefaultValue(def), def);
});

export const deleteVariableValueEverywhere = vi.fn((varName) => {
    if (!varName) return;
    for (const state of Object.values(store().chats)) delete state?.variables?.[varName];
    context.variables.local.del(varName);
    persistSettings();
});

export const hydrateMacroStoreForChat = vi.fn((chatId) => {
    for (const [name, entry] of Object.entries(loadChatState(chatId).variables)) {
        context.variables.local.set(name, entry.value);
    }
});

export const clearMacroVarsForChat = vi.fn((chatId) => {
    for (const name of Object.keys(loadChatState(chatId).variables)) context.variables.local.del(name);
});
