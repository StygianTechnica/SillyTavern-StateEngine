// State Engine — initialization / reset

import { LOG_PREFIX, getSettings, migrateAllSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { setVar, loadChatState } from './chat-state.js';
import { getDefaultValue } from './variable-schema.js';
import { shouldSkipPromptedRefresh, runPromptedStateUpdate } from './prompted-engine.js';
import { recalculateDependents, recalculateAllForChat } from './calculated-engine.js';


export function applyResetOnNewChat() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    const variables = getAllVariablesFromPresets(activePresetIds);

    for (const def of Object.values(variables)) {
        if (!def.name || !def.resetOnNewChat || shouldSkipPromptedRefresh(def)) continue;
        setVar(chatId, def.name, getDefaultValue(def));
        recalculateDependents(chatId, def.name);
    }
}

// Offers to copy another chat's stored variables into a brand-new chat, when
// one exists for the same character/group. Only ever called from
// CHAT_CREATED (never CHAT_CHANGED) - this is a one-time new-chat
// convenience, not automatic hydration, and must not be confused with
// seeding (3.1 forbids seeding on CHAT_CREATED; this only ever copies
// already-stored values from a *different* chat, through setVar() per
// variable - it never assigns the whole stored state object, so the new
// chat keeps its own characterAvatar/groupId/seeded stamps rather than
// inheriting the source chat's).
export function offerCopyFromPreviousChat(chatId) {
    try {
        if (!chatId) return;
        const context = SillyTavern.getContext();
        const settings = getSettings();
        const store = settings.variableStore?.chats || {};

        // loadChatState() stamps characterAvatar/groupId based on the
        // current character/group selection even before this chat's entry
        // is persisted - reliable for matching purposes here.
        const newChatState = loadChatState(chatId);
        const isGroup = !!newChatState.groupId;

        const candidates = Object.entries(store)
            .filter(([id, state]) => id !== chatId && Object.keys(state?.variables || {}).length > 0)
            .filter(([, state]) => isGroup
                ? state?.groupId === newChatState.groupId
                : state?.characterAvatar === newChatState.characterAvatar)
            .sort(([, a], [, b]) => (b?.lastUpdated || 0) - (a?.lastUpdated || 0));

        if (candidates.length === 0) return;

        const [sourceChatId, sourceState] = candidates[0];
        const confirmed = window.confirm(
            `Copy stored State Engine variables from your most recent previous chat with this ${isGroup ? 'group' : 'character'} ("${sourceChatId}") into this new chat? This will overwrite any variables this new chat already has.`
        );
        if (!confirmed) return;

        for (const [varName, entry] of Object.entries(sourceState.variables || {})) {
            if (!varName) continue;
            setVar(chatId, varName, entry?.value, entry?.def);
        }
        // One pass, after all copied values are in place, rather than a
        // recalculateDependents() per variable - potentially many variables
        // just changed at once, and calculated variables should reflect the
        // fully-copied state, not partial intermediate states from earlier
        // in this loop.
        recalculateAllForChat(chatId);
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

let startupRan = false;

export function runStartupOnce() {
    if (startupRan) return;
    startupRan = true;
    const settings = getSettings();
    migrateAllSettings(settings);
    runPromptedStateUpdate('startup');
}
