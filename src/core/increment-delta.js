// State Engine — the step an increment applies (requirements spec 1.37).

import { LOG_PREFIX, DEFAULT_CALENDAR_ID } from './settings-core.js';
import { isValidDelta } from './calendar-engine.js';
import { getVar } from './chat-state.js';

// The delta an increment of `def` applies right now (requirements spec
// 1.37). def.increment.deltaVariable, when set, names another variable whose
// CURRENT stored value is the step - any variable, calculated ones included,
// so a computed step needs no expression of its own. A number variable needs
// a finite number from it; a datetime accepts a number (seconds) or a duration
// string its calendar understands ("3h", "1d"). Anything else - the variable
// does not exist, has no value yet, or holds something unusable - falls back
// to the fixed def.increment.delta, with a warning, so an increment never
// silently stops. Every increment path (deterministic, prompted, independent
// presets) asks this instead of reading def.increment.delta directly.
export function incrementDelta(chatId, def) {
    const fixed = def?.increment?.delta;
    const sourceName = typeof def?.increment?.deltaVariable === 'string' ? def.increment.deltaVariable.trim() : '';
    if (!sourceName || (def.type !== 'number' && def.type !== 'datetime')) return fixed;

    const value = getVar(chatId, sourceName)?.value;
    if (def.type === 'number') {
        const n = typeof value === 'number' ? value
            : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
        if (Number.isFinite(n)) return n;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    } else if (typeof value === 'string' && value.trim() !== '' && isValidDelta(def.calendar || DEFAULT_CALENDAR_ID, value.trim())) {
        return value.trim();
    }
    console.warn(LOG_PREFIX, `increment of "${def.name}": delta variable "${sourceName}" has no usable value (${JSON.stringify(value)}) - using the fixed delta ${JSON.stringify(fixed)}`);
    return fixed;
}
