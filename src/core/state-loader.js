// State Engine — state loader
//
// Centralizes "get me this chat's state, initialized if needed" so callers
// don't talk to variable-store.js's internals directly.

import { LOG_PREFIX } from './settings-core.js';
import { loadChatState } from './variable-store.js';

export function loadStateForChat(chatId) {
    try {
        return loadChatState(chatId);
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        return { variables: {}, lastUpdated: Date.now(), version: 1 };
    }
}
