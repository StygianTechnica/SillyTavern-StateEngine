// Extension Capability Graph
//
// A global metadata layer over the extension records in settings.extensions:
// what each extension PROVIDES (record.capabilities) and what it DEPENDS ON
// (record.dependsOn), both plain lists of capability strings such as
// "ui.panel" or "data.inventory". Those two fields on the extension's
// record are the single source of truth - extension registration
// (extension-registration.js) writes them through declareCapabilities()/
// declareDependencies() below and merges them back into what discovery
// returns, so nothing is stored twice and nothing can drift.
//
// Pure metadata, like registration: writing here touches
// settings.extensions[<namespace>].capabilities / .dependsOn and nothing
// else - no presets, variables, chat-state, dependency edges, macros or
// events. See docs/STATE ENGINE API SPECIFICATION.md, "Extension Capability
// Graph".

import { persistSettings } from '../core/settings-core.js';
import { resolveCallerRecord } from './identity.js';
import { getExtensionsStore, findExtensionRecord } from './namespace-manager.js';
import { normalizeStringList } from './capability-rules.js';

function reject(reason) {
    throw new Error(`Capability declaration rejected: ${reason}`);
}

const copy = (list) => (Array.isArray(list) ? [...list] : []);

// Replaces (does not merge) the list of capabilities this extension
// provides. An empty array clears it. Validates completely before writing,
// so a rejected call leaves the previous list untouched. Returns a copy of
// what was stored.
export function declareCapabilities(extensionId, instanceId, capabilities) {
    const record = resolveCallerRecord(extensionId, instanceId);
    record.capabilities = normalizeStringList(capabilities, 'capabilities', reject);
    persistSettings();
    return copy(record.capabilities);
}

// Replaces the list of capabilities this extension depends on. Nothing
// checks that any provider exists - a dependency may legitimately be unmet
// (its provider not installed yet); getExtensionsProviding() is how a
// consumer resolves one.
export function declareDependencies(extensionId, instanceId, capabilityList) {
    const record = resolveCallerRecord(extensionId, instanceId);
    record.dependsOn = normalizeStringList(capabilityList, 'dependencies', reject);
    persistSettings();
    return copy(record.dependsOn);
}

// ---- discovery: open to any caller, read-only, always returns copies -----

// { [extensionId]: { capabilities, dependsOn } } for EVERY extension that
// has claimed a namespace (including the built-in `se`), with empty lists
// for one that has declared nothing. Relationships between extensions are
// not stored separately: "A depends on something B provides" is derivable
// from this map (or getExtensionsProviding) and stays correct by
// construction.
export function getCapabilityGraph() {
    const graph = {};
    for (const record of Object.values(getExtensionsStore())) {
        if (!record) continue;
        graph[record.id] = { capabilities: copy(record.capabilities), dependsOn: copy(record.dependsOn) };
    }
    return graph;
}

// Ids of every extension that provides `capability`, in namespace-claim
// order. [] for none, or for a non-string argument.
export function getExtensionsProviding(capability) {
    if (typeof capability !== 'string' || !capability) return [];
    return Object.values(getExtensionsStore())
        .filter((record) => Array.isArray(record?.capabilities) && record.capabilities.includes(capability))
        .map((record) => record.id);
}

export function getExtensionCapabilities(extensionId) {
    return copy(findExtensionRecord(extensionId)?.capabilities);
}

export function getExtensionDependencies(extensionId) {
    return copy(findExtensionRecord(extensionId)?.dependsOn);
}
