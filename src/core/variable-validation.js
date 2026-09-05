// State Engine — variable value validation and coercion

import { getDefaultValue, clampNumber } from './variable-definition.js';

// Validate a value against type constraints; return {valid: boolean, value: coerced, error?: string}
export function validateValueStrict(def, raw) {
    if (raw === undefined || raw === null) {
        return { valid: true, value: getDefaultValue(def) };
    }

    const errors = [];
    let coerced = raw;

    try {
        switch (def.type) {
            case 'number': {
                if (typeof raw === 'number') {
                    coerced = raw;
                } else if (typeof raw === 'string' && raw.trim() !== '') {
                    coerced = Number(raw.trim());
                    if (Number.isNaN(coerced)) {
                        errors.push(`Cannot convert "${raw}" to number`);
                        coerced = getDefaultValue(def);
                        break;
                    }
                } else {
                    errors.push(`Expected number, got ${typeof raw}`);
                    coerced = getDefaultValue(def);
                    break;
                }

                if (!Number.isFinite(coerced)) {
                    errors.push(`Not a valid number (got ${raw})`);
                    coerced = getDefaultValue(def);
                } else {
                    coerced = clampNumber(def, coerced);
                }
                break;
            }

            case 'boolean': {
                if (typeof raw === 'boolean') {
                    coerced = raw;
                } else if (typeof raw === 'number') {
                    coerced = raw !== 0;
                } else if (typeof raw === 'string') {
                    const s = raw.trim().toLowerCase();
                    if (['true', 'yes', '1', 'on'].includes(s)) {
                        coerced = true;
                    } else if (['false', 'no', '0', 'off'].includes(s)) {
                        coerced = false;
                    } else {
                        errors.push(`"${raw}" is not a valid boolean`);
                        coerced = getDefaultValue(def);
                    }
                } else {
                    errors.push(`Expected boolean, got ${typeof raw}`);
                    coerced = getDefaultValue(def);
                }
                break;
            }

            case 'enum': {
                const s = String(raw);
                if (!def.enumValues.includes(s)) {
                    errors.push(`"${s}" not in allowed values: [${def.enumValues.join(', ')}]`);
                    coerced = getDefaultValue(def);
                } else {
                    coerced = s;
                }
                break;
            }

            case 'array': {
                if (Array.isArray(raw)) {
                    coerced = raw;
                } else if (typeof raw === 'string') {
                    try {
                        const parsed = JSON.parse(raw);
                        if (Array.isArray(parsed)) {
                            coerced = parsed;
                        } else {
                            errors.push(`Parsed JSON is not an array`);
                            coerced = getDefaultValue(def);
                        }
                    } catch (e) {
                        errors.push(`Invalid JSON for array: ${e.message}`);
                        coerced = getDefaultValue(def);
                    }
                } else {
                    errors.push(`Expected array, got ${typeof raw}`);
                    coerced = getDefaultValue(def);
                }
                break;
            }

            default: {
                // String type: accept anything, stringify it
                coerced = String(raw);
            }
        }
    } catch (err) {
        errors.push(`Validation error: ${err.message}`);
        coerced = getDefaultValue(def);
    }

    return {
        valid: errors.length === 0,
        value: coerced,
        error: errors.length > 0 ? errors.join('; ') : undefined,
    };
}

export function coerceValue(def, raw) {
    if (raw === undefined || raw === null) return getDefaultValue(def);
    switch (def.type) {
        case 'number': {
            let n = typeof raw === 'number' ? raw : Number(raw);
            if (!Number.isFinite(n)) n = getDefaultValue(def);
            return clampNumber(def, n);
        }
        case 'boolean': {
            if (typeof raw === 'boolean') return raw;
            const s = String(raw).trim().toLowerCase();
            return ['true', 'yes', '1', 'on'].includes(s);
        }
        case 'enum': {
            const s = String(raw);
            return def.enumValues.includes(s) ? s : getDefaultValue(def);
        }
        case 'array': {
            if (Array.isArray(raw)) return raw;
            if (typeof raw === 'string') {
                try { return JSON.parse(raw); }
                catch { return getDefaultValue(def); }
            }
            return getDefaultValue(def);
        }
        default:
            return String(raw);
    }
}
