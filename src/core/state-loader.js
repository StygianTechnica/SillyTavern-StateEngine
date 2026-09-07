// State Engine — state loader
//
// Centralizes "get me this chat's state, initialized if needed" so callers
// don't talk to variable-store.js's internals directly.

import { LOG_PREFIX } from './settings-core.js';
import { loadChatState } from './variable-store.js';

export function loadStateForChat(chatId) {
    try {
        // Load whatever persistent state exists
        const state = loadChatState(chatId) || { variables: {}, lastUpdated: Date.now(), version: 1 };

        // Get active presets for this chat
        const activePresetIds = getPresetsForChat(chatId);

        // Get all variable definitions from those presets
        const variables = getAllVariablesFromPresets(activePresetIds);

        // Ensure every variable exists in persistent state
        for (const def of Object.values(variables)) {
            if (!def?.name) continue;

            if (!state.variables[def.name]) {
                state.variables[def.name] = {
                    value: getDefaultValue(def)
                };
            }
        }

        return state;
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        return { variables: {}, lastUpdated: Date.now(), version: 1 };
    }
}

