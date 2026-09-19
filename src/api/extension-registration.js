// Extension Registration API
//
// Lets an extension that already owns a namespace (createNamespace() in
// namespace-manager.js) DECLARE what it provides there - which variables,
// which capabilities, which capabilities it depends on, a description - so
// other extensions can discover it (getRegisteredExtensions /
// getExtensionRegistration).
//
// Pure metadata: registering touches the extension's own record in
// settings.extensions and nothing else. It creates no variables or
// presets, seeds nothing, recalculates nothing, refreshes no macros, fires
// no events and adds no dependency edges - a declared variable need not
// even exist yet. See docs/STATE ENGINE API SPECIFICATION.md, "Extension
// Registration API" and "Extension Capability Graph".
//
// Where the data lives: `registration` (on the record) holds namespace,
// variables and description. `capabilities` and `dependsOn` are NOT stored
// in it - they live on the record itself, owned by capability-graph.js, and
// this module writes them through declareCapabilities()/declareDependencies()
// and merges them back into every registration it returns. One copy, so a
// later direct declareCapabilities() call can never leave the registration
// showing stale capabilities.

import { persistSettings } from '../core/settings-core.js';
import { validateCallerIdentity } from './identity.js';
import { getExtensionsStore, findExtensionRecord } from './namespace-manager.js';
import { declareCapabilities, declareDependencies } from './capability-graph.js';
import { normalizeStringList } from './capability-rules.js';

const ALLOWED_FIELDS = new Set(['namespace', 'variables', 'capabilities', 'dependsOn', 'description']);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function reject(reason) {
    throw new Error(`Extension registration rejected: ${reason}`);
}

// Validates `metadata` and returns it normalized: exactly { namespace,
// variables, capabilities, dependsOn, description }, arrays copied and
// de-duplicated (first occurrence wins), omitted fields defaulted. Never
// returns the caller's own objects, so later mutation by the caller cannot
// alter what is stored. Everything is validated BEFORE anything is written.
function normalizeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        reject('metadata must be an object');
    }
    for (const key of Object.keys(metadata)) {
        if (!ALLOWED_FIELDS.has(key)) reject(`unknown metadata field '${key}' (allowed: ${[...ALLOWED_FIELDS].join(', ')})`);
    }

    const { namespace } = metadata;
    if (typeof namespace !== 'string' || !namespace) reject('metadata.namespace must be a non-empty string');

    const variables = metadata.variables ?? [];
    if (!Array.isArray(variables)) reject('metadata.variables must be an array of strings');
    const prefix = `${namespace}__`;
    for (const name of variables) {
        if (typeof name !== 'string') reject('metadata.variables must contain only strings');
        // "Fully qualified" = the exact stored form variable-api.js gives a
        // variable: `${namespace}__${localName}`, in the caller's OWN
        // namespace, and a single valid DSL identifier (a dot would break
        // calculated-variable expressions - see variable-api.js).
        if (!name.startsWith(prefix) || name.length === prefix.length || !IDENTIFIER.test(name)) {
            reject(`variable '${name}' is not fully qualified - expected '${prefix}<name>' in namespace '${namespace}'`);
        }
    }

    // Same rule, same function as declareCapabilities()/declareDependencies().
    const capabilities = normalizeStringList(metadata.capabilities ?? [], 'metadata.capabilities', reject);
    const dependsOn = normalizeStringList(metadata.dependsOn ?? [], 'metadata.dependsOn', reject);

    const description = metadata.description ?? '';
    if (typeof description !== 'string') reject('metadata.description must be a string');

    return { namespace, variables: [...new Set(variables)], capabilities, dependsOn, description };
}

const copy = (list) => (Array.isArray(list) ? [...list] : []);

// The registration as callers see it: the stored declaration plus the live
// capability-graph fields from the same record.
function composeRegistration(record) {
    const registration = record.registration;
    return {
        namespace: registration.namespace,
        variables: [...registration.variables],
        capabilities: copy(record.capabilities),
        dependsOn: copy(record.dependsOn),
        description: registration.description,
    };
}

// Identity first (wrong instance / extension doesn't own metadata.namespace
// / no namespace supplied all throw before anything is inspected), then
// full metadata validation (throws), then the writes. A registration
// REPLACES any previous one for that extension outright - it is not
// merged - and that includes the capability graph: a registration that
// omits `capabilities` or `dependsOn` CLEARS them, exactly as it clears
// `variables` and `description`. Returns a copy of the composed result.
export function registerExtension(extensionId, instanceId, metadata) {
    validateCallerIdentity(extensionId, instanceId, metadata?.namespace);
    const normalized = normalizeMetadata(metadata);

    // Ownership was just verified, so this record exists and is this
    // extension's.
    const record = getExtensionsStore()[normalized.namespace];
    record.registration = {
        namespace: normalized.namespace,
        variables: normalized.variables,
        description: normalized.description,
    };
    persistSettings();

    // Already validated above, so these cannot reject; they are the single
    // writers of record.capabilities / record.dependsOn.
    declareCapabilities(extensionId, instanceId, normalized.capabilities);
    declareDependencies(extensionId, instanceId, normalized.dependsOn);

    return composeRegistration(record);
}

// Discovery - open to any caller, no identity required, read-only.
// Returns { [extensionId]: registration } for every extension that has
// called registerExtension(). An extension that merely claimed a namespace
// (or only called declareCapabilities/declareDependencies) is absent here -
// it is listed by getNamespaces() and getCapabilityGraph().
export function getRegisteredExtensions() {
    const registered = {};
    for (const record of Object.values(getExtensionsStore())) {
        if (record?.registration) registered[record.id] = composeRegistration(record);
    }
    return registered;
}

// Discovery for a single extension: its registration, or null if it is
// unknown or has not registered.
export function getExtensionRegistration(extensionId) {
    const record = findExtensionRecord(extensionId);
    return record?.registration ? composeRegistration(record) : null;
}
