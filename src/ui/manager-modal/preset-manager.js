// State Engine — preset and preset-scoped variable operations
// Uses ES6 modules - imported by manager-modal.js

import {genId} from '../../core/variable-schema.js'
import { deleteVariableValueEverywhere } from '../../core/chat-state.js';
import { isVariableNameTaken, generateUniqueVariableName } from '../../core/preset-manager.js';

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

// Cloning must never produce two presets sharing a variable name/id: the
// isolated store and macro store are both keyed by name (not id), so a
// clone that kept the source's exact names would collide with the source
// the moment either preset is active - and a JSON deep-clone also kept
// the exact same variable ids, which would have let a later
// isVariableNameTaken(name, excludeVarId) call in one preset accidentally
// also exclude the identically-id'd variable in the OTHER preset from its
// own collision check. Pre-existing bug (present before this pass);
// root-caused and fixed 2026-09-10.
export function clonePreset(presetId, newName) {
    const settings = managerApi.getSettings();
    const preset = settings.presets[presetId];
    if (!preset) return null;

    const newPresetId = genId();
    const newPreset = JSON.parse(JSON.stringify(preset));
    newPreset.id = newPresetId;
    newPreset.name = newName;

    // Every cloned variable gets a fresh id and a fresh, globally-unique
    // name. generateUniqueVariableName() is called with no excludeVarId -
    // the source preset's own identically-named variable must always
    // register as "taken" here (it still exists, unrenamed, under its own
    // id in settings.presets[presetId]), so every clone variable reliably
    // gets renamed, not just ones that happen to also collide with some
    // unrelated third preset.
    const nameRenameMap = new Map(); // old name -> new (unique) name
    const renamedVariables = {};

    for (const def of Object.values(newPreset.variables || {})) {
        const newId = genId();
        const finalName = generateUniqueVariableName(def.name);
        if (finalName !== def.name) nameRenameMap.set(def.name, finalName);

        def.id = newId;
        def.name = finalName;
        renamedVariables[newId] = def;
    }
    newPreset.variables = renamedVariables;

    // A calculated variable within the clone references its SIBLINGS by
    // name (dependencies/expression) - those siblings were just renamed
    // above, so the references must be rewritten to match, or the clone's
    // calculated variables would silently point at the SOURCE preset's
    // variables instead of its own copies. Same word-boundary-safe
    // approach as settings-core.js's migrateToBuiltinNamespace(), for the
    // same reason (never a raw substring replace - renaming "hp" must
    // never also touch "hp_max").
    for (const def of Object.values(newPreset.variables)) {
        if (def?.type !== 'calculated') continue;
        if (Array.isArray(def.dependencies)) {
            def.dependencies = def.dependencies.map((depName) => nameRenameMap.get(depName) ?? depName);
        }
        if (typeof def.expression === 'string' && def.expression) {
            for (const [oldName, newNm] of nameRenameMap) {
                def.expression = def.expression.replace(
                    new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
                    newNm,
                );
            }
        }
    }

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

    const varName = preset.variables[varId].name;
    delete preset.variables[varId];
    managerApi.persistSettings(settings);

    // Clear the stored value everywhere too, not just the definition -
    // otherwise recreating a variable with the same name would silently
    // resurrect the deleted one's stored value (seeding only seeds names it
    // doesn't already have an entry for).
    if (varName) deleteVariableValueEverywhere(varName);

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
