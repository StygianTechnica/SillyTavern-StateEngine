// State Engine — preset export / import
//
// A preset is exported as a plain object (a deep copy) and imported as a NEW
// preset. Import never overwrites, and never lets an imported variable collide
// with one that already exists: the isolated store and the macro store key
// every variable by its NAME across all presets (see preset-manager.js's
// isVariableNameTaken()), so an imported variable whose name is taken gets a
// unique name, and calculated variables in the same preset are re-pointed at
// the renamed siblings (the same rule clonePreset() follows).

import { LOG_PREFIX, BUILTIN_NAMESPACE, getSettings, persistSettings } from './settings-core.js';
import { genId } from './variable-schema.js';
import { isVariableNameTaken } from './preset-manager.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A deep copy of a stored preset, or null when there is no such preset.
export function exportPreset(presetId) {
    const preset = getSettings().presets?.[presetId];
    return preset ? clone(preset) : null;
}

function uniquePresetName(namespace, wanted) {
    const presets = Object.values(getSettings().presets || {});
    const taken = (name) => presets.some((p) => (p.namespace || BUILTIN_NAMESPACE) === namespace && p.name === name);
    if (!taken(wanted)) return wanted;
    let candidate = `${wanted} (imported)`;
    for (let n = 2; taken(candidate); n++) candidate = `${wanted} (imported ${n})`;
    return candidate;
}

// Imports preset data as a new preset and reports what happened:
//   { presetId, idMap, nameMap }
//   idMap   old variable id   -> new variable id
//   nameMap old variable name -> new variable name (every variable)
// Returns null (and warns) when the data is not a preset. Persists.
export function importPresetDetailed(presetData) {
    if (!presetData || typeof presetData !== 'object' || Array.isArray(presetData)
        || !presetData.variables || typeof presetData.variables !== 'object' || Array.isArray(presetData.variables)) {
        console.warn(LOG_PREFIX, 'importPreset: not a preset (needs an object with a "variables" object)');
        return null;
    }

    const settings = getSettings();
    const data = clone(presetData);

    // A namespace this install does not know is imported into the built-in one,
    // swapping the "<ns>__" prefix its variable names carry.
    const oldNamespace = typeof data.namespace === 'string' ? data.namespace : BUILTIN_NAMESPACE;
    const known = oldNamespace === BUILTIN_NAMESPACE || !!settings.extensions?.[oldNamespace];
    const namespace = known ? oldNamespace : BUILTIN_NAMESPACE;

    const presetId = genId();
    const preset = {
        ...data,
        id: presetId,
        namespace,
        name: uniquePresetName(namespace, typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Imported Preset'),
        description: typeof data.description === 'string' ? data.description : '',
        triggers: Array.isArray(data.triggers) ? data.triggers : ['ai'],
        showInTracker: data.showInTracker === true,
    };

    const idMap = {};
    const nameMap = {};
    const taken = new Set();
    const variables = {};

    for (const [oldId, def] of Object.entries(data.variables)) {
        if (!def || typeof def !== 'object') continue;
        const newId = genId();
        let name = typeof def.name === 'string' ? def.name : '';
        if (!known && name.startsWith(`${oldNamespace}__`)) name = `${BUILTIN_NAMESPACE}__${name.slice(oldNamespace.length + 2)}`;

        // Unique against every stored variable AND the ones just imported.
        let finalName = name;
        for (let n = 2; isVariableNameTaken(finalName) || taken.has(finalName); n++) finalName = `${name}_${n}`;
        taken.add(finalName);

        idMap[oldId] = newId;
        if (def.name !== undefined) nameMap[def.name] = finalName;
        variables[newId] = { ...def, id: newId, name: finalName };
    }

    // Calculated variables reference their siblings by name: word-boundary
    // rewrite, never a substring replace (renaming "hp" must not touch "hp_max").
    const renames = Object.entries(nameMap).filter(([from, to]) => from !== to);
    for (const def of Object.values(variables)) {
        if (def.type !== 'calculated') continue;
        if (Array.isArray(def.dependencies)) def.dependencies = def.dependencies.map((d) => nameMap[d] ?? d);
        if (typeof def.expression === 'string') {
            for (const [from, to] of renames) def.expression = def.expression.replace(new RegExp(`\\b${escapeRegex(from)}\\b`, 'g'), to);
        }
    }

    preset.variables = variables;
    settings.presets[presetId] = preset;
    persistSettings();
    return { presetId, idMap, nameMap };
}

// Imports preset data as a new preset and returns its id (null when the data is
// not a preset). See importPresetDetailed() for the rules.
export function importPreset(presetData) {
    return importPresetDetailed(presetData)?.presetId ?? null;
}
