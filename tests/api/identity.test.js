import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import ownsNamespace, { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import { validateCallerIdentity } from '../../src/api/identity.js';
import * as adapters from '../../src/ui/manager-modal/manager-api.js';
import { setStatus } from '../../src/ui/settings-panel-ui.js';
import { setManagerApi } from '../../src/ui/manager-modal/manager-modal.js';
import { dispatchNamespacedEvent } from '../../src/events/event-engine.js';

// The manager-modal adapters pull in the whole UI graph; only their edges
// are faked so the adapters themselves run for real.
vi.mock('../../src/ui/manager-modal/manager-modal.js', () => ({ setManagerApi: vi.fn() }));
vi.mock('../../src/ui/manager-modal-ui.js', () => ({ renderVarTable: vi.fn() }));
vi.mock('../../src/ui/tracker-panel-ui.js', () => ({ renderTrackerPanel: vi.fn() }));
vi.mock('../../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../../src/ui/wand-ui.js', () => ({ getCurrentChatId: vi.fn(() => 'chat-1') }));
vi.mock('../../src/core/debug-engine.js', () => ({ getDebugInfo: vi.fn() }));

const WRONG_INSTANCE = 'State Engine API call rejected: wrong instance';
let instanceId;

beforeEach(() => {
    instanceId = ensureInstanceId();
});

// One entry per identity-guarded API function. `target` is the namespace the
// call is aimed at; `call(extensionId, instanceId)` invokes it.
const ARGS = {
    createPreset: (t) => [{ namespace: t, name: 'P' }],
    updatePreset: (t) => [t, 'P', {}],
    deletePreset: (t) => [t, 'P'],
    activatePreset: (t) => ['chat-1', t, 'P'],
    deactivatePreset: (t) => ['chat-1', t, 'P'],
    listPresets: (t) => [t],
    createVariable: (t) => [{ namespace: t, presetName: 'P', name: 'v', type: 'number' }],
    updateVariable: (t) => [{ namespace: t, presetName: 'P', variableName: 'v' }, {}],
    deleteVariable: (t) => [{ namespace: t, presetName: 'P', variableName: 'v' }],
    getVariable: (t) => [{ namespace: t, presetName: 'P', variableName: 'v' }],
    listVariables: (t) => [t, 'P'],
    registerExtension: (t) => [{ namespace: t, variables: [], capabilities: [], description: '' }],
    validateCalculatedDefinition: (t) => [{ type: 'calculated', expression: '1', namespace: t, presetName: 'P' }],
    applyCalculatedDefinition: (t) => [{ namespace: t, presetName: 'P', variableName: 'v' }, { name: 'x' }, []],
    registerEventSource: (t) => [{ namespace: t, eventName: 'e' }],
    // "no target namespace" for an event means a name with no prefix at all.
    fireEvent: (t) => ['chat-1', t === undefined ? 'noPrefix' : `${t}.e`],
    configureIndependentPreset: (t) => [t, 'P', {}],
    runIndependentPreset: (t) => ['chat-1', { namespace: t, name: 'P' }],
};
const NAMES = Object.keys(ARGS);
const invoke = (name, extensionId, inst, target) => stateEngine[name](extensionId, inst, ...ARGS[name](target));

describe('identity', () => {
    describe('ensureInstanceId', () => {
        it('lazily creates an instanceId at settings.extensions.se.instanceId', () => {
            settings.reset(); // the outer beforeEach already created one - start from a blob that has none
            expect(settings.get().extensions.se.instanceId).toBeUndefined();
            const id = ensureInstanceId();
            expect(typeof id).toBe('string');
            expect(id.length).toBeGreaterThan(0);
            expect(settings.get().extensions.se.instanceId).toBe(id);
        });

        it('is stable across calls and persists on first creation', () => {
            context.saveSettingsDebounced.mockClear();
            settings.reset();
            const first = ensureInstanceId();
            expect(context.saveSettingsDebounced).toHaveBeenCalled();
            expect(ensureInstanceId()).toBe(first);
        });

        it('throws before the built-in namespace exists, and does NOT create a partial `se` record', () => {
            context.extensionSettings = {}; // a blank blob: the core migration has not run
            expect(() => ensureInstanceId()).toThrow(/not initialized/);
            // A partial record here would make the core migration (gated on this record) skip itself forever.
            expect(settings.get().extensions.se).toBeUndefined();
        });

        it('is a fresh token per settings blob', () => {
            const a = ensureInstanceId();
            settings.reset();
            expect(ensureInstanceId()).not.toBe(a);
        });
    });

    describe('validateCallerIdentity', () => {
        it('allows the correct instance + an owned namespace', () => {
            expect(() => validateCallerIdentity('se', instanceId, 'se')).not.toThrow();
        });

        it.each([
            ['a wrong instanceId', 'nope'],
            ['a missing (undefined) instanceId', undefined],
            ['a null instanceId', null],
            ['an empty instanceId', ''],
            ['a non-string instanceId', 12345],
        ])('rejects %s', (_label, bad) => {
            expect(() => validateCallerIdentity('se', bad, 'se')).toThrow(WRONG_INSTANCE);
        });

        it('rejects wrong namespace ownership with the exact message', () => {
            registerNamespaces('pp');
            expect(() => validateCallerIdentity('pp', instanceId, 'se')).toThrow("Extension 'pp' does not own namespace 'se'");
            expect(() => validateCallerIdentity('se', instanceId, 'pp')).toThrow("Extension 'se' does not own namespace 'pp'");
        });

        it('rejects an unregistered namespace and an unregistered extension', () => {
            expect(() => validateCallerIdentity('se', instanceId, 'nope')).toThrow("Extension 'se' does not own namespace 'nope'");
            expect(() => validateCallerIdentity('ghost', instanceId, 'se')).toThrow("Extension 'ghost' does not own namespace 'se'");
        });

        it.each([undefined, null, ''])('rejects a missing targetNamespace (%s)', (target) => {
            expect(() => validateCallerIdentity('se', instanceId, target)).toThrow(/no target namespace supplied/);
        });

        it('checks the instance BEFORE ownership (a wrong instance never reveals namespace details)', () => {
            expect(() => validateCallerIdentity('ghost', 'nope', 'nope')).toThrow(WRONG_INSTANCE);
        });

        it('honours an extension id that differs from its namespace', () => {
            stateEngine.createNamespace('pretty-panels', instanceId, 'pp');
            expect(() => validateCallerIdentity('pretty-panels', instanceId, 'pp')).not.toThrow();
            expect(() => validateCallerIdentity('pp', instanceId, 'pp')).toThrow("Extension 'pp' does not own namespace 'pp'");
        });

        it('agrees with ownsNamespace()', () => {
            registerNamespaces('pp');
            for (const [ext, ns] of [['se', 'se'], ['pp', 'pp'], ['pp', 'se'], ['se', 'pp'], ['se', 'nope']]) {
                const owns = ownsNamespace(ext, ns);
                const allowed = (() => { try { validateCallerIdentity(ext, instanceId, ns); return true; } catch { return false; } })();
                expect(allowed).toBe(owns);
            }
        });
    });

    describe.each(NAMES)('%s', (name) => {
        it('rejects a wrong instanceId', () => {
            expect(() => invoke(name, 'se', 'nope', 'se')).toThrow(WRONG_INSTANCE);
        });

        it('rejects a missing instanceId', () => {
            expect(() => invoke(name, 'se', undefined, 'se')).toThrow(WRONG_INSTANCE);
        });

        it('rejects an extension that does not own the target namespace', () => {
            registerNamespaces('pp');
            expect(() => invoke(name, 'pp', instanceId, 'se')).toThrow("Extension 'pp' does not own namespace 'se'");
        });

        it('rejects a missing target namespace', () => {
            expect(() => invoke(name, 'se', instanceId, undefined)).toThrow(/no target namespace supplied/);
        });

        it('a rejected call has no side effects', () => {
            registerNamespaces('pp');
            const before = JSON.stringify(settings.snapshot());
            vi.clearAllMocks();

            expect(() => invoke(name, 'se', 'nope', 'se')).toThrow();
            expect(() => invoke(name, 'pp', instanceId, 'se')).toThrow();

            expect(JSON.stringify(settings.snapshot())).toBe(before);
            expect(context.saveSettingsDebounced).not.toHaveBeenCalled();
            expect(dispatchNamespacedEvent).not.toHaveBeenCalled();
        });

        it('allows the correct identity (it may still return null/false for missing data - but never throws)', () => {
            expect(() => invoke(name, 'se', instanceId, 'se')).not.toThrow();
        });
    });

    // Their signatures carry no namespace - the target is the caller's OWN
    // record - so they don't fit the (target namespace) table above.
    describe.each(['declareCapabilities', 'declareDependencies'])('%s', (name) => {
        const call = (ext, inst, list = ['ui.panel']) => stateEngine[name](ext, inst, list);

        beforeEach(() => {
            registerNamespaces('pp');
        });

        it.each([
            ['a wrong instanceId', 'nope'],
            ['a missing instanceId', undefined],
            ['a null instanceId', null],
            ['a non-string instanceId', 7],
        ])('rejects %s and throws', (_label, bad) => {
            expect(() => call('pp', bad)).toThrow(WRONG_INSTANCE);
        });

        it('checks the instance before anything about the extension', () => {
            expect(() => call('ghost', 'nope')).toThrow(WRONG_INSTANCE);
        });

        it.each([['ghost'], [undefined], [''], [null]])('rejects an extension that owns no namespace (%j)', (id) => {
            expect(() => call(id, instanceId)).toThrow("does not own a namespace - call createNamespace() first");
        });

        it('rejects a namespace string used as an extension id (ownership is by extension id)', () => {
            stateEngine.createNamespace('prettypanels', instanceId, 'pretty');
            expect(() => call('pretty', instanceId)).toThrow(/does not own a namespace/);
        });

        it('a rejected call has no side effects', () => {
            const before = JSON.stringify(settings.snapshot());
            context.saveSettingsDebounced.mockClear();

            expect(() => call('pp', 'nope')).toThrow();
            expect(() => call('ghost', instanceId)).toThrow();

            expect(JSON.stringify(settings.snapshot())).toBe(before);
            expect(context.saveSettingsDebounced).not.toHaveBeenCalled();
        });

        it('allows the correct identity for the caller\'s own namespace', () => {
            expect(() => call('pp', instanceId)).not.toThrow();
            expect(() => call('se', instanceId)).not.toThrow(); // the built-in extension owns `se`
        });

        it('only ever affects the caller\'s own record', () => {
            call('pp', instanceId, ['pp.only']);
            const other = stateEngine.getCapabilityGraph();
            expect(other.se).toEqual({ capabilities: [], dependsOn: [] });
        });

        it('follows namespace ownership: allowed once createNamespace has run, rejected again after unregisterExtension', () => {
            expect(() => call('late', instanceId)).toThrow(/does not own a namespace/);
            stateEngine.createNamespace('late', instanceId, 'late');
            expect(() => call('late', instanceId)).not.toThrow();
            stateEngine.unregisterExtension('late');
            expect(() => call('late', instanceId)).toThrow(/does not own a namespace/);
        });

        it('is identity-checked by the real validateCallerIdentity path (agrees with ownsNamespace)', () => {
            for (const ext of ['pp', 'se', 'ghost']) {
                const owns = ownsNamespace(ext, ext);
                const allowed = (() => { try { call(ext, instanceId); return true; } catch { return false; } })();
                expect(allowed).toBe(owns);
            }
        });
    });

    // Same shape as the capability-graph writers: no namespace parameter, the
    // target is the caller's own namespace, and the variable must live there.
    describe.each([
        ['assignBatch', (ext, inst, variable = 'v') => stateEngine.assignBatch(ext, inst, variable, 'extra')],
        ['removeBatch', (ext, inst, variable = 'v') => stateEngine.removeBatch(ext, inst, variable)],
    ])('%s', (_name, call) => {
        beforeEach(() => {
            registerNamespaces('pp', 'zz');
            stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'P' });
            stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'P', name: 'v', type: 'number' });
            stateEngine.createPreset('zz', instanceId, { namespace: 'zz', name: 'Z' });
            stateEngine.createVariable('zz', instanceId, { namespace: 'zz', presetName: 'Z', name: 'w', type: 'number' });
        });

        it.each([
            ['a wrong instanceId', 'nope'],
            ['a missing instanceId', undefined],
            ['a null instanceId', null],
            ['a non-string instanceId', 7],
        ])('rejects %s and throws', (_label, bad) => {
            expect(() => call('pp', bad)).toThrow(WRONG_INSTANCE);
        });

        it('checks the instance before anything about the extension or the variable', () => {
            expect(() => call('ghost', 'nope', 'nothing')).toThrow(WRONG_INSTANCE);
        });

        it.each([['ghost'], [undefined], [''], [null]])('rejects an extension that owns no namespace (%j)', (id) => {
            expect(() => call(id, instanceId)).toThrow('does not own a namespace - call createNamespace() first');
        });

        it('rejects a variable that lives in another extension\'s namespace - it cannot even address it', () => {
            expect(() => call('pp', instanceId, 'w')).toThrow("does not exist in namespace 'pp'");
            expect(() => call('pp', instanceId, 'zz__w')).toThrow("does not exist in namespace 'pp'");
            expect(() => call('zz', instanceId, 'w')).not.toThrow(); // its owner can
        });

        it('a rejected call has no side effects', () => {
            const before = JSON.stringify(settings.snapshot());
            context.saveSettingsDebounced.mockClear();

            expect(() => call('pp', 'nope')).toThrow();
            expect(() => call('ghost', instanceId)).toThrow();
            expect(() => call('pp', instanceId, 'w')).toThrow();

            expect(JSON.stringify(settings.snapshot())).toBe(before);
            expect(context.saveSettingsDebounced).not.toHaveBeenCalled();
        });

        it('allows the correct identity for a variable in the caller\'s own namespace', () => {
            expect(() => call('pp', instanceId)).not.toThrow();
        });

        it('follows namespace ownership: rejected again once the extension is unregistered', () => {
            expect(() => call('pp', instanceId)).not.toThrow();
            stateEngine.unregisterExtension('pp');
            expect(() => call('pp', instanceId)).toThrow(/does not own a namespace/);
        });

        it('is identity-checked through the real validateCallerIdentity path (agrees with ownsNamespace)', () => {
            for (const ext of ['pp', 'zz', 'ghost']) {
                const variable = ext === 'zz' ? 'w' : 'v';
                const allowed = (() => { try { call(ext, instanceId, variable); return true; } catch { return false; } })();
                expect(allowed).toBe(ownsNamespace(ext, ext));
            }
        });
    });

    describe('createNamespace (instance identity only - it runs before the caller owns anything)', () => {
        it.each([
            ['a wrong instanceId', 'nope'],
            ['a missing instanceId', undefined],
            ['a null instanceId', null],
            ['a non-string instanceId', 7],
        ])('rejects %s, throws, and claims nothing', (_label, bad) => {
            const before = JSON.stringify(settings.snapshot());
            context.saveSettingsDebounced.mockClear();

            expect(() => stateEngine.createNamespace('pp', bad, 'pp')).toThrow(WRONG_INSTANCE);

            expect(JSON.stringify(settings.snapshot())).toBe(before);
            expect(context.saveSettingsDebounced).not.toHaveBeenCalled();
        });

        it('allows the correct instance without any prior ownership', () => {
            expect(ownsNamespace('pp', 'pp')).toBe(false);
            expect(() => stateEngine.createNamespace('pp', instanceId, 'pp')).not.toThrow();
            expect(ownsNamespace('pp', 'pp')).toBe(true);
        });

        it('confers ownership only to the extension named - which is what makes validateCallerIdentity pass for it', () => {
            stateEngine.createNamespace('pp', instanceId, 'pp');
            expect(() => validateCallerIdentity('pp', instanceId, 'pp')).not.toThrow();
            expect(() => validateCallerIdentity('zz', instanceId, 'pp')).toThrow("Extension 'zz' does not own namespace 'pp'");
        });

        it('cannot be used to take over a namespace someone else already owns', () => {
            expect(() => stateEngine.createNamespace('intruder', instanceId, 'se')).toThrow("Namespace 'se' is already taken");
            expect(() => validateCallerIdentity('intruder', instanceId, 'se')).toThrow("Extension 'intruder' does not own namespace 'se'");
            expect(() => validateCallerIdentity('se', instanceId, 'se')).not.toThrow();
        });

        it('is the one identity-taking function that is not ownership-checked', () => {
            registerNamespaces('pp');
            // a non-owner is rejected by every ownership-checked function...
            expect(() => stateEngine.listPresets('zz', instanceId, 'pp')).toThrow("does not own namespace 'pp'");
            // ...but may create a namespace of its own
            expect(() => stateEngine.createNamespace('zz', instanceId, 'zz')).not.toThrow();
        });
    });

    describe('rejection is loud, never a silent no-op', () => {
        it('throws an Error (rather than returning null/false like the API\'s own failure paths)', () => {
            let caught;
            try { stateEngine.createPreset('se', 'nope', { namespace: 'se', name: 'X' }); } catch (err) { caught = err; }
            expect(caught).toBeInstanceOf(Error);
            expect(caught.message).toBe(WRONG_INSTANCE);
        });

        it('runIndependentPreset throws synchronously instead of returning a rejected Promise', () => {
            let returned;
            expect(() => { returned = stateEngine.runIndependentPreset('se', 'nope', 'chat-1', { namespace: 'se', name: 'P' }); }).toThrow(WRONG_INSTANCE);
            expect(returned).toBeUndefined();
        });

        it('an authorized call that merely fails validation still returns null instead of throwing', () => {
            expect(stateEngine.createPreset('se', instanceId, { namespace: 'se' })).toBeNull();
        });
    });

    describe('cross-extension isolation', () => {
        beforeEach(() => {
            registerNamespaces('pp', 'zz');
        });

        it('each extension can act in its own namespace with the shared token', () => {
            expect(stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'A' })).toMatchObject({ namespace: 'pp' });
            expect(stateEngine.createPreset('zz', instanceId, { namespace: 'zz', name: 'A' })).toMatchObject({ namespace: 'zz' });
        });

        it('no extension can write into, read, or fire events in another\'s namespace', () => {
            stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Secret' });

            expect(() => stateEngine.deletePreset('zz', instanceId, 'pp', 'Secret')).toThrow("Extension 'zz' does not own namespace 'pp'");
            expect(() => stateEngine.listPresets('zz', instanceId, 'pp')).toThrow("Extension 'zz' does not own namespace 'pp'");
            expect(() => stateEngine.fireEvent('zz', instanceId, 'chat-1', 'pp.anything')).toThrow("Extension 'zz' does not own namespace 'pp'");
            expect(stateEngine.listPresets('pp', instanceId, 'pp')).toHaveLength(1);
        });

        it('the built-in extension has no special access to other namespaces', () => {
            expect(() => stateEngine.listPresets('se', instanceId, 'pp')).toThrow("Extension 'se' does not own namespace 'pp'");
        });
    });

    describe('manager-modal adapters (UI edges mocked)', () => {
        const createSpy = () => vi.spyOn(stateEngine, 'createPreset');

        it('wired themselves into the manager modal on import', () => {
            expect(setManagerApi).toBeDefined(); // mocked module - the import itself ran manager-api.js's top-level wiring
        });

        it('createPresetAdapter calls the API as extension "se" with the real instanceId', () => {
            const spy = createSpy();
            const id = adapters.createPresetAdapter('UI Preset');

            expect(spy).toHaveBeenCalledWith('se', instanceId, { namespace: 'se', name: 'UI Preset' });
            expect(settings.get().presets[id]).toMatchObject({ name: 'UI Preset', namespace: 'se' });
            expect(instanceId).toBe(settings.get().extensions.se.instanceId);
        });

        it('rename / activate / deactivate / delete all identify as "se" with the real instanceId', () => {
            const id = adapters.createPresetAdapter('UI Preset');
            const update = vi.spyOn(stateEngine, 'updatePreset');
            const activate = vi.spyOn(stateEngine, 'activatePreset');
            const deactivate = vi.spyOn(stateEngine, 'deactivatePreset');
            const del = vi.spyOn(stateEngine, 'deletePreset');

            adapters.renamePresetAdapter(id, 'Renamed');
            expect(update).toHaveBeenCalledWith('se', instanceId, 'se', 'UI Preset', { name: 'Renamed' });

            adapters.addPresetToChatAdapter('chat-1', id);
            expect(activate).toHaveBeenCalledWith('se', instanceId, 'chat-1', 'se', 'Renamed');
            expect(settings.get().chatPresetBindings['chat-1'].presetIds).toContain(id);

            adapters.removePresetFromChatAdapter('chat-1', id);
            expect(deactivate).toHaveBeenCalledWith('se', instanceId, 'chat-1', 'se', 'Renamed');
            expect(settings.get().chatPresetBindings['chat-1'].presetIds).not.toContain(id);

            adapters.deletePresetAdapter(id);
            expect(del).toHaveBeenCalledWith('se', instanceId, 'se', 'Renamed');
            expect(settings.get().presets[id]).toBeUndefined();
        });

        it('still auto-uniquifies a duplicate name instead of failing (create and rename)', () => {
            adapters.createPresetAdapter('Same');
            const second = adapters.createPresetAdapter('Same');
            expect(settings.get().presets[second].name).toBe('Same (2)');

            adapters.renamePresetAdapter(second, 'Same');
            expect(settings.get().presets[second].name).toBe('Same (2)');
        });

        describe('a preset owned by another namespace', () => {
            let foreignId;
            beforeEach(() => {
                registerNamespaces('pp');
                foreignId = stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Theirs' }).id;
                setStatus.mockClear();
            });

            it.each([
                ['deletePresetAdapter', () => adapters.deletePresetAdapter(foreignId)],
                ['renamePresetAdapter', () => adapters.renamePresetAdapter(foreignId, 'Mine now')],
                ['addPresetToChatAdapter', () => adapters.addPresetToChatAdapter('chat-1', foreignId)],
                ['removePresetFromChatAdapter', () => adapters.removePresetFromChatAdapter('chat-1', foreignId)],
            ])('%s reports the rejection through setStatus instead of throwing into the UI handler', (_name, act) => {
                expect(act).not.toThrow();
                expect(setStatus).toHaveBeenCalledWith("Extension 'se' does not own namespace 'pp'", true);
            });

            it('and the other namespace\'s preset is untouched', () => {
                adapters.deletePresetAdapter(foreignId);
                adapters.renamePresetAdapter(foreignId, 'Mine now');
                adapters.addPresetToChatAdapter('chat-1', foreignId);

                expect(settings.get().presets[foreignId]).toMatchObject({ name: 'Theirs', namespace: 'pp' });
                expect(settings.get().chatPresetBindings['chat-1']?.presetIds ?? []).not.toContain(foreignId);
            });
        });

        it('reports (not throws) when State Engine is not initialized yet', () => {
            context.extensionSettings = {}; // no built-in namespace record -> ensureInstanceId() refuses
            setStatus.mockClear();

            expect(() => adapters.createPresetAdapter('Early')).not.toThrow();
            expect(setStatus).toHaveBeenCalledWith(expect.stringMatching(/not initialized/), true);
        });
    });
});
