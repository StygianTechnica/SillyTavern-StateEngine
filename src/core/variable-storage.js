// State Engine — reading/writing variable values in SillyTavern's native
// chat/global variable store.

import { LOG_PREFIX } from './settings-core.js';
import { getDefaultValue } from './variable-definition.js';
import { validateValueStrict } from './variable-validation.js';

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
