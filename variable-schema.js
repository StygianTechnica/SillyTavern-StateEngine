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
    return (type === 'number' || type === 'boolean' || type === 'enum');
}

export function normalizeCollectedValues(values) {
    const out = {};

    // Basic fields
    if (values.name !== undefined) out.name = values.name.trim();
    if (values.label !== undefined) out.label = String(values.label).trim();
    if (values.description !== undefined) out.description = values.description;

    if (values.enumValues !== undefined) out.enumValues = values.enumValues;
    if (values.defaultValue !== undefined) out.defaultValue = values.defaultValue;

    if (values.min !== undefined) out.min = values.min;
    if (values.max !== undefined) out.max = values.max;

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
    let out = [];

    // Type + default
    const base = `${d.name || 'This variable'} is a ${d.type} variable`;
    if (d.default !== '' && d.default !== undefined && d.default !== null) {
        out.push(`${base} with a default value of "${d.default}".`);
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
        }
    }

    return out.join(' ');
}
