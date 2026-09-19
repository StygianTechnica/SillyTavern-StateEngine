// Stand-in for src/core/calculated-engine.js: evaluation + dependent
// cascades over the mock chat-state. The expression itself is evaluated by
// the REAL src/core/expression-dsl.js (a pure module) - only the graph walk
// and store wiring are simplified. Same failure model as the real engine: a
// variable that can't evaluate retains its previous value and records an
// error instead of throwing.

import { vi } from 'vitest';
import { evaluateExpression } from '../../src/core/expression-dsl.js';
import { getVar, setVar } from './chat-state.mock.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.mock.js';

// Lives on globalThis so setup.js can clear it between tests without
// depending on which module instance the API layer happened to import.
const errors = (globalThis.__seCalcErrors ??= new Map());
const key = (chatId, name) => `${chatId}::${name}`;

export function getCalculatedVariableError(chatId, varName) {
    return errors.get(key(chatId, varName)) ?? null;
}

export const evaluateCalculatedVariable = vi.fn((chatId, def) => {
    if (!chatId || def?.type !== 'calculated' || !def.name) return;
    const deps = Array.isArray(def.dependencies) ? def.dependencies : [];
    const values = {};
    for (const dep of deps) values[dep] = getVar(chatId, dep)?.value;

    const result = evaluateExpression(def.expression, deps, values);
    if (!result.ok) {
        errors.set(key(chatId, def.name), result.error);
        return;
    }
    errors.delete(key(chatId, def.name));
    setVar(chatId, def.name, result.value, def);
});

function graph(chatId) {
    const byName = {};
    for (const def of Object.values(getAllVariablesFromPresets(getPresetsForChat(chatId)))) {
        if (def?.name) byName[def.name] = def;
    }
    const calcNames = Object.values(byName).filter((d) => d.type === 'calculated').map((d) => d.name);
    return { byName, calcNames };
}

// Dependencies-first order; anything in a cycle is left out (retains its value).
function order(byName, calcNames) {
    const done = new Set();
    const stack = new Set();
    const cyclic = new Set();
    const out = [];
    const visit = (name, path) => {
        if (done.has(name) || byName[name]?.type !== 'calculated') { done.add(name); return; }
        if (stack.has(name)) { path.slice(path.indexOf(name)).forEach((n) => cyclic.add(n)); return; }
        stack.add(name);
        path.push(name);
        for (const dep of byName[name].dependencies || []) visit(dep, path);
        path.pop();
        stack.delete(name);
        done.add(name);
        out.push(name);
    };
    calcNames.forEach((n) => visit(n, []));
    return out.filter((n) => !cyclic.has(n));
}

export const recalculateDependents = vi.fn((chatId, varName) => {
    if (!chatId || !varName) return;
    const { byName, calcNames } = graph(chatId);
    const affected = new Set();
    let grew = true;
    while (grew) {
        grew = false;
        for (const name of calcNames) {
            const deps = byName[name].dependencies || [];
            if (!affected.has(name) && (deps.includes(varName) || deps.some((d) => affected.has(d)))) {
                affected.add(name);
                grew = true;
            }
        }
    }
    for (const name of order(byName, calcNames)) {
        if (affected.has(name)) evaluateCalculatedVariable(chatId, byName[name]);
    }
});

export const recalculateAllForChat = vi.fn((chatId) => {
    if (!chatId) return;
    const { byName, calcNames } = graph(chatId);
    for (const name of order(byName, calcNames)) evaluateCalculatedVariable(chatId, byName[name]);
});
