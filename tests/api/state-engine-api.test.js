import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import ownsNamespace, { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import * as apiIndex from '../../src/api/index.js';
import { getVar } from '../../src/core/chat-state.js';
import { deleteVariableValueEverywhere } from '../../src/core/chat-state.js';
import { refreshVariableMacros } from '../../src/core/macro-registration.js';
import { dispatchNamespacedEvent } from '../../src/events/event-engine.js';

const extensionId = 'se';
let instanceId;

// Everything that takes (extensionId, instanceId, ...) first.
const GUARDED = [
    'createPreset', 'updatePreset', 'deletePreset', 'activatePreset', 'deactivatePreset', 'listPresets',
    'createVariable', 'updateVariable', 'deleteVariable', 'getVariable', 'listVariables',
    'validateCalculatedDefinition', 'applyCalculatedDefinition',
    'registerEventSource', 'fireEvent',
    'configureIndependentPreset', 'runIndependentPreset',
];
// Public, unguarded: the registry itself, and read-only introspection.
const UNGUARDED = [
    'registerExtension', 'unregisterExtension', 'getRegisteredExtensions',
    'validateNamespace', 'ownsNamespace', 'getDependencies', 'getDependents',
];

beforeEach(() => {
    instanceId = ensureInstanceId();
});

describe('state-engine-api facade', () => {
    describe('surface', () => {
        it.each([...GUARDED, ...UNGUARDED])('exposes %s as a function', (name) => {
            expect(typeof stateEngine[name]).toBe('function');
        });

        it.each(GUARDED)('%s takes (extensionId, instanceId, ...) as its first two parameters', (name) => {
            expect(stateEngine[name].toString()).toMatch(/^(?:async\s+)?(?:function\s*\w*\s*)?\(\s*extensionId\s*,\s*instanceId\b/);
        });

        it('does not hand out the identity helpers through the public facade or index', () => {
            for (const name of ['ensureInstanceId', 'validateCallerIdentity']) {
                expect(stateEngine[name]).toBeUndefined();
                expect(apiIndex[name]).toBeUndefined();
            }
        });

        it('the facade functions are the same ones the index re-exports', () => {
            for (const name of [...GUARDED, ...UNGUARDED]) expect(stateEngine[name]).toBe(apiIndex[name]);
        });
    });

    describe('extension lifecycle', () => {
        it('a registered extension can act in its own namespace with the shared instance token', () => {
            stateEngine.registerExtension({ namespace: 'pp', name: 'Pretty Panels' });
            const preset = stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Panels' });
            expect(preset.namespace).toBe('pp');
            expect(ownsNamespace('pp', 'pp')).toBe(true);
        });

        it('unregisterExtension removes the namespace, its presets, and their stored values, then refreshes macros', () => {
            stateEngine.registerExtension({ namespace: 'pp' });
            stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Panels' });
            stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Panels', name: 'x', type: 'number', defaultValue: 1 });
            stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Panels');
            expect(getVar('chat-1', 'pp__x').value).toBe(1);
            vi.clearAllMocks();

            expect(stateEngine.unregisterExtension('pp')).toBe(true);

            expect(stateEngine.validateNamespace('pp')).toBe(false);
            expect(Object.values(settings.get().presets).some((p) => p.namespace === 'pp')).toBe(false);
            expect(deleteVariableValueEverywhere).toHaveBeenCalledWith('pp__x');
            expect(getVar('chat-1', 'pp__x')).toBeUndefined();
            expect(refreshVariableMacros).toHaveBeenCalled();
        });

        it('unregisterExtension leaves presets from other namespaces (including un-namespaced legacy ones) alone', () => {
            registerNamespaces('pp');
            stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Mine' });
            settings.get().presets.legacy = { id: 'legacy', name: 'Legacy', variables: {} };

            stateEngine.unregisterExtension('pp');

            expect(stateEngine.listPresets(extensionId, instanceId, 'se')).toHaveLength(1);
            expect(settings.get().presets.legacy).toBeDefined();
        });

        it('after unregistering, the former owner is rejected', () => {
            stateEngine.registerExtension({ namespace: 'pp' });
            stateEngine.unregisterExtension('pp');
            expect(() => stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'X' })).toThrow("Extension 'pp' does not own namespace 'pp'");
        });

        it('unregisterExtension returns false for an unknown id', () => {
            expect(stateEngine.unregisterExtension('ghost')).toBe(false);
            expect(stateEngine.unregisterExtension(undefined)).toBe(false);
        });
    });

    describe('end to end through the facade', () => {
        it('preset -> plain + calculated variables -> activate -> cascade -> event', () => {
            const call = (name, ...args) => stateEngine[name](extensionId, instanceId, ...args);

            call('createPreset', { namespace: 'se', name: 'Combat' });
            call('activatePreset', 'chat-1', 'se', 'Combat');
            call('createVariable', { namespace: 'se', presetName: 'Combat', name: 'hp', type: 'number', defaultValue: 10 });
            call('createVariable', { namespace: 'se', presetName: 'Combat', name: 'half', type: 'calculated', expression: 'se__hp / 2' });
            expect(getVar('chat-1', 'se__half').value).toBe(5);

            call('registerEventSource', { namespace: 'se', eventName: 'hit' });
            const heard = vi.fn();
            context.eventSource.on('se.hit', heard);
            expect(call('fireEvent', 'chat-1', 'se.hit')).toBe(true);
            expect(dispatchNamespacedEvent).toHaveBeenCalledWith('chat-1', 'se.hit');
            expect(heard).toHaveBeenCalledWith('chat-1');

            expect(stateEngine.getDependents({ namespace: 'se', variableName: 'hp' }).map((d) => d.name)).toEqual(['se__half']);
        });
    });
});
