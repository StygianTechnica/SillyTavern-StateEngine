// State Engine — event wiring

import { applyResetOnNewChat, applyDefaultsForMissing, runStartupOnce } from '../core/initialization-engine.js';
import { runPromptedStateUpdate } from '../core/prompted-engine.js';
import { runDeterministicIncrements } from '../core/increment-engine.js';
import { applyWorldInfoConditionalFiltering } from '../world-info/wi-filtering.js';
import { observeWIEditorChanges } from '../world-info/wi-condition-ui.js';
import { refreshPanelIfOpen } from '../ui/ui-entrypoints.js';
import { refreshManagerButtonLater } from '../ui/wand-ui.js';
import { populateConnectionProfileDropdown } from '../ui/connection-profile-ui.js';

export function registerEvents() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    // Covers the case where this extension finishes loading only after
    // APP_READY has already fired; runStartupOnce() guards against firing twice.
    eventSource.on(eventTypes.APP_READY, runStartupOnce);

    eventSource.on(eventTypes.CHAT_CREATED, () => {
        applyResetOnNewChat();
        applyDefaultsForMissing();
        runPromptedStateUpdate('new_chat');
        refreshPanelIfOpen();
        refreshManagerButtonLater();
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        applyDefaultsForMissing();
        runPromptedStateUpdate('chat_change');
        refreshPanelIfOpen();
        refreshManagerButtonLater();
    });

    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, () => {
        //runCounters('user');
        runDeterministicIncrements('user');
        runPromptedStateUpdate('user');
    });

    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => {
        //runCounters('ai');
        runDeterministicIncrements('ai');
        runPromptedStateUpdate('ai');
    });

    eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, () => {
        runPromptedStateUpdate('pre_generation');
    });

    if (eventTypes.GROUP_MEMBER_DRAFTED) {
        eventSource.on(eventTypes.GROUP_MEMBER_DRAFTED, () => {
            runPromptedStateUpdate('group_draft');
        });
    }

    // Hook into world info to apply conditional filtering
    if (eventTypes.WORLD_INFO_ACTIVATED) {
        eventSource.on(eventTypes.WORLD_INFO_ACTIVATED, () => {
            applyWorldInfoConditionalFiltering();
        });
    }

    // Keep the connection-profile dropdown in sync if profiles are
    // created/renamed/deleted elsewhere while the panel is open.
    for (const key of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED', 'CONNECTION_PROFILE_LOADED']) {
        const evt = eventTypes[key];
        if (evt) {
            eventSource.on(evt, () => populateConnectionProfileDropdown());
        }
    }

    // Start monitoring WI editor for condition UI injection
    observeWIEditorChanges();
}
