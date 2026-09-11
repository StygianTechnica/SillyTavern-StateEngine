// Variable API
//
// Delegates variable value/lifecycle logic to src/core/chat-state.js
// (seedVariablesForChat, resetValueIfTypeChanged, deleteVariableValueEverywhere)
// and src/core/calculated-engine.js (recalculateAllForChat) — this module
// only owns namespaced addressing and the preset.variables insertion
// itself.
//
// Namespaced storage key (why): chat-state.js/macro-store.js key every
// variable by its bare def.name — preset-manager.js's isVariableNameTaken()
// comment documents a real, already-fixed bug where two variables sharing
// a name (even across different presets) silently collide in both stores.
// A namespace tag that lived only in API-layer metadata (not in def.name
// itself) would not prevent that same collision between two namespaces —
// it would just add a permission check in front of the exact bug that was
// already root-caused once. So every variable created through this module
// is stored under the fully-qualified name `${namespace}__${localName}`
// (e.g. "pp__mood") — collision-proof against the existing global-by-name
// store with zero changes to chat-state.js/macro-store.js.
//
// Delimiter is "__", not "." (2026-09-10 fix): a calculated variable's
// dependencies/expression reference other variables by their literal
// def.name (calculated-engine.js, expression-dsl.js). The DSL's tokenizer
// treats "." as property-access syntax ("arr.length", "s.upper()") — a
// dotted identifier like "se.mood" tokenizes as ident("se") + op(".") +
// ident("mood"), not one identifier, so evaluateExpression() rejects it
// ("Identifier "se" is not in this variable's dependencies") every time.
// "__" is a normal identifier character with no such collision, and needed
// no changes to expression-dsl.js (deliberately pure/self-contained per its
// own header comment) to work correctly. Root-caused by actually evaluating
// an expression through the real engine, not just checking the stored
// dependency string matched - see this pass's implementation report.

import { LOG_PREFIX, persistSettings } from '../core/settings-core.js';
import { validateNamespace } from './namespace-manager.js';
import { findPresetEntry } from './preset-api.js';
import { blankDefinition } from '../core/variable-schema.js';
import { isVariableNameTaken } from '../core/preset-manager.js';
import { seedVariablesForChat, resetValueIfTypeChanged, deleteVariableValueEverywhere } from '../core/chat-state.js';
import { recalculateAllForChat } from '../core/calculated-engine.js';
import { refreshVariableMacros } from '../core/macro-registration.js';

function qualifiedName(namespace, localName) {
    return `${namespace}__${localName}`;
}

// Returns [varId, def] for the variable stored under namespace.localName
// inside `preset`, or null if not found.
function findVariableEntry(preset, namespace, localName) {
    const target = qualifiedName(namespace, localName);
    for (const [varId, def] of Object.entries(preset?.variables || {})) {
        if (def?.name === target) return [varId, def];
    }
    return null;
}

function currentChatId() {
    try {
        return SillyTavern.getContext().chatId;
    } catch {
        return null;
    }
}

export function createVariable(def) {
    try {
        if (!def || !def.namespace || !def.presetName || !def.name) {
            console.warn(LOG_PREFIX, 'createVariable requires def.namespace, def.presetName, and def.name');
            return null;
        }
        if (!validateNamespace(def.namespace)) {
            console.warn(LOG_PREFIX, `createVariable: namespace "${def.namespace}" is not registered`);
            return null;
        }
        const presetEntry = findPresetEntry(def.namespace, def.presetName);
        if (!presetEntry) {
            console.warn(LOG_PREFIX, `createVariable: preset "${def.namespace}.${def.presetName}" not found`);
            return null;
        }
        const [, preset] = presetEntry;

        const target = qualifiedName(def.namespace, def.name);
        if (isVariableNameTaken(target)) {
            console.warn(LOG_PREFIX, `createVariable: variable name "${target}" is already in use`);
            return null;
        }

        const { namespace: _ns, presetName: _presetName, name: _localName, id: _ignoredId, ...rest } = def;
        const fullDef = { ...blankDefinition(), ...rest, name: target };
        preset.variables[fullDef.id] = fullDef;
        persistSettings();

        const chatId = currentChatId();
        if (chatId) {
            seedVariablesForChat(chatId);
            recalculateAllForChat(chatId);
        }
        refreshVariableMacros();

        return fullDef;
    } catch (err) {
        console.warn(LOG_PREFIX, 'createVariable failed (gracefully handled)', err);
        return null;
    }
}

export function updateVariable(ref, patch) {
    try {
        if (!ref || !ref.namespace || !ref.presetName || !ref.variableName) {
            console.warn(LOG_PREFIX, 'updateVariable requires ref.namespace, ref.presetName, and ref.variableName');
            return null;
        }
        if (!validateNamespace(ref.namespace)) {
            console.warn(LOG_PREFIX, `updateVariable: namespace "${ref.namespace}" is not registered`);
            return null;
        }
        const presetEntry = findPresetEntry(ref.namespace, ref.presetName);
        if (!presetEntry) {
            console.warn(LOG_PREFIX, `updateVariable: preset "${ref.namespace}.${ref.presetName}" not found`);
            return null;
        }
        const [, preset] = presetEntry;
        const varEntry = findVariableEntry(preset, ref.namespace, ref.variableName);
        if (!varEntry) {
            console.warn(LOG_PREFIX, `updateVariable: variable "${ref.namespace}.${ref.variableName}" not found`);
            return null;
        }
        const [varId, def] = varEntry;

        const safePatch = { ...(patch || {}) };
        delete safePatch.id;

        // A renamed local name is re-qualified into the same namespace — an
        // extension may not move a variable to a different namespace via
        // patch, matching updatePreset()'s same rule.
        if (typeof safePatch.name === 'string') {
            const newTarget = qualifiedName(ref.namespace, safePatch.name);
            if (newTarget !== def.name) {
                if (isVariableNameTaken(newTarget, def.id)) {
                    console.warn(LOG_PREFIX, `updateVariable: variable name "${newTarget}" is already in use`);
                    return null;
                }
                // Renaming leaves any already-stored per-chat value behind
                // under the old key — chat-state.js has no rename-migration
                // path, and neither does the manager-modal inline editor
                // this mirrors; out of scope for this pass.
                safePatch.name = newTarget;
            } else {
                delete safePatch.name;
            }
        }

        // A fresh object, not Object.assign(def, safePatch): chat-state.js's
        // isolated-store snapshot (entry.def, see chat-state.js's setVar)
        // is the *same object reference* as this preset.variables[varId]
        // entry — preset-manager.js's getAllVariablesFromPresets() never
        // clones. Mutating def in place would mutate entry.def out from
        // under resetValueIfTypeChanged() before it runs, so it could never
        // see the old type to compare against. The manager-modal inline
        // editor (ui-events.js) avoids exactly this by building a new
        // object and replacing preset.variables[id] wholesale — mirrored
        // here, root-caused against this module's own functional smoke
        // test rather than assumed.
        const newDef = { ...def, ...safePatch };
        preset.variables[varId] = newDef;
        persistSettings();

        const chatId = currentChatId();
        if (chatId) {
            resetValueIfTypeChanged(chatId, newDef);
            recalculateAllForChat(chatId);
        }
        refreshVariableMacros();

        return newDef;
    } catch (err) {
        console.warn(LOG_PREFIX, 'updateVariable failed (gracefully handled)', err);
        return null;
    }
}

export function deleteVariable(ref) {
    try {
        if (!ref || !ref.namespace || !ref.presetName || !ref.variableName) {
            console.warn(LOG_PREFIX, 'deleteVariable requires ref.namespace, ref.presetName, and ref.variableName');
            return false;
        }
        if (!validateNamespace(ref.namespace)) {
            console.warn(LOG_PREFIX, `deleteVariable: namespace "${ref.namespace}" is not registered`);
            return false;
        }
        const presetEntry = findPresetEntry(ref.namespace, ref.presetName);
        if (!presetEntry) {
            console.warn(LOG_PREFIX, `deleteVariable: preset "${ref.namespace}.${ref.presetName}" not found`);
            return false;
        }
        const [, preset] = presetEntry;
        const varEntry = findVariableEntry(preset, ref.namespace, ref.variableName);
        if (!varEntry) {
            console.warn(LOG_PREFIX, `deleteVariable: variable "${ref.namespace}.${ref.variableName}" not found`);
            return false;
        }
        const [varId, def] = varEntry;

        delete preset.variables[varId];
        persistSettings();
        deleteVariableValueEverywhere(def.name);
        refreshVariableMacros();
        return true;
    } catch (err) {
        console.warn(LOG_PREFIX, 'deleteVariable failed (gracefully handled)', err);
        return false;
    }
}

export function getVariable(ref) {
    try {
        if (!ref || !ref.namespace || !ref.presetName || !ref.variableName) return undefined;
        const presetEntry = findPresetEntry(ref.namespace, ref.presetName);
        if (!presetEntry) return undefined;
        const [, preset] = presetEntry;
        const varEntry = findVariableEntry(preset, ref.namespace, ref.variableName);
        return varEntry ? varEntry[1] : undefined;
    } catch (err) {
        console.warn(LOG_PREFIX, 'getVariable failed (gracefully handled)', err);
        return undefined;
    }
}

export function listVariables(namespace, presetName) {
    try {
        const entry = findPresetEntry(namespace, presetName);
        if (!entry) return [];
        const [, preset] = entry;
        return Object.values(preset.variables || {});
    } catch (err) {
        console.warn(LOG_PREFIX, 'listVariables failed (gracefully handled)', err);
        return [];
    }
}
