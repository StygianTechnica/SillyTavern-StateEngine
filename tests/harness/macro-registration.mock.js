// Stand-in for src/core/macro-registration.js: refreshVariableMacros()
// re-registers a {{name}} macro (via the context's registerMacro spy) for
// every variable in a preset active for the current chat.

import { vi } from 'vitest';
import context from './context.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.mock.js';

// On globalThis so setup.js can reset it regardless of module instance.
const registered = (globalThis.__seRegisteredMacros ??= new Set());

export const unregisterAllVariableMacros = vi.fn(() => {
    for (const name of registered) context.unregisterMacro(name);
    registered.clear();
});

export const refreshVariableMacros = vi.fn(() => {
    unregisterAllVariableMacros();
    const defs = getAllVariablesFromPresets(getPresetsForChat(context.chatId));
    for (const def of Object.values(defs)) {
        if (!def.name || registered.has(def.name)) continue;
        registered.add(def.name);
        context.registerMacro(def.name, () => String(context.variables.local.get(def.name) ?? ''));
    }
});

export function getRegisteredMacroNames() {
    return [...registered];
}
