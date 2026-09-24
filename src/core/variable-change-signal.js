// State Engine — "variable values changed" signal
//
// Every value write in chat-state.js funnels through saveChatState() (or,
// for a variable deleted everywhere, deleteVariableValueEverywhere()), so
// those two call notifyVariablesChanged() and nothing else has to. The
// signal is re-broadcast on SillyTavern's own event bus as
// VARIABLES_CHANGED_EVENT, so any extension can follow value changes with
// a plain eventSource.on(...) - no import of this file required.
//
// Coalesced per microtask: a single engine pass (seeding, a prompted
// update, a calculated recalculation) can save the same chat's state many
// times in a row; listeners get ONE event per chat for the whole burst.
// The payload is just the chatId (null = "possibly every chat") - listeners
// re-read whatever values they care about. It deliberately carries no
// per-variable diff: the store has no cheap way to produce one, and a
// listener that re-reads is correct by construction.

import { LOG_PREFIX } from './settings-core.js';

export const VARIABLES_CHANGED_EVENT = 'state_engine_variables_changed';

const pending = new Set();
let scheduled = false;

function flush() {
    scheduled = false;
    const chatIds = [...pending];
    pending.clear();
    let eventSource;
    try {
        eventSource = SillyTavern.getContext()?.eventSource;
    } catch {
        return;
    }
    if (typeof eventSource?.emit !== 'function') return;
    for (const chatId of chatIds) {
        try {
            // emit() may return a Promise (SillyTavern's bus awaits async
            // listeners) - a listener failure must never surface here.
            const result = eventSource.emit(VARIABLES_CHANGED_EVENT, chatId);
            if (result && typeof result.catch === 'function') {
                result.catch((err) => console.warn(LOG_PREFIX, 'variables-changed listener failed (gracefully handled)', err));
            }
        } catch (err) {
            console.warn(LOG_PREFIX, 'variables-changed emit failed (gracefully handled)', err);
        }
    }
}

export function notifyVariablesChanged(chatId = null) {
    pending.add(chatId ?? null);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
}
