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

        // Datetime mode (requirements spec 1.36, only meaningful when
        // type === 'datetime'): 'full' (default) | 'dateOnly' | 'timeOnly'.
        // Restricts which HALF of the scalar is meaningful - dateOnly
        // normalizes the time-of-day to 00:00:00 after every write,
        // timeOnly normalizes the date to the calendar's own reference
        // moment (day 0) after every write - see calendar-engine.js's
        // normalizeForDatetimeMode(), applied at chat-state.js's setVar()/
        // applyIncrement(), the write paths every caller already shares.
        // Every existing delta/answer/semantic-phrase path is otherwise
        // completely unchanged; 'full' is a pure no-op here, so a plain
        // datetime variable (the default) behaves exactly as it always has.
        datetimeMode: 'full',

        // Calculated-datetime extension (requirements spec 1.31, revised
        // 2026-09-22 - only meaningful when type === 'datetime'): deltaSource
        // names another (normal, prompted, type: 'string') variable in the
        // same preset; whenever THAT variable's value changes, its text is
        // parsed as a calendar instruction and applied to this variable,
        // then the source is reset to '' - see calculated-engine.js's
        // applyDatetimeDeltaTriggers(). A datetime that ALSO ticks on its
        // own (fixed, per-message advancement) uses the SAME
        // behaviors.increment/increment.delta every other type already has
        // - there is no separate "automatic time flow" toggle. An earlier
        // version of this feature added fixedIncrement/tickUnit/accumulate
        // as a second, parallel tick mechanism; it was removed (2026-09-22)
        // for being functionally redundant with behaviors.increment and,
        // in the UI, genuinely confusing - two controls for nearly the same
        // thing, one of them oddly separated from the other. See
        // deterministic-engine.js's datetime branch for how a tick now
        // cooperates with a deltaSource jump (consumeDatetimeJump).
        deltaSource: '',

        // Semantic time of day (requirements spec 1.35, only meaningful when
        // type === 'datetime'): 'none' (default) | 'semanticTimeOfDay'. When
        // enabled, a prompted datetime answer's semantic phrases ("morning",
        // "the next evening", ...) are interpreted into a precise target time
        // BEFORE the ordinary duration/verb grammar gets a chance at them -
        // see calendar-engine.js's resolveSemanticTimeOfDay(). Independent of
        // deltaSource above: deltaSource's own text is never given semantic
        // interpretation (the request that introduced this field says so
        // explicitly) - only the model's direct prompted answer for THIS
        // variable is.
        timeSemanticMode: 'none',

        // Default value
        defaultValue: 0,

        // Numeric constraints
        min: null,
        max: null,

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
