// State Engine — deterministic (non-LLM) variable increments, isolated
// store version.
//
// Reads/writes exclusively through chat-state.js. Never touches
// SillyTavern chat metadata, never touches prompt-building code, and never
// contributes anything to the prompted-update pipeline (that separation is
// enforced in prompted-engine.js's own classification step).

import { LOG_PREFIX, DEFAULT_CALENDAR_ID, getSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { setVar, applyIncrement } from './chat-state.js';
import { recalculateDependents } from './calculated-engine.js';
import { isValidDelta } from './calendar-engine.js';

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

                // A datetime variable is stepped by the calendar, not by
                // numeric addition: applyIncrement() (chat-state.js) routes
                // it through calendar-engine's incrementScalar() - the one
                // write path every increment shares - with delta as a string
                // such as "1h"/"1d"/"1mo"/"1y" - or, on a fantasy calendar
                // (spec 1.22.3), "1season"/"1cycle". isValidDelta() checks
                // the delta against THAT calendar's own units, so "1season"
                // is valid on a calendar with seasons and skipped (with this
                // warning) on one without. An unparseable delta is reported
                // here, by variable, instead of silently doing nothing
                // inside applyIncrement().
                if (def.type === 'datetime' && !isValidDelta(def.calendar || DEFAULT_CALENDAR_ID, def.increment.delta)) {
                    console.warn(LOG_PREFIX, `datetime increment skipped for "${def.name}": invalid delta ${JSON.stringify(def.increment.delta)} for calendar "${def.calendar || DEFAULT_CALENDAR_ID}"`);
                    continue;
                }

                applyIncrement(chatId, def.name, def.increment.delta, def);
                recalculateDependents(chatId, def.name);
            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}
