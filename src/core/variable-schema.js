// State Engine — variable definition helpers

import { DEFAULT_CALENDAR_ID } from './settings-core.js';
import { toScalar } from './calendar-engine.js';
import { checkImageValue, emptyImageValue } from './image-variables.js';

export function genId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `se-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Variable definition helpers
// ---------------------------------------------------------------------------

// Variable batching (docs/STATE ENGINE REQUIREMENTS SPECIFICATION.md 1.20):
// every variable belongs to exactly one batch, and a batch is a PROMPT SCOPE
// - which variables appear together in a prompt - not a folder (that's a
// preset). "core" is where every variable lives unless assigned elsewhere,
// and the only batch the main prompted update asks about.
export const DEFAULT_BATCH = 'core';

// Datetime variables (requirements spec 1.21) are created in this batch
// unless the caller picks another - see createVariable() in variable-api.js.
export const TIME_BATCH = 'time';

// The batch a definition belongs to. A definition with no `batch` field at
// all (anything created before batching existed) is in DEFAULT_BATCH - so
// legacy variables keep behaving exactly as they always did, with no data
// migration. Lives here (not in src/api) so core modules such as
// prompted-engine.js can use it without importing upward from the API layer.
export function batchOf(def) {
    return typeof def?.batch === 'string' && def.batch ? def.batch : DEFAULT_BATCH;
}

export function blankDefinition() {
    return {
        id: genId(),

        // Identity
        name: '',
        label: '',
        description: '',

        // Scope
        scope: 'chat', // chat | global

        // Type system
        type: 'number', // number | string | boolean | enum | array | calculated | datetime | image | imageList | imageMap
        enumValues: [],

        // Flag mode (only meaningful when type === 'boolean', requirements spec
        // 1.28): once true, the value can only move back to false through a
        // MANUAL write (the tracker's edit pencil / reset button) - never a
        // prompted update, an increment operation, or an extension. See
        // getDefaultValue() below (a flag always starts false) and chat-state.js's
        // setVar()/applyIncrement() (where the rule is actually enforced - the
        // one write path every caller shares).
        flagMode: false,

        // Calculated-variable configuration (only meaningful when
        // type === 'calculated'). dependencies names the other variables
        // (in the same preset) the expression may reference; expression is
        // a Tiny Expression DSL string (see expression-dsl.js and
        // docs/TINY EXPRESSION DSL SPECIFICATION.md).
        dependencies: [],
        expression: '',

        // Image map only (type === 'imageMap'): the NAME of the variable whose
        // current value picks the map's key (any variable that resolves to a string:
        // string, enum, an array's current value, a calculated result). '' = none, so
        // the tracker shows a placeholder. See image-variables.js.
        currentKeyVariable: '',

        // Typed-array schema (only meaningful when type === 'array')
        itemType: 'any',    // string | number | boolean | enum | object | any
        itemEnumValues: [], // only used when itemType === 'enum'
        // Only used when itemType === 'object'. Shape:
        //   { fieldName: { type: 'string'|'number'|'boolean'|'enum', enumValues?: [...] }, ... }
        itemSchema: {},
        maxLength: null,    // null = no limit
        unique: false,
        sorted: false,

        // Datetime configuration (only meaningful when type === 'datetime'):
        // which calendar definition (settings.calendars) converts this
        // variable's scalar time, and the unit that scalar is stored in.
        calendar: DEFAULT_CALENDAR_ID,
        unit: 'seconds',

        // Default value
        defaultValue: 0,

        // Numeric constraints
        min: null,
        max: null,

        // Prompt scope (see DEFAULT_BATCH above). Never read or altered by
        // getDefaultValue()/clampNumber() below.
        batch: DEFAULT_BATCH,

        // Behavior flags
        resetOnNewChat: false,
        showInTracker: true,

        // New behavior model
        behaviors: {
            increment: false,   // deterministic increment
            prompted: false,    // LLM-driven increment
        },

        // Deterministic increment configuration
        increment: {
            delta: 1,           // arithmetic increment for numbers
            triggers: ['ai'],   // user | ai | both
            tick_mode: null,    // null or "per_message"
            tick_on: 'both',    // user | ai | both
            tick_every: 1,      // threshold for deterministic increments
            operation: null,    // array only: push | unshift | pop | shift | rotate | clear | toggle | cycle | incrementField | toggleField
            operand: undefined, // array only: the fixed value used by push/unshift/toggle
        },

        // Prompted increment configuration
        prompted: {
            instructions: '',   // LLM instructions
        },
        version: 1
    };
}


export function getDefaultValue(def) {
    switch (def.type) {
        case 'number': {
            const n = Number(def.defaultValue);
            return Number.isFinite(n) ? n : 0;
        }
        case 'boolean':
            // A flag-mode boolean always STARTS false, whatever defaultValue says -
            // the whole point of a flag is "this hasn't happened yet" (1.28).
            if (def.flagMode === true) return false;
            return String(def.defaultValue).trim().toLowerCase() === 'true';
        case 'enum': {
            const list = Array.isArray(def.enumValues) ? def.enumValues : [];
            if (list.includes(def.defaultValue)) return def.defaultValue;
            return list[0] ?? '';
        }
        case 'datetime': {
            // Scalar seconds. A number is used as-is; an ISO date/datetime
            // string is converted through the variable's calendar; anything
            // else is 0.
            const scalar = toScalar(def.calendar || DEFAULT_CALENDAR_ID, def.defaultValue);
            return scalar ?? 0;
        }
        case 'image':
        case 'imageList':
        case 'imageMap': {
            // '' / [] / {} unless the definition carries a valid default (a JSON
            // string is accepted for the list and the map, like an array's).
            const checked = checkImageValue(def.type, def.defaultValue ?? emptyImageValue(def.type));
            return checked.ok ? checked.value : emptyImageValue(def.type);
        }
        case 'array':
            if (Array.isArray(def.defaultValue)) return [...def.defaultValue];
            if (typeof def.defaultValue === 'string' && def.defaultValue.trim()) {
                try { return JSON.parse(def.defaultValue); }
                catch { return []; }
            }
            return [];
        default:
            return def.defaultValue ?? '';
    }
}

export function clampNumber(def, n) {
    let result = n;
    if (def.min !== '' && def.min !== null && def.min !== undefined && !Number.isNaN(Number(def.min))) {
        result = Math.max(result, Number(def.min));
    }
    if (def.max !== '' && def.max !== null && def.max !== undefined && !Number.isNaN(Number(def.max))) {
        result = Math.min(result, Number(def.max));
    }
    return result;
}
