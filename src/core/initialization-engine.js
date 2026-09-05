// State Engine — initialization / reset

import { getSettings, migrateAllSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { varStore, setVarValue } from './variable-storage.js';
import { getDefaultValue } from './variable-definition.js';
import { shouldSkipPromptedRefresh, runPromptedStateUpdate } from './prompted-engine.js';

export function applyDefaultsForMissing() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);

    // If no presets bound to this chat, use default
    if (activePresetIds.length === 0 && getSettings().defaultPresetForNewChats) {
        activePresetIds.push(getSettings().defaultPresetForNewChats);
    }

    const variables = getAllVariablesFromPresets(activePresetIds);
    for (const def of Object.values(variables)) {
        if (!def.name || shouldSkipPromptedRefresh(def)) continue;
        const store = varStore(context, def);
        let exists = false;
        try {
            exists = store.has(def.name);
        } catch {
            exists = false;
        }
        if (!exists) {
            setVarValue(context, def, getDefaultValue(def));
        }
    }
}

export function applyResetOnNewChat() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    const variables = getAllVariablesFromPresets(activePresetIds);

    for (const def of Object.values(variables)) {
        if (!def.name || !def.resetOnNewChat || shouldSkipPromptedRefresh(def)) continue;
        setVarValue(context, def, getDefaultValue(def));
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
