// Caller identity validation for the API layer.
//
// Every namespaced API entry point (preset-api.js, variable-api.js,
// event-api.js, independent-presets.js) calls validateCallerIdentity()
// synchronously BEFORE doing anything, and lets its error propagate - it is
// deliberately called outside each function's own try/catch, which
// otherwise converts failures into warn-and-return-null. A rejected call
// must never silently no-op.
//
// Honest scope: instanceId is a token stored in settings
// (settings.extensions.se.instanceId), readable by any code running in the
// same page - this catches wrong-instance and wrong-namespace calls
// (accidents, mismatched wiring, an extension reaching into another's
// namespace by mistake), it is NOT a security boundary against hostile
// code in the same JS context.

import { getSettings, persistSettings, BUILTIN_NAMESPACE } from '../core/settings-core.js';
import { genId } from '../core/variable-schema.js';
import { ownsNamespace, findExtensionRecord } from './namespace-manager.js';

// Returns settings.extensions.se.instanceId, creating and persisting it on
// first use. Never creates the `se` record itself: settings-core.js's
// migrateToBuiltinNamespace() is gated on that record not existing yet, so
// creating a partial one here would silently skip the migration entirely.
export function ensureInstanceId() {
    const record = getSettings().extensions?.[BUILTIN_NAMESPACE];
    if (!record) {
        throw new Error('State Engine API call rejected: State Engine is not initialized (built-in namespace not registered yet)');
    }
    if (!record.instanceId) {
        record.instanceId = genId();
        persistSettings();
    }
    return record.instanceId;
}

// The instance half of the identity check on its own. createNamespace()
// needs exactly this: it runs BEFORE the caller owns anything, so the
// ownership half of validateCallerIdentity() could never pass for it.
export function validateInstanceId(instanceId) {
    const expected = ensureInstanceId();
    if (typeof instanceId !== 'string' || instanceId !== expected) {
        throw new Error('State Engine API call rejected: wrong instance');
    }
}

// targetNamespace is a third parameter beyond the two the request named:
// the ownership check needs to know which namespace the call is aimed at.
export function validateCallerIdentity(extensionId, instanceId, targetNamespace) {
    validateInstanceId(instanceId);
    if (!targetNamespace) {
        throw new Error(`State Engine API call rejected: no target namespace supplied by extension '${extensionId}'`);
    }
    if (!ownsNamespace(extensionId, targetNamespace)) {
        throw new Error(`Extension '${extensionId}' does not own namespace '${targetNamespace}'`);
    }
}

// For calls whose signature carries no namespace (declareCapabilities,
// assignBatch, ...): the target is the caller's OWN namespace record. Instance
// first (a wrong instance never reveals whether an extension exists), then
// the record, then the real ownership check - trivially satisfied for a
// record found by id, but it keeps every write on the same identity path.
// Returns the extension's record.
export function resolveCallerRecord(extensionId, instanceId) {
    validateInstanceId(instanceId);
    const record = findExtensionRecord(extensionId);
    if (!record) {
        throw new Error(`Extension '${extensionId}' does not own a namespace - call createNamespace() first`);
    }
    validateCallerIdentity(extensionId, instanceId, record.namespace);
    return record;
}
