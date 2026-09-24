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
    'listAllVariables', 'getVariableValue', 'getVariableValues', 'getVariableImage', 'setVariableValue',
    'validateCalculatedDefinition', 'applyCalculatedDefinition',
    'registerEventSource', 'fireEvent',
    'configureIndependentPreset', 'runIndependentPreset',
    // extension registration: registerExtension takes full identity, createNamespace the instance half
    'registerExtension', 'createNamespace',
    // capability graph writers (target namespace = the caller's own record)
    'declareCapabilities', 'declareDependencies',
];
// Public, unguarded: the registry itself, and read-only introspection.
const UNGUARDED = [
    'unregisterExtension', 'getRegisteredExtensions', 'getExtensionRegistration', 'getNamespaces',
    'getCapabilityGraph', 'getExtensionsProviding', 'getExtensionCapabilities', 'getExtensionDependencies',
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
            stateEngine.createNamespace('pp', instanceId, 'pp');
            const preset = stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Panels' });
            expect(preset.namespace).toBe('pp');
            expect(ownsNamespace('pp', 'pp')).toBe(true);
        });

        it('unregisterExtension removes the namespace, its presets, and their stored values, then refreshes macros', () => {
            stateEngine.createNamespace('pp', instanceId, 'pp');
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
            stateEngine.createNamespace('pp', instanceId, 'pp');
            stateEngine.unregisterExtension('pp');
            expect(() => stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'X' })).toThrow("Extension 'pp' does not own namespace 'pp'");
        });

        it('unregisterExtension returns false for an unknown id', () => {
            expect(stateEngine.unregisterExtension('ghost')).toBe(false);
            expect(stateEngine.unregisterExtension(undefined)).toBe(false);
        });
    });

    describe('namespace creation and listing', () => {
        it('createNamespace claims a namespace that getNamespaces then lists and validateNamespace accepts', () => {
            expect(stateEngine.getNamespaces()).toEqual(['se']);

            stateEngine.createNamespace('pp', instanceId, 'pp');

            expect(stateEngine.getNamespaces()).toEqual(['se', 'pp']);
            expect(stateEngine.validateNamespace('pp')).toBe(true);
            expect(ownsNamespace('pp', 'pp')).toBe(true);
        });

        it('a created namespace is immediately usable by its owner and closed to everyone else', () => {
            stateEngine.createNamespace('pp', instanceId, 'pp');
            expect(stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Mine' })).toMatchObject({ namespace: 'pp' });
            expect(() => stateEngine.createPreset('se', instanceId, { namespace: 'pp', name: 'Theirs' })).toThrow("Extension 'se' does not own namespace 'pp'");
        });

        it('createNamespace is rejected for a wrong instance and does not claim anything', () => {
            expect(() => stateEngine.createNamespace('pp', 'nope', 'pp')).toThrow('State Engine API call rejected: wrong instance');
            expect(stateEngine.getNamespaces()).toEqual(['se']);
        });

        it('the old namespace-claiming registerExtension(info) form is gone - its name now means metadata registration', () => {
            // Under the new (extensionId, instanceId, metadata) signature an
            // old-style call is an identity failure, never a silent namespace claim.
            expect(() => stateEngine.registerExtension({ namespace: 'pp' })).toThrow();
            expect(stateEngine.getNamespaces()).toEqual(['se']);
        });
    });

    describe('extension registration discovery', () => {
        it('a registered extension is discoverable by other extensions - by map and by id', () => {
            registerNamespaces('pp', 'zz');
            stateEngine.registerExtension('pp', instanceId, { namespace: 'pp', variables: ['pp__mood'], capabilities: ['panels'], description: 'Panels' });

            expect(stateEngine.getRegisteredExtensions().pp).toEqual({ namespace: 'pp', variables: ['pp__mood'], capabilities: ['panels'], dependsOn: [], description: 'Panels' });
            expect(stateEngine.getExtensionRegistration('pp').capabilities).toEqual(['panels']);
            expect(stateEngine.getExtensionRegistration('zz')).toBeNull(); // claimed a namespace, never registered
            expect(stateEngine.getNamespaces()).toEqual(['se', 'pp', 'zz']);
        });

        it('discovery is open but writes are protected: another extension cannot overwrite a registration', () => {
            registerNamespaces('pp', 'zz');
            stateEngine.registerExtension('pp', instanceId, { namespace: 'pp', description: 'mine' });

            expect(() => stateEngine.registerExtension('zz', instanceId, { namespace: 'pp', description: 'hijack' })).toThrow("Extension 'zz' does not own namespace 'pp'");
            expect(stateEngine.getExtensionRegistration('pp').description).toBe('mine');
        });

        it('unregistering an extension removes its registration along with its namespace', () => {
            stateEngine.createNamespace('pp', instanceId, 'pp');
            stateEngine.registerExtension('pp', instanceId, { namespace: 'pp', description: 'x' });

            stateEngine.unregisterExtension('pp');

            expect(stateEngine.getExtensionRegistration('pp')).toBeNull();
            expect(stateEngine.getRegisteredExtensions()).toEqual({});
            expect(stateEngine.getNamespaces()).toEqual(['se']);
        });

        it('a namespace re-created after unregistering starts clean - nothing is inherited', () => {
            stateEngine.createNamespace('pp', instanceId, 'pp');
            stateEngine.registerExtension('pp', instanceId, { namespace: 'pp', description: 'old', capabilities: ['old'] });
            stateEngine.unregisterExtension('pp');

            stateEngine.createNamespace('pp', instanceId, 'pp');
            expect(stateEngine.getExtensionRegistration('pp')).toBeNull();
        });
    });

    describe('capability graph discovery', () => {
        it('an extension discovers who provides what it needs, through the facade alone', () => {
            registerNamespaces('inv', 'panels');
            stateEngine.declareCapabilities('inv', instanceId, ['data.inventory', 'world.location']);
            stateEngine.registerExtension('panels', instanceId, {
                namespace: 'panels',
                capabilities: ['ui.panel'],
                dependsOn: ['data.inventory', 'character.stats'],
            });

            // panels resolving its own dependencies
            const needs = stateEngine.getExtensionDependencies('panels');
            expect(needs).toEqual(['data.inventory', 'character.stats']);
            expect(stateEngine.getExtensionsProviding('data.inventory')).toEqual(['inv']);
            expect(stateEngine.getExtensionsProviding('character.stats')).toEqual([]); // an unmet dependency is visible, not an error

            expect(stateEngine.getCapabilityGraph()).toEqual({
                se: { capabilities: [], dependsOn: [] },
                inv: { capabilities: ['data.inventory', 'world.location'], dependsOn: [] },
                panels: { capabilities: ['ui.panel'], dependsOn: ['data.inventory', 'character.stats'] },
            });
        });

        it('namespace creation is the prerequisite: declaring before createNamespace is rejected, after is allowed', () => {
            expect(() => stateEngine.declareCapabilities('pp', instanceId, ['ui.panel'])).toThrow(/call createNamespace\(\) first/);
            stateEngine.createNamespace('pp', instanceId, 'pp');
            expect(stateEngine.declareCapabilities('pp', instanceId, ['ui.panel'])).toEqual(['ui.panel']);
            expect(stateEngine.getNamespaces()).toContain('pp');
        });

        it('registration metadata and direct declarations are one graph: registering populates it, declaring updates the registration', () => {
            registerNamespaces('pp');
            stateEngine.registerExtension('pp', instanceId, { namespace: 'pp', capabilities: ['a.one'], dependsOn: ['b.two'] });
            stateEngine.declareCapabilities('pp', instanceId, ['a.one', 'a.two']);

            expect(stateEngine.getExtensionRegistration('pp')).toMatchObject({ capabilities: ['a.one', 'a.two'], dependsOn: ['b.two'] });
            expect(stateEngine.getRegisteredExtensions().pp.capabilities).toEqual(stateEngine.getExtensionCapabilities('pp'));
            expect(stateEngine.getCapabilityGraph().pp).toEqual({ capabilities: ['a.one', 'a.two'], dependsOn: ['b.two'] });
        });

        it('graph discovery is open, but declaring stays private to the owner', () => {
            registerNamespaces('pp', 'zz');
            stateEngine.declareCapabilities('pp', instanceId, ['pp.cap']);

            // zz can read pp's capabilities but has no way to write them
            expect(stateEngine.getExtensionCapabilities('pp')).toEqual(['pp.cap']);
            stateEngine.declareCapabilities('zz', instanceId, ['zz.cap']);
            expect(stateEngine.getExtensionCapabilities('pp')).toEqual(['pp.cap']);
        });

        it('unregisterExtension removes the extension from the graph', () => {
            registerNamespaces('pp');
            stateEngine.declareCapabilities('pp', instanceId, ['ui.panel']);
            stateEngine.declareDependencies('pp', instanceId, ['data.inventory']);

            stateEngine.unregisterExtension('pp');

            expect(Object.keys(stateEngine.getCapabilityGraph())).toEqual(['se']);
            expect(stateEngine.getExtensionsProviding('ui.panel')).toEqual([]);
            expect(stateEngine.getExtensionCapabilities('pp')).toEqual([]);
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
