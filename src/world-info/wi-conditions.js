// State Engine — World Info condition logic (operators, evaluation, storage)

import { LOG_PREFIX, getSettings } from '../core/settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from '../core/preset-manager.js';
import { getMacroValue } from '../core/macro-store.js';

// World Info conditional display operators
const CONDITION_OPERATORS = {
    'equals': (varValue, condValue) => {
        const v = String(varValue).toLowerCase().trim();
        const c = String(condValue).toLowerCase().trim();
        return v === c;
    },
    'not_equals': (varValue, condValue) => {
        const v = String(varValue).toLowerCase().trim();
        const c = String(condValue).toLowerCase().trim();
        return v !== c;
    },
    'greater_than': (varValue, condValue) => {
        const v = Number(varValue);
        const c = Number(condValue);
        return !isNaN(v) && !isNaN(c) && v > c;
    },
    'less_than': (varValue, condValue) => {
        const v = Number(varValue);
        const c = Number(condValue);
        return !isNaN(v) && !isNaN(c) && v < c;
    },
    'greater_or_equal': (varValue, condValue) => {
        const v = Number(varValue);
        const c = Number(condValue);
        return !isNaN(v) && !isNaN(c) && v >= c;
    },
    'less_or_equal': (varValue, condValue) => {
        const v = Number(varValue);
        const c = Number(condValue);
        return !isNaN(v) && !isNaN(c) && v <= c;
    },
    'contains': (varValue, condValue) => {
        if (Array.isArray(varValue)) {
            const target = String(condValue).toLowerCase();
            return varValue.some((item) => String(item).toLowerCase() === target);
        }
        return String(varValue).toLowerCase().includes(String(condValue).toLowerCase());
    },
    'not_contains': (varValue, condValue) => {
        if (Array.isArray(varValue)) {
            const target = String(condValue).toLowerCase();
            return !varValue.some((item) => String(item).toLowerCase() === target);
        }
        return !String(varValue).toLowerCase().includes(String(condValue).toLowerCase());
    },
    // Array-aware operators.
    'length_gt': (varValue, condValue) => {
        if (!Array.isArray(varValue)) return false;
        const c = Number(condValue);
        return !Number.isNaN(c) && varValue.length > c;
    },
    'length_eq': (varValue, condValue) => {
        if (!Array.isArray(varValue)) return false;
        const c = Number(condValue);
        return !Number.isNaN(c) && varValue.length === c;
    },
    // condValue format is "<index>:<value>" (e.g. "0:sword") - this encoding
    // isn't specified anywhere; it's a judgment call to fit index+value into
    // the single condValue field the storage format already has.
    'index_eq': (varValue, condValue) => {
        if (!Array.isArray(varValue)) return false;
        const raw = String(condValue);
        const sep = raw.indexOf(':');
        if (sep === -1) return false;
        const idx = Number(raw.slice(0, sep));
        const expected = raw.slice(sep + 1);
        if (!Number.isInteger(idx)) return false;
        return String(varValue[idx]).toLowerCase() === expected.toLowerCase();
    },
    'regex': (varValue, condValue) => {
        try {
            return new RegExp(condValue, 'i').test(String(varValue));
        } catch (e) {
            console.error(`${LOG_PREFIX} Invalid regex in condition:`, condValue, e);
            return true; // Fail open on regex error
        }
    },
    'in_list': (varValue, condValue) => {
        const list = String(condValue).split(',').map(v => v.trim().toLowerCase());
        return list.includes(String(varValue).toLowerCase());
    },
    'is_true': (varValue) => varValue == true || String(varValue).toLowerCase() === 'true' || varValue == 1,
    'is_false': (varValue) => varValue == false || String(varValue).toLowerCase() === 'false' || varValue == 0,
};

// ---------------------------------------------------------------------------
// World Info Conditional Display
// ---------------------------------------------------------------------------

export function makeWIEntryKey(world, uid) {
    return `${world}.${uid}`;
}

export function getWIConditions(entryKey) {
    const settings = getSettings();
    return settings.wiConditions[entryKey] || [];
}

export function setWICondition(entryKey, condition) {
    const settings = getSettings();
    if (!settings.wiConditions[entryKey]) {
        settings.wiConditions[entryKey] = [];
    }
    settings.wiConditions[entryKey].push(condition);
    //saveSettings(settings);
    console.log(`${LOG_PREFIX} Added condition to ${entryKey}:`, condition);
}

export function updateWICondition(entryKey, index, condition) {
    const settings = getSettings();
    if (settings.wiConditions[entryKey] && settings.wiConditions[entryKey][index]) {
        settings.wiConditions[entryKey][index] = condition;
        //saveSettings(settings);
        console.log(`${LOG_PREFIX} Updated condition ${index} for ${entryKey}:`, condition);
    }
}

export function deleteWICondition(entryKey, index) {
    const settings = getSettings();
    if (settings.wiConditions[entryKey]) {
        settings.wiConditions[entryKey].splice(index, 1);
        if (settings.wiConditions[entryKey].length === 0) {
            delete settings.wiConditions[entryKey];
        }
        //saveSettings(settings);
        console.log(`${LOG_PREFIX} Deleted condition ${index} for ${entryKey}`);
    }
}

export function clearWIConditionsForEntry(entryKey) {
    const settings = getSettings();
    if (settings.wiConditions[entryKey]) {
        delete settings.wiConditions[entryKey];
        //saveSettings(settings);
        console.log(`${LOG_PREFIX} Cleared all conditions for ${entryKey}`);
    }
}

export function evaluateCondition(varName, operator, condValue) {
    try {
        // getMacroValue(context, def) needs both a live context and the
        // variable's def (for scope/type) - previously called here as
        // getMacroValue(varName) with one argument, which made def.scope
        // inside macroStore() throw on every single evaluation (varName was
        // being passed as context, def was undefined). The outer catch below
        // swallowed that and fail-opened to true, so every WI condition has
        // always silently evaluated as "met" until now.
        const context = SillyTavern.getContext();
        const currentChatId = context.chatId || 'unknown';
        const activePresetIds = getPresetsForChat(currentChatId);
        const variables = getAllVariablesFromPresets(activePresetIds);
        const def = variables[varName] || { name: varName, type: 'string' };

        const varValue = getMacroValue(context, def);
        const operatorFunc = CONDITION_OPERATORS[operator];

        if (!operatorFunc) {
            console.warn(`${LOG_PREFIX} Unknown operator: ${operator}`);
            return true; // Fail open
        }

        return operatorFunc(varValue, condValue);
    } catch (e) {
        console.error(`${LOG_PREFIX} Error evaluating condition for ${varName}:`, e);
        return true; // Fail open
    }
}

export function shouldDisplayWIEntry(entryKey) {
    const conditions = getWIConditions(entryKey);
    if (conditions.length === 0) return true; // No conditions = always show

    // All conditions must evaluate to true (AND logic)
    return conditions.every(cond => {
        const result = evaluateCondition(cond.variable, cond.operator, cond.value);
        if (!result) {
            console.debug(`${LOG_PREFIX} ${entryKey} filtered out: ${cond.variable} ${cond.operator} ${cond.value}`);
        }
        return result;
    });
}

export function getAvailableVariablesForConditions() {
    // Get all variables from all active presets in current chat.
    //
    // context.chat is the array of chat MESSAGES, not the chat identifier -
    // it has no .id property, so context.chat.id was always undefined and
    // this always fell back to the literal string 'unknown', meaning this
    // function has always looked up presets for the wrong "chat" regardless
    // of which chat was actually open. context.chatId is the real chat id
    // (see st-context.js) and is what every other module in this codebase
    // already uses.
    const context = SillyTavern.getContext();
    const currentChatId = context.chatId || 'unknown';
    const settings = getSettings();

    const variables = [];
    const activePresetIds = getPresetsForChat(currentChatId);
    const seenNames = new Set();

    for (const presetId of activePresetIds) {
        const preset = settings.presets[presetId];
        if (!preset || !preset.variables) continue;

        for (const [varName, def] of Object.entries(preset.variables)) {
            if (seenNames.has(varName)) continue;
            seenNames.add(varName);

            const entry = {
                name: varName,
                type: def.type || 'manual',
                category: def.category || 'manual',
                presetId: presetId,
                presetName: preset.name || presetId,
            };

            if (def.type === 'array') {
                entry.itemType = def.itemType || 'any';
                if (entry.itemType === 'enum') {
                    entry.itemEnumValues = Array.isArray(def.itemEnumValues) ? def.itemEnumValues : [];
                }
            }

            variables.push(entry);
        }
    }

    return variables;
}
