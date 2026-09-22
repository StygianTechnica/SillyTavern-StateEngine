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
import { recalculateDependents, consumeDatetimeJump } from './calculated-engine.js';
import { isValidDelta } from './calendar-engine.js';

// Returns how many variables were incremented (0 when nothing was), so the caller
// can redraw the tracker only when something actually changed.
export function runDeterministicIncrements(chatId, triggerType) {
    let applied = 0;
    try {
        const settings = getSettings();
        if (!settings.enabled) return 0;

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
                applied += 1;
            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        }

        applied += runFixedIncrementTicks(chatId, variables);
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
    return applied;
}

// Calculated-datetime extension (requirements spec 1.31): a SEPARATE,
// independent mechanism from the legacy behaviors.increment/increment.delta
// loop above - a datetime variable opts in with fixedIncrement: true AND
// accumulate: true (both required; accumulate is the deliberate master
// switch a datetime variable can flip without touching fixedIncrement/
// tickUnit - see variable-schema.js) and steps by tickUnit on every
// deterministic pass, i.e. every call to runDeterministicIncrements()
// regardless of triggerType - it has no `triggers` config of its own,
// unlike the legacy path. A variable whose deltaSource just applied a jump
// this same pass (calculated-engine.js's consumeDatetimeJump(), one-shot)
// skips this one tick instead of also stepping by tickUnit on top of the
// jump it just received - per instruction, a delta jump and the fixed tick
// never both land on the same variable at once. This is best-effort, not a
// hard guarantee: see consumeDatetimeJump()'s own comment for why.
function runFixedIncrementTicks(chatId, variables) {
    let applied = 0;
    for (const def of Object.values(variables)) {
        try {
            if (def?.type !== 'datetime' || !def.name) continue;
            if (def.fixedIncrement !== true || def.accumulate !== true) continue;

            if (consumeDatetimeJump(chatId, def.name)) continue;

            const calendarId = def.calendar || DEFAULT_CALENDAR_ID;
            if (!isValidDelta(calendarId, def.tickUnit)) {
                console.warn(LOG_PREFIX, `fixedIncrement tick skipped for "${def.name}": invalid tickUnit ${JSON.stringify(def.tickUnit)} for calendar "${calendarId}"`);
                continue;
            }

            applyIncrement(chatId, def.name, def.tickUnit, def);
            recalculateDependents(chatId, def.name);
            applied += 1;
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        }
    }
    return applied;
}
