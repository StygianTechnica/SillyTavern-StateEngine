// Shared validation for batch names.
//
// Internal to the API layer (not re-exported from index.js / the facade).
// assignBatch() (batching.js) and createVariable()/updateVariable()
// (variable-api.js, when a definition or patch carries `batch`) validate
// through this one function, so a batch name is legal or not identically
// everywhere it can enter the system.

// Returns the normalized batch name (surrounding whitespace trimmed).
// `reject(reason)` must throw - each caller supplies its own error prefix.
//
// A batch name is written straight into a prompt heading (batchPrompt:
// "### <NAME>"), so besides being a non-empty string it may not contain a
// line break - one would let a name start a new prompt line.
export function normalizeBatchName(value, reject) {
    if (typeof value !== 'string') reject('batchName must be a non-empty string');
    const name = value.trim();
    if (!name) reject('batchName must be a non-empty string');
    if (/[\r\n]/.test(name)) reject('batchName must not contain line breaks');
    return name;
}
