// Object presets and field roles (src/core/object-presets.js, objects.js;
// docs/DESIGN - OBJECT PRESETS.md): each setting's fields per object type -
// baseline (global scope) and runtime (chat scope) - as a real preset that no
// chat or tracker list shows; field roles as the contract other code reads
// through; prompted baseline fields; objects held by a single object
// variable get their fields asked too; migration from runtime fields.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { loadChatState } from '../src/core/chat-state.js';
import * as O from '../src/core/objects.js';
import { isObjectPreset } from '../src/core/object-types.js';
import { isVariableNameTaken } from '../src/core/preset-manager.js';
import { runPromptedStateUpdate } from '../src/core/prompted-engine.js';
import { callBackgroundLLM } from '../src/core/background-llm.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

const CHAT = 'chat-1';
let id;
let story;
const api = (fn, ...args) => stateEngine[fn]('pp', id, ...args);
const names = (defs) => defs.map((d) => d.name);

beforeEach(() => {
    id = ensureInstanceId();
    registerNamespaces('pp');
    story = O.createSetting({ name: 'Story', autoConfirm: false });
    O.setChatSetting(CHAT, story.id);
    context.chatId = CHAT;
    callBackgroundLLM.mockReset();
});

describe('a setting\'s object presets', () => {
    it('start from the type\'s defaults: baseline fields (global), then runtime fields (chat)', () => {
        const defs = O.getObjectFields(story.id, 'character');
        expect(defs.map((d) => [d.name, d.scope])).toEqual([
            ['personality', 'global'], ['role', 'global'], ['goals', 'global'], ['relationships', 'global'],
            ['thought', 'chat'], ['mood', 'chat'], ['intent', 'chat'], ['factions', 'chat'],
        ]);
        // Factions are tracked as the story goes, and stay when a character leaves the scene.
        expect(defs.find((d) => d.name === 'factions')).toMatchObject({ type: 'array', itemType: 'object', itemObjectType: 'faction', behaviors: { prompted: true }, clearOnLeave: false });
        expect(O.getObjectFields(story.id, 'location').map((d) => d.name)).toEqual(['region', 'conditions', 'factions']);
        expect(defs.find((d) => d.name === 'personality')).toMatchObject({ type: 'string', multiline: true });
        expect(defs.find((d) => d.name === 'thought')).toMatchObject({ behaviors: { prompted: true }, prompted: { newEachTurn: true, mode: 'update' }, clearOnLeave: true });
        expect(O.getObjectFields(story.id, 'location').find((d) => d.name === 'conditions').clearOnLeave).toBe(false);
    });

    it('are real presets that no chat list, tracker list or name check sees', () => {
        O.getObjectFields(story.id, 'character');
        const stored = Object.values(settings.get().presets).filter(isObjectPreset);
        expect(stored.some((p) => p.settingId === story.id && p.objectType === 'character' && p.name === 'Story · Characters')).toBe(true);
        expect(api('listAllVariables').some((p) => isObjectPreset(p) || p.objectType)).toBe(false);
        expect(isVariableNameTaken('mood')).toBe(false);
        O.updateSetting(story.id, { name: 'Saga' });
        expect(stored.find((p) => p.settingId === story.id && p.objectType === 'character').name).toBe('Saga · Characters');
        O.deleteSetting(story.id);
        expect(Object.values(settings.get().presets).some((p) => p.settingId === story.id)).toBe(false);
    });

    it('fields are validated; any field can be removed', () => {
        const defs = O.getObjectFields(story.id, 'location');
        expect(() => O.setObjectFields(story.id, 'location', [...defs, { name: 'Bad Name' }])).toThrow(/not valid/);
        expect(() => O.setObjectFields(story.id, 'location', [{ name: 'name' }])).toThrow(/already has it/);
        expect(() => O.setObjectFields(story.id, 'location', [{ name: 'when', type: 'datetime' }])).toThrow(/a field is one of/);
        expect(() => O.setObjectFields(story.id, 'location', [{ name: 'boss', type: 'object' }])).toThrow(/objectType/);
        expect(names(O.setObjectFields(story.id, 'location', [{ name: 'crowd', scope: 'chat', type: 'enum', enumValues: ['Empty', 'Busy'] }]))).toEqual(['crowd']);
        expect(api('setObjectFields', story.id, 'location', [{ name: 'x', type: 'colour' }])).toBeNull();
    });
});

describe('field values', () => {
    it('baseline fields live on the record, runtime fields in the chat; object fields take names', () => {
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys', role: 'Smuggler' });
        O.setObjectFieldValue(CHAT, rhys.id, 'role', 'Captain');
        expect(O.getObjectFieldValue('chat-2', rhys.id, 'role', { settingId: story.id })).toBe('Captain');
        expect(() => O.setObjectFieldValue(CHAT, rhys.id, 'mood', 'Sad')).toThrow(/prompted/);
        expect(() => O.setObjectFieldValue(CHAT, rhys.id, 'nope', 'x')).toThrow(/not a character field/);
        expect(() => O.setObjectFieldValue(null, rhys.id, 'factions', 42, { settingId: story.id })).toThrow(/not a valid/);
    });

    it('a runtime field\'s starting value (a scenario author\'s): every chat begins from it, then keeps its own', () => {
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys', startValues: { factions: ['the Guild', 'Ashguard'] } });
        const guild = O.getObjectByAlias(CHAT, 'faction', 'the guild');
        const ash = O.getObjectByAlias(CHAT, 'faction', 'Ashguard');
        expect(guild).toMatchObject({ scope: 'setting', confirmed: true });
        expect(O.getObject(null, rhys.id, story.id).startValues).toEqual({ factions: [guild.id, ash.id] });
        expect(O.getObject(CHAT, rhys.id).runtime.values.factions).toEqual([guild.id, ash.id]);
        // The story changes it in one chat; the other chat still starts from the starting value.
        O.markObjectPresent(CHAT, rhys.id);
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { factions: ['Ashguard', 'the Crown'] } });
        const crown = O.getObjectByAlias(CHAT, 'faction', 'the Crown');
        expect(O.getObject(CHAT, rhys.id).runtime.values.factions).toEqual([ash.id, crown.id]);
        O.setChatSetting('chat-2', story.id);
        expect(O.getObject('chat-2', rhys.id).runtime.values.factions).toEqual([guild.id, ash.id]);
        // Leaving the scene keeps them; an empty answer is the chat's own value.
        O.markObjectAbsent(CHAT, rhys.id);
        expect(O.getObject(CHAT, rhys.id).runtime.values.factions).toEqual([ash.id, crown.id]);
        // With no chat, a runtime field is its starting value - set even though it is prompted.
        O.setObjectFieldValue(null, rhys.id, 'factions', ['the Guild'], { settingId: story.id });
        expect(O.getObjectFieldValue(null, rhys.id, 'factions', { settingId: story.id })).toEqual([guild.id]);
        expect(O.getObjectFieldValue('chat-3', rhys.id, 'se__character.factions', { settingId: story.id })).toEqual([guild.id]);
        // Any type can be given factions; a location has them by default.
        const docks = O.createObject(story.id, 'location', { name: 'The Docks', startValues: { factions: ['the citizens of Riverton'] } });
        expect(O.getObject(CHAT, docks.id).runtime.values.factions).toEqual([O.getObjectByAlias(CHAT, 'faction', 'the citizens of Riverton').id]);
    });

    it('a field read or written through its role', () => {
        const market = O.createObject(story.id, 'location', { name: 'Brass Market', region: 'Lowtown' });
        expect(O.getObjectFieldValue(CHAT, market.id, 'se__location.region')).toBe('Lowtown');
        expect(api('getObjectField', CHAT, market.id, 'se__location.region')).toBe('Lowtown');
        api('setObjectField', CHAT, market.id, 'se__location.region', 'Uptown');
        expect(O.getObject(CHAT, market.id).region).toBe('Uptown');
    });

    it('a deleted object leaves every object field that held it', () => {
        const guild = O.createObject(story.id, 'faction', { name: 'The Guild' });
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys', startValues: { factions: [guild.id] } });
        O.deleteObject(CHAT, guild.id);
        expect(O.getObject(CHAT, rhys.id).startValues.factions).toEqual([]);
    });
});

describe('renaming and replacing fields', () => {
    it('a rename keeps the field\'s values and its role', () => {
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys', role: 'Smuggler' });
        O.markObjectPresent(CHAT, rhys.id);
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { mood: 'Sad' } });
        const defs = O.getObjectFields(story.id, 'character');
        const renamed = defs.map((d) => (d.name === 'mood' ? { ...d, name: 'emotion' } : d.name === 'role' ? { ...d, name: 'occupation' } : d));
        O.setObjectFields(story.id, 'character', renamed);
        expect(O.getObject(CHAT, rhys.id)).toMatchObject({ occupation: 'Smuggler', runtime: { values: { emotion: 'Sad' } } });
        expect(O.getObjectFieldRoles(story.id, 'character').find((r) => r.id === 'se__character.mood').assigned).toBe('emotion');
        expect(O.getObjectFieldValue(CHAT, rhys.id, 'se__character.mood')).toBe('Sad');
        expect(O.getObjectFieldValue(CHAT, rhys.id, 'se__character.role')).toBe('Smuggler');
    });

    it('a removed field leaves its role unassigned; the role can point at another field', () => {
        const defs = O.getObjectFields(story.id, 'character').filter((d) => d.name !== 'mood');
        O.setObjectFields(story.id, 'character', [...defs, { name: 'feeling', scope: 'chat', type: 'string' }]);
        expect(O.getObjectFieldRoles(story.id, 'character').find((r) => r.id === 'se__character.mood').assigned).toBeNull();
        expect(O.assignObjectFieldRole(story.id, 'se__character.mood', 'feeling').assigned).toBe('feeling');
        expect(() => O.assignObjectFieldRole(story.id, 'se__character.mood', 'nope')).toThrow(/no character field/);
        expect(() => O.assignObjectFieldRole(story.id, 'se__nothing.here', 'feeling')).toThrow(/not a field role/);
        expect(api('getObjectFieldRoles', story.id, 'character').find((r) => r.publicName === 'character.mood')).toMatchObject({ assigned: 'feeling', type: 'text' });
    });
});

describe('prompted fields', () => {
    it('a baseline field in fill mode is answered once, while empty', () => {
        const defs = O.getObjectFields(story.id, 'location').map((d) => (d.name === 'region' ? { ...d, behaviors: { prompted: true }, prompted: { instructions: 'the district' } } : d));
        O.setObjectFields(story.id, 'location', defs);
        expect(O.getObjectFields(story.id, 'location').find((d) => d.name === 'region').prompted.mode).toBe('fill');
        const docks = O.createChatObject(CHAT, 'location', 'The Docks');
        O.applyRuntimeUpdates(CHAT, 'location', { [docks.id]: { region: 'Lowtown', conditions: 'Foggy' } });
        expect(O.getObject(CHAT, docks.id)).toMatchObject({ region: 'Lowtown', runtime: { values: { conditions: 'Foggy' } } });
        O.applyRuntimeUpdates(CHAT, 'location', { [docks.id]: { region: 'Uptown' } });
        expect(O.getObject(CHAT, docks.id).region).toBe('Lowtown');
        // Writing a baseline field does not confirm the object.
        expect(O.getObject(CHAT, docks.id)).toMatchObject({ scope: 'chat', confirmed: false });
    });

    it('the place a single object variable holds has its fields asked and written', async () => {
        api('createPreset', { namespace: 'pp', name: 'Scene' });
        api('activatePreset', CHAT, 'pp', 'Scene');
        api('createVariable', { namespace: 'pp', presetName: 'Scene', name: 'where', type: 'object', objectType: 'location', behaviors: { prompted: true, increment: false }, prompted: { instructions: 'where the scene is' } });
        const docks = O.createObject(story.id, 'location', { name: 'The Docks' });
        O.applyRuntimeUpdates(CHAT, 'location', { [docks.id]: { conditions: 'Foggy' } });
        stateEngine.setVariableValue('pp', id, CHAT, { namespace: 'pp', presetName: 'Scene', variableName: 'where' }, docks.id);
        context.chat = [{ is_user: false, name: 'GM', mes: 'Rain sweeps the docks.' }];
        callBackgroundLLM.mockResolvedValue(JSON.stringify({ pp__where: 'The Docks', __locations: { 'The Docks': { conditions: 'Rain, slick planks' } } }));
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(O.getObject(CHAT, docks.id).runtime.values.conditions).toBe('Rain, slick planks'));
        const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
        expect(prompt).toContain('"__locations"');
        expect(prompt).toContain('currently {"The Docks":{"conditions":"Foggy","factions":null}}');
        expect(prompt).toContain('"factions": JSON array of faction names');
    });
});

describe('leaving the scene', () => {
    it('clears only the fields marked clearOnLeave', () => {
        const defs = O.getObjectFields(story.id, 'character');
        O.setObjectFields(story.id, 'character', [...defs, { name: 'injuries', scope: 'chat', type: 'array', itemType: 'string' }]);
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        O.markObjectPresent(CHAT, rhys.id);
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { mood: 'Sad' } });
        O.setObjectFieldValue(CHAT, rhys.id, 'injuries', ['broken arm']);
        O.markObjectAbsent(CHAT, rhys.id);
        expect(O.getObject(CHAT, rhys.id).runtime.values).toMatchObject({ mood: null, injuries: ['broken arm'] });
    });
});

describe('migration', () => {
    it('a setting\'s old runtime fields become its object preset; object fields holding names get objects; idempotent', () => {
        const store = settings.get().variableStore;
        store.settings.set_old = {
            id: 'set_old', name: 'Old', autoConfirm: false, createdAt: 1,
            objects: { character: { chr_a: { id: 'chr_a', type: 'character', name: 'Ann', faction: 'Guild, Crown', variants: { v1: { id: 'v1', name: 'Alt', overrides: { faction: 'Rebels', role: 'Spy' } } } } } },
            runtimeFields: { character: {
                mood: { name: 'mood', type: 'enum', prompted: true, values: ['Calm', 'Angry'], images: { Calm: 'calm.png' } },
                fear: { name: 'fear', type: 'number', prompted: false, min: 0, max: 10 },
            } },
        };
        const state = loadChatState('chat-old');
        state.setting = 'set_old';
        state.objects = { character: { entries: {}, local: { chr_b: { id: 'chr_b', type: 'character', name: 'Bo', faction: 'Guild' } } } };
        expect(O.migrateObjectFields()).toEqual({ settings: 1, references: 2 });
        expect(store.settings.set_old.runtimeFields).toBeUndefined();
        const runtime = O.getObjectFields('set_old', 'character').filter((d) => d.scope === 'chat');
        expect(runtime.map((d) => d.name)).toEqual(['thought', 'mood', 'intent', 'factions', 'fear']);
        expect(runtime.find((d) => d.name === 'mood')).toMatchObject({ enumValues: ['Calm', 'Angry'], enumImages: { Calm: 'calm.png' } });
        expect(runtime.find((d) => d.name === 'thought').prompted.newEachTurn).toBe(true);
        const guild = O.getObjectByAlias('chat-old', 'faction', 'Guild');
        const crown = O.getObjectByAlias('chat-old', 'faction', 'Crown');
        expect(guild).toMatchObject({ scope: 'setting', settingId: 'set_old' });
        // A character's faction is now the starting value of its factions.
        expect(O.getObject('chat-old', 'chr_a')).toMatchObject({ startValues: { factions: [guild.id, crown.id] }, variants: [{ overrides: { role: 'Spy' } }] });
        expect(O.getObject('chat-old', 'chr_a').variants[0].overrides.faction).toBeUndefined();
        expect(O.getObject('chat-old', 'chr_b').startValues.factions).toEqual([guild.id]);
        expect(O.getObject('chat-old', 'chr_b').faction).toBeUndefined();
        expect(O.migrateObjectFields()).toEqual({ settings: 0, references: 0 });
    });
});
