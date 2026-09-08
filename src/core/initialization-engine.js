// State Engine — initialization / reset

import { getSettings, migrateAllSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { setVar } from './chat-state.js';
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
    runPromptedStateUpdate('startup');
}
