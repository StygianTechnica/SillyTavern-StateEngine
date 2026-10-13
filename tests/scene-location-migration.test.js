// Scene Context's location becoming a location object
// (src/core/scene-location-migration.js): the preset's variable, every
// chat's stored text, once.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { loadChatState, saveChatState } from '../src/core/chat-state.js';
import * as O from '../src/core/objects.js';
import { migrateSceneLocation } from '../src/core/scene-location-migration.js';
import { SCENE_CONTEXT_BLUEPRINT } from '../src/core/scene-context-preset.js';
import { variableTypeFitsRole } from '../src/core/roles.js';

vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

const VAR = 'se__scene_location';
const OLD = 'Infer the current location from the recent roleplay messages.\nUpdate only when a new location is explicitly named or strongly implied.\nIf the location has not changed, leave this variable unchanged.';

function scenePreset(def) {
    settings.get().presets.p_scene = { id: 'p_scene', name: 'Scene Context', namespace: 'se', variables: { v_loc: { id: 'v_loc', name: VAR, ...def } } };
}

function storeValue(chatId, value) {
    const state = loadChatState(chatId);
    state.variables[VAR] = { value, def: { name: VAR, type: 'string' } };
    saveChatState(chatId, state);
}

let story;
beforeEach(() => {
    story = O.createSetting({ name: 'Story', autoConfirm: false });
    context.chatId = 'chat-a';
});

describe('the Scene Context blueprint', () => {
    it('holds the location as a location object', () => {
        expect(SCENE_CONTEXT_BLUEPRINT.vars.find((v) => v.name === 'scene_location')).toMatchObject({ type: 'object', objectType: 'location' });
    });

    it('a text role still takes it (an object shows as its name)', () => {
        expect(variableTypeFitsRole('text', 'object')).toBe(true);
    });
});

describe('migrating an install', () => {
    it('the preset variable becomes a location object, and each chat\'s text the location it names', () => {
        scenePreset({ type: 'string', label: 'Location', behaviors: { prompted: true }, prompted: { instructions: OLD } });
        O.setChatSetting('chat-a', story.id);
        O.setChatSetting('chat-b', story.id);
        const docks = O.createObject(story.id, 'location', { name: 'The Docks', aliases: ['the harbour'] });
        storeValue('chat-a', 'the Harbour');
        storeValue('chat-b', 'Brass Market');
        storeValue('chat-c', '');

        expect(migrateSceneLocation()).toEqual({ preset: true, chats: 3 });

        const def = settings.get().presets.p_scene.variables.v_loc;
        expect(def).toMatchObject({ type: 'object', objectType: 'location', label: 'Location', defaultValue: '' });
        expect(def.prompted.instructions).toMatch(/most specific/);
        expect(loadChatState('chat-a').variables[VAR]).toMatchObject({ value: docks.id, def: { type: 'object' } });
        const market = O.getObject('chat-b', loadChatState('chat-b').variables[VAR].value);
        expect(market).toMatchObject({ type: 'location', name: 'Brass Market', scope: 'chat', confirmed: false });
        expect(loadChatState('chat-c').variables[VAR].value).toBe('');
    });

    it('instructions the user wrote are kept', () => {
        scenePreset({ type: 'string', prompted: { instructions: 'My own words.' } });
        migrateSceneLocation();
        expect(settings.get().presets.p_scene.variables.v_loc.prompted.instructions).toBe('My own words.');
    });

    it('runs once, and leaves a location the user already changed alone', () => {
        scenePreset({ type: 'enum', enumValues: ['Inn', 'Road'] });
        expect(migrateSceneLocation()).toEqual({ preset: false, chats: 0 });
        expect(settings.get().presets.p_scene.variables.v_loc.type).toBe('enum');
        settings.get().presets.p_scene.variables.v_loc.type = 'string';
        expect(migrateSceneLocation()).toEqual({ preset: false, chats: 0 });
        expect(settings.get().presets.p_scene.variables.v_loc.type).toBe('string');
    });
});
