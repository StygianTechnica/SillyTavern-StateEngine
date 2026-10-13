// State Engine - one-time migration: Scene Context's location becomes a
// location OBJECT (2026-10-13).
//
// Scene Context's `se__scene_location` was a plain string. It is now an
// object variable of type location (scene-context-preset.js), so the place
// a scene is in is a State Engine object: matched by name and alias, one
// record per place in the setting, with its own fields and runtime state -
// and the same object Archivist, Pretty Panels and Curator see.
//
// For an existing install this changes the user's own Scene Context preset
// (only while its location variable is still a string - a user who already
// made it something else is left alone) and every chat's stored value: the
// text becomes the location it names - an existing one when the name or an
// alias matches, otherwise a new, unconfirmed chat location, reviewed like
// any other detected object. Runs once (settings.migrations.sceneLocationObject).

import { LOG_PREFIX, BUILTIN_NAMESPACE, getSettings, persistSettings } from './settings-core.js';
import { loadChatState, saveChatState } from './chat-state.js';
import { getObjectByAlias, createChatObject } from './objects.js';
import { objectTypeOfId } from './object-types.js';
import { SCENE_CONTEXT_BLUEPRINT } from './scene-context-preset.js';

const PRESET_NAME = 'Scene Context';
const VARIABLE = `${BUILTIN_NAMESPACE}__scene_location`;
const FLAG = 'sceneLocationObject';
const LOCATION = 'location';

// The instructions Scene Context shipped with while the location was text:
// replaced by the new ones; anything the user wrote is kept.
const OLD_INSTRUCTIONS = 'Infer the current location from the recent roleplay messages.\nUpdate only when a new location is explicitly named or strongly implied.\nIf the location has not changed, leave this variable unchanged.';

function blueprintLocation() {
    return SCENE_CONTEXT_BLUEPRINT.vars.find((v) => v.name === 'scene_location');
}

// The def as an object variable (a copy).
function asLocationObject(def) {
    const next = { ...def, type: 'object', objectType: LOCATION, defaultValue: '' };
    const instructions = def.prompted?.instructions ?? '';
    if (!instructions.trim() || instructions.trim() === OLD_INSTRUCTIONS) {
        next.prompted = { ...(def.prompted ?? {}), instructions: blueprintLocation().prompted.instructions };
    }
    return next;
}

// The location id a stored text value means in a chat ('' for none).
function locationFor(chatId, value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    if (objectTypeOfId(value)?.id === LOCATION) return value;
    const match = getObjectByAlias(chatId, LOCATION, value);
    return match ? match.id : createChatObject(chatId, LOCATION, value.trim()).id;
}

// Runs the migration if it has not run yet. Returns { preset, chats }
// (whether the preset changed, how many chats' values were converted).
export function migrateSceneLocation() {
    const settings = getSettings();
    if (!settings.migrations || typeof settings.migrations !== 'object') settings.migrations = {};
    if (settings.migrations[FLAG]) return { preset: false, chats: 0 };
    const result = { preset: false, chats: 0 };

    const preset = Object.values(settings.presets || {}).find((p) => p?.namespace === BUILTIN_NAMESPACE && p.name === PRESET_NAME);
    const key = preset && Object.keys(preset.variables || {}).find((k) => preset.variables[k]?.name === VARIABLE);
    const def = key ? preset.variables[key] : null;
    if (def?.type === 'string') {
        const next = asLocationObject(def);
        preset.variables[key] = next;
        result.preset = true;
        for (const chatId of Object.keys(settings.variableStore?.chats || {})) {
            const entry = loadChatState(chatId)?.variables?.[VARIABLE];
            if (!entry) continue;
            let value = '';
            try {
                value = locationFor(chatId, entry.value);
            } catch (err) {
                console.warn(LOG_PREFIX, `scene location migration: could not convert "${entry.value}" in chat ${chatId}`, err);
            }
            // Reloaded: creating a location wrote the chat's state.
            const state = loadChatState(chatId);
            state.variables[VARIABLE] = { value, def: next };
            saveChatState(chatId, state);
            result.chats++;
        }
    }
    settings.migrations[FLAG] = true;
    persistSettings();
    if (result.preset) console.log(`${LOG_PREFIX} Scene Context's location is now a location object (${result.chats} chat(s) converted)`);
    return result;
}
