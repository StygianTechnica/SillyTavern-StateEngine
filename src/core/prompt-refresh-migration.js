// State Engine - one-time migration: two built-in prompts that did not work
// (2026-10-14).
//
//   Scene Context's Delta Time asked only for a duration and told the model
//   to turn vague time into numbers, so "the next morning" became a guessed
//   number of hours and the date rarely turned over. It now also takes a
//   time of day ("the next morning", "until dawn") - which the date and time
//   variables resolve themselves - and counts conversation as time passing.
//
//   A character's intent was shown back to the model every turn as its
//   current value, and the model repeated it: it got stuck. It is now asked
//   NEW EACH TURN, like the thought (an empty answer keeps the last one).
//
// Each is changed only while it still has the old built-in text - anything
// the user wrote is left alone. Existing installs only: a new Scene Context
// preset or setting starts from the new text (scene-context-preset.js,
// object-types.js). Runs once (settings.migrations.promptRefresh20261014).

import { LOG_PREFIX, BUILTIN_NAMESPACE, getSettings, persistSettings } from './settings-core.js';
import { isObjectPreset, OBJECT_TYPES } from './object-types.js';
import { SCENE_CONTEXT_BLUEPRINT } from './scene-context-preset.js';

const FLAG = 'promptRefresh20261014';
const SCENE_PRESET = 'Scene Context';
const DELTA_VARIABLE = `${BUILTIN_NAMESPACE}__scene_deltatime`;

export const OLD_DELTA_INSTRUCTIONS = 'Read every message in the Latest turn, including the user’s. Answer how much in-story time passed across all of it, as a duration such as “30 minutes” or “2 hours”. Drop hedging words (“about half an hour” → “30 minutes”) and turn vague durations into numbers. Answer “” only if the whole turn happens in a single moment.';
export const OLD_INTENT_INSTRUCTIONS = 'A short phrase: what they mean to do next.';

const same = (a, b) => String(a ?? '').trim() === b;

function newDeltaInstructions() {
    return SCENE_CONTEXT_BLUEPRINT.vars.find((v) => v.name === 'scene_deltatime').prompted.instructions;
}

// Runtime fields whose old built-in text is replaced, by field name: the
// registry's field of that name (on the object preset's type) is the new.
const OLD_RUNTIME_INSTRUCTIONS = Object.freeze({ intent: OLD_INTENT_INSTRUCTIONS });

function registryField(objectType, name) {
    return OBJECT_TYPES[objectType]?.runtime?.find((f) => f.name === name) ?? null;
}

// Runs the migration if it has not run yet. Returns { delta, intents }
// (whether Delta Time changed, how many settings' intent fields did).
export function migratePromptRefresh() {
    const settings = getSettings();
    if (!settings.migrations || typeof settings.migrations !== 'object') settings.migrations = {};
    if (settings.migrations[FLAG]) return { delta: false, intents: 0 };
    const result = { delta: false, intents: 0 };

    for (const preset of Object.values(settings.presets || {})) {
        if (!preset || typeof preset !== 'object') continue;
        const variables = Object.values(preset.variables || {});
        if (preset.namespace === BUILTIN_NAMESPACE && preset.name === SCENE_PRESET) {
            const delta = variables.find((v) => v?.name === DELTA_VARIABLE);
            if (delta && same(delta.prompted?.instructions, OLD_DELTA_INSTRUCTIONS)) {
                delta.prompted = { ...delta.prompted, instructions: newDeltaInstructions() };
                result.delta = true;
            }
        }
        if (isObjectPreset(preset)) {
            for (const variable of variables) {
                const old = OLD_RUNTIME_INSTRUCTIONS[variable?.name];
                const field = old ? registryField(preset.objectType, variable.name) : null;
                if (!field || !same(variable.prompted?.instructions, old)) continue;
                variable.prompted = { ...variable.prompted, instructions: field.description, newEachTurn: field.fresh === true };
                result.intents++;
            }
        }
    }

    settings.migrations[FLAG] = true;
    persistSettings();
    if (result.delta || result.intents) {
        console.log(`${LOG_PREFIX} updated built-in prompts: Scene Context's Delta Time ${result.delta ? 'updated' : 'unchanged'}, character intent in ${result.intents} setting(s)`);
    }
    return result;
}
