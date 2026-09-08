// State Engine — event wiring

import { LOG_PREFIX } from '../core/settings-core.js';
import { applyResetOnNewChat, runStartupOnce } from '../core/initialization-engine.js';
import { runPromptedStateUpdate } from '../core/prompted-engine.js';
import { runDeterministicIncrements } from '../core/deterministic-engine.js';
import { seedVariablesForChat, clearMacroVarsForChat, cleanupDeadChats, hydrateMacroStoreForChat, loadChatState } from '../core/variable-store.js';
import { applyWorldInfoConditionalFiltering } from '../world-info/wi-filtering.js';
import { observeWIEditorChanges } from '../world-info/wi-condition-ui.js';
import { refreshPanelIfOpen } from '../ui/ui-entrypoints.js';
import { refreshManagerButtonLater } from '../ui/wand-ui.js';
import { populateConnectionProfileDropdown } from '../ui/connection-profile-ui.js';

export function registerEvents() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    // On extension load.
    try {
        cleanupDeadChats();
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }

    // Covers the case where this extension finishes loading only after
    // APP_READY has already fired; runStartupOnce() guards against firing twice.
    eventSource.on(eventTypes.APP_READY, runStartupOnce);

    // Every statement below is wrapped in its own try/catch. A failure in
    // one State Engine step (e.g. a prompted update) must never prevent the
    // next step from running, and must never propagate out of this event
    // handler into SillyTavern's own event dispatch / generation pipeline.
    // Nothing here reads or writes SillyTavern chat metadata — chat state
    // lives exclusively in variable-store.js (via loadChatState).
    eventSource.on(eventTypes.CHAT_CREATED, () => {
        const context = SillyTavern.getContext();
        const chatId = context.chatId;

        try {
            clearMacroVarsForChat(chatId);
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            cleanupDeadChats();
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            applyResetOnNewChat();
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            loadChatState(chatId);
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            seedVariablesForChat(chatId);
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            runPromptedStateUpdate('new_chat');
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            refreshPanelIfOpen();
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            refreshManagerButtonLater();
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        const context = SillyTavern.getContext();
        const chatId = context.chatId;

        try {
            clearMacroVarsForChat(chatId);
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            cleanupDeadChats();
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            loadChatState(chatId);
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            hydrateMacroStoreForChat(chatId);
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            runPromptedStateUpdate('chat_change');
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            refreshPanelIfOpen();
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            refreshManagerButtonLater();
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }
    });

    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, () => {
        const chatId = SillyTavern.getContext().chatId;

        try {
            runDeterministicIncrements(chatId, 'user');
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            runPromptedStateUpdate('user');
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }
    });

    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => {
        const chatId = SillyTavern.getContext().chatId;

        try {
            runDeterministicIncrements(chatId, 'ai');
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            runPromptedStateUpdate('ai');
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }
    });

    eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, () => {
        try {
            runPromptedStateUpdate('pre_generation');
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }
    });

    if (eventTypes.GROUP_MEMBER_DRAFTED) {
        eventSource.on(eventTypes.GROUP_MEMBER_DRAFTED, () => {
            try {
                runPromptedStateUpdate('group_draft');
            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        });
    }

    // Hook into world info to apply conditional filtering
    if (eventTypes.WORLD_INFO_ACTIVATED) {
        // eventSource.on(eventTypes.WORLD_INFO_ACTIVATED, () => {
        //     applyWorldInfoConditionalFiltering();
        // });
    }

    // Keep the connection-profile dropdown in sync if profiles are
    // created/renamed/deleted elsewhere while the panel is open.
    for (const key of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED', 'CONNECTION_PROFILE_LOADED']) {
        const evt = eventTypes[key];
        if (evt) {
            eventSource.on(evt, () => {
                try {
                    populateConnectionProfileDropdown();
                } catch (err) {
                    console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
                }
            });
        }
    }

    // Start monitoring WI editor for condition UI injection
    try {
        observeWIEditorChanges();
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}
