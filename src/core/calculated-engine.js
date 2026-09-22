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

import { LOG_PREFIX, DEFAULT_CALENDAR_ID } from './settings-core.js';
import { getVar, setVar } from './chat-state.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { evaluateExpression } from './expression-dsl.js';
import { toScalar, resolveInstruction } from './calendar-engine.js';
import { getDefaultValue } from './variable-schema.js';

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
// (section 11.3), a variable that can't be resolved retains its previous
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
// 11.3: retain the previous stored value, log a warning, never throw.
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

// Calculated-datetime extension (requirements spec 1.31): datetime.value has
// just jumped via its deltaSource, keyed "chatId::datetimeVarName". Read
// (and cleared) once by deterministic-engine.js's fixedIncrement tick, so a
// jump that lands the same round a tick would otherwise fire suppresses that
// one tick rather than both landing on top of each other. Best-effort, not a
// hard guarantee: the prompted update that writes a deltaSource is fire-and-
// forget (prompted-engine.js never awaits it), so it can resolve either
// before or after that round's deterministic pass already ran - a jump that
// lands AFTER the tick already fired cannot retroactively suppress it. In-
// memory only, same lifetime/cleanup tradeoff as lastEvaluationErrors above.
const recentDatetimeJumps = new Map();

function jumpKey(chatId, varName) {
    return `${chatId}::${varName}`;
}

// One-shot read: true if `varName` just received a delta jump since this was
// last called for it, and clears the flag either way. Exported for
// deterministic-engine.js.
export function consumeDatetimeJump(chatId, varName) {
    const key = jumpKey(chatId, varName);
    const had = recentDatetimeJumps.get(key) === true;
    recentDatetimeJumps.delete(key);
    return had;
}

// Datetime delta-consumption trigger (requirements spec 1.31): a datetime
// variable can name another (normal, prompted, type: 'string') variable in
// the same preset as its deltaSource. Whenever that source variable's value
// changes - detected here, since every write-path caller already calls
// recalculateDependents() right after any write (this file's own header
// comment) - its text ("3 days", "until morning", "skip to next season", an
// exact date, ...) is parsed through the SAME calendar NL parser
// prompted-engine.js's direct "update" mode already uses (resolveInstruction,
// spec 1.22.4) and applied to the datetime variable's current value. The
// source is then reset to '' so the same answer is never re-applied on a
// later, unrelated write to some other variable. A source whose text fails
// to parse is left untouched (neither the datetime value nor the source
// itself is written) so the bad answer stays visible - for the console and
// for the next write to correct - rather than being silently discarded.
//
// Two or more datetime variables may share one deltaSource (fan-out): each
// gets the delta applied independently, and the source resets once, after the
// loop, only if at least one of them actually applied it (so an all-parse-
// failure round leaves the source untouched, for the same reason above).
//
// Returns the names of every datetime variable actually updated, so the
// caller (recalculateDependents) can cascade into their own dependents -
// both ordinary calculated variables and, via deltaSource chaining, another
// datetime variable's own trigger.
function applyDatetimeDeltaTriggers(chatId, sourceVarName, allDefs) {
    const sourceValue = getVar(chatId, sourceVarName)?.value;
    if (typeof sourceValue !== 'string' || sourceValue.trim() === '') return [];

    const defs = Object.values(allDefs || {});
    const touched = [];
    let anyApplied = false;

    for (const def of defs) {
        if (def?.type !== 'datetime' || def.deltaSource !== sourceVarName || !def.name) continue;
        try {
            const calendarId = def.calendar || DEFAULT_CALENDAR_ID;
            const stored = getVar(chatId, def.name)?.value ?? getDefaultValue(def);
            const current = toScalar(calendarId, stored) ?? 0;
            // resolveInstruction() as prompted-engine.js's direct "update" mode
            // already uses it requires a verb ("advance 3 hours") or an absolute
            // date/scalar - a bare duration ("3 days", the example phrasing
            // requirements spec 1.31 itself gives a delta variable) matches
            // neither, so it is retried with an implicit "advance " prefix
            // before being treated as unparseable. An instruction that already
            // has its own verb (or is an absolute date) is unaffected - the
            // first, unprefixed attempt already resolves those.
            const next = resolveInstruction(calendarId, current, sourceValue)
                ?? resolveInstruction(calendarId, current, `advance ${sourceValue}`);
            if (next === null) {
                console.warn(LOG_PREFIX, `datetime delta skipped for "${def.name}": could not understand ${JSON.stringify(sourceValue)} from "${sourceVarName}"`);
                continue;
            }
            setVar(chatId, def.name, next, def);
            if (def.fixedIncrement === true) recentDatetimeJumps.set(jumpKey(chatId, def.name), true);
            touched.push(def.name);
            anyApplied = true;
        } catch (err) {
            console.warn(LOG_PREFIX, `datetime delta trigger failed for "${def.name}" (gracefully handled)`, err);
        }
    }

    if (anyApplied) {
        const sourceDef = defs.find((d) => d?.name === sourceVarName) || null;
        if (sourceDef) setVar(chatId, sourceVarName, '', sourceDef);
    }

    return touched;
}

// Recursion guard for the datetime delta trigger below: recalculateDependents
// can call itself (a jump writes a datetime variable, which itself needs its
// own dependents recalculated - including, via deltaSource chaining, another
// datetime trigger). The calculated-variable graph itself never recurses
// (topoSortCalculated already excludes a dependency cycle from `order`), so
// this cap only ever matters for a misconfigured deltaSource chain (A's jump
// writes B, whose own trigger writes back to A, ...). Generous but finite -
// a legitimate chain of datetime triggers is never this deep.
const MAX_DATETIME_TRIGGER_DEPTH = 25;

// Re-evaluates every calculated variable that (directly or transitively,
// through a chain of other calculated variables) depends on `varName`, and
// runs the calculated-datetime delta trigger for it (requirements spec
// 1.31). Called by every write-path caller right after it changes varName's
// value - deterministic-engine.js after an increment, prompted-engine.js
// after a prompted write, ui-events.js after a variable is saved/renamed/
// deleted. `_visited` is internal recursion state only - external callers
// always use the two-argument form and get a fresh guard each call.
export function recalculateDependents(chatId, varName, _visited = new Set()) {
    try {
        if (!chatId || !varName) return;
        if (_visited.has(varName)) {
            console.warn(LOG_PREFIX, `datetime delta trigger cycle detected at "${varName}"; stopping.`);
            return;
        }
        if (_visited.size >= MAX_DATETIME_TRIGGER_DEPTH) {
            console.warn(LOG_PREFIX, 'datetime delta trigger chain exceeded depth limit; stopping.');
            return;
        }
        _visited.add(varName);

        const activePresetIds = getPresetsForChat(chatId);
        const allDefs = getAllVariablesFromPresets(activePresetIds);

        const touchedByDelta = applyDatetimeDeltaTriggers(chatId, varName, allDefs);
        for (const touchedName of touchedByDelta) {
            recalculateDependents(chatId, touchedName, _visited);
        }

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
