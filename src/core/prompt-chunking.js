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
//
// maxAnswer (2026-10-28): a second budget, for the ANSWER - each unit's
// `answer` is about how many characters the model writes for it. A long
// list of short questions can still ask for more than the model may write
// back (a thought, mood and intent for every character present), and an
// answer cut off loses whatever comes last. Optional: without it, or with
// units that carry no `answer`, chunking is by `size` alone, as before.
export function chunkPromptUnits(units, maxChars, maxAnswer = Infinity) {
    const budget = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : Infinity;
    const answerBudget = Number.isFinite(maxAnswer) && maxAnswer > 0 ? maxAnswer : Infinity;
    const list = Array.isArray(units) ? units : [];

    const chunks = [];
    let current = [];
    let currentSize = 0;
    let currentAnswer = 0;

    for (const unit of list) {
        const size = Number.isFinite(unit?.size) ? unit.size : 0;
        const answer = Number.isFinite(unit?.answer) ? unit.answer : 0;
        if (current.length > 0 && (currentSize + size > budget || currentAnswer + answer > answerBudget)) {
            chunks.push(current);
            current = [];
            currentSize = 0;
            currentAnswer = 0;
        }
        current.push(unit);
        currentSize += size;
        currentAnswer += answer;
    }
    if (current.length > 0) chunks.push(current);

    return chunks;
}
