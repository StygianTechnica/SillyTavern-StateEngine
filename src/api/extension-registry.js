// Extension Registry
//
// unregisterExtension() removes an extension's record from
// settings.extensions (namespace-manager.js owns that store's shape and its
// createNamespace() writer). The old registerExtension(info) and
// getRegisteredExtensions() that used to live here were replaced by
// createNamespace()/getNamespaces() (namespace-manager.js) and the
// identity-checked registerExtension()/getRegisteredExtensions() in
// extension-registration.js - same names, new meaning, so they cannot
// coexist in one export surface.

import { LOG_PREFIX, getSettings, persistSettings } from '../core/settings-core.js';
import { getExtensionsStore } from './namespace-manager.js';
import { deletePreset as deletePresetCore } from '../core/preset-manager.js';
import { deleteVariableValueEverywhere } from '../core/chat-state.js';
import { refreshVariableMacros } from '../core/macro-registration.js';

// Removes the extension's own metadata, then deletes every preset (and
// that preset's stored variable values, everywhere) whose preset.namespace
// matches — the namespace this extension owned no longer has an owner, so
// nothing should be left behind for a later createNamespace() call under
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
