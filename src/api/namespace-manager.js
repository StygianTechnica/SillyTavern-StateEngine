// Namespace Manager — owns namespace rules and isolation
//
// A "namespace" identifies which registered extension owns a given set of
// presets/variables/events in the API layer (docs/STATE ENGINE API
// SPECIFICATION.md, Section 2). Extension records live in
// settings.extensions, KEYED BY NAMESPACE ({ id, namespace, name,
// registeredAt, registration? }) — the shape settings-core.js's migration
// already gives the built-in `se` record. This module owns that structure
// and the validation helpers built on it; createNamespace() (below) and
// unregisterExtension() (extension-registry.js) are the only writers of the
// records themselves, and registerExtension() (extension-registration.js)
// the only writer of a record's `registration` metadata.
//
// This module and identity.js import each other (identity needs
// ownsNamespace, createNamespace needs the instance check). Safe: every
// cross-reference is a function declaration used only at call time.

import { getSettings, persistSettings, LOG_PREFIX } from '../core/settings-core.js';
import { validateInstanceId } from './identity.js';

// Defensive accessor, mirroring chat-state.js's getStore() pattern — never
// assumes settings-core.js's own default-backfill already ran.
export function getExtensionsStore() {
    const settings = getSettings();
    if (!settings.extensions || typeof settings.extensions !== 'object') {
        settings.extensions = {};
    }
    return settings.extensions;
}

// Returns the record whose `id` is `extensionId`, or null. An extension
// owns at most one namespace (createNamespace enforces it), so this is
// unambiguous. Records are keyed by namespace, not by extension id, which
// is why a lookup by id is a scan.
export function findExtensionRecord(extensionId) {
    if (typeof extensionId !== 'string' || !extensionId) return null;
    for (const record of Object.values(getExtensionsStore())) {
        if (record?.id === extensionId) return record;
    }
    return null;
}

// A namespace is a prefix of every qualified variable name ("pp__mood",
// delimiter "__" - see variable-api.js) and of every event name ("pp.roll",
// delimiter "."), so it may contain neither "_" nor "." and must lead with
// a letter so the qualified name still tokenizes as one DSL identifier.
const NAMESPACE_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

// Claims `namespace` for `extensionId`: adds a record keyed by the
// namespace, owned by that extension id. Instance identity only - there is
// no ownership to check yet, that is what this call creates.
//
// Throws (loudly, like the rest of the identity layer) on: a wrong
// instance, an invalid extensionId/namespace, a namespace already taken by
// a DIFFERENT extension, or an extension that already owns a different
// namespace. Re-creating a namespace the same extension already owns is
// idempotent - returns the existing record, writes nothing - because
// settings persist across page loads and an extension calling this on
// every startup must not fail on its second load.
export function createNamespace(extensionId, instanceId, namespace) {
    validateInstanceId(instanceId);

    if (typeof extensionId !== 'string' || !extensionId) {
        throw new Error('State Engine API call rejected: createNamespace requires an extensionId');
    }
    if (typeof namespace !== 'string' || !NAMESPACE_PATTERN.test(namespace)) {
        throw new Error(`Namespace '${namespace}' is invalid: it must start with a letter and contain only letters and digits`);
    }

    const store = getExtensionsStore();
    if (Object.prototype.hasOwnProperty.call(store, namespace)) {
        if (store[namespace].id === extensionId) return { ...store[namespace] };
        throw new Error(`Namespace '${namespace}' is already taken`);
    }

    const owned = findExtensionRecord(extensionId);
    if (owned) {
        throw new Error(`Extension '${extensionId}' already owns namespace '${owned.namespace}'`);
    }

    const record = { id: extensionId, namespace, name: extensionId, registeredAt: Date.now() };
    store[namespace] = record;
    persistSettings();
    return { ...record };
}

// Every namespace currently claimed, including the built-in `se`. Open to
// any caller by design: namespaces are meant to be discoverable, and the
// list carries no metadata (that is getExtensionRegistration()).
export function getNamespaces() {
    try {
        return Object.keys(getExtensionsStore());
    } catch (err) {
        console.warn(LOG_PREFIX, 'getNamespaces failed (gracefully handled)', err);
        return [];
    }
}

// True if `namespace` is a currently-claimed namespace (an extension called
// createNamespace() for it and hasn't since been unregistered). This is
// namespace *existence*, not per-caller ownership — see ownsNamespace().
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
// claimed `namespace`. This is the ownership half of identity.js's
// validateCallerIdentity().
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
