// State Engine — initialization / reset

import { LOG_PREFIX, getSettings, migrateAllSettings, persistSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets, addPresetToChat } from './preset-manager.js';
import { getActiveLorebookNames, getPresetsForLorebook, declineKey, pruneDeclinesForChat } from './lorebook-bindings.js';
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

// When a chat loads: for every lorebook attached to it that has presets bound
// (lorebook-bindings.js) which are not active for this chat, ask once per
// lorebook whether to activate them.
//   Yes -> addPresetToChat() for each.
//   No  -> nothing is activated, and the choice is remembered for this chat
//          (settings.lorebookPresetDeclines) so the question is not repeated on
//          every chat load. Without the presets their variables do not exist,
//          and wi-filtering.js treats a WI condition on a missing variable as
//          met (fail-open), so the lorebook's entries are not hidden.
// Returns the preset ids it activated. Never throws.
export function offerLorebookPresets(chatId) {
    const activated = [];
    try {
        if (!chatId) return activated;
        const settings = getSettings();

        // A lorebook that is no longer attached to this chat takes its declines
        // with it, so re-attaching it later asks again.
        const attached = getActiveLorebookNames();
        pruneDeclinesForChat(chatId, attached);

        for (const book of attached) {
            const active = getPresetsForChat(chatId);
            const declined = settings.lorebookPresetDeclines[chatId] || [];
            const missing = getPresetsForLorebook(book, book)
                .filter((id) => !active.includes(id) && !declined.includes(declineKey(book, book, id)));
            if (missing.length === 0) continue;

            const names = missing.map((id) => settings.presets[id]?.name || id).join(', ');
            if (window.confirm(`This lorebook ("${book}") requires the presets ${names}. Activate them?`)) {
                for (const id of missing) {
                    addPresetToChat(chatId, id);
                    activated.push(id);
                }
            } else {
                settings.lorebookPresetDeclines[chatId] = [...declined, ...missing.map((id) => declineKey(book, book, id))];
                persistSettings();
            }
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
    return activated;
}

let startupRan = false;

export function runStartupOnce() {
    if (startupRan) return;
    startupRan = true;
    const settings = getSettings();
    migrateAllSettings(settings);
    runPromptedStateUpdate('startup');
}
