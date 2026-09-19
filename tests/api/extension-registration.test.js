import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import { getExtensionsStore } from '../../src/api/namespace-manager.js';
import { setVar, seedVariablesForChat, deleteVariableValueEverywhere, applyIncrement } from '../../src/core/chat-state.js';
import { createPreset as createPresetCore, addPresetToChat, renamePreset, deletePreset } from '../../src/core/preset-manager.js';
import { recalculateAllForChat, recalculateDependents, evaluateCalculatedVariable } from '../../src/core/calculated-engine.js';
import { refreshVariableMacros } from '../../src/core/macro-registration.js';
import { dispatchNamespacedEvent } from '../../src/events/event-engine.js';

const WRONG_INSTANCE = 'State Engine API call rejected: wrong instance';
let instanceId;

const meta = (extra = {}) => ({
    namespace: 'pp',
    variables: ['pp__mood', 'pp__energy'],
    capabilities: ['panels', 'themes'],
    dependsOn: [],
    description: 'Pretty Panels',
    ...extra,
});
const register = (metadata, ext = 'pp') => stateEngine.registerExtension(ext, instanceId, metadata);
// The registration as discovery returns it (stored declaration + the live
// capability-graph fields), or undefined if none. Extension id === namespace here.
const stored = (id = 'pp') => stateEngine.getExtensionRegistration(id) ?? undefined;

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
});

describe('extension registration', () => {
    describe('registerExtension - correct identity', () => {
        it('stores the metadata under the extension\'s record and returns it', () => {
            const result = register(meta());
            expect(result).toEqual(meta());
            expect(stored()).toEqual(meta());
        });

        it('keeps the record\'s own fields (id, namespace) intact next to `registration`', () => {
            register(meta());
            expect(getExtensionsStore().pp).toMatchObject({ id: 'pp', namespace: 'pp' });
        });

        it('stores capabilities/dependsOn ONCE, on the record - the registration itself does not duplicate them', () => {
            register(meta({ dependsOn: ['data.inventory'] }));
            const record = getExtensionsStore().pp;

            expect(record.registration).toEqual({ namespace: 'pp', variables: ['pp__mood', 'pp__energy'], description: 'Pretty Panels' });
            expect(record.capabilities).toEqual(['panels', 'themes']);
            expect(record.dependsOn).toEqual(['data.inventory']);
        });

        it('persists to settings', () => {
            context.saveSettingsDebounced.mockClear();
            register(meta());
            expect(context.saveSettingsDebounced).toHaveBeenCalled();
            const persisted = settings.snapshot().extensions.pp;
            expect(persisted.registration).toEqual({ namespace: 'pp', variables: ['pp__mood', 'pp__energy'], description: 'Pretty Panels' });
            expect(persisted.capabilities).toEqual(['panels', 'themes']);
            expect(persisted.dependsOn).toEqual([]);
        });

        it('works when the extension id differs from its namespace', () => {
            stateEngine.createNamespace('prettypanels', instanceId, 'pretty');
            register({ namespace: 'pretty', variables: ['pretty__a'] }, 'prettypanels');
            expect(getExtensionsStore().pretty.registration.variables).toEqual(['pretty__a']);
            expect(stateEngine.getExtensionRegistration('prettypanels').namespace).toBe('pretty');
        });

        it('the built-in extension can register too', () => {
            stateEngine.registerExtension('se', instanceId, { namespace: 'se', variables: ['se__hp'] });
            expect(stateEngine.getExtensionRegistration('se').variables).toEqual(['se__hp']);
        });
    });

    describe('registerExtension - defaults and normalization', () => {
        it('only `namespace` is required; the rest default to empty', () => {
            expect(register({ namespace: 'pp' })).toEqual({ namespace: 'pp', variables: [], capabilities: [], dependsOn: [], description: '' });
        });

        it('de-duplicates variables and capabilities, first occurrence wins', () => {
            register(meta({ variables: ['pp__a', 'pp__b', 'pp__a'], capabilities: ['x', 'y', 'x'] }));
            expect(stored().variables).toEqual(['pp__a', 'pp__b']);
            expect(stored().capabilities).toEqual(['x', 'y']);
        });

        it('stores a copy - mutating the caller\'s object afterwards changes nothing', () => {
            const input = meta();
            register(input);
            input.variables.push('pp__sneaky');
            input.capabilities.length = 0;
            input.description = 'changed';
            expect(stored()).toEqual(meta());
        });

        it('returns a copy - mutating the result changes nothing stored', () => {
            const result = register(meta());
            result.variables.push('pp__sneaky');
            expect(stored().variables).toEqual(['pp__mood', 'pp__energy']);
        });

        it('a declared variable does not need to exist (registration is a declaration)', () => {
            expect(() => register(meta({ variables: ['pp__notCreatedYet'] }))).not.toThrow();
        });
    });

    describe('registerExtension - overwrite', () => {
        it('replaces previous metadata outright rather than merging', () => {
            register(meta());
            register({ namespace: 'pp', variables: ['pp__only'], capabilities: [], description: 'second' });

            expect(stored()).toEqual({ namespace: 'pp', variables: ['pp__only'], capabilities: [], dependsOn: [], description: 'second' });
        });

        it('a registration that omits a field clears it (does not keep the old value)', () => {
            register(meta());
            register({ namespace: 'pp' });
            expect(stored()).toEqual({ namespace: 'pp', variables: [], capabilities: [], dependsOn: [], description: '' });
        });

        it('a rejected re-registration leaves the previous one untouched', () => {
            register(meta());
            expect(() => register(meta({ variables: ['not_qualified'] }))).toThrow();
            expect(stored()).toEqual(meta());
        });
    });

    describe('registerExtension - wrong identity is rejected', () => {
        it.each([
            ['a wrong instanceId', 'nope'],
            ['a missing instanceId', undefined],
            ['a null instanceId', null],
        ])('rejects %s and writes nothing', (_label, bad) => {
            const before = JSON.stringify(settings.snapshot());
            expect(() => stateEngine.registerExtension('pp', bad, meta())).toThrow(WRONG_INSTANCE);
            expect(JSON.stringify(settings.snapshot())).toBe(before);
        });

        it('rejects an extension that does not own metadata.namespace', () => {
            registerNamespaces('zz');
            const before = JSON.stringify(settings.snapshot());
            expect(() => register(meta(), 'zz')).toThrow("Extension 'zz' does not own namespace 'pp'");
            expect(JSON.stringify(settings.snapshot())).toBe(before);
        });

        it('rejects the built-in extension registering into another extension\'s namespace', () => {
            expect(() => register(meta(), 'se')).toThrow("Extension 'se' does not own namespace 'pp'");
        });

        it('rejects an unknown extension id', () => {
            expect(() => register(meta(), 'ghost')).toThrow("Extension 'ghost' does not own namespace 'pp'");
        });

        it('rejects a namespace nobody has claimed', () => {
            expect(() => register(meta({ namespace: 'unclaimed', variables: [] }))).toThrow("Extension 'pp' does not own namespace 'unclaimed'");
        });

        it.each([undefined, null, {}, { namespace: '' }, { variables: [] }])('rejects missing namespace (%j)', (bad) => {
            expect(() => register(bad)).toThrow(/no target namespace supplied/);
            expect(stored()).toBeUndefined();
        });

        it('checks the instance before the ownership of the namespace', () => {
            expect(() => stateEngine.registerExtension('ghost', 'nope', meta())).toThrow(WRONG_INSTANCE);
        });
    });

    describe('registerExtension - metadata validation', () => {
        const rejects = (metadata, pattern) => {
            expect(() => register(metadata)).toThrow(pattern);
            expect(stored()).toBeUndefined();
        };

        describe('variables must be fully qualified', () => {
            it.each([
                ['a bare name', 'mood'],
                ['another namespace\'s variable', 'zz__mood'],
                ['only the prefix', 'pp__'],
                ['a dotted (DSL-breaking) name', 'pp.mood'],
                ['a dotted local part', 'pp__a.b'],
                ['a name with spaces', 'pp__a b'],
                ['a prefix-lookalike', 'ppp__mood'],
                ['an empty string', ''],
            ])('rejects %s', (_label, name) => {
                rejects(meta({ variables: [name] }), /is not fully qualified - expected 'pp__<name>' in namespace 'pp'/);
            });

            it('rejects one bad entry among good ones', () => {
                rejects(meta({ variables: ['pp__ok', 'bad'] }), /variable 'bad' is not fully qualified/);
            });

            it.each([[42], [null], [{}], [['pp__nested']]])('rejects a non-string entry (%j)', (entry) => {
                rejects(meta({ variables: [entry] }), /variables must contain only strings/);
            });

            it.each(['pp__mood', 'not-an-array', 7, {}])('rejects a non-array variables value (%j)', (value) => {
                rejects(meta({ variables: value }), /variables must be an array of strings/);
            });

            it('accepts underscores and digits in the local part', () => {
                expect(() => register(meta({ variables: ['pp__mood_2', 'pp___x', 'pp__A1'] }))).not.toThrow();
            });
        });

        describe('capabilities must be strings', () => {
            it.each([[42], [null], [undefined], [{}], [['x']], [true]])('rejects a non-string capability (%j)', (cap) => {
                rejects(meta({ capabilities: [cap] }), /capabilities must contain only non-empty strings/);
            });

            it('rejects an empty-string capability', () => {
                rejects(meta({ capabilities: [''] }), /capabilities must contain only non-empty strings/);
            });

            it.each(['panels', 7, {}])('rejects a non-array capabilities value (%j)', (value) => {
                rejects(meta({ capabilities: value }), /capabilities must be an array of strings/);
            });
        });

        describe('description and shape', () => {
            it.each([42, {}, [], true])('rejects a non-string description (%j)', (value) => {
                rejects(meta({ description: value }), /description must be a string/);
            });

            it.each([42, 'a string', [], true])('rejects non-object metadata (%j)', (value) => {
                // a non-object has no .namespace to authorize against, so identity rejects it first
                expect(() => register(value)).toThrow();
                expect(stored()).toBeUndefined();
            });

            it('rejects unknown fields instead of silently dropping them', () => {
                rejects(meta({ version: '1.0' }), /unknown metadata field 'version'/);
                rejects(meta({ name: 'Pretty' }), /unknown metadata field 'name'/);
            });

            it('rejects a non-string namespace', () => {
                expect(() => register(meta({ namespace: 42 }))).toThrow();
                expect(stored()).toBeUndefined();
            });
        });

        it('validation failures throw an "Extension registration rejected" Error', () => {
            let caught;
            try { register(meta({ variables: ['bad'] })); } catch (err) { caught = err; }
            expect(caught).toBeInstanceOf(Error);
            expect(caught.message).toMatch(/^Extension registration rejected: /);
        });
    });

    describe('getRegisteredExtensions', () => {
        it('is empty when nobody has registered', () => {
            expect(stateEngine.getRegisteredExtensions()).toEqual({});
        });

        it('maps extensionId -> registration for every registered extension', () => {
            registerNamespaces('zz');
            register(meta());
            register({ namespace: 'zz', capabilities: ['z'] }, 'zz');

            expect(stateEngine.getRegisteredExtensions()).toEqual({
                pp: meta(),
                zz: { namespace: 'zz', variables: [], capabilities: ['z'], dependsOn: [], description: '' },
            });
        });

        it('is keyed by extension id, not namespace', () => {
            stateEngine.createNamespace('prettypanels', instanceId, 'pretty');
            register({ namespace: 'pretty' }, 'prettypanels');
            expect(Object.keys(stateEngine.getRegisteredExtensions())).toEqual(['prettypanels']);
        });

        it('omits an extension that claimed a namespace but never registered', () => {
            registerNamespaces('zz');
            register(meta());
            expect(Object.keys(stateEngine.getRegisteredExtensions())).toEqual(['pp']);
            expect(stateEngine.getNamespaces()).toContain('zz'); // still discoverable as a namespace
        });

        it('needs no identity - discovery is open', () => {
            register(meta());
            expect(stateEngine.getRegisteredExtensions.length).toBe(0);
            expect(() => stateEngine.getRegisteredExtensions()).not.toThrow();
        });

        it('returns copies - mutating the result does not touch the registry', () => {
            register(meta());
            const map = stateEngine.getRegisteredExtensions();
            map.pp.variables.push('pp__sneaky');
            delete map.pp;
            expect(stored()).toEqual(meta());
            expect(Object.keys(stateEngine.getRegisteredExtensions())).toEqual(['pp']);
        });

        it('reflects an overwrite', () => {
            register(meta());
            register({ namespace: 'pp', description: 'v2' });
            expect(stateEngine.getRegisteredExtensions().pp.description).toBe('v2');
        });

        it('drops an extension when it is unregistered', () => {
            register(meta());
            stateEngine.unregisterExtension('pp');
            expect(stateEngine.getRegisteredExtensions()).toEqual({});
        });
    });

    describe('getExtensionRegistration', () => {
        it('returns the registration for a registered extension', () => {
            register(meta());
            expect(stateEngine.getExtensionRegistration('pp')).toEqual(meta());
        });

        it('returns null for an extension that claimed a namespace but has not registered', () => {
            expect(stateEngine.getExtensionRegistration('pp')).toBeNull();
        });

        it.each([['ghost'], [''], [undefined], [null], [42]])('returns null for an unknown/invalid extension id (%j)', (id) => {
            expect(stateEngine.getExtensionRegistration(id)).toBeNull();
        });

        it('looks up by extension id, not by namespace', () => {
            stateEngine.createNamespace('prettypanels', instanceId, 'pretty');
            register({ namespace: 'pretty', description: 'x' }, 'prettypanels');
            expect(stateEngine.getExtensionRegistration('prettypanels').description).toBe('x');
            expect(stateEngine.getExtensionRegistration('pretty')).toBeNull();
        });

        it('returns a copy', () => {
            register(meta());
            stateEngine.getExtensionRegistration('pp').capabilities.push('hacked');
            expect(stored().capabilities).toEqual(['panels', 'themes']);
        });

        it('needs no identity - discovery is open', () => {
            expect(stateEngine.getExtensionRegistration.length).toBe(1);
        });

        it('is gone after the extension is unregistered', () => {
            register(meta());
            stateEngine.unregisterExtension('pp');
            expect(stateEngine.getExtensionRegistration('pp')).toBeNull();
        });
    });

    describe('no side effects beyond settings.extensions[namespace].registration', () => {
        // Give the world some real state first, so "nothing changed" is meaningful.
        beforeEach(() => {
            stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
            stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
            stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', name: 'a', type: 'number', defaultValue: 2 });
            stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', name: 'dbl', type: 'calculated', expression: 'pp__a * 2' });
            stateEngine.registerEventSource('pp', instanceId, { namespace: 'pp', eventName: 'tick' });
            vi.clearAllMocks();
        });

        it('touches nothing in settings except the extension record\'s `registration`', () => {
            const before = settings.snapshot();
            register(meta());
            const after = settings.snapshot();

            // The extension's own record is the only thing allowed to change: registration + capability graph.
            const strip = (s) => {
                const c = JSON.parse(JSON.stringify(s));
                for (const key of ['registration', 'capabilities', 'dependsOn']) delete c.extensions.pp[key];
                return c;
            };
            expect(strip(after)).toEqual(strip(before));
            expect(after.extensions.pp.registration.description).toBe('Pretty Panels');
            expect(after.extensions.pp.capabilities).toEqual(['panels', 'themes']);
        });

        it('does not touch chat-state (no seed, write, increment or delete; stored values unchanged)', () => {
            const snapshot = JSON.stringify(settings.get().variableStore);
            register(meta());

            expect(setVar).not.toHaveBeenCalled();
            expect(seedVariablesForChat).not.toHaveBeenCalled();
            expect(applyIncrement).not.toHaveBeenCalled();
            expect(deleteVariableValueEverywhere).not.toHaveBeenCalled();
            expect(JSON.stringify(settings.get().variableStore)).toBe(snapshot);
            expect(context.variables.local.get('pp__a')).toBe(2);
        });

        it('does not touch presets (no create/rename/delete/bind, definitions unchanged)', () => {
            const presets = JSON.stringify(settings.get().presets);
            const bindings = JSON.stringify(settings.get().chatPresetBindings);
            register(meta());

            for (const spy of [createPresetCore, addPresetToChat, renamePreset, deletePreset]) expect(spy).not.toHaveBeenCalled();
            expect(JSON.stringify(settings.get().presets)).toBe(presets);
            expect(JSON.stringify(settings.get().chatPresetBindings)).toBe(bindings);
        });

        it('does not touch the dependency graph (no recalculation/evaluation, dependencies unchanged)', () => {
            const deps = stateEngine.getDependencies({ namespace: 'pp', presetName: 'Demo', variableName: 'dbl' });
            register(meta({ variables: ['pp__a', 'pp__dbl'] }));

            expect(recalculateAllForChat).not.toHaveBeenCalled();
            expect(recalculateDependents).not.toHaveBeenCalled();
            expect(evaluateCalculatedVariable).not.toHaveBeenCalled();
            expect(stateEngine.getDependencies({ namespace: 'pp', presetName: 'Demo', variableName: 'dbl' })).toEqual(deps);
            expect(stateEngine.getDependents({ namespace: 'pp', variableName: 'a' }).map((d) => d.name)).toEqual(['pp__dbl']);
        });

        it('does not refresh macros', () => {
            register(meta());
            expect(refreshVariableMacros).not.toHaveBeenCalled();
            expect(context.registerMacro).not.toHaveBeenCalled();
            expect(context.unregisterMacro).not.toHaveBeenCalled();
        });

        it('does not fire or register events', () => {
            const before = JSON.stringify(settings.get().eventSources);
            const heard = vi.fn();
            context.eventSource.on('pp.tick', heard);

            register(meta());

            expect(dispatchNamespacedEvent).not.toHaveBeenCalled();
            expect(heard).not.toHaveBeenCalled();
            expect(JSON.stringify(settings.get().eventSources)).toBe(before);
        });

        it('a rejected registration has none of these effects either', () => {
            const before = JSON.stringify(settings.snapshot());
            expect(() => register(meta({ variables: ['bad'] }))).toThrow();
            expect(() => stateEngine.registerExtension('pp', 'nope', meta())).toThrow();

            expect(JSON.stringify(settings.snapshot())).toBe(before);
            expect(dispatchNamespacedEvent).not.toHaveBeenCalled();
            expect(setVar).not.toHaveBeenCalled();
        });
    });
});
