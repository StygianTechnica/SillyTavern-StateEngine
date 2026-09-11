// Extension Registry
//
// registerExtension()/unregisterExtension() are the only writers of
// settings.extensions — namespace-manager.js owns that store's shape and
// the read-only validateNamespace()/ownsNamespace() checks built on it.

import { LOG_PREFIX, getSettings, persistSettings } from '../core/settings-core.js';
import { getExtensionsStore } from './namespace-manager.js';
import { deletePreset as deletePresetCore } from '../core/preset-manager.js';
import { deleteVariableValueEverywhere } from '../core/chat-state.js';
import { refreshVariableMacros } from '../core/macro-registration.js';

// info: { namespace, name?, id?, ... }. `namespace` must be unique among
// currently-registered extensions. `id` defaults to `namespace` — see
// namespace-manager.js's ownsNamespace() comment for why the two are kept
// as (currently identical) separate fields rather than collapsed into one.
export function registerExtension(info) {
    try {
        if (!info || !info.namespace) {
            console.warn(LOG_PREFIX, 'registerExtension requires info.namespace');
            return null;
        }
        const extensions = getExtensionsStore();
        if (Object.prototype.hasOwnProperty.call(extensions, info.namespace)) {
            console.warn(LOG_PREFIX, `registerExtension: namespace "${info.namespace}" is already registered`);
            return null;
        }

        const record = {
            ...info,
            id: info.id || info.namespace,
            namespace: info.namespace,
            name: info.name || info.namespace,
            registeredAt: Date.now(),
        };
        extensions[info.namespace] = record;
        persistSettings();
        return record;
    } catch (err) {
        console.warn(LOG_PREFIX, 'registerExtension failed (gracefully handled)', err);
        return null;
    }
}

// Removes the extension's own metadata, then deletes every preset (and
// that preset's stored variable values, everywhere) whose preset.namespace
// matches — the namespace this extension owned no longer has an owner, so
// nothing should be left behind for a later registerExtension() call under
// the same namespace to silently inherit. Presets with no `namespace`
// field (created directly through preset-manager.js/the manager modal,
// never through this API layer) are untouched — they were never owned by
// any extension in the first place.
export function unregisterExtension(id) {
    try {
        if (!id) return false;
        const extensions = getExtensionsStore();
        const namespace = Object.keys(extensions).find((ns) => extensions[ns]?.id === id);
        if (!namespace) {
            console.warn(LOG_PREFIX, `unregisterExtension: no extension found for id "${id}"`);
            return false;
        }

        delete extensions[namespace];

        const settings = getSettings();
        const presetIdsToDelete = Object.entries(settings.presets || {})
            .filter(([, preset]) => preset?.namespace === namespace)
            .map(([presetId]) => presetId);

        for (const presetId of presetIdsToDelete) {
            const preset = settings.presets[presetId];
            const varNames = Object.values(preset?.variables || {}).map((def) => def?.name).filter(Boolean);
            // deletePresetCore() handles chat-binding cleanup, clearing
            // defaultPresetForNewChats, and its own persist — never
            // reimplemented here (engine spec: don't duplicate preset logic).
            deletePresetCore(presetId);
            for (const varName of varNames) {
                deleteVariableValueEverywhere(varName);
            }
        }

        persistSettings();
        refreshVariableMacros();
        return true;
    } catch (err) {
        console.warn(LOG_PREFIX, 'unregisterExtension failed (gracefully handled)', err);
        return false;
    }
}

export function getRegisteredExtensions() {
    try {
        return Object.values(getExtensionsStore());
    } catch (err) {
        console.warn(LOG_PREFIX, 'getRegisteredExtensions failed (gracefully handled)', err);
        return [];
    }
}
