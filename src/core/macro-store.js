// State Engine — reading/writing variable values in SillyTavern's native
// chat/global variable store.
//
// These are named "macro" (not "var") deliberately: this store is the
// {{getvar::name}}/{{setvar::name}} macro mirror, not the source of truth.
// Nothing outside chat-state.js should call these directly - reach for
// setVar()/applyIncrement()/getVar() in chat-state.js instead.

import { LOG_PREFIX } from './settings-core.js';
import { getDefaultValue } from './variable-schema.js';
import { validateValueStrict } from './variable-validation.js';

export function macroStore(context, def) {
    return def.scope === 'global' ? context.variables.global : context.variables.local;
}

export function getMacroValue(context, def) {
    const store = macroStore(context, def);
    try {
        if (store.has(def.name)) {
            return store.get(def.name);
        }
    } catch (err) {
        console.warn(LOG_PREFIX, `could not read variable "${def.name}"`, err);
    }
    return getDefaultValue(def);
}

export function setMacroValue(context, def, rawValue) {
    const store = macroStore(context, def);
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

export function deleteMacroValue(context, def) {
    const store = macroStore(context, def);
    try {
        store.del(def.name);
    } catch (err) {
        console.warn(LOG_PREFIX, `could not delete variable "${def.name}"`, err);
    }
}
