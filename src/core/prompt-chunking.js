// State Engine — automatic prompt chunking (requirements spec 1.20, rewritten
// 2026-09-22)
//
// Replaces the earlier "batching" system (named batches an extension had to
// manually assign each variable to - src/api/batching.js, now removed) with
// what was actually asked for: splitting an oversized prompted-variable list
// into several right-sized LLM calls automatically, with NO manual per-
// variable configuration. See requirements spec 1.20 for the full account of
// why the earlier system missed the mark.
//
// Pure and deterministic: given the same units and budget, always returns
// the same chunking. No I/O, no settings access - callers own measuring
// each unit's size and deciding the budget (prompted-engine.js and
// independent-presets.js both do this slightly differently, so neither is
// hard-coded here).

// unit: { def, kind: 'update' | 'increment', line, size }. `line` is the
// caller's own already-rendered prompt text for this variable; `size` is
// whatever measure the caller's `maxChars` budget is denominated in (both
// current callers use `line.length`, but this function never assumes that -
// it only ever adds up whatever `size` it is given).
//
// Greedy first-fit-in-order: fills the CURRENT chunk until the NEXT unit
// would push it over budget, then starts a new chunk. Never reorders units
// (each kind's relative order, and update-before-increment, is preserved
// exactly as the caller supplied it) and never drops one: a single unit
// larger than the whole budget still gets its own (oversized) chunk rather
// than being silently omitted - the budget is a soft target this function
// tries not to exceed when it has a choice, not a hard per-item limit.
//
// Returns an array of chunks, each an array of units (in the same shape as
// `units`) - never empty chunks, and `[]` for `[]`/no units.
export function chunkPromptUnits(units, maxChars) {
    const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : Infinity;
    const list = Array.isArray(units) ? units : [];

    const chunks = [];
    let current = [];
    let currentSize = 0;

    for (const unit of list) {
        const size = Number.isFinite(unit?.size) ? unit.size : 0;
        if (current.length > 0 && currentSize + size > budget) {
            chunks.push(current);
            current = [];
            currentSize = 0;
        }
        current.push(unit);
        currentSize += size;
    }
    if (current.length > 0) chunks.push(current);

    return chunks;
}
