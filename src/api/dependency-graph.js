// Dependency Graph
//
// Read-only introspection over calculated-variable dependencies (engine
// spec 1.17) — never mutates a definition or a stored value, never
// triggers evaluation. src/core/calculated-engine.js owns the real
// evaluation/recalculation logic; this module only reads what's already
// stored in def.dependencies.

import { LOG_PREFIX, getSettings } from '../core/settings-core.js';
import { findPresetEntry } from './preset-api.js';

// "__" delimiter, not ".", matching variable-api.js's qualifiedName() -
// see that module's header comment for why a dot breaks the expression
// DSL's tokenizer.
function qualifiedName(namespace, localName) {
    return `${namespace}__${localName}`;
}

function findVariableByQualifiedName(preset, target) {
    for (const def of Object.values(preset?.variables || {})) {
        if (def?.name === target) return def;
    }
    return null;
}

// ref: { namespace, presetName, variableName }. Returns a copy of
// def.dependencies (variable names, in whatever format they were stored
// in — see getDependents() below for why that matters).
export function getDependencies(ref) {
    try {
        if (!ref || !ref.namespace || !ref.presetName || !ref.variableName) return [];
        const entry = findPresetEntry(ref.namespace, ref.presetName);
        if (!entry) return [];
        const [, preset] = entry;
        const def = findVariableByQualifiedName(preset, qualifiedName(ref.namespace, ref.variableName));
        return Array.isArray(def?.dependencies) ? [...def.dependencies] : [];
    } catch (err) {
        console.warn(LOG_PREFIX, 'getDependencies failed (gracefully handled)', err);
        return [];
    }
}

// Scans every variable in ref.namespace's own presets (not other
// namespaces — "Scan all variables in the namespace" per this pass's
// instructions) for a `dependencies` entry matching ref's own qualified
// name. Dependencies are stored as literal def.name strings, and every
// variable created through variable-api.js is stored under its qualified
// "namespace__localName" (see that module's header comment) — so the match
// target has to be qualified the same way, not the bare ref.variableName.
export function getDependents(ref) {
    try {
        if (!ref || !ref.namespace || !ref.variableName) return [];
        const target = qualifiedName(ref.namespace, ref.variableName);
        const settings = getSettings();
        const dependents = [];
        for (const preset of Object.values(settings.presets || {})) {
            if (preset?.namespace !== ref.namespace) continue;
            for (const def of Object.values(preset.variables || {})) {
                if (Array.isArray(def?.dependencies) && def.dependencies.includes(target)) {
                    dependents.push(def);
                }
            }
        }
        return dependents;
    } catch (err) {
        console.warn(LOG_PREFIX, 'getDependents failed (gracefully handled)', err);
        return [];
    }
}
