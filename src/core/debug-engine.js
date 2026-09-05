// State Engine — debug info collection

import { LOG_PREFIX, getSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { getVarValue } from './variable-storage.js';
import { getCurrentChatId } from '../ui/wand-ui.js';

// ---------------------------------------------------------------------------
// Debug info collection
// ---------------------------------------------------------------------------

export function getDebugInfo() {
    try {
        const context = SillyTavern.getContext();
        const chatId = getCurrentChatId();
        const settings = getSettings();
        const activePresetIds = getPresetsForChat(chatId);

        // Collect active preset details
        const activePresetsInfo = activePresetIds.map(id => {
            const preset = settings.presets[id];
            return {
                id,
                name: preset?.name || 'unknown',
                description: preset?.description || '',
                variableCount: Object.keys(preset?.variables || {}).length,
                triggers: preset?.triggers || []
            };
        });

        // Collect all variables and their current values
        const variables = getAllVariablesFromPresets(activePresetIds);
        const variablesWithValues = Object.entries(variables).map(([varId, varDef]) => {
            const value = getVarValue(context, varDef);
            return {
                id: varId,
                name: varDef.name,
                label: varDef.label,
                type: varDef.type,
                scope: varDef.scope,
                value: value,
                defaultValue: varDef.defaultValue,
                enumValues: varDef.enumValues,
                min: varDef.min,
                max: varDef.max,
                showInTracker: varDef.showInTracker !== false,

                // New behavior model
                behaviors: varDef.behaviors || {},

                // Deterministic increment config
                increment: varDef.increment || {},

                // Prompted increment config
                prompted: varDef.prompted || {},
            };
        });

        return {
            chatId,
            currentTimestamp: new Date().toISOString(),
            activePresets: activePresetsInfo,
            variables: variablesWithValues,
            totalPresets: Object.keys(settings.presets || {}).length,
            debugEnabled: window.seDebugMode,
            settingsKeys: Object.keys(settings),
            fullSettings: settings
        };
    } catch (err) {
        console.error(`${LOG_PREFIX} Error collecting debug info:`, err);
        return { error: err.message };
    }
}
