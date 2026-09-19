import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import * as apiIndex from '../../src/api/index.js';
import { getExtensionsStore } from '../../src/api/namespace-manager.js';
import { setVar, seedVariablesForChat, deleteVariableValueEverywhere, applyIncrement } from '../../src/core/chat-state.js';
import { createPreset as createPresetCore, addPresetToChat, renamePreset, deletePreset } from '../../src/core/preset-manager.js';
import { recalculateAllForChat, recalculateDependents, evaluateCalculatedVariable } from '../../src/core/calculated-engine.js';
import { refreshVariableMacros } from '../../src/core/macro-registration.js';
import { dispatchNamespacedEvent } from '../../src/events/event-engine.js';

const WRONG_INSTANCE = 'State Engine API call rejected: wrong instance';
let instanceId;

const declareCaps = (list, ext = 'pp') => stateEngine.declareCapabilities(ext, instanceId, list);
const declareDeps = (list, ext = 'pp') => stateEngine.declareDependencies(ext, instanceId, list);
const register = (metadata, ext = 'pp') => stateEngine.registerExtension(ext, instanceId, metadata);
const record = (namespace = 'pp') => getExtensionsStore()[namespace];

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp', 'zz');
});

describe('capability graph', () => {
    describe('declareCapabilities', () => {
        it('with correct identity, stores the capabilities and returns them', () => {
            expect(declareCaps(['ui.panel', 'data.inventory'])).toEqual(['ui.panel', 'data.inventory']);
            expect(stateEngine.getExtensionCapabilities('pp')).toEqual(['ui.panel', 'data.inventory']);
        });

        it('stores them under the extension\'s own namespace record', () => {
            declareCaps(['ui.panel']);
            expect(record('pp').capabilities).toEqual(['ui.panel']);
            expect(record('zz').capabilities).toBeUndefined();
            expect(record('se').capabilities).toBeUndefined();
        });

        it('resolves the namespace record by extension id when the id differs from the namespace', () => {
            stateEngine.createNamespace('prettypanels', instanceId, 'pretty');
            declareCaps(['ui.panel'], 'prettypanels');
            expect(record('pretty').capabilities).toEqual(['ui.panel']);
            expect(stateEngine.getExtensionCapabilities('prettypanels')).toEqual(['ui.panel']);
            expect(stateEngine.getExtensionCapabilities('pretty')).toEqual([]); // 'pretty' is a namespace, not an extension id
        });

        it('persists to settings', () => {
            context.saveSettingsDebounced.mockClear();
            declareCaps(['ui.panel']);
            expect(context.saveSettingsDebounced).toHaveBeenCalled();
            expect(settings.snapshot().extensions.pp.capabilities).toEqual(['ui.panel']);
        });

        it('REPLACES the previous list (declarations are not merged)', () => {
            declareCaps(['a.one', 'a.two']);
            declareCaps(['b.only']);
            expect(stateEngine.getExtensionCapabilities('pp')).toEqual(['b.only']);
        });

        it('an empty array clears the list', () => {
            declareCaps(['a.one']);
            declareCaps([]);
            expect(stateEngine.getExtensionCapabilities('pp')).toEqual([]);
            expect(stateEngine.getExtensionsProviding('a.one')).toEqual([]);
        });

        it('de-duplicates, first occurrence wins', () => {
            expect(declareCaps(['a.one', 'a.two', 'a.one'])).toEqual(['a.one', 'a.two']);
        });

        it('stores a copy of the input, and returns a copy of what is stored', () => {
            const input = ['a.one'];
            const result = declareCaps(input);
            input.push('sneaky');
            result.push('also.sneaky');
            expect(stateEngine.getExtensionCapabilities('pp')).toEqual(['a.one']);
        });

        it('a capability is any non-empty string - dotted names are convention, not syntax', () => {
            expect(() => declareCaps(['ui.panel', 'data.inventory', 'world.location', 'character.stats', 'plain', 'with space'])).not.toThrow();
        });

        describe('wrong identity is rejected', () => {
            it.each([
                ['a wrong instanceId', 'nope'],
                ['a missing instanceId', undefined],
                ['a null instanceId', null],
                ['a non-string instanceId', 9],
            ])('rejects %s and writes nothing', (_label, bad) => {
                const before = JSON.stringify(settings.snapshot());
                expect(() => stateEngine.declareCapabilities('pp', bad, ['ui.panel'])).toThrow(WRONG_INSTANCE);
                expect(JSON.stringify(settings.snapshot())).toBe(before);
            });

            it('checks the instance BEFORE looking the extension up (a wrong instance never reveals who exists)', () => {
                expect(() => stateEngine.declareCapabilities('ghost', 'nope', ['x'])).toThrow(WRONG_INSTANCE);
                expect(() => stateEngine.declareCapabilities('pp', 'nope', ['x'])).toThrow(WRONG_INSTANCE);
            });
        });

        describe('wrong namespace ownership is rejected', () => {
            // The signature carries no namespace: the target is the caller's OWN record,
            // so "wrong namespace" means the caller owns none.
            it.each([['ghost'], ['pretty'], [''], [undefined], [null], [42]])('rejects an extension id that owns no namespace (%j)', (id) => {
                expect(() => stateEngine.declareCapabilities(id, instanceId, ['x'])).toThrow(/does not own a namespace - call createNamespace\(\) first/);
            });

            it('a namespace string is not an extension id', () => {
                stateEngine.createNamespace('prettypanels', instanceId, 'pretty');
                expect(() => stateEngine.declareCapabilities('pretty', instanceId, ['x'])).toThrow(/does not own a namespace/);
            });

            it('an extension can only ever write its own record - declaring as zz leaves pp untouched', () => {
                declareCaps(['pp.thing']);
                declareCaps(['zz.thing'], 'zz');
                expect(stateEngine.getExtensionCapabilities('pp')).toEqual(['pp.thing']);
                expect(stateEngine.getExtensionCapabilities('zz')).toEqual(['zz.thing']);
            });

            it('rejects after an extension is unregistered (its namespace, and so its ownership, is gone)', () => {
                stateEngine.unregisterExtension('pp');
                expect(() => declareCaps(['x'])).toThrow(/does not own a namespace/);
            });

            it('writes nothing when rejected', () => {
                const before = JSON.stringify(settings.snapshot());
                expect(() => stateEngine.declareCapabilities('ghost', instanceId, ['x'])).toThrow();
                expect(JSON.stringify(settings.snapshot())).toBe(before);
            });
        });

        describe('capabilities must be strings', () => {
            it.each([
                ['a string', 'ui.panel'], ['an object', { a: 1 }], ['null', null], ['undefined', undefined], ['a number', 5],
            ])('rejects a non-array (%s)', (_label, value) => {
                expect(() => declareCaps(value)).toThrow('Capability declaration rejected: capabilities must be an array of strings');
            });

            it.each([
                ['a number', 42], ['null', null], ['undefined', undefined], ['an object', {}], ['an array', ['nested']], ['a boolean', true],
            ])('rejects a non-string entry (%s)', (_label, entry) => {
                expect(() => declareCaps(['ok.cap', entry])).toThrow('Capability declaration rejected: capabilities must contain only non-empty strings');
            });

            it('rejects an empty-string entry', () => {
                expect(() => declareCaps([''])).toThrow('capabilities must contain only non-empty strings');
            });

            it('a rejected declaration leaves the previous list untouched', () => {
                declareCaps(['keep.me']);
                expect(() => declareCaps(['ok', 42])).toThrow();
                expect(stateEngine.getExtensionCapabilities('pp')).toEqual(['keep.me']);
            });

            it('throws an Error rather than returning null/false', () => {
                let caught;
                try { declareCaps('nope'); } catch (err) { caught = err; }
                expect(caught).toBeInstanceOf(Error);
            });
        });
    });

    describe('declareDependencies', () => {
        it('with correct identity, stores the dependencies and returns them', () => {
            expect(declareDeps(['data.inventory', 'world.location'])).toEqual(['data.inventory', 'world.location']);
            expect(stateEngine.getExtensionDependencies('pp')).toEqual(['data.inventory', 'world.location']);
        });

        it('stores them under the extension\'s own namespace record as `dependsOn`', () => {
            declareDeps(['data.inventory']);
            expect(record('pp').dependsOn).toEqual(['data.inventory']);
            expect(record('zz').dependsOn).toBeUndefined();
        });

        it('persists to settings', () => {
            context.saveSettingsDebounced.mockClear();
            declareDeps(['data.inventory']);
            expect(context.saveSettingsDebounced).toHaveBeenCalled();
            expect(settings.snapshot().extensions.pp.dependsOn).toEqual(['data.inventory']);
        });

        it('replaces rather than merges, an empty array clears, duplicates collapse', () => {
            declareDeps(['a.one', 'a.two', 'a.one']);
            expect(stateEngine.getExtensionDependencies('pp')).toEqual(['a.one', 'a.two']);
            declareDeps(['b.only']);
            expect(stateEngine.getExtensionDependencies('pp')).toEqual(['b.only']);
            declareDeps([]);
            expect(stateEngine.getExtensionDependencies('pp')).toEqual([]);
        });

        it('does not require any provider to exist - an unmet dependency is legitimate', () => {
            expect(() => declareDeps(['nobody.provides.this'])).not.toThrow();
            expect(stateEngine.getExtensionsProviding('nobody.provides.this')).toEqual([]);
        });

        it('is independent of capabilities - declaring one never touches the other', () => {
            declareCaps(['provides.x']);
            declareDeps(['needs.y']);
            declareDeps([]);
            expect(stateEngine.getExtensionCapabilities('pp')).toEqual(['provides.x']);
            declareCaps([]);
            declareDeps(['needs.z']);
            expect(stateEngine.getExtensionDependencies('pp')).toEqual(['needs.z']);
        });

        it('stores a copy and returns a copy', () => {
            const input = ['a.one'];
            const result = declareDeps(input);
            input.push('sneaky');
            result.push('also.sneaky');
            expect(stateEngine.getExtensionDependencies('pp')).toEqual(['a.one']);
        });

        describe('wrong identity is rejected', () => {
            it.each([['a wrong instanceId', 'nope'], ['a missing instanceId', undefined], ['a null instanceId', null]])('rejects %s and writes nothing', (_label, bad) => {
                const before = JSON.stringify(settings.snapshot());
                expect(() => stateEngine.declareDependencies('pp', bad, ['x'])).toThrow(WRONG_INSTANCE);
                expect(JSON.stringify(settings.snapshot())).toBe(before);
            });
        });

        describe('wrong namespace ownership is rejected', () => {
            it.each([['ghost'], [''], [undefined], [42]])('rejects an extension id that owns no namespace (%j)', (id) => {
                expect(() => stateEngine.declareDependencies(id, instanceId, ['x'])).toThrow(/does not own a namespace - call createNamespace\(\) first/);
            });

            it('an extension can only write its own dependsOn', () => {
                declareDeps(['pp.needs']);
                declareDeps(['zz.needs'], 'zz');
                expect(stateEngine.getExtensionDependencies('pp')).toEqual(['pp.needs']);
                expect(stateEngine.getExtensionDependencies('zz')).toEqual(['zz.needs']);
            });
        });

        describe('dependencies must be strings', () => {
            it.each([['a string', 'x'], ['an object', {}], ['null', null], ['undefined', undefined]])('rejects a non-array (%s)', (_label, value) => {
                expect(() => declareDeps(value)).toThrow('Capability declaration rejected: dependencies must be an array of strings');
            });

            it.each([[42], [null], [undefined], [{}], [['nested']], [false]])('rejects a non-string entry (%j)', (entry) => {
                expect(() => declareDeps(['ok', entry])).toThrow('dependencies must contain only non-empty strings');
            });

            it('rejects an empty-string entry', () => {
                expect(() => declareDeps([''])).toThrow('dependencies must contain only non-empty strings');
            });

            it('a rejected declaration leaves the previous list untouched', () => {
                declareDeps(['keep.me']);
                expect(() => declareDeps([7])).toThrow();
                expect(stateEngine.getExtensionDependencies('pp')).toEqual(['keep.me']);
            });
        });
    });

    describe('discovery', () => {
        describe('getExtensionsProviding', () => {
            it('returns the ids of every extension that provides the capability, in claim order', () => {
                declareCaps(['ui.panel', 'data.inventory']);
                declareCaps(['ui.panel'], 'zz');
                expect(stateEngine.getExtensionsProviding('ui.panel')).toEqual(['pp', 'zz']);
                expect(stateEngine.getExtensionsProviding('data.inventory')).toEqual(['pp']);
            });

            it('returns [] for a capability nobody provides', () => {
                declareCaps(['ui.panel']);
                expect(stateEngine.getExtensionsProviding('world.location')).toEqual([]);
            });

            it('matches exactly - not by prefix or substring', () => {
                declareCaps(['ui.panel']);
                expect(stateEngine.getExtensionsProviding('ui')).toEqual([]);
                expect(stateEngine.getExtensionsProviding('ui.pane')).toEqual([]);
                expect(stateEngine.getExtensionsProviding('UI.PANEL')).toEqual([]);
            });

            it('does not confuse providing with depending', () => {
                declareDeps(['ui.panel']);
                expect(stateEngine.getExtensionsProviding('ui.panel')).toEqual([]);
            });

            it.each([[undefined], [null], [''], [42], [{}], [['ui.panel']]])('returns [] for an invalid capability argument (%j)', (bad) => {
                declareCaps(['ui.panel']);
                expect(stateEngine.getExtensionsProviding(bad)).toEqual([]);
            });

            it('follows replacement, clearing and unregistering', () => {
                declareCaps(['ui.panel']);
                declareCaps(['data.inventory']);
                expect(stateEngine.getExtensionsProviding('ui.panel')).toEqual([]);

                declareCaps(['ui.panel'], 'zz');
                stateEngine.unregisterExtension('zz');
                expect(stateEngine.getExtensionsProviding('ui.panel')).toEqual([]);
            });

            it('needs no identity and returns a fresh array', () => {
                declareCaps(['ui.panel']);
                expect(stateEngine.getExtensionsProviding.length).toBe(1);
                stateEngine.getExtensionsProviding('ui.panel').push('hacked');
                expect(stateEngine.getExtensionsProviding('ui.panel')).toEqual(['pp']);
            });

            it('can resolve another extension\'s dependency to its providers (the "relationship" between extensions)', () => {
                declareCaps(['data.inventory']);
                declareDeps(['data.inventory', 'world.location'], 'zz');

                const resolved = Object.fromEntries(
                    stateEngine.getExtensionDependencies('zz').map((cap) => [cap, stateEngine.getExtensionsProviding(cap)]),
                );
                expect(resolved).toEqual({ 'data.inventory': ['pp'], 'world.location': [] });
            });
        });

        describe('getCapabilityGraph', () => {
            it('returns the full graph: every extension id -> { capabilities, dependsOn }', () => {
                declareCaps(['ui.panel', 'data.inventory']);
                declareDeps(['world.location']);
                declareCaps(['world.location'], 'zz');

                expect(stateEngine.getCapabilityGraph()).toEqual({
                    se: { capabilities: [], dependsOn: [] },
                    pp: { capabilities: ['ui.panel', 'data.inventory'], dependsOn: ['world.location'] },
                    zz: { capabilities: ['world.location'], dependsOn: [] },
                });
            });

            it('includes an extension that has declared nothing, with empty lists', () => {
                expect(stateEngine.getCapabilityGraph().pp).toEqual({ capabilities: [], dependsOn: [] });
            });

            it('is keyed by extension id, not namespace', () => {
                stateEngine.createNamespace('prettypanels', instanceId, 'pretty');
                declareCaps(['ui.panel'], 'prettypanels');
                const graph = stateEngine.getCapabilityGraph();
                expect(graph.prettypanels.capabilities).toEqual(['ui.panel']);
                expect(graph.pretty).toBeUndefined();
            });

            it('needs no identity', () => {
                expect(stateEngine.getCapabilityGraph.length).toBe(0);
                expect(() => stateEngine.getCapabilityGraph()).not.toThrow();
            });

            it('returns copies - mutating the result never touches the registry', () => {
                declareCaps(['ui.panel']);
                const graph = stateEngine.getCapabilityGraph();
                graph.pp.capabilities.push('hacked');
                graph.pp.dependsOn.push('hacked');
                delete graph.zz;
                expect(stateEngine.getCapabilityGraph().pp).toEqual({ capabilities: ['ui.panel'], dependsOn: [] });
                expect(Object.keys(stateEngine.getCapabilityGraph())).toContain('zz');
            });

            it('drops an extension when it is unregistered', () => {
                declareCaps(['ui.panel']);
                stateEngine.unregisterExtension('pp');
                expect(Object.keys(stateEngine.getCapabilityGraph())).toEqual(['se', 'zz']);
            });
        });

        describe('getExtensionCapabilities / getExtensionDependencies', () => {
            it('return the declared lists', () => {
                declareCaps(['a.one']);
                declareDeps(['b.two']);
                expect(stateEngine.getExtensionCapabilities('pp')).toEqual(['a.one']);
                expect(stateEngine.getExtensionDependencies('pp')).toEqual(['b.two']);
            });

            it('return [] for an extension that declared nothing, is unknown, or is an invalid id', () => {
                for (const id of ['pp', 'ghost', '', undefined, null, 42]) {
                    expect(stateEngine.getExtensionCapabilities(id)).toEqual([]);
                    expect(stateEngine.getExtensionDependencies(id)).toEqual([]);
                }
            });

            it('return copies and need no identity', () => {
                declareCaps(['a.one']);
                declareDeps(['b.two']);
                stateEngine.getExtensionCapabilities('pp').push('hacked');
                stateEngine.getExtensionDependencies('pp').push('hacked');
                expect(stateEngine.getExtensionCapabilities('pp')).toEqual(['a.one']);
                expect(stateEngine.getExtensionDependencies('pp')).toEqual(['b.two']);
                expect(stateEngine.getExtensionCapabilities.length).toBe(1);
                expect(stateEngine.getExtensionDependencies.length).toBe(1);
            });
        });
    });

    describe('integration with extension registration', () => {
        const meta = (extra = {}) => ({
            namespace: 'pp',
            variables: ['pp__mood'],
            capabilities: ['ui.panel', 'data.inventory'],
            dependsOn: ['world.location'],
            description: 'Pretty Panels',
            ...extra,
        });

        it('registerExtension(metadata) auto-populates capabilities and dependencies', () => {
            register(meta());

            expect(stateEngine.getExtensionCapabilities('pp')).toEqual(['ui.panel', 'data.inventory']);
            expect(stateEngine.getExtensionDependencies('pp')).toEqual(['world.location']);
            expect(record('pp').capabilities).toEqual(['ui.panel', 'data.inventory']);
            expect(record('pp').dependsOn).toEqual(['world.location']);
        });

        it('the capability graph reflects the registration metadata', () => {
            register(meta());
            declareCaps(['world.location'], 'zz');

            expect(stateEngine.getCapabilityGraph().pp).toEqual({ capabilities: ['ui.panel', 'data.inventory'], dependsOn: ['world.location'] });
            expect(stateEngine.getExtensionsProviding('ui.panel')).toEqual(['pp']);

            const registration = stateEngine.getExtensionRegistration('pp');
            expect(registration.capabilities).toEqual(stateEngine.getExtensionCapabilities('pp'));
            expect(registration.dependsOn).toEqual(stateEngine.getExtensionDependencies('pp'));
        });

        it('the registration schema now includes dependsOn (the documented four fields + dependsOn)', () => {
            expect(register(meta())).toEqual(meta());
            expect(register({ namespace: 'pp' })).toEqual({ namespace: 'pp', variables: [], capabilities: [], dependsOn: [], description: '' });
        });

        it('stores capabilities/dependsOn once - the registration does not carry a second copy that could drift', () => {
            register(meta());
            expect(record('pp').registration).toEqual({ namespace: 'pp', variables: ['pp__mood'], description: 'Pretty Panels' });
        });

        it('a later declareCapabilities/declareDependencies shows up in the registration too (single source of truth)', () => {
            register(meta());
            declareCaps(['only.this']);
            declareDeps([]);

            expect(stateEngine.getExtensionRegistration('pp').capabilities).toEqual(['only.this']);
            expect(stateEngine.getExtensionRegistration('pp').dependsOn).toEqual([]);
            expect(stateEngine.getRegisteredExtensions().pp.capabilities).toEqual(['only.this']);
        });

        describe('re-registering overwrites previous metadata cleanly', () => {
            it('replaces both lists with the new ones', () => {
                register(meta());
                register(meta({ capabilities: ['ui.theme'], dependsOn: ['character.stats'] }));

                expect(stateEngine.getCapabilityGraph().pp).toEqual({ capabilities: ['ui.theme'], dependsOn: ['character.stats'] });
            });

            it('a capability dropped by the new registration is no longer provided by anyone', () => {
                register(meta());
                register(meta({ capabilities: ['ui.theme'] }));
                expect(stateEngine.getExtensionsProviding('ui.panel')).toEqual([]);
                expect(stateEngine.getExtensionsProviding('ui.theme')).toEqual(['pp']);
            });

            it('omitting capabilities/dependsOn CLEARS them - a registration is the whole declaration', () => {
                register(meta());
                register({ namespace: 'pp', variables: ['pp__mood'] });

                expect(stateEngine.getCapabilityGraph().pp).toEqual({ capabilities: [], dependsOn: [] });
            });

            it('that includes capabilities declared directly beforehand', () => {
                declareCaps(['declared.directly']);
                declareDeps(['needed.directly']);
                register({ namespace: 'pp' });

                expect(stateEngine.getCapabilityGraph().pp).toEqual({ capabilities: [], dependsOn: [] });
            });

            it('does not disturb another extension\'s graph entry', () => {
                declareCaps(['zz.cap'], 'zz');
                register(meta());
                register(meta({ capabilities: [] }));
                expect(stateEngine.getExtensionCapabilities('zz')).toEqual(['zz.cap']);
            });
        });

        describe('validation and atomicity', () => {
            it('a rejected registration leaves the capability graph exactly as it was', () => {
                register(meta());
                const before = JSON.stringify(stateEngine.getCapabilityGraph());
                const snapshot = JSON.stringify(settings.snapshot());

                expect(() => register(meta({ dependsOn: [42] }))).toThrow();
                expect(() => register(meta({ capabilities: ['ok', ''] }))).toThrow();
                expect(() => register(meta({ variables: ['not_qualified'] }))).toThrow();
                expect(() => register(meta({ unknownField: 1 }))).toThrow();

                expect(JSON.stringify(stateEngine.getCapabilityGraph())).toBe(before);
                expect(JSON.stringify(settings.snapshot())).toBe(snapshot);
            });

            it('an invalid dependsOn is rejected with the metadata.dependsOn label', () => {
                expect(() => register(meta({ dependsOn: 'ui.panel' }))).toThrow('Extension registration rejected: metadata.dependsOn must be an array of strings');
                expect(() => register(meta({ dependsOn: [null] }))).toThrow('metadata.dependsOn must contain only non-empty strings');
            });

            it('still rejects unknown fields - and now names dependsOn among the allowed ones', () => {
                expect(() => register(meta({ requires: ['x'] }))).toThrow(/unknown metadata field 'requires' \(allowed: .*dependsOn.*\)/);
                expect(() => register(meta({ provides: ['x'] }))).toThrow(/unknown metadata field 'provides'/);
            });

            it('registration and declareCapabilities apply the same rule to capabilities', () => {
                for (const bad of ['str', [1], [''], [null]]) {
                    let fromDeclare; let fromRegister;
                    try { declareCaps(bad); } catch (err) { fromDeclare = err.message.replace(/^Capability declaration rejected: /, '').replace(/^capabilities/, ''); }
                    try { register(meta({ capabilities: bad })); } catch (err) { fromRegister = err.message.replace(/^Extension registration rejected: /, '').replace(/^metadata\.capabilities/, ''); }
                    expect(fromDeclare).toBeDefined();
                    expect(fromRegister).toBe(fromDeclare);
                }
            });

            it('registration identity is still enforced before the graph is touched', () => {
                declareCaps(['keep.me']);
                expect(() => stateEngine.registerExtension('pp', 'nope', meta())).toThrow(WRONG_INSTANCE);
                expect(() => stateEngine.registerExtension('zz', instanceId, meta())).toThrow("Extension 'zz' does not own namespace 'pp'");
                expect(stateEngine.getExtensionCapabilities('pp')).toEqual(['keep.me']);
            });
        });

        it('an extension that only declared (never registered) is in the graph but not in getRegisteredExtensions', () => {
            declareCaps(['ui.panel']);
            expect(stateEngine.getCapabilityGraph().pp.capabilities).toEqual(['ui.panel']);
            expect(stateEngine.getRegisteredExtensions()).toEqual({});
            expect(stateEngine.getExtensionRegistration('pp')).toBeNull();
        });

        it('unregistering removes the registration AND the graph entry; a re-created namespace starts empty', () => {
            register(meta());
            stateEngine.unregisterExtension('pp');
            expect(stateEngine.getExtensionsProviding('ui.panel')).toEqual([]);

            stateEngine.createNamespace('pp', instanceId, 'pp');
            expect(stateEngine.getCapabilityGraph().pp).toEqual({ capabilities: [], dependsOn: [] });
            expect(stateEngine.getExtensionRegistration('pp')).toBeNull();
        });
    });

    describe('surface', () => {
        it('the shared validation helper is internal - not on the facade or the index', () => {
            expect(stateEngine.normalizeStringList).toBeUndefined();
            expect(apiIndex.normalizeStringList).toBeUndefined();
        });
    });

    describe('no side effects beyond the extension record\'s capabilities / dependsOn', () => {
        // Give the world real state first, so "nothing changed" is meaningful.
        beforeEach(() => {
            stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
            stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
            stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', name: 'a', type: 'number', defaultValue: 2 });
            stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', name: 'dbl', type: 'calculated', expression: 'pp__a * 2' });
            stateEngine.registerEventSource('pp', instanceId, { namespace: 'pp', eventName: 'tick' });
            vi.clearAllMocks();
        });

        const declareEverything = () => {
            declareCaps(['ui.panel', 'data.inventory']);
            declareDeps(['world.location']);
            register({ namespace: 'pp', capabilities: ['ui.panel'], dependsOn: ['world.location'] });
        };

        it('touches nothing in settings except the extension record\'s own graph and registration fields', () => {
            const before = settings.snapshot();
            declareEverything();
            const after = settings.snapshot();

            const strip = (s) => {
                const c = JSON.parse(JSON.stringify(s));
                for (const key of ['registration', 'capabilities', 'dependsOn']) delete c.extensions.pp[key];
                return c;
            };
            expect(strip(after)).toEqual(strip(before));
        });

        it('does not touch chat-state', () => {
            const store = JSON.stringify(settings.get().variableStore);
            declareEverything();

            expect(setVar).not.toHaveBeenCalled();
            expect(seedVariablesForChat).not.toHaveBeenCalled();
            expect(applyIncrement).not.toHaveBeenCalled();
            expect(deleteVariableValueEverywhere).not.toHaveBeenCalled();
            expect(JSON.stringify(settings.get().variableStore)).toBe(store);
            expect(context.variables.local.get('pp__a')).toBe(2);
        });

        it('does not touch presets', () => {
            const presets = JSON.stringify(settings.get().presets);
            const bindings = JSON.stringify(settings.get().chatPresetBindings);
            declareEverything();

            for (const spy of [createPresetCore, addPresetToChat, renamePreset, deletePreset]) expect(spy).not.toHaveBeenCalled();
            expect(JSON.stringify(settings.get().presets)).toBe(presets);
            expect(JSON.stringify(settings.get().chatPresetBindings)).toBe(bindings);
        });

        it('does not touch the variable dependency graph (capability dependencies are a separate, string-only layer)', () => {
            const deps = stateEngine.getDependencies({ namespace: 'pp', presetName: 'Demo', variableName: 'dbl' });
            declareEverything();

            expect(recalculateAllForChat).not.toHaveBeenCalled();
            expect(recalculateDependents).not.toHaveBeenCalled();
            expect(evaluateCalculatedVariable).not.toHaveBeenCalled();
            expect(stateEngine.getDependencies({ namespace: 'pp', presetName: 'Demo', variableName: 'dbl' })).toEqual(deps);
            expect(stateEngine.getDependents({ namespace: 'pp', variableName: 'a' }).map((d) => d.name)).toEqual(['pp__dbl']);
        });

        it('does not refresh macros', () => {
            declareEverything();
            expect(refreshVariableMacros).not.toHaveBeenCalled();
            expect(context.registerMacro).not.toHaveBeenCalled();
            expect(context.unregisterMacro).not.toHaveBeenCalled();
        });

        it('does not fire or register events', () => {
            const before = JSON.stringify(settings.get().eventSources);
            const heard = vi.fn();
            context.eventSource.on('pp.tick', heard);

            declareEverything();

            expect(dispatchNamespacedEvent).not.toHaveBeenCalled();
            expect(heard).not.toHaveBeenCalled();
            expect(JSON.stringify(settings.get().eventSources)).toBe(before);
        });

        it('rejected calls have none of these effects either', () => {
            const snapshot = JSON.stringify(settings.snapshot());
            expect(() => declareCaps([1])).toThrow();
            expect(() => declareDeps('x')).toThrow();
            expect(() => stateEngine.declareCapabilities('pp', 'nope', ['x'])).toThrow();
            expect(() => stateEngine.declareDependencies('ghost', instanceId, ['x'])).toThrow();

            expect(JSON.stringify(settings.snapshot())).toBe(snapshot);
            expect(dispatchNamespacedEvent).not.toHaveBeenCalled();
            expect(setVar).not.toHaveBeenCalled();
        });
    });
});
