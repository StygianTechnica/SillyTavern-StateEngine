// State Engine — preset and preset-scoped variable operations
// Uses ES6 modules - imported by manager-modal.js

import { generateUUID } from './utils.js';

let managerApi = null;

export function setManagerApi(api) {
    managerApi = api;
}

export function moveVariable(presetId, varId, direction) {
    const settings = managerApi.getSettings();
    const preset = settings.presets[presetId];
    if (!preset || !preset.variables) return;

    const entries = Object.entries(preset.variables);
    const idx = entries.findIndex(([id]) => id === varId);
    if (idx === -1) return;

    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= entries.length) return;

    const swapped = entries.slice();
    const tmp = swapped[idx];
    swapped[idx] = swapped[nextIdx];
    swapped[nextIdx] = tmp;
    preset.variables = Object.fromEntries(swapped);
    managerApi.persistSettings(settings);
    return true;
}

export function clonePreset(presetId, newName) {
    const settings = managerApi.getSettings();
    const preset = settings.presets[presetId];
    if (!preset) return null;

    const newPresetId = generateUUID();
    const newPreset = JSON.parse(JSON.stringify(preset));
    newPreset.name = newName;
    settings.presets[newPresetId] = newPreset;
    managerApi.persistSettings(settings);
    return newPresetId;
}

export function toggleVariableVisibility(presetId, varId) {
    const settings = managerApi.getSettings();
    const preset = settings.presets[presetId];
    if (!preset || !preset.variables[varId]) return null;

    const varDef = preset.variables[varId];
    varDef.showInTracker = varDef.showInTracker === false;
    managerApi.persistSettings(settings);
    return varDef;
}

export function deleteVariable(presetId, varId) {
    const settings = managerApi.getSettings();
    const preset = settings.presets[presetId];
    if (!preset || !preset.variables[varId]) return false;

    delete preset.variables[varId];
    managerApi.persistSettings(settings);
    return true;
}

export function updatePresetDescription(presetId, newDescription) {
    const settings = managerApi.getSettings();
    const preset = settings.presets[presetId];
    if (!preset) return null;

    preset.description = newDescription;
    managerApi.persistSettings(settings);
    return preset;
}

export function updatePresetTriggers(presetId, trigger, checked) {
    const settings = managerApi.getSettings();
    const preset = settings.presets[presetId];
    if (!preset) return null;

    if (!preset.triggers) preset.triggers = [];

    if (checked) {
        if (!preset.triggers.includes(trigger)) {
            preset.triggers.push(trigger);
        }
    } else {
        preset.triggers = preset.triggers.filter(t => t !== trigger);
    }

    managerApi.persistSettings(settings);
    return preset;
}
