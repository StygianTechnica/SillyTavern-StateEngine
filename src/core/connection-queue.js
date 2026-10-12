// State Engine — one request at a time per LLM connection
//
// Every background LLM call State Engine makes (the main prompted update's
// chunks, every independent preset run's chunks, whichever extension asked
// for it) goes through callBackgroundLLM (background-llm.js), which lines it
// up here on the connection it will use. Calls on the SAME connection run
// one after another, first come first served; calls on DIFFERENT
// connections run side by side. State Engine owns the connection, so it is
// the one place that decides when a request may go - an extension just
// awaits its call and never has to wait out (or retry around) another
// extension's run.
//
// A failed or rejected call never blocks the line: the next one starts as
// soon as it settles, either way.

const tails = new Map(); // connection key -> the promise the next call waits for
const pending = new Map(); // connection key -> calls queued or running

// The connection a call with these settings goes to (see background-llm.js
// for the order it tries them in): State Engine's own profile override,
// else the configured connection profile, else the chat's active
// connection ('').
export function connectionKeyFor(settings) {
    return String(settings?.stateEngineProfileId || settings?.connectionProfileId || '');
}

// Runs `task` (a function returning a promise) once every call queued
// before it on `key` has settled. Resolves or rejects as `task` does.
export function enqueueOnConnection(key, task) {
    const before = tails.get(key) ?? Promise.resolve();
    pending.set(key, (pending.get(key) ?? 0) + 1);
    const run = before.then(() => task());
    const settled = run.then(() => undefined, () => undefined);
    tails.set(key, settled);
    void settled.then(() => {
        const left = (pending.get(key) ?? 1) - 1;
        if (left > 0) pending.set(key, left);
        else pending.delete(key);
        if (tails.get(key) === settled) tails.delete(key);
    });
    return run;
}

// How many calls are queued or running on `key` (0 when it is idle).
export function pendingOnConnection(key) {
    return pending.get(key) ?? 0;
}
