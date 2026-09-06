// State Engine — reading/writing variable values in SillyTavern's native
// chat/global variable store.

import { LOG_PREFIX } from './settings-core.js';
import { getDefaultValue } from './variable-definition.js';
import { validateValueStrict } from './variable-validation.js';
import { getPresetsForChat, getAllVariablesFromPresets } from '../core/preset-manager.js';
import { getSettings } from '../core/settings-core.js';
import { shouldSkipPromptedRefresh } from './prompted-engine.js';

export function varStore(context, def) {
    return def.scope === 'global' ? context.variables.global : context.variables.local;
}

export function getVarValue(context, def) {
    const store = varStore(context, def);
    try {
        if (store.has(def.name)) {
            return store.get(def.name);
        }
    } catch (err) {
        console.warn(LOG_PREFIX, `could not read variable "${def.name}"`, err);
    }
    return getDefaultValue(def);
}

export function setVarValue(context, def, rawValue) {
    const store = varStore(context, def);
    const validation = validateValueStrict(def, rawValue);

    if (!validation.valid && validation.error) {
        console.warn(LOG_PREFIX, `Type validation for "${def.name}": ${validation.error}`);
    }

    try {
        store.set(def.name, validation.value);
    } catch (err) {
        console.error(LOG_PREFIX, `could not write variable "${def.name}"`, err);
    }
    return validation.value;
}

function syncVarStoreToChat(context) {
    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);

    if (activePresetIds.length === 0 && getSettings().defaultPresetForNewChats) {
        activePresetIds.push(getSettings().defaultPresetForNewChats);
    }

    const variables = getAllVariablesFromPresets(activePresetIds);
    const definedNames = new Set(
        Object.values(variables)
            .filter(def => def.name && !shouldSkipPromptedRefresh(def))
            .map(def => def.name)
    );

    // 1. Write correct values from preset storage into varStore
    for (const def of Object.values(variables)) {
        if (!def.name || shouldSkipPromptedRefresh(def)) continue;
        const value = getAllVariablesFromPresets(activePresetIds);
        //const value = getVarValueFromPresetStorage(context, def); // per-chat source of truth
        setVarValue(context, def, value);
    }

    // 2. Remove stale entries not defined by this chat's presets
    //for (const key of getStoreKeys(context)) {
        if (!definedNames.has(key)) {
            //removeVar(context, key);
        }
    }
}   