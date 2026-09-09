// State Engine — variable schema helpers
// Merging, coercion/normalization, validation, and description text for
// variable definitions. Uses ES6 modules - imported by manager-modal.js

export function mergeDefinition(defaults, varDef) {
    const d = Object.assign({}, defaults, varDef);

    // Deep merge nested objects so old presets don't crash
    d.behaviors = Object.assign({}, defaults.behaviors, varDef?.behaviors);
    d.increment = Object.assign({}, defaults.increment, varDef?.increment);
    d.prompted = Object.assign({}, defaults.prompted, varDef?.prompted);
    return d;
}

export function canIncrement(type) {
    return (type === 'number' || type === 'boolean' || type === 'enum' || type === 'array');
}

// Splits multiline-editor textarea content into individual entries. The
// documented format is one value per line, but this also tolerates the
// whole textarea being a single pasted JSON array literal (e.g. copied from
// this same UI's own Variable Management JSON export, or from an LLM
// example) - a very natural alternate input style that would otherwise
// silently collapse into one bogus "line" containing the entire bracketed
// text verbatim, which then matches nothing during enum item validation
// (every real value gets compared against the whole string and fails).
export function splitMultilineList(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed.map((v) => String(v));
        } catch { /* not valid JSON - fall through to newline splitting */ }
    }
    return raw.split(/\r?\n/);
}

export function normalizeCollectedValues(values) {
    const out = {};

    // Basic fields
    if (values.name !== undefined) out.name = values.name.trim();
    if (values.label !== undefined) out.label = String(values.label).trim();
    if (values.description !== undefined) out.description = values.description;

    if (values.enumValuesMultiline !== undefined) {
        if (typeof values.enumValuesMultiline !== 'string') {
            values.enumValuesMultiline = '';
        }
        const raw = String(values.enumValuesMultiline || '');
        const lines = splitMultilineList(raw);
        const seen = new Set();
        const cleaned = [];
        for (const line of lines) {
            const s = line.trim();
            if (!s || seen.has(s)) continue;
            seen.add(s);
            cleaned.push(s);
        }
        out.enumValues = cleaned;
    }
    if (values.defaultValue !== undefined) {
        // The defaultValue input is a plain text field regardless of type
        // (jQuery .val() is always a string), so a number-type variable's
        // defaultValue must be coerced here or it lands on the definition
        // as e.g. "10" instead of 10 - fine for display (getDefaultValue()
        // coerces on read) but wrong for anything that does a strict
        // typeof check on the stored value, like expression-dsl.js's
        // arithmetic operators (root-caused 2026-09-09). Every other type
        // is either already string-shaped (string/enum) or safely
        // re-parsed from a string on read (boolean).
        out.defaultValue = values.type === 'number'
            ? (Number.isFinite(Number(values.defaultValue)) ? Number(values.defaultValue) : 0)
            : values.defaultValue;
    }

    // Calculated-variable fields. dependencies comes from the editor's
    // checkbox list (already an array of variable names, not multiline
    // text); expression is collected like any other plain text field.
    if (values.dependencies !== undefined) {
        out.dependencies = Array.isArray(values.dependencies) ? values.dependencies.filter(Boolean) : [];
    }
    if (values.expression !== undefined) out.expression = String(values.expression || '');

    if (values.min !== undefined) out.min = values.min;
    if (values.max !== undefined) out.max = values.max;

    // Typed-array schema
    if (values.itemType !== undefined) out.itemType = values.itemType || 'any';

    if (values.itemEnumValuesMultiline !== undefined) {
        if (typeof values.itemEnumValuesMultiline !== 'string') {
            values.itemEnumValuesMultiline = '';
        }
        const raw = String(values.itemEnumValuesMultiline || '');
        const lines = splitMultilineList(raw);
        const seen = new Set();
        const cleaned = [];
        for (const line of lines) {
            const s = line.trim();
            if (!s || seen.has(s)) continue;
            seen.add(s);
            cleaned.push(s);
        }
        out.itemEnumValues = cleaned;
    }

    if (values.maxLength !== undefined) {
        const raw = String(values.maxLength ?? '').trim();
        if (raw === '') {
            out.maxLength = null;
        } else {
            const n = Number(raw);
            out.maxLength = Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
        }
    }

    if (values.unique !== undefined) out.unique = !!values.unique;
    if (values.sorted !== undefined) out.sorted = !!values.sorted;

    if (values.resetOnNewChat !== undefined) {
        out.resetOnNewChat = !!values.resetOnNewChat;
    }

    if (values.showInTracker !== undefined) {
        out.showInTracker = values.showInTracker !== false;
    }

    // Behaviors
    if (values.behaviors !== undefined) {
        out.behaviors = {
            increment: !!values.behaviors.increment,
            prompted: !!values.behaviors.prompted,
        };
    }

    // Increment block
    if (values.increment !== undefined) {
        out.increment = {};

        if (values.increment.delta !== undefined) {
            out.increment.delta = Number(values.increment.delta);
        }

        if (values.increment.triggers !== undefined) {
            out.increment.triggers = values.increment.triggers;
        }

        if (values.increment.tick_mode !== undefined) {
            out.increment.tick_mode = values.increment.tick_mode;
        }

        if (values.increment.tick_on !== undefined) {
            out.increment.tick_on = values.increment.tick_on;
        }

        if (values.increment.tick_every !== undefined) {
            out.increment.tick_every = Number(values.increment.tick_every);
        }

        if (values.increment.operation !== undefined) {
            out.increment.operation = values.increment.operation || null;
        }

        if (values.increment.operand !== undefined) {
            out.increment.operand = values.increment.operand;
        }
    }

    // Prompted block
    if (values.prompted !== undefined) {
        out.prompted = {
            instructions: values.prompted.instructions || '',
        };
    }

    return out;
}


export function validateVariableName(name) {
    return !!name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function describeIncrementTrigger(triggers) {
    if (triggers.includes('user')) return 'when a user chat is received';
    if (triggers.includes('ai')) return 'when an AI chat is received';
    if (triggers.includes('both')) return 'when either user or AI chat is received';
    return 'when the increment condition is met';
}

export function describeVariable(d) {
    if (d.type === 'calculated') {
        const deps = Array.isArray(d.dependencies) ? d.dependencies : [];
        const depsText = deps.length ? deps.join(', ') : '(none selected)';
        const exprText = (d.expression || '').trim() || '(no expression set)';
        return `${d.name || 'This variable'} is a calculated variable. It is read-only, recalculates automatically whenever `
            + `${depsText} changes, and is never updated by prompted or incremented behavior. Expression: ${exprText}`;
    }

    let out = [];

    // Type + default
    const base = `${d.name || 'This variable'} is a ${d.type} variable`;
    if (d.defaultValue !== '' && d.defaultValue !== undefined && d.defaultValue !== null) {
        out.push(`${base} with a default value of "${d.defaultValue}".`);
    } else {
        out.push(`${base} with no default value.`);
    }

    // Prompted behavior
    if (d.behaviors?.prompted) {
        out.push(`It updates when the prompted instructions are satisfied.`);
    }

    // Increment behavior
    if (d.behaviors?.increment) {

        // Trigger logic depends on prompted
        if (d.behaviors.prompted) {
            out.push(`Its value increments when the prompted condition is met.`);
        } else {
            const trigger = describeIncrementTrigger(d.increment?.triggers || []);
            out.push(`Its value increments ${trigger}.`);
        }

        // Type-specific increment behavior
        if (d.type === 'number') {
            out.push(`Each increment changes the value by ${d.increment?.delta ?? 1}.`);
        } else if (d.type === 'boolean') {
            out.push(`Each increment toggles the boolean value.`);
        } else if (d.type === 'enum') {
            out.push(`Each increment cycles through the enum values.`);
        } else if (d.type === 'array') {
            const op = d.increment?.operation;
            out.push(op ? `Each increment applies the "${op}" operation to the array.` : `No array operation is configured, so increments do nothing.`);
        }
    }

    return out.join(' ');
}
