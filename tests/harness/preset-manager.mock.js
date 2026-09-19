// Stand-in for src/core/preset-manager.js: preset CRUD + chat bindings over
// the real settings blob. Only the surface the API layer (and the
// manager-modal adapters) actually import.

import { vi } from 'vitest';
import { getSettings, persistSettings } from '../../src/core/settings-core.js';
import { genId } from '../../src/core/variable-schema.js';
import { seedVariablesForChat } from './chat-state.mock.js';
import { recalculateAllForChat } from './calculated-engine.mock.js';
import { refreshVariableMacros } from './macro-registration.mock.js';

const validChatId = (id) => !!id && id !== 'undefined' && id !== 'null';

function binding(chatId) {
    const s = getSettings();
    s.chatPresetBindings[chatId] ??= { presetIds: [], presetLoadOrder: [] };
    return s.chatPresetBindings[chatId];
}

export const createPreset = vi.fn((name) => {
    const id = genId();
    getSettings().presets[id] = {
        id, name: name || 'New Preset', description: '', variables: {}, triggers: ['ai'], showInTracker: false,
    };
    persistSettings();
    return id;
});

export const renamePreset = vi.fn((presetId, newName) => {
    const preset = getSettings().presets[presetId];
    if (preset) { preset.name = newName; persistSettings(); }
});

export const deletePreset = vi.fn((presetId) => {
    const s = getSettings();
    delete s.presets[presetId];
    for (const b of Object.values(s.chatPresetBindings)) {
        b.presetIds = (b.presetIds || []).filter((id) => id !== presetId);
        b.presetLoadOrder = (b.presetLoadOrder || []).filter((id) => id !== presetId);
    }
    if (s.defaultPresetForNewChats === presetId) s.defaultPresetForNewChats = '';
    persistSettings();
});

export function getPresetsForChat(chatId) {
    if (!validChatId(chatId)) return [];
    return binding(chatId).presetIds;
}

// Mirrors the real function's side effects: bind, then seed + recalculate +
// refresh macros (all three are separate mocks, so tests can assert on them).
export const addPresetToChat = vi.fn((chatId, presetId) => {
    if (!validChatId(chatId)) return;
    const b = binding(chatId);
    if (!b.presetIds.includes(presetId)) b.presetIds.push(presetId);
    if (!b.presetLoadOrder.includes(presetId)) b.presetLoadOrder.push(presetId);
    persistSettings();
    seedVariablesForChat(chatId);
    recalculateAllForChat(chatId);
    refreshVariableMacros();
});

export const removePresetFromChat = vi.fn((chatId, presetId) => {
    if (!validChatId(chatId)) return;
    const b = binding(chatId);
    b.presetIds = b.presetIds.filter((id) => id !== presetId);
    b.presetLoadOrder = b.presetLoadOrder.filter((id) => id !== presetId);
    persistSettings();
    seedVariablesForChat(chatId);
    recalculateAllForChat(chatId);
    refreshVariableMacros();
});

export function getAllVariablesFromPresets(presetIds) {
    const all = {};
    for (const presetId of presetIds) {
        const preset = getSettings().presets[presetId];
        for (const [varId, def] of Object.entries(preset?.variables || {})) {
            if (!all[varId]) all[varId] = def;
        }
    }
    return all;
}

export function isVariableNameTaken(name, excludeVarId) {
    for (const preset of Object.values(getSettings().presets || {})) {
        for (const [varId, def] of Object.entries(preset.variables || {})) {
            if (varId === excludeVarId) continue;
            if (def?.name === name) return true;
        }
    }
    return false;
}

export function generateUniqueVariableName(baseName, excludeVarId) {
    if (!isVariableNameTaken(baseName, excludeVarId)) return baseName;
    let n = 2;
    while (isVariableNameTaken(`${baseName}_${n}`, excludeVarId)) n++;
    return `${baseName}_${n}`;
}

// Starter-preset seeding is not simulated - nothing under test depends on it.
export const restoreDefaultPresets = vi.fn();
