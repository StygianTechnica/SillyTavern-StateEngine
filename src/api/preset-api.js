// Preset API
//
// Delegates all actual preset mutation to src/core/preset-manager.js — this
// module adds namespaced (namespace, name) addressing and ownership
// checking on top, it never reimplements preset CRUD itself.
//
// Caller identity: every exported function takes (extensionId, instanceId)
// first and checks it before doing anything - a wrong instance or a
// namespace the caller doesn't own throws, it never silently no-ops. See
// docs/STATE ENGINE API SPECIFICATION.md Section 7.4.
//
// activatePreset()/deactivatePreset() are the deliberate exception to
// namespace OWNERSHIP (2026-09-23): write isolation exists to stop one
// extension changing another's definitions - a preset's variables, name,
// triggers - and binding a preset to a chat changes none of those. A UI
// extension (Pretty Panels) must be able to switch on the user's own `se`
// presets that its layouts display. So these two only require a
// registered caller on the right instance (resolveCallerRecord), and may
// target any namespace. Everything that edits a preset stays owner-only.

import { LOG_PREFIX, getSettings, persistSettings } from '../core/settings-core.js';
import { validateNamespace } from './namespace-manager.js';
import { validateCallerIdentity, resolveCallerRecord } from './identity.js';
import {
    createPreset as createPresetCore,
    renamePreset as renamePresetCore,
    deletePreset as deletePresetCore,
    addPresetToChat,
    removePresetFromChat,
} from '../core/preset-manager.js';
import { deleteVariableValueEverywhere } from '../core/chat-state.js';
import { refreshVariableMacros } from '../core/macro-registration.js';

// Returns [presetId, preset] for the preset addressed as namespace.name, or
// null if none exists. Exported so variable-api.js and dependency-graph.js
// can resolve a preset by the same (namespace, name) addressing without
// duplicating this scan.
export function findPresetEntry(namespace, name) {
    const settings = getSettings();
    for (const [presetId, preset] of Object.entries(settings.presets || {})) {
        if (preset?.namespace === namespace && preset?.name === name) {
            return [presetId, preset];
        }
    }
    return null;
}

export function createPreset(extensionId, instanceId, def) {
    validateCallerIdentity(extensionId, instanceId, def?.namespace);
    try {
        if (!def || !def.namespace || !def.name) {
            console.warn(LOG_PREFIX, 'createPreset requires def.namespace and def.name');
            return null;
        }
        if (!validateNamespace(def.namespace)) {
            console.warn(LOG_PREFIX, `createPreset: namespace "${def.namespace}" is not registered`);
            return null;
        }
        if (findPresetEntry(def.namespace, def.name)) {
            console.warn(LOG_PREFIX, `createPreset: "${def.namespace}.${def.name}" already exists`);
            return null;
        }

        const presetId = createPresetCore(def.name);
        const settings = getSettings();
        const preset = settings.presets[presetId];
        preset.namespace = def.namespace;
        if (def.description !== undefined) preset.description = def.description;
        if (Array.isArray(def.triggers)) preset.triggers = def.triggers;
        if (def.showInTracker !== undefined) preset.showInTracker = def.showInTracker;
        persistSettings();
        return { id: presetId, ...preset };
    } catch (err) {
        console.warn(LOG_PREFIX, 'createPreset failed (gracefully handled)', err);
        return null;
    }
}

export function updatePreset(extensionId, instanceId, namespace, name, patch) {
    validateCallerIdentity(extensionId, instanceId, namespace);
    try {
        if (!validateNamespace(namespace)) {
            console.warn(LOG_PREFIX, `updatePreset: namespace "${namespace}" is not registered`);
            return null;
        }
        const entry = findPresetEntry(namespace, name);
        if (!entry) {
            console.warn(LOG_PREFIX, `updatePreset: "${namespace}.${name}" not found`);
            return null;
        }
        const [presetId, preset] = entry;
        const safePatch = { ...(patch || {}) };
        delete safePatch.id;
        delete safePatch.namespace; // an extension may not move a preset into another namespace via patch

        // Renaming goes through preset-manager.js's own renamePreset() —
        // never a direct field assignment — so that logic stays in one
        // place (engine spec: don't duplicate preset logic).
        if (typeof safePatch.name === 'string' && safePatch.name !== preset.name) {
            if (findPresetEntry(namespace, safePatch.name)) {
                console.warn(LOG_PREFIX, `updatePreset: "${namespace}.${safePatch.name}" already exists`);
                return null;
            }
            renamePresetCore(presetId, safePatch.name);
        }
        delete safePatch.name;

        Object.assign(preset, safePatch);
        persistSettings();
        return { id: presetId, ...preset };
    } catch (err) {
        console.warn(LOG_PREFIX, 'updatePreset failed (gracefully handled)', err);
        return null;
    }
}

export function deletePreset(extensionId, instanceId, namespace, name) {
    validateCallerIdentity(extensionId, instanceId, namespace);
    try {
        if (!validateNamespace(namespace)) {
            console.warn(LOG_PREFIX, `deletePreset: namespace "${namespace}" is not registered`);
            return false;
        }
        const entry = findPresetEntry(namespace, name);
        if (!entry) {
            console.warn(LOG_PREFIX, `deletePreset: "${namespace}.${name}" not found`);
            return false;
        }
        const [presetId, preset] = entry;
        const varNames = Object.values(preset.variables || {}).map((def) => def?.name).filter(Boolean);

        deletePresetCore(presetId);
        for (const varName of varNames) {
            deleteVariableValueEverywhere(varName);
        }
        refreshVariableMacros();
        return true;
    } catch (err) {
        console.warn(LOG_PREFIX, 'deletePreset failed (gracefully handled)', err);
        return false;
    }
}

export function activatePreset(extensionId, instanceId, chatId, namespace, name) {
    // Any registered caller, any target namespace - see the header comment.
    resolveCallerRecord(extensionId, instanceId);
    try {
        if (!chatId) return false;
        if (!validateNamespace(namespace)) {
            console.warn(LOG_PREFIX, `activatePreset: namespace "${namespace}" is not registered`);
            return false;
        }
        const entry = findPresetEntry(namespace, name);
        if (!entry) {
            console.warn(LOG_PREFIX, `activatePreset: "${namespace}.${name}" not found`);
            return false;
        }
        const [presetId] = entry;
        // addPresetToChat() already seeds + recalculates + refreshes macros
        // internally (src/core/preset-manager.js) — nothing to repeat here.
        addPresetToChat(chatId, presetId);
        return true;
    } catch (err) {
        console.warn(LOG_PREFIX, 'activatePreset failed (gracefully handled)', err);
        return false;
    }
}

export function deactivatePreset(extensionId, instanceId, chatId, namespace, name) {
    // Any registered caller, any target namespace - see the header comment.
    resolveCallerRecord(extensionId, instanceId);
    try {
        if (!chatId) return false;
        if (!validateNamespace(namespace)) {
            console.warn(LOG_PREFIX, `deactivatePreset: namespace "${namespace}" is not registered`);
            return false;
        }
        const entry = findPresetEntry(namespace, name);
        if (!entry) {
            console.warn(LOG_PREFIX, `deactivatePreset: "${namespace}.${name}" not found`);
            return false;
        }
        const [presetId] = entry;
        removePresetFromChat(chatId, presetId);
        return true;
    } catch (err) {
        console.warn(LOG_PREFIX, 'deactivatePreset failed (gracefully handled)', err);
        return false;
    }
}

export function listPresets(extensionId, instanceId, namespace) {
    validateCallerIdentity(extensionId, instanceId, namespace);
    try {
        const settings = getSettings();
        return Object.entries(settings.presets || {})
            .filter(([, preset]) => preset?.namespace === namespace)
            .map(([id, preset]) => ({ id, ...preset }));
    } catch (err) {
        console.warn(LOG_PREFIX, 'listPresets failed (gracefully handled)', err);
        return [];
    }
}
