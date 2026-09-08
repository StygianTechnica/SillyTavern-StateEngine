// State Engine — state loader
//
// Centralizes "get me this chat's state, initialized if needed" so callers
// don't talk to variable-store.js's internals directly.

import { LOG_PREFIX } from './settings-core.js';
import { loadChatState } from './variable-store.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { getDefaultValue } from './variable-definition.js';

export function loadStateForChat(chatId) {
    try {
        // Load whatever persistent state exists
        const state = loadChatState(chatId);

        // Always return the stored state as-is.
        // Seeding happens ONLY in lifecycle events (CHAT_CREATED, CHAT_CHANGED, engine enable, preset add/remove).
        return state;
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        return { variables: {}, lastUpdated: Date.now(), version: 1 };
    }
}

