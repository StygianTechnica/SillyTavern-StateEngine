// State Engine — initialization / reset

import { LOG_PREFIX, getSettings, migrateAllSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { setVar, cleanupDeadChats } from './chat-state.js';
import { getDefaultValue } from './variable-schema.js';
import { shouldSkipPromptedRefresh, runPromptedStateUpdate } from './prompted-engine.js';


export function applyResetOnNewChat() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    const variables = getAllVariablesFromPresets(activePresetIds);

    for (const def of Object.values(variables)) {
        if (!def.name || !def.resetOnNewChat || shouldSkipPromptedRefresh(def)) continue;
        setVar(chatId, def.name, getDefaultValue(def));
    }
}

let startupRan = false;

export function runStartupOnce() {
    if (startupRan) return;
    startupRan = true;
    const settings = getSettings();
    migrateAllSettings(settings);

    // Deliberately run here, not bare at extension-script-load time: this
    // fires on/after APP_READY (or immediately if APP_READY already fired -
    // see registerEvents()), by which point context.characters is actually
    // populated. Running it any earlier meant knownAvatars was empty on
    // every load, so every character looked "no longer existing" and
    // cleanupDeadChats deleted every chat's isolated-store entry outright.
    try {
        cleanupDeadChats();
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }

    runPromptedStateUpdate('startup');
}
