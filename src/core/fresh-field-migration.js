// State Engine - one-time migration: NEW EACH TURN put back (2026-10-28).
//
//   setRuntimeFields() took a view without `fresh` as "not new each turn",
//   so an editor that left it out (Pretty Panels' runtime fields tab, saving
//   a mood's images) turned it off for a character's thought and intent.
//   Shown back as their current value, the small model copied them every
//   turn: thoughts stopped changing, and empty ones stayed empty.
//
// A built-in field the registry asks new each turn (object-types.js `fresh`)
// gets it back while it still has the built-in text - a field the user wrote
// their own prompt for is left alone. Runs once
// (settings.migrations.freshFields20261028).

import { LOG_PREFIX, getSettings, persistSettings } from './settings-core.js';
import { isObjectPreset, OBJECT_TYPES } from './object-types.js';

const FLAG = 'freshFields20261028';

// Runs the migration if it has not run yet. -> how many fields changed.
export function migrateFreshFields() {
    const settings = getSettings();
    if (!settings.migrations || typeof settings.migrations !== 'object') settings.migrations = {};
    if (settings.migrations[FLAG]) return 0;
    let fixed = 0;
    for (const preset of Object.values(settings.presets || {})) {
        if (!isObjectPreset(preset)) continue;
        const builtIns = OBJECT_TYPES[preset.objectType]?.runtime ?? [];
        for (const variable of Object.values(preset.variables || {})) {
            const field = builtIns.find((f) => f.name === variable?.name && f.fresh === true);
            if (!field || variable.scope === 'global' || variable.prompted?.newEachTurn === true) continue;
            if (String(variable.prompted?.instructions ?? '').trim() !== field.description) continue;
            variable.prompted = { ...variable.prompted, newEachTurn: true };
            fixed++;
        }
    }
    settings.migrations[FLAG] = true;
    persistSettings();
    if (fixed) console.log(`${LOG_PREFIX} ${fixed} character field(s) (thought, intent) are asked new each turn again`);
    return fixed;
}
