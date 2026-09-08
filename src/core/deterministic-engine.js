// State Engine — deterministic (non-LLM) variable increments, isolated
// store version.
//
// Reads/writes exclusively through variable-store.js. Never touches
// SillyTavern chat metadata, never touches prompt-building code, and never
// contributes anything to the prompted-update pipeline (that separation is
// enforced in prompted-engine.js's own classification step).

import { LOG_PREFIX, getSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { setVar, applyIncrement } from './variable-store.js';

export function runDeterministicIncrements(chatId, triggerType) {
    try {
        const settings = getSettings();
        if (!settings.enabled) return;

        const activePresetIds = getPresetsForChat(chatId);
        const variables = getAllVariablesFromPresets(activePresetIds);

        for (const def of Object.values(variables)) {
            try {
                if (!def.name) continue;

                // Only deterministic increment variables - never prompted ones.
                if (def.behaviors?.prompted === true) continue;
                if (def.behaviors?.increment !== true) continue;
                if (!def.increment) continue;

                if (def.increment.triggers !== triggerType
                    && !(def.increment.triggers === 'both' && (triggerType === 'ai' || triggerType === 'user'))) {
                    continue;
                }

                applyIncrement(chatId, def.name, def.increment.delta, def);
            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}
