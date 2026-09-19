// Shared validation for capability strings.
//
// Internal to the API layer: deliberately NOT re-exported from index.js /
// the stateEngine facade. Both capability-graph.js (declareCapabilities /
// declareDependencies) and extension-registration.js (metadata.capabilities
// / metadata.dependsOn) validate through this one function, so the two entry
// points can never disagree about what a legal capability list is.

// Returns a copy of `value` with duplicates removed (first occurrence wins).
// `reject(reason)` must throw - each caller supplies its own error prefix.
// `label` names the offending argument in the message.
export function normalizeStringList(value, label, reject) {
    if (!Array.isArray(value)) reject(`${label} must be an array of strings`);
    for (const item of value) {
        if (typeof item !== 'string' || !item) reject(`${label} must contain only non-empty strings`);
    }
    return [...new Set(value)];
}
