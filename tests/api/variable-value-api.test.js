import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine, VARIABLES_CHANGED_EVENT } from '../../src/api/index.js';
import { getVar, setVar } from '../../src/core/chat-state.js';
import { recalculateDependents } from '../../src/core/calculated-engine.js';

const WRONG_INSTANCE = 'State Engine API call rejected: wrong instance';
let instanceId;

// `se` owns a user preset; `pp` is a display extension with its own preset.
beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    stateEngine.createPreset('se', instanceId, { namespace: 'se', name: 'Stats', description: 'combat' });
    stateEngine.createVariable('se', instanceId, { namespace: 'se', presetName: 'Stats', name: 'hp', label: 'Health', type: 'number', defaultValue: 10, min: 0, max: 20 });
    stateEngine.createVariable('se', instanceId, { namespace: 'se', presetName: 'Stats', name: 'mood', type: 'enum', enumValues: ['calm', 'angry'], defaultValue: 'calm' });
    stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Config' });
    stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Config', name: 'layoutId', type: 'string', defaultValue: '' });
    stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Config', name: 'echo', type: 'calculated', dependencies: ['pp__layoutId'], expression: 'pp__layoutId' });
    stateEngine.activatePreset('se', instanceId, 'chat-1', 'se', 'Stats');
});

describe('variable-value-api', () => {
    describe('listAllVariables', () => {
        it('lists every namespace\'s presets, grouped, sorted by namespace then name', () => {
            const list = stateEngine.listAllVariables('pp', instanceId);
            expect(list.map((p) => `${p.namespace}.${p.name}`)).toEqual(['pp.Config', 'se.Stats']);
            const stats = list[1];
            expect(stats.description).toBe('combat');
            expect(stats.variables.map((v) => v.name)).toEqual(['se__hp', 'se__mood']);
            expect(stats.variables[0]).toMatchObject({ label: 'Health', type: 'number', min: 0, max: 20 });
            expect(stats.variables[1].enumValues).toEqual(['calm', 'angry']);
        });

        it('marks which presets are active in a chat only when a chatId is given', () => {
            expect(stateEngine.listAllVariables('pp', instanceId)[0].active).toBeUndefined();
            const byName = Object.fromEntries(stateEngine.listAllVariables('pp', instanceId, 'chat-1').map((p) => [p.name, p.active]));
            expect(byName).toEqual({ Config: false, Stats: true });
        });

        it('exposes display fields only, as copies', () => {
            const list = stateEngine.listAllVariables('pp', instanceId);
            const hp = list[1].variables[0];
            expect(hp.behaviors).toBeUndefined();
            expect(hp.defaultValue).toBeUndefined();
            list[1].variables[1].enumValues.push('hacked');
            const stored = Object.values(settings.get().presets).find((p) => p.name === 'Stats');
            expect(Object.values(stored.variables).find((v) => v.name === 'se__mood').enumValues).toEqual(['calm', 'angry']);
        });

        it('rejects a wrong instance and an unregistered caller', () => {
            expect(() => stateEngine.listAllVariables('pp', 'nope')).toThrow(WRONG_INSTANCE);
            expect(() => stateEngine.listAllVariables('ghost', instanceId)).toThrow(/does not own a namespace/);
        });
    });

    describe('getVariableValue / getVariableValues', () => {
        it('reads another namespace\'s value with its display definition', () => {
            const read = stateEngine.getVariableValue('pp', instanceId, 'chat-1', 'se__hp');
            expect(read.value).toBe(10);
            expect(read.def).toMatchObject({ name: 'se__hp', label: 'Health', type: 'number', min: 0, max: 20 });
        });

        it('is undefined for a variable never seeded in that chat, or no chat', () => {
            expect(stateEngine.getVariableValue('pp', instanceId, 'chat-1', 'pp__layoutId')).toBeUndefined();
            expect(stateEngine.getVariableValue('pp', instanceId, '', 'se__hp')).toBeUndefined();
            expect(stateEngine.getVariableValue('pp', instanceId, 'chat-1', 'se__nope')).toBeUndefined();
        });

        it('returns a copy of array values', () => {
            setVar('chat-1', 'se__list', ['a'], null);
            const read = stateEngine.getVariableValue('pp', instanceId, 'chat-1', 'se__list');
            read.value.push('b');
            expect(getVar('chat-1', 'se__list').value).toEqual(['a']);
            expect(read.def).toBeNull();
        });

        it('reads several names at once', () => {
            const values = stateEngine.getVariableValues('pp', instanceId, 'chat-1', ['se__hp', 'se__mood', 'se__nope']);
            expect(values.se__hp.value).toBe(10);
            expect(values.se__mood.value).toBe('calm');
            expect(values.se__nope).toBeUndefined();
        });

        it('rejects a wrong instance', () => {
            expect(() => stateEngine.getVariableValue('pp', 'nope', 'chat-1', 'se__hp')).toThrow(WRONG_INSTANCE);
        });
    });

    describe('setVariableValue', () => {
        const ref = (variableName, namespace = 'pp', presetName = 'Config') => ({ namespace, presetName, variableName });

        it('writes a value in the caller\'s own namespace and recalculates dependents', () => {
            expect(stateEngine.setVariableValue('pp', instanceId, 'chat-1', ref('layoutId'), 'ppl-1')).toBe(true);
            expect(getVar('chat-1', 'pp__layoutId').value).toBe('ppl-1');
            expect(context.variables.local.get('pp__layoutId')).toBe('ppl-1');
            expect(recalculateDependents).toHaveBeenCalledWith('chat-1', 'pp__layoutId');
        });

        it('refuses another namespace\'s variable (ownership, like every write)', () => {
            expect(() => stateEngine.setVariableValue('pp', instanceId, 'chat-1', ref('hp', 'se', 'Stats'), 1))
                .toThrow("Extension 'pp' does not own namespace 'se'");
            expect(getVar('chat-1', 'se__hp').value).toBe(10);
        });

        it('refuses calculated variables, unknown variables/presets, and a missing chat', () => {
            expect(stateEngine.setVariableValue('pp', instanceId, 'chat-1', ref('echo'), 'x')).toBe(false);
            expect(stateEngine.setVariableValue('pp', instanceId, 'chat-1', ref('nope'), 'x')).toBe(false);
            expect(stateEngine.setVariableValue('pp', instanceId, 'chat-1', ref('layoutId', 'pp', 'Nope'), 'x')).toBe(false);
            expect(stateEngine.setVariableValue('pp', instanceId, '', ref('layoutId'), 'x')).toBe(false);
        });
    });

    it('re-exports the change event name', () => {
        expect(VARIABLES_CHANGED_EVENT).toBe('state_engine_variables_changed');
    });
});
