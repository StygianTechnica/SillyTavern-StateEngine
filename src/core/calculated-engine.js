// State Engine — calculated-variable evaluation and re-evaluation triggers
//
// Calculated variables (type: "calculated") derive their value from other
// variables via expression-dsl.js and are never written by setVar/
// applyIncrement's normal callers - the LLM, deterministic ticks, and manual
// edits never target them directly (their behaviors.prompted/increment are
// always false). Instead, every write-path caller that changes some OTHER
// variable's value explicitly calls recalculateDependents()/
// recalculateAllForChat() afterward, from here.
//
// This module is deliberately NOT called from inside chat-state.js's own
// setVar/applyIncrement: chat-state.js is the write-path (spec 1.6) and
// already exists; having it call back into this module would create a
// circular import (this module needs setVar/getVar from chat-state.js, and
// getPresetsForChat/getAllVariablesFromPresets from preset-manager.js).
// Each caller owning its own trigger avoids that, mirroring how
// deterministic-engine.js already owns its own applyIncrement trigger.

import { LOG_PREFIX } from './settings-core.js';
import { getVar, setVar } from './chat-state.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { evaluateExpression } from './expression-dsl.js';

// Builds a name-keyed map of every variable definition active for this chat,
// plus the list of calculated-type variable names among them. Variable
// identity elsewhere in this codebase is by id, but calculated-variable
// dependencies/expressions reference variables by name (per the DSL spec),
// so name is the key here.
function buildCalculatedGraph(allDefs) {
    const byName = {};
    for (const def of Object.values(allDefs)) {
        if (def?.name) byName[def.name] = def;
    }
    const calcNames = Object.values(byName)
        .filter((d) => d.type === 'calculated')
        .map((d) => d.name);
    return { byName, calcNames };
}

// Topologically sorts calculated variables so each one is evaluated only
// after every calculated variable it depends on (chaining is allowed - a
// calculated variable may depend on another calculated variable). Any
// calculated variable that participates in a dependency cycle is excluded
// from `order` and reported in `cyclic` instead: per the DSL's error model
// (section 10.3), a variable that can't be resolved retains its previous
// stored value rather than being evaluated.
function topoSortCalculated(byName, calcNames) {
    const visited = new Set();
    const inStack = new Set();
    const cyclic = new Set();
    const order = [];

    function visit(name, path) {
        if (visited.has(name)) return;
        const def = byName[name];
        if (!def || def.type !== 'calculated') {
            // Not a calculated variable (or no longer exists) - nothing to
            // recurse into; it's a leaf value read directly from the store.
            visited.add(name);
            return;
        }
        if (inStack.has(name)) {
            const idx = path.indexOf(name);
            for (let i = idx; i < path.length; i++) cyclic.add(path[i]);
            return;
        }

        inStack.add(name);
        path.push(name);
        for (const dep of Array.isArray(def.dependencies) ? def.dependencies : []) {
            visit(dep, path);
        }
        path.pop();
        inStack.delete(name);

        visited.add(name);
        order.push(name);
    }

    for (const name of calcNames) visit(name, []);

    return { order: order.filter((n) => !cyclic.has(n)), cyclic };
}

// Last-evaluation-failure tracking, purely in-memory (not persisted - it's
// re-derived every time a calculated variable is (re)evaluated, and is
// meaningless across a page reload anyway). Lets the UI (tracker,
// manager-modal editor) surface a failure inline instead of only in the
// console, per instruction (2026-09-09): "the user must see the error and
// be able to fix it." Keyed by "chatId::varName" since the same variable
// name can exist as different definitions across chats/presets.
const lastEvaluationErrors = new Map();

function errorKey(chatId, varName) {
    return `${chatId}::${varName}`;
}

// Returns the error string from this variable's most recent failed
// evaluation for this chat, or null if its last evaluation succeeded (or it
// has never been evaluated). Read by tracker-panel-ui.js and ui-events.js.
export function getCalculatedVariableError(chatId, varName) {
    if (!chatId || !varName) return null;
    return lastEvaluationErrors.get(errorKey(chatId, varName)) ?? null;
}

// Evaluates one calculated variable's expression against its dependencies'
// *currently stored* values and writes the result through setVar() (so it
// lands in the isolated store and mirrors into the macro store, same as any
// other write - spec 1.1/1.2). On any evaluation failure, per DSL section
// 10.3: retain the previous stored value, log a warning, never throw.
export function evaluateCalculatedVariable(chatId, def) {
    try {
        if (!chatId || !def || def.type !== 'calculated' || !def.name) return;
        const key = errorKey(chatId, def.name);

        const deps = Array.isArray(def.dependencies) ? def.dependencies : [];
        const values = {};
        for (const depName of deps) {
            const stored = getVar(chatId, depName);
            values[depName] = stored ? stored.value : undefined;
        }

        const result = evaluateExpression(def.expression, deps, values);
        if (!result.ok) {
            console.warn(LOG_PREFIX, `Calculated variable "${def.name}" failed to evaluate (${result.error}); retaining previous value.`);
            lastEvaluationErrors.set(key, result.error);
            return;
        }

        lastEvaluationErrors.delete(key);
        setVar(chatId, def.name, result.value, def);
    } catch (err) {
        console.warn(LOG_PREFIX, `Calculated variable "${def?.name}" evaluation error (gracefully handled)`, err);
        if (chatId && def?.name) lastEvaluationErrors.set(errorKey(chatId, def.name), err?.message || String(err));
    }
}

function warnCyclic(cyclic) {
    for (const name of cyclic) {
        console.warn(LOG_PREFIX, `Calculated variable "${name}" is part of a dependency cycle; retaining previous value.`);
    }
}

// Re-evaluates every calculated variable that (directly or transitively,
// through a chain of other calculated variables) depends on `varName`.
// Called by every write-path caller right after it changes varName's value -
// deterministic-engine.js after an increment, prompted-engine.js after a
// prompted write, ui-events.js after a variable is saved/renamed/deleted.
export function recalculateDependents(chatId, varName) {
    try {
        if (!chatId || !varName) return;

        const activePresetIds = getPresetsForChat(chatId);
        const allDefs = getAllVariablesFromPresets(activePresetIds);
        const { byName, calcNames } = buildCalculatedGraph(allDefs);
        const { order, cyclic } = topoSortCalculated(byName, calcNames);

        // Direct dependents of varName, then the transitive closure over the
        // calculated-variable dependency graph (a calculated variable that
        // depends on another affected calculated variable is affected too).
        const affected = new Set();
        for (const name of calcNames) {
            const def = byName[name];
            if (Array.isArray(def.dependencies) && def.dependencies.includes(varName)) affected.add(name);
        }
        let changed = true;
        while (changed) {
            changed = false;
            for (const name of calcNames) {
                if (affected.has(name)) continue;
                const def = byName[name];
                if (Array.isArray(def.dependencies) && def.dependencies.some((d) => affected.has(d))) {
                    affected.add(name);
                    changed = true;
                }
            }
        }

        if (affected.size === 0) return;

        for (const name of order) {
            if (affected.has(name)) evaluateCalculatedVariable(chatId, byName[name]);
        }

        warnCyclic([...cyclic].filter((name) => affected.has(name)));
    } catch (err) {
        console.warn(LOG_PREFIX, 'recalculateDependents failed (gracefully handled)', err);
    }
}

// Evaluates every calculated variable active for this chat, in dependency
// order, once. Used right after seeding (engine enable, preset add/remove,
// new-chat variable copy) so a freshly seeded calculated variable shows its
// real computed value immediately rather than sitting at defaultValue until
// some dependency happens to change later. This is a distinct lifecycle step
// from hydration/chat-load - it never runs there (spec 4.2/5 forbid that).
export function recalculateAllForChat(chatId) {
    try {
        if (!chatId) return;

        const activePresetIds = getPresetsForChat(chatId);
        const allDefs = getAllVariablesFromPresets(activePresetIds);
        const { byName, calcNames } = buildCalculatedGraph(allDefs);
        if (calcNames.length === 0) return;

        const { order, cyclic } = topoSortCalculated(byName, calcNames);
        for (const name of order) evaluateCalculatedVariable(chatId, byName[name]);
        warnCyclic(cyclic);
    } catch (err) {
        console.warn(LOG_PREFIX, 'recalculateAllForChat failed (gracefully handled)', err);
    }
}
