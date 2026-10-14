// Two built-in prompts brought up to date on existing installs
// (src/core/prompt-refresh-migration.js): Scene Context's Delta Time, and
// the character intent asked new each turn - only while they still have the
// old built-in text, once.
import { describe, it, expect, vi } from 'vitest';
import settings from './harness/settings.js';
import { migratePromptRefresh, OLD_DELTA_INSTRUCTIONS, OLD_INTENT_INSTRUCTIONS } from '../src/core/prompt-refresh-migration.js';
import { SCENE_CONTEXT_BLUEPRINT } from '../src/core/scene-context-preset.js';
import { OBJECT_TYPES } from '../src/core/object-types.js';

vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

const DELTA = 'se__scene_deltatime';

function install({ delta = OLD_DELTA_INSTRUCTIONS, intent = OLD_INTENT_INSTRUCTIONS } = {}) {
    const presets = settings.get().presets;
    presets.p_scene = { id: 'p_scene', name: 'Scene Context', namespace: 'se', variables: { v_d: { id: 'v_d', name: DELTA, type: 'string', prompted: { instructions: delta } } } };
    presets.p_chars = {
        id: 'p_chars', name: 'Story · Characters', objectType: 'character', settingId: 'set_story',
        variables: { v_i: { id: 'v_i', name: 'intent', scope: 'chat', type: 'string', prompted: { instructions: intent, newEachTurn: false, mode: 'update' } } },
    };
}

describe('the new built-in prompts', () => {
    it('Delta Time takes a time of day as well as a duration', () => {
        const text = SCENE_CONTEXT_BLUEPRINT.vars.find((v) => v.name === 'scene_deltatime').prompted.instructions;
        expect(text).toContain('the next morning');
        expect(text).not.toContain('turn vague durations into numbers');
    });

    it('a character\'s intent is asked new each turn', () => {
        expect(OBJECT_TYPES.character.runtime.find((f) => f.name === 'intent')).toMatchObject({ fresh: true });
    });
});

describe('migrating an install', () => {
    it('replaces the old built-in texts', () => {
        install();
        expect(migratePromptRefresh()).toEqual({ delta: true, intents: 1 });
        const presets = settings.get().presets;
        expect(presets.p_scene.variables.v_d.prompted.instructions).toMatch(/time of day/);
        expect(presets.p_chars.variables.v_i.prompted).toMatchObject({ newEachTurn: true, mode: 'update' });
        expect(presets.p_chars.variables.v_i.prompted.instructions).toMatch(/very next move/);
    });

    it('keeps what the user wrote, and runs once', () => {
        install({ delta: 'My own words.', intent: 'Their plan.' });
        expect(migratePromptRefresh()).toEqual({ delta: false, intents: 0 });
        expect(settings.get().presets.p_scene.variables.v_d.prompted.instructions).toBe('My own words.');
        install();
        expect(migratePromptRefresh()).toEqual({ delta: false, intents: 0 });
        expect(settings.get().presets.p_scene.variables.v_d.prompted.instructions).toBe(OLD_DELTA_INSTRUCTIONS);
    });
});
