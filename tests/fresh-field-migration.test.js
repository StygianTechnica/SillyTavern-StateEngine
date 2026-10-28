// A thought and intent an editor's save stopped asking new each turn
// (src/core/fresh-field-migration.js): turned back on while they still
// have the built-in text, once.
import { describe, it, expect } from 'vitest';
import settings from './harness/settings.js';
import { migrateFreshFields } from '../src/core/fresh-field-migration.js';
import { OBJECT_TYPES } from '../src/core/object-types.js';

const builtIn = (name) => OBJECT_TYPES.character.runtime.find((f) => f.name === name).description;
const field = (name, instructions, newEachTurn = false) => ({ id: `v_${name}`, name, scope: 'chat', type: 'string', prompted: { instructions, newEachTurn, mode: 'update' } });

function install(variables) {
    settings.get().presets.p_chars = { id: 'p_chars', name: 'Story · Characters', objectType: 'character', settingId: 'set_story', variables: Object.fromEntries(variables.map((v) => [v.id, v])) };
    return settings.get().presets.p_chars.variables;
}

describe('new each turn put back', () => {
    it('turns it back on for the built-in thought and intent, once', () => {
        const vars = install([field('thought', builtIn('thought')), field('intent', builtIn('intent')), field('mood', builtIn('mood'))]);
        expect(migrateFreshFields()).toBe(2);
        expect(vars.v_thought.prompted.newEachTurn).toBe(true);
        expect(vars.v_intent.prompted.newEachTurn).toBe(true);
        // Mood is never new each turn.
        expect(vars.v_mood.prompted.newEachTurn).toBe(false);
        vars.v_thought.prompted.newEachTurn = false;
        expect(migrateFreshFields()).toBe(0);
        expect(vars.v_thought.prompted.newEachTurn).toBe(false);
    });

    it('leaves a field with the user\'s own prompt alone', () => {
        const vars = install([field('thought', 'What they would never say aloud.')]);
        expect(migrateFreshFields()).toBe(0);
        expect(vars.v_thought.prompted.newEachTurn).toBe(false);
    });
});
