// State Engine — variable definition helpers

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
        type: 'number', // number | string | boolean | enum | array
        enumValues: [],

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
            const n = Number(def.default);
            return Number.isFinite(n) ? n : 0;
        }
        case 'boolean':
            return String(def.default).trim().toLowerCase() === 'true';
        case 'enum':
            return def.enumValues.includes(def.default) ? def.default : (def.enumValues[0] ?? '');
        case 'array':
            if (Array.isArray(def.default)) return [...def.default];
            if (typeof def.default === 'string' && def.default.trim()) {
                try { return JSON.parse(def.default); }
                catch { return []; }
            }
            return [];
        default:
            return def.default ?? '';
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
