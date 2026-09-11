// State Engine — wires the manager-modal.js API bag to the split modules
//
// Preset CRUD (createPreset/renamePreset/deletePreset/addPresetToChat/
// removePresetFromChat) routes through src/api/* (stateEngine.*) instead of
// calling src/core/preset-manager.js directly, per docs/STATE ENGINE API
// SPECIFICATION.md. The API layer addresses presets by (namespace, name),
// while every UI call site (ui-events.js, ui-render.js) still addresses
// them by presetId - the small adapters below translate between the two,
// resolving each presetId's preset.namespace/preset.name and calling
// through stateEngine.*, so nothing above this file had to change.
//
// Everything else in this bag (getPresetsForChat, restoreDefaultPresets,
// isVariableNameTaken, generateUniqueVariableName, blankDefinition, plain
// settings/debug/render helpers) has no namespaced equivalent in the API
// layer and stays a direct import - see this pass's implementation report
// for why (Part 8: no API surface was specified for these).

import { setManagerApi } from './manager-modal.js';
import { getSettings, persistSettings, toggleDebugMode, debugLog, BUILTIN_NAMESPACE } from '../../core/settings-core.js';
import { getPresetsForChat, restoreDefaultPresets, isVariableNameTaken, generateUniqueVariableName } from '../../core/preset-manager.js';
import { stateEngine } from '../../api/index.js';
import { getDebugInfo } from '../../core/debug-engine.js';
import { blankDefinition } from '../../core/variable-schema.js';
import { isReservedVariable } from '../../core/validation-utils.js';
import { renderVarTable } from '../manager-modal-ui.js';
import { renderTrackerPanel } from '../tracker-panel-ui.js';
import { setStatus } from '../settings-panel-ui.js';
import { getCurrentChatId } from '../wand-ui.js';

function findPresetById(presetId) {
    return getSettings().presets[presetId] || null;
}

// preset-manager.js's own createPreset()/renamePreset() never enforced
// name uniqueness (only presetId is unique there) - callers (ui-events.js)
// expect "create/rename always succeeds," silently allowing duplicate
// display names. stateEngine.createPreset()/updatePreset() DO require
// (namespace, name) to be unique, since that pair is how a preset is
// addressed. Auto-uniquifying here (rather than letting a collision
// silently no-op) preserves the "always succeeds" behavior without
// loosening the API layer's own addressing invariant.
function uniquePresetName(namespace, desiredName, excludePresetId) {
    const isTaken = (candidate) => Object.entries(getSettings().presets || {}).some(
        ([id, preset]) => id !== excludePresetId && preset?.namespace === namespace && preset?.name === candidate,
    );
    if (!isTaken(desiredName)) return desiredName;
    let n = 2;
    let candidate = `${desiredName} (${n})`;
    while (isTaken(candidate)) {
        n++;
        candidate = `${desiredName} (${n})`;
    }
    return candidate;
}

export function createPresetAdapter(name) {
    const desired = (name || 'New Preset').trim() || 'New Preset';
    const finalName = uniquePresetName(BUILTIN_NAMESPACE, desired, null);
    const created = stateEngine.createPreset({ namespace: BUILTIN_NAMESPACE, name: finalName });
    return created ? created.id : null;
}

export function renamePresetAdapter(presetId, newName) {
    const preset = findPresetById(presetId);
    if (!preset) return;
    const namespace = preset.namespace || BUILTIN_NAMESPACE;
    const finalName = uniquePresetName(namespace, newName, presetId);
    stateEngine.updatePreset(namespace, preset.name, { name: finalName });
}

export function deletePresetAdapter(presetId) {
    const preset = findPresetById(presetId);
    if (!preset) return;
    stateEngine.deletePreset(preset.namespace || BUILTIN_NAMESPACE, preset.name);
}

export function addPresetToChatAdapter(chatId, presetId) {
    const preset = findPresetById(presetId);
    if (!preset) return;
    stateEngine.activatePreset(chatId, preset.namespace || BUILTIN_NAMESPACE, preset.name);
}

export function removePresetFromChatAdapter(chatId, presetId) {
    const preset = findPresetById(presetId);
    if (!preset) return;
    stateEngine.deactivatePreset(chatId, preset.namespace || BUILTIN_NAMESPACE, preset.name);
}

setManagerApi({
    getSettings,
    persistSettings,
    getCurrentChatId,
    createPreset: createPresetAdapter,
    renamePreset: renamePresetAdapter,
    deletePreset: deletePresetAdapter,
    getPresetsForChat,
    addPresetToChat: addPresetToChatAdapter,
    removePresetFromChat: removePresetFromChatAdapter,
    setStatus,
    renderVarTable,
    renderTrackerPanel,
    restoreDefaultPresets,
    toggleDebugMode,
    debugLog,
    getDebugInfo,
    isReservedVariable,
    blankDefinition,
    isVariableNameTaken,
    generateUniqueVariableName
});
