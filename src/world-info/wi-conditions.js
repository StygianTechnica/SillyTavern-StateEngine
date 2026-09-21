// State Engine — World Info condition logic (operators, evaluation, storage)

import { LOG_PREFIX, DEFAULT_CALENDAR_ID, getSettings, persistSettings } from '../core/settings-core.js';
import { toScalar } from '../core/calendar-engine.js';
import { getPresetsForChat, getAllVariablesFromPresets } from '../core/preset-manager.js';
import { getMacroValue } from '../core/macro-store.js';
import { normalizeWorldName } from './world-names.js';

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

// Every entry key is built from normalizeWorldName() (world-names.js), so the
// same entry always gets the same key no matter which of ST's name fields is set
// (SillyTavern itself sets `world`).
export { normalizeWorldName };

// The key for a WI entry object ({ world|book|folder, uid }).
export function makeWIEntryKeyForEntry(entry) {
    return makeWIEntryKey(normalizeWorldName(entry), entry?.uid);
}

// Before normalizeWorldName() existed, an entry with no world name was keyed
// under the literal world "unknown". A key that has no conditions stored under
// it falls back to that legacy key, so conditions saved by earlier versions
// keep working (nothing is rewritten or migrated on disk).
function storedKeyFor(settings, entryKey) {
    if (Object.prototype.hasOwnProperty.call(settings.wiConditions, entryKey)) return entryKey;
    if (entryKey.startsWith('default.')) {
        const legacy = `unknown.${entryKey.slice('default.'.length)}`;
        if (Object.prototype.hasOwnProperty.call(settings.wiConditions, legacy)) return legacy;
    }
    return entryKey;
}

export function getWIConditions(entryKey) {
    const settings = getSettings();
    return settings.wiConditions[storedKeyFor(settings, entryKey)] || [];
}

export function setWICondition(entryKey, condition) {
    const settings = getSettings();
    entryKey = storedKeyFor(settings, entryKey);
    if (!settings.wiConditions[entryKey]) {
        settings.wiConditions[entryKey] = [];
    }
    settings.wiConditions[entryKey].push(condition);
    persistSettings();
    console.log(`${LOG_PREFIX} Added condition to ${entryKey}:`, condition);
}

export function updateWICondition(entryKey, index, condition) {
    const settings = getSettings();
    entryKey = storedKeyFor(settings, entryKey);
    if (settings.wiConditions[entryKey] && settings.wiConditions[entryKey][index]) {
        settings.wiConditions[entryKey][index] = condition;
        persistSettings();
        console.log(`${LOG_PREFIX} Updated condition ${index} for ${entryKey}:`, condition);
    }
}

export function deleteWICondition(entryKey, index) {
    const settings = getSettings();
    entryKey = storedKeyFor(settings, entryKey);
    if (settings.wiConditions[entryKey]) {
        settings.wiConditions[entryKey].splice(index, 1);
        if (settings.wiConditions[entryKey].length === 0) {
            delete settings.wiConditions[entryKey];
        }
        persistSettings();
        console.log(`${LOG_PREFIX} Deleted condition ${index} for ${entryKey}`);
    }
}

export function clearWIConditionsForEntry(entryKey) {
    const settings = getSettings();
    entryKey = storedKeyFor(settings, entryKey);
    if (settings.wiConditions[entryKey]) {
        delete settings.wiConditions[entryKey];
        persistSettings();
        console.log(`${LOG_PREFIX} Cleared all conditions for ${entryKey}`);
    }
}

// A datetime variable is stored as scalar seconds, but nobody can be expected to
// know what that number is: a condition on one is written as a date ("2022-05-11
// 00:00:00", the same form as the variable's default) or a calendar's own written
// date, and turned into seconds through the variable's calendar here. Plain
// numbers still work. Text that is not a date is left as it is (so the operator
// simply does not match). Not applied to regex / in_list / array operators.
const DATETIME_VALUE_OPERATORS = new Set(['equals', 'not_equals', 'greater_than', 'less_than', 'greater_or_equal', 'less_or_equal']);
function datetimeConditionValue(def, operator, condValue) {
    if (def?.type !== 'datetime' || !DATETIME_VALUE_OPERATORS.has(operator)) return condValue;
    const scalar = toScalar(def.calendar || DEFAULT_CALENDAR_ID, condValue);
    return scalar === null ? condValue : scalar;
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
        // A condition stores the variable's id, but the API (and older data) may
        // store its name - accept both, like knownVariablesForChat().
        const def = variables[varName]
            || Object.values(variables).find((d) => d?.name === varName)
            || { name: varName, type: 'string' };

        // World Info conditions are primitive-only: an array of objects has no
        // field to compare, and the editor does not offer one. A stored condition
        // on one (old or hand-edited data) is treated as met, never as a failure.
        if (def.type === 'array' && def.itemType === 'object') {
            console.warn(`${LOG_PREFIX} Object-array variable "${varName}" cannot be used in WI conditions — treating condition as met.`);
            return true;
        }

        const varValue = getMacroValue(context, def);
        condValue = datetimeConditionValue(def, operator, condValue);
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

// Ids AND names of every variable defined in the chat's active presets (a
// condition's `variable` is whichever the editor or the API stored).
export function knownVariablesForChat(chatId) {
    const known = new Set();
    const variables = getAllVariablesFromPresets(getPresetsForChat(chatId));
    for (const [id, def] of Object.entries(variables)) {
        known.add(id);
        if (def?.name) known.add(def.name);
    }
    return known;
}

// THE rule for whether a WI entry is shown - used by the runtime filter
// (wi-filtering.js) and by shouldDisplayWIEntry(), so the two cannot disagree.
//   - no conditions                          -> shown
//   - every condition must hold (AND), except that a condition is skipped
//     (counts as met) when its variable is not defined in any active preset,
//     or when it is malformed, or when evaluating it fails; an unknown operator
//     also counts as met (evaluateCondition fails open)
//   - a malformed condition LIST (not an array) -> shown, with a warning
// It never throws: any error is logged and the entry is shown.
export function entryConditionsMet(entryKey, knownVariables) {
    try {
        const conditions = getWIConditions(entryKey);
        if (!Array.isArray(conditions)) {
            console.warn(`${LOG_PREFIX} Conditions for ${entryKey} are malformed (not a list) - entry shown`);
            return true;
        }
        if (conditions.length === 0) return true;
        const known = knownVariables
            || knownVariablesForChat(SillyTavern.getContext().chatId || 'unknown');

        return conditions.every((cond) => {
            try {
                if (!cond || typeof cond !== 'object') {
                    console.warn(`${LOG_PREFIX} A condition on ${entryKey} is malformed - treated as met`);
                    return true;
                }
                if (!known.has(cond.variable)) return true; // variable not available: fail open
                const result = evaluateCondition(cond.variable, cond.operator, cond.value);
                if (!result) {
                    console.debug(`${LOG_PREFIX} ${entryKey} filtered out: ${cond.variable} ${cond.operator} ${cond.value}`);
                }
                return result;
            } catch (err) {
                console.warn(`${LOG_PREFIX} Could not evaluate a condition on ${entryKey} - treated as met`, err);
                return true;
            }
        });
    } catch (err) {
        console.warn(`${LOG_PREFIX} Could not evaluate the conditions of ${entryKey} - entry shown`, err);
        return true;
    }
}

// Whether a WI entry should be displayed right now. Identical to what the
// runtime filter decides (see entryConditionsMet).
export function shouldDisplayWIEntry(entryKey) {
    return entryConditionsMet(entryKey);
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

            // Arrays of objects cannot be used in World Info conditions.
            if (def.type === 'array' && def.itemType === 'object') continue;

            const entry = {
                name: varName, // the key a condition stores (the variable's id)
                // What the editor SHOWS: the variable's real name, else its label.
                variableName: def.name || def.label || varName,
                type: def.type || 'manual',
                category: def.category || 'manual',
                presetId: presetId,
                presetName: preset.name || presetId,
            };

            if (def.type === 'datetime') entry.calendar = def.calendar;

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
