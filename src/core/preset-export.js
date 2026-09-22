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
import { embedManagedImages, restoreEmbeddedImages } from './image-import.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A deep copy of a stored preset, or null when there is no such preset.
//
// Independent presets (requirements spec 1.29): independentPreset,
// independentConfig (model/batch/prompt/schedule/trigger settings - request
// Section 9's own list) and independentConfig.context (if any) are plain
// preset fields, so they come along with everything else in the clone below -
// no special-casing needed to include them. TWO things are deliberately
// dropped again right after cloning:
//   - independentStatus: last-run time/outcome/changed-variables is runtime
//     history for what happened HERE, in THIS install's chats - re-importing
//     it into another install (or re-importing the same preset here) would
//     misrepresent a preset that has never actually run there as if it had.
//     Not in the request's own export list either (name/batch/prompt/model/
//     triggers/schedule/context - no "status").
//   - a non-JSON-serializable independentConfig.context: context is `any`,
//     extension-owned, and never interpreted (request Section 3.A) - but
//     exporting to a JSON file is a hard boundary a function, a circular
//     structure or a DOM node cannot cross. Dropped with a console warning
//     rather than failing the whole export; every other field still exports.
export function exportPreset(presetId) {
    const preset = getSettings().presets?.[presetId];
    if (!preset) return null;

    // A non-JSON-safe context (a circular structure, a function, a DOM node...)
    // would make clone()'s JSON.stringify throw for the WHOLE preset, not just
    // that one field - checked and set aside before the real clone runs, never
    // touching the live preset object itself.
    let unsafeContext = false;
    if (preset.independentConfig && Object.prototype.hasOwnProperty.call(preset.independentConfig, 'context')) {
        try {
            JSON.stringify(preset.independentConfig.context);
        } catch {
            unsafeContext = true;
        }
    }
    const toClone = unsafeContext
        ? { ...preset, independentConfig: { ...preset.independentConfig, context: null } }
        : preset;

    const data = clone(toClone); // the LIVE preset is never touched - only this copy
    delete data.independentStatus;
    if (unsafeContext) {
        console.warn(LOG_PREFIX, `exportPreset: "${preset.name}"'s independent context is not JSON-serializable and was left out of the export`);
        delete data.independentConfig.context;
    }
    return data;
}

// exportPreset() plus the image files its image variables reference in State
// Engine's image folder (core/image-import.js), embedded as
// `stateEngineImages: { "<file name>": "<base64>" }` so the preset can be shared
// without breaking its pictures. -> { data, missing } (missing = referenced paths
// whose file could not be read; they are left as references), or null when there
// is no such preset. A preset with no such images comes back exactly as
// exportPreset() gives it. `deps` is for tests.
export async function exportPresetWithImages(presetId, deps) {
    const data = exportPreset(presetId);
    return data ? embedManagedImages(data, deps) : null;
}

// importPresetDetailed() for data that may carry embedded images: the files are
// put back into State Engine's image folder first (same name, or a numeric suffix
// when a different file already has it, or reused when it is the same file) and the
// preset's references are rewritten to match. -> { ...importPresetDetailed's result,
// images: { restored, reused, failed } } or null when the data is not a preset.
export async function importPresetWithImages(presetData, deps) {
    if (!presetData || typeof presetData !== 'object' || Array.isArray(presetData)) return importPresetDetailed(presetData);
    const { data, restored, reused, failed } = await restoreEmbeddedImages(presetData, deps);
    const result = importPresetDetailed(data);
    return result ? { ...result, images: { restored, reused, failed } } : null;
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
    // Embedded image files belong to the image folder, never to the stored preset
    // (importPresetWithImages() restores them first); a plain import just drops them.
    delete data.stateEngineImages;
    // Defensive: exportPreset() already strips this, but a hand-edited or
    // differently-sourced file might still carry it - an imported independent
    // preset always starts with a clean run history (1.29).
    delete data.independentStatus;

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
