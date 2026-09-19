import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import ownsNamespace from '../harness/namespaces.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import { getExtensionsStore, findExtensionRecord } from '../../src/api/namespace-manager.js';

// validateNamespace/ownsNamespace/getNamespaces take no caller identity -
// they ARE the registry the identity check reads. createNamespace takes the
// INSTANCE half of identity only: it runs before the caller owns anything.

const WRONG_INSTANCE = 'State Engine API call rejected: wrong instance';
let instanceId;

beforeEach(() => {
    instanceId = ensureInstanceId();
});

describe('namespace-manager', () => {
    describe('createNamespace', () => {
        it('claims the namespace for the extension and returns its record', () => {
            const record = stateEngine.createNamespace('pp', instanceId, 'pp');
            expect(record).toMatchObject({ id: 'pp', namespace: 'pp', name: 'pp' });
            expect(typeof record.registeredAt).toBe('number');
        });

        it('stores the record keyed by namespace, in the same shape as the built-in `se` record', () => {
            stateEngine.createNamespace('prettypanels', instanceId, 'pp');
            const store = getExtensionsStore();
            expect(store.pp).toMatchObject({ id: 'prettypanels', namespace: 'pp' });
            expect(Object.keys(store.pp).sort()).toEqual(Object.keys(store.se).filter((k) => k !== 'instanceId').sort());
        });

        it('persists to settings', () => {
            context.saveSettingsDebounced.mockClear();
            stateEngine.createNamespace('pp', instanceId, 'pp');
            expect(context.saveSettingsDebounced).toHaveBeenCalled();
            expect(settings.snapshot().extensions.pp.namespace).toBe('pp');
        });

        it('makes the namespace valid, owned by that extension only, and lets it act', () => {
            stateEngine.createNamespace('prettypanels', instanceId, 'pp');
            expect(stateEngine.validateNamespace('pp')).toBe(true);
            expect(ownsNamespace('prettypanels', 'pp')).toBe(true);
            expect(ownsNamespace('pp', 'pp')).toBe(false); // ownership is by extension id, not namespace string
            expect(stateEngine.createPreset('prettypanels', instanceId, { namespace: 'pp', name: 'X' })).toMatchObject({ namespace: 'pp' });
        });

        describe('identity', () => {
            it.each([
                ['a wrong instanceId', 'nope'],
                ['a missing instanceId', undefined],
                ['a null instanceId', null],
                ['a non-string instanceId', 42],
            ])('rejects %s and claims nothing', (_label, bad) => {
                const before = JSON.stringify(settings.snapshot());
                expect(() => stateEngine.createNamespace('pp', bad, 'pp')).toThrow(WRONG_INSTANCE);
                expect(JSON.stringify(settings.snapshot())).toBe(before);
                expect(stateEngine.validateNamespace('pp')).toBe(false);
            });

            it('needs no prior ownership - it is what creates the ownership', () => {
                expect(ownsNamespace('pp', 'pp')).toBe(false);
                expect(() => stateEngine.createNamespace('pp', instanceId, 'pp')).not.toThrow();
            });

            it('checks the instance before anything about the arguments', () => {
                expect(() => stateEngine.createNamespace(undefined, 'nope', '!!')).toThrow(WRONG_INSTANCE);
            });
        });

        describe('uniqueness', () => {
            it('rejects a namespace already taken by a different extension, leaving the owner intact', () => {
                stateEngine.createNamespace('pp', instanceId, 'pp');
                expect(() => stateEngine.createNamespace('intruder', instanceId, 'pp')).toThrow("Namespace 'pp' is already taken");
                expect(getExtensionsStore().pp.id).toBe('pp');
                expect(findExtensionRecord('intruder')).toBeNull();
            });

            it('cannot claim the built-in namespace', () => {
                expect(() => stateEngine.createNamespace('intruder', instanceId, 'se')).toThrow("Namespace 'se' is already taken");
                expect(getExtensionsStore().se.id).toBe('se');
            });

            it('is idempotent for the extension that already owns it (settings persist across page loads)', () => {
                const first = stateEngine.createNamespace('pp', instanceId, 'pp');
                context.saveSettingsDebounced.mockClear();

                const second = stateEngine.createNamespace('pp', instanceId, 'pp');

                expect(second).toEqual(first);
                expect(Object.keys(getExtensionsStore()).filter((k) => k === 'pp')).toHaveLength(1);
                expect(context.saveSettingsDebounced).not.toHaveBeenCalled();
            });

            it('an extension owns at most one namespace', () => {
                stateEngine.createNamespace('pp', instanceId, 'pp');
                expect(() => stateEngine.createNamespace('pp', instanceId, 'pp2')).toThrow("Extension 'pp' already owns namespace 'pp'");
                expect(stateEngine.validateNamespace('pp2')).toBe(false);
            });

            it('two different extensions can each hold their own namespace', () => {
                stateEngine.createNamespace('a', instanceId, 'aa');
                stateEngine.createNamespace('b', instanceId, 'bb');
                expect(stateEngine.getNamespaces().sort()).toEqual(['aa', 'bb', 'se']);
            });
        });

        describe('argument validation', () => {
            it.each([undefined, null, '', 42])('rejects an invalid extensionId (%s)', (bad) => {
                expect(() => stateEngine.createNamespace(bad, instanceId, 'pp')).toThrow(/requires an extensionId/);
            });

            it.each([
                [undefined], [null], [''], [42],
                ['1abc'], ['a_b'], ['a__b'], ['a.b'], ['a b'], ['__proto__'],
            ])('rejects an invalid namespace (%s) - it is a prefix of "ns__name" variables and "ns.event" names', (bad) => {
                expect(() => stateEngine.createNamespace('pp', instanceId, bad)).toThrow(/is invalid/);
                expect(stateEngine.getNamespaces()).toEqual(['se']);
            });

            it('accepts letters and digits after a leading letter', () => {
                expect(() => stateEngine.createNamespace('x', instanceId, 'Pp2')).not.toThrow();
            });
        });
    });

    describe('getNamespaces', () => {
        it('lists the built-in namespace', () => {
            expect(stateEngine.getNamespaces()).toEqual(['se']);
        });

        it('lists every claimed namespace, in claim order', () => {
            registerNamespaces('pp', 'zz');
            expect(stateEngine.getNamespaces()).toEqual(['se', 'pp', 'zz']);
        });

        it('needs no identity - discovery is open', () => {
            expect(() => stateEngine.getNamespaces()).not.toThrow();
            expect(stateEngine.getNamespaces.length).toBe(0);
        });

        it('returns a fresh array - mutating it does not touch the registry', () => {
            stateEngine.getNamespaces().push('hacked');
            expect(stateEngine.getNamespaces()).toEqual(['se']);
        });

        it('drops a namespace when its extension is unregistered', () => {
            registerNamespaces('pp');
            stateEngine.unregisterExtension('pp');
            expect(stateEngine.getNamespaces()).toEqual(['se']);
        });

        it('is consistent with validateNamespace', () => {
            registerNamespaces('pp');
            for (const ns of ['se', 'pp']) expect(stateEngine.validateNamespace(ns)).toBe(true);
            expect(stateEngine.validateNamespace('zz')).toBe(false);
        });
    });

    describe('validateNamespace', () => {
        it('is true for a claimed namespace (the built-in `se` is claimed by the harness)', () => {
            expect(stateEngine.validateNamespace('se')).toBe(true);
        });

        it('is true after createNamespace, false before', () => {
            expect(stateEngine.validateNamespace('pp')).toBe(false);
            registerNamespaces('pp');
            expect(stateEngine.validateNamespace('pp')).toBe(true);
        });

        it('is false for unknown, empty, or missing input', () => {
            expect(stateEngine.validateNamespace('nope')).toBe(false);
            expect(stateEngine.validateNamespace('')).toBe(false);
            expect(stateEngine.validateNamespace(undefined)).toBe(false);
        });
    });

    describe('ownsNamespace', () => {
        it('is true only for the extension that claimed the namespace', () => {
            registerNamespaces('pp');
            expect(ownsNamespace('pp', 'pp')).toBe(true);
            expect(ownsNamespace('se', 'pp')).toBe(false);
            expect(ownsNamespace('pp', 'se')).toBe(false);
        });

        it('the built-in extension owns `se`', () => {
            expect(ownsNamespace('se', 'se')).toBe(true);
        });

        it('is false for an unclaimed namespace, or missing arguments', () => {
            expect(ownsNamespace('se', 'nope')).toBe(false);
            expect(ownsNamespace(undefined, 'se')).toBe(false);
            expect(ownsNamespace('se', undefined)).toBe(false);
        });
    });

    describe('findExtensionRecord', () => {
        it('looks a record up by extension id (records are keyed by namespace)', () => {
            stateEngine.createNamespace('prettypanels', instanceId, 'pp');
            expect(findExtensionRecord('prettypanels').namespace).toBe('pp');
            expect(findExtensionRecord('pp')).toBeNull();
        });

        it.each([undefined, null, '', 7, 'ghost'])('returns null for %s', (bad) => {
            expect(findExtensionRecord(bad)).toBeNull();
        });
    });

    describe('getExtensionsStore', () => {
        it('the built-in record carries the lazily-created instanceId only after first use', () => {
            settings.reset();
            expect(getExtensionsStore().se.instanceId).toBeUndefined();
            const id = ensureInstanceId();
            expect(getExtensionsStore().se.instanceId).toBe(id);
        });
    });
});
