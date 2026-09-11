// Namespace Manager — owns namespace rules and isolation
//
// A "namespace" identifies which registered extension owns a given set of
// presets/variables/events in the API layer (docs/STATE ENGINE API
// SPECIFICATION.md, Section 2). Extension metadata lives in
// settings.extensions, keyed by namespace — this module owns that
// structure's shape plus the read-only validation helpers built on it.
// extension-registry.js (registerExtension/unregisterExtension) is the
// only writer; every other API module only reads through
// validateNamespace()/ownsNamespace() below.

import { getSettings, LOG_PREFIX } from '../core/settings-core.js';

// Defensive accessor, mirroring chat-state.js's getStore() pattern — never
// assumes settings-core.js's own default-backfill already ran.
export function getExtensionsStore() {
    const settings = getSettings();
    if (!settings.extensions || typeof settings.extensions !== 'object') {
        settings.extensions = {};
    }
    return settings.extensions;
}

export function createNamespace(id) {}
export function getNamespaces() {}

// True if `namespace` is a currently-registered namespace (i.e. some
// extension called registerExtension() with this namespace and hasn't
// since been unregistered). This is namespace *existence*, not per-caller
// ownership — see ownsNamespace() below and this pass's implementation
// report for why the two are different here.
export function validateNamespace(namespace) {
    try {
        if (!namespace) return false;
        const extensions = getExtensionsStore();
        return Object.prototype.hasOwnProperty.call(extensions, namespace);
    } catch (err) {
        console.warn(LOG_PREFIX, 'validateNamespace failed (gracefully handled)', err);
        return false;
    }
}

// True only if the extension identified by `extensionId` is the one that
// registered `namespace`. Real per-caller enforcement requires the caller
// to actually pass its own extensionId in — none of the CRUD functions in
// preset-api.js/variable-api.js/event-api.js/independent-presets.js take
// one (their signatures come straight from docs/STATE ENGINE API
// SPECIFICATION.md Section 3), so they can only call validateNamespace()
// today. This function exists and is correct, it's just currently unused
// by the rest of the API layer — flagged, not silently glossed over.
export function ownsNamespace(extensionId, namespace) {
    try {
        if (!extensionId || !namespace) return false;
        const extensions = getExtensionsStore();
        const record = extensions[namespace];
        return !!record && record.id === extensionId;
    } catch (err) {
        console.warn(LOG_PREFIX, 'ownsNamespace failed (gracefully handled)', err);
        return false;
    }
}
