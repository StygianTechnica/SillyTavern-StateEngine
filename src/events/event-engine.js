// State Engine — event wiring

import { LOG_PREFIX } from '../core/settings-core.js';
import { applyResetOnNewChat, runStartupOnce, offerNewChatStart, looksLikeNewChat } from '../core/initialization-engine.js';
import { runPromptedStateUpdate } from '../core/prompted-engine.js';
import { runDeterministicIncrements } from '../core/deterministic-engine.js';
import { seedVariablesForChat, hydrateMacroStoreForChat, loadChatState } from '../core/chat-state.js';
import { refreshVariableMacros } from '../core/macro-registration.js';
import { filterLoadedWorldInfo } from '../world-info/wi-filtering.js';
import { offerLorebookPresets } from '../core/initialization-engine.js';
import { observeWIEditorChanges } from '../world-info/wi-condition-ui.js';
import { refreshPanelIfOpen } from '../ui/ui-entrypoints.js';
import { refreshManagerButtonLater } from '../ui/wand-ui.js';
import { renderNotificationUi } from '../ui/notification-ui.js';
import { populateConnectionProfileDropdown } from '../ui/connection-profile-ui.js';

export function registerEvents() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    // Covers the case where this extension finishes loading only after
    // APP_READY has already fired; runStartupOnce() guards against firing twice.
    eventSource.on(eventTypes.APP_READY, runStartupOnce);

    // Every statement below is wrapped in its own try/catch. A failure in
    // one State Engine step (e.g. a prompted update) must never prevent the
    // next step from running, and must never propagate out of this event
    // handler into SillyTavern's own event dispatch / generation pipeline.
    // Nothing here reads or writes SillyTavern chat metadata — chat state
    // lives exclusively in chat-state.js (via loadChatState).
    // The chat that was open just before the current one: the chat a new chat is
    // started FROM, and so what it should continue from.
    let previousChatId = null;
    let currentChatId = null;

    const onChatCreated = async () => {
        const context = SillyTavern.getContext();
        const chatId = context.chatId;

        try {
            loadChatState(chatId);
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            // Asks how the new chat should start (same presets / same presets + data
            // / clean slate). SillyTavern awaits this listener, so the answer is
            // applied before the chat carries on.
            await offerNewChatStart(chatId, undefined, previousChatId);
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            // CHAT_CHANGED already asked about lorebook presets, but a new chat's
            // attached lorebooks may not have been readable yet then; asking again
            // is harmless - it only asks about presets that are still missing and
            // not declined.
            offerLorebookPresets(chatId);
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            refreshVariableMacros();
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
    };
    eventSource.on(eventTypes.CHAT_CREATED, onChatCreated);
    // A brand-new GROUP chat emits GROUP_CHAT_CREATED instead of CHAT_CREATED.
    if (eventTypes.GROUP_CHAT_CREATED) eventSource.on(eventTypes.GROUP_CHAT_CREATED, onChatCreated);

    eventSource.on(eventTypes.CHAT_CHANGED, async () => {
        const context = SillyTavern.getContext();
        const chatId = context.chatId;
        if (chatId !== currentChatId) {
            previousChatId = currentChatId;
            currentChatId = chatId;
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
            // A new chat whose character has no greeting never gets CHAT_CREATED,
            // so the "start from your last chat?" question is also asked here.
            // Asked BEFORE the lorebook offer so the earlier chat's presets are
            // settled first (a preset already active is not offered again).
            if (looksLikeNewChat(chatId, context)) await offerNewChatStart(chatId, undefined, previousChatId);
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            offerLorebookPresets(chatId);
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            runPromptedStateUpdate('chat_change');
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }

        try {
            refreshVariableMacros();
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

        try {
            renderNotificationUi(); // puts the notification button back if ST rebuilt the send bar
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }
    });

    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, () => {
        const chatId = SillyTavern.getContext().chatId;

        try {
            // A deterministic increment (a counter, an image list rotating...) changes
            // what the tracker shows, and nothing else redraws it: the prompted update
            // only does when it has prompted variables to ask about.
            if (runDeterministicIncrements(chatId, 'user') > 0) refreshPanelIfOpen();
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
            if (runDeterministicIncrements(chatId, 'ai') > 0) refreshPanelIfOpen();
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

    // Conditional world info: WORLDINFO_ENTRIES_LOADED fires BEFORE the scan with
    // mutable arrays of entries, so filtering them here really keeps entries out
    // of the prompt. (WORLD_INFO_ACTIVATED - the hook that used to be commented
    // out here - fires after activation with a copy, and cannot filter anything.
    // See wi-filtering.js.)
    if (eventTypes.WORLDINFO_ENTRIES_LOADED) {
        eventSource.on(eventTypes.WORLDINFO_ENTRIES_LOADED, (payload) => {
            filterLoadedWorldInfo(payload);
        });
    } else {
        console.warn(LOG_PREFIX, 'WORLDINFO_ENTRIES_LOADED is not available in this SillyTavern version - conditional world info is inactive');
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

// Dispatches a namespaced API-layer event (src/api/event-api.js) on the
// same eventSource instance every built-in listener above is registered
// on, so API-fired events go through this one place rather than callers
// reaching for SillyTavern.getContext().eventSource directly. Never
// throws — a listener that fails is exactly as isolated as failures
// already are everywhere else in this file.
export function dispatchNamespacedEvent(chatId, eventName) {
    try {
        const context = SillyTavern.getContext();
        context.eventSource?.emit(eventName, chatId);
        return true;
    } catch (err) {
        console.warn(LOG_PREFIX, `dispatchNamespacedEvent failed for "${eventName}" (gracefully handled)`, err);
        return false;
    }
}
