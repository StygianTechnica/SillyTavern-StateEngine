// State Engine — lorebook bundle export / import
//
// A bundle carries a lorebook together with everything State Engine has tied
// to it, so it can be shared as one file:
//
// {
//   "lorebook": { ...SillyTavern lorebook JSON (loadWorldInfo) },
//   "lorebookName": "My Book",
//   "stateEngine": {
//     "presets": { [presetId]: preset },
//     "wiConditions": { "<world>.<uid>": [ {variable, operator, value} ] },
//     "lorebookPresetBindings": { [world]: { [lorebookId]: [presetId] } }
//   }
// }
//
// "lorebookName" is not in the requested shape: a lorebook's name is not inside
// its JSON, and importing needs one. A part of "stateEngine" with nothing in it
// is left out rather than written as an empty list.

import { LOG_PREFIX, getSettings, persistSettings } from './settings-core.js';
import { getPresetsForChat, addPresetToChat } from './preset-manager.js';
import { getPresetsForLorebook, getLorebookBindings } from './lorebook-bindings.js';
import { exportPreset, importPresetDetailed } from './preset-export.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

// The condition keys of a world are "<world>.<uid>". Empty lists are skipped.
function conditionsForWorld(world) {
    const out = {};
    for (const [key, list] of Object.entries(getSettings().wiConditions || {})) {
        if (key.startsWith(`${world}.`) && Array.isArray(list) && list.length > 0) out[key] = clone(list);
    }
    return out;
}

// Builds the bundle for one lorebook, or returns null when the lorebook cannot
// be loaded. `lorebookId` is the lorebook's name in SillyTavern (it defaults to
// `world`, which is the same thing - see lorebook-bindings.js).
export async function exportLorebookBundle(world, lorebookId = world) {
    const context = SillyTavern.getContext();
    const lorebook = await context.loadWorldInfo(lorebookId);
    if (!lorebook) {
        console.warn(LOG_PREFIX, `exportLorebookBundle: lorebook "${lorebookId}" could not be loaded`);
        return null;
    }

    const presetIds = getPresetsForLorebook(world, lorebookId);
    const presets = {};
    for (const presetId of presetIds) presets[presetId] = exportPreset(presetId);
    const conditions = conditionsForWorld(world);
    const bound = getLorebookBindings()?.[world]?.[lorebookId];

    // Only what has content: no empty preset list, condition list or binding.
    const stateEngine = {};
    if (presetIds.length > 0) stateEngine.presets = presets;
    if (Object.keys(conditions).length > 0) stateEngine.wiConditions = conditions;
    if (bound && presetIds.length > 0) stateEngine.lorebookPresetBindings = { [world]: { [lorebookId]: presetIds } };

    return { lorebook: clone(lorebook), lorebookName: lorebookId, stateEngine };
}

// Finds a stored preset that is the same preset as `data` (same name and the
// same variable names) so importing a bundle twice does not pile up copies.
// -> { presetId, idMap } (old variable id -> stored variable id) or null.
function findExistingPreset(data) {
    const wanted = Object.entries(data.variables || {});
    for (const [presetId, preset] of Object.entries(getSettings().presets || {})) {
        if (preset.name !== data.name) continue;
        const stored = Object.entries(preset.variables || {});
        if (stored.length !== wanted.length) continue;
        const byName = new Map(stored.map(([id, def]) => [def.name, id]));
        if (!wanted.every(([, def]) => byName.has(def.name))) continue;
        return { presetId, idMap: Object.fromEntries(wanted.map(([oldId, def]) => [oldId, byName.get(def.name)])) };
    }
    return null;
}

// Whether any stored preset defines a variable with this id or name.
function variableExists(variable) {
    if (typeof variable !== 'string') return false;
    return Object.values(getSettings().presets || {}).some((preset) =>
        Object.entries(preset.variables || {}).some(([id, def]) => id === variable || def?.name === variable));
}

// The uids of the entries in a lorebook's JSON.
function entryUids(lorebook) {
    const uids = new Set();
    for (const [key, entry] of Object.entries(lorebook.entries || {})) {
        uids.add(String(key));
        if (entry && entry.uid !== undefined) uids.add(String(entry.uid));
    }
    return uids;
}

// Imports a bundle: the lorebook into SillyTavern, its presets into State
// Engine, its conditions and bindings merged in - then offers to activate the
// presets for the open chat. options.name overrides the lorebook name.
//
// Nothing is imported that would be left dangling:
//   - a condition for an entry the lorebook does not have, or on a variable that
//     neither the bundle's presets nor this install defines, is skipped;
//   - a preset is imported only if the bundle binds it or a kept condition uses
//     one of its variables;
//   - a binding is made only to a preset that was imported (or reused) here.
// Returns a summary, or null when the bundle is unusable / the user cancelled
// the overwrite. Persists.
export async function importLorebookBundle(bundle, options = {}) {
    if (!bundle || typeof bundle !== 'object' || !bundle.lorebook || typeof bundle.lorebook !== 'object' || !bundle.lorebook.entries) {
        console.warn(LOG_PREFIX, 'importLorebookBundle: not a lorebook bundle (needs a "lorebook" with "entries")');
        return null;
    }
    const se = bundle.stateEngine && typeof bundle.stateEngine === 'object' ? bundle.stateEngine : {};
    const bundledBindings = se.lorebookPresetBindings && typeof se.lorebookPresetBindings === 'object' ? se.lorebookPresetBindings : {};
    const bundledPresets = {};
    for (const [id, data] of Object.entries(se.presets && typeof se.presets === 'object' ? se.presets : {})) {
        if (data && typeof data === 'object' && data.variables && typeof data.variables === 'object') bundledPresets[id] = data;
    }

    // The original world/lorebook names come from the binding entry (or the name).
    const [originalWorld, originalBooks] = Object.entries(bundledBindings)[0] || [];
    const originalId = bundle.lorebookName || Object.keys(originalBooks || {})[0] || originalWorld;
    const name = (options.name || bundle.lorebookName || originalId || '').toString().trim();
    if (!name) {
        console.warn(LOG_PREFIX, 'importLorebookBundle: the bundle has no lorebook name - pass options.name');
        return null;
    }

    const context = SillyTavern.getContext();

    // 1. The lorebook. ST overwrites a book with the same name, so ask first.
    if (context.getWorldInfoNames?.().includes(name)
        && !window.confirm(`A lorebook named "${name}" already exists. Overwrite it with the imported one?`)) {
        return null;
    }
    await context.saveWorldInfo(name, clone(bundle.lorebook), true);
    await context.updateWorldInfoList?.();

    // 2. Decide what is needed. Conditions first (only on entries this lorebook
    // has), so a preset that only a dropped condition used is not imported.
    const uids = entryUids(bundle.lorebook);
    const candidates = []; // { uid, cond }
    let skippedConditions = 0;
    for (const [key, list] of Object.entries(se.wiConditions && typeof se.wiConditions === 'object' ? se.wiConditions : {})) {
        if (!Array.isArray(list)) { skippedConditions += 1; continue; }
        const dot = key.indexOf('.');
        const uid = dot > 0 ? key.slice(dot + 1) : key;
        for (const cond of list) {
            if (!cond || typeof cond !== 'object' || !uids.has(uid)) { skippedConditions += 1; continue; }
            candidates.push({ uid, cond });
        }
    }

    const presetOfVariable = new Map(); // bundle variable id / name -> bundle preset id
    for (const [presetId, data] of Object.entries(bundledPresets)) {
        for (const [varId, def] of Object.entries(data.variables)) {
            presetOfVariable.set(varId, presetId);
            if (def?.name) presetOfVariable.set(def.name, presetId);
        }
    }
    const boundOld = new Set();
    for (const books of Object.values(bundledBindings)) {
        for (const ids of Object.values(books || {})) {
            for (const id of Array.isArray(ids) ? ids : []) if (bundledPresets[id]) boundOld.add(id);
        }
    }
    const needed = new Set(boundOld);
    for (const { cond } of candidates) {
        const owner = presetOfVariable.get(cond.variable);
        if (owner) needed.add(owner);
    }

    // 3. Presets (new, or the identical preset already stored).
    const presetIdMap = {};   // bundle preset id -> stored preset id
    const variableIdMap = {}; // bundle variable id -> stored variable id
    const variableNameMap = {};
    for (const oldPresetId of needed) {
        const data = bundledPresets[oldPresetId];
        const existing = findExistingPreset(data);
        if (existing) {
            presetIdMap[oldPresetId] = existing.presetId;
            Object.assign(variableIdMap, existing.idMap);
            continue;
        }
        const imported = importPresetDetailed(data);
        if (!imported) continue;
        presetIdMap[oldPresetId] = imported.presetId;
        Object.assign(variableIdMap, imported.idMap);
        Object.assign(variableNameMap, imported.nameMap);
    }
    const skippedPresets = Object.keys(bundledPresets).length - needed.size;

    const settings = getSettings();

    // 4. Conditions: re-keyed to the imported name, variables re-pointed at the
    // imported ones, merged without duplicating a condition already there. A
    // condition whose variable exists nowhere is dropped, not stored dangling.
    let mergedConditions = 0;
    for (const { uid, cond } of candidates) {
        const variable = variableIdMap[cond.variable] ?? variableNameMap[cond.variable] ?? cond.variable;
        if (!variableExists(variable)) { skippedConditions += 1; continue; }
        const newKey = `${name}.${uid}`;
        const remapped = { ...cond, variable };
        const existing = Array.isArray(settings.wiConditions[newKey]) ? settings.wiConditions[newKey] : (settings.wiConditions[newKey] = []);
        if (existing.some((c) => JSON.stringify(c) === JSON.stringify(remapped))) continue;
        existing.push(remapped);
        mergedConditions++;
    }

    // 5. Bindings: to the imported name, only to presets that now exist here.
    const boundPresetIds = [];
    for (const oldId of boundOld) {
        const storedId = presetIdMap[oldId];
        if (storedId && settings.presets[storedId] && !boundPresetIds.includes(storedId)) boundPresetIds.push(storedId);
    }
    if (boundPresetIds.length) {
        const bindings = settings.lorebookPresetBindings;
        if (!bindings[name]) bindings[name] = {};
        const merged = new Set((bindings[name][name] || []).filter((id) => settings.presets[id]));
        boundPresetIds.forEach((id) => merged.add(id));
        bindings[name][name] = [...merged];
    }
    persistSettings();

    // 6. Offer to activate them for the open chat.
    let activated = false;
    const chatId = context.chatId;
    if (chatId && boundPresetIds.length) {
        const inactive = boundPresetIds.filter((id) => !getPresetsForChat(chatId).includes(id));
        if (inactive.length) {
            const names = inactive.map((id) => settings.presets[id]?.name || id).join(', ');
            if (window.confirm(`The lorebook "${name}" comes with the presets ${names}. Activate them for this chat?`)) {
                inactive.forEach((id) => addPresetToChat(chatId, id));
                activated = true;
            }
        }
    }

    return {
        lorebook: name,
        presetIds: Object.values(presetIdMap),
        boundPresetIds,
        conditions: mergedConditions,
        skipped: { conditions: skippedConditions, presets: skippedPresets },
        activated,
    };
}
