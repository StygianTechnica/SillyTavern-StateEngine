// State Engine — World Info condition logic (operators, evaluation, storage)

import { LOG_PREFIX, getSettings } from '../core/settings-core.js';
import { getPresetsForChat } from '../core/preset-manager.js';
import { getVarValue } from '../core/variable-storage.js';

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
        return String(varValue).toLowerCase().includes(String(condValue).toLowerCase());
    },
    'not_contains': (varValue, condValue) => {
        return !String(varValue).toLowerCase().includes(String(condValue).toLowerCase());
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
        const varValue = getVarValue(varName);
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
    // Get all variables from all active presets in current chat
    const context = SillyTavern.getContext();
    const currentChatId = context.chat.id || 'unknown';
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

            variables.push({
                name: varName,
                type: def.type || 'manual',
                category: def.category || 'manual',
                presetId: presetId,
                presetName: preset.name || presetId,
            });
        }
    }

    return variables;
}
