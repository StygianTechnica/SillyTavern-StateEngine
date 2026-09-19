import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import ownsNamespace from '../harness/namespaces.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import { getExtensionsStore } from '../../src/api/namespace-manager.js';

// validateNamespace/ownsNamespace/registerExtension take no caller identity -
// they ARE the registry the identity check reads. Identity is only needed
// where a test creates presets through the guarded API.

describe('namespace-manager', () => {
    describe('validateNamespace', () => {
        it('is true for a registered namespace (the built-in `se` is registered by the harness)', () => {
            expect(stateEngine.validateNamespace('se')).toBe(true);
        });

        it('is true after registerExtension, false before', () => {
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
        it('is true only for the extension that registered the namespace', () => {
            registerNamespaces('pp');
            expect(ownsNamespace('pp', 'pp')).toBe(true);
            expect(ownsNamespace('se', 'pp')).toBe(false);
            expect(ownsNamespace('pp', 'se')).toBe(false);
        });

        it('the built-in extension owns `se`', () => {
            expect(ownsNamespace('se', 'se')).toBe(true);
        });

        it('is false for an unregistered namespace, or missing arguments', () => {
            expect(ownsNamespace('se', 'nope')).toBe(false);
            expect(ownsNamespace(undefined, 'se')).toBe(false);
            expect(ownsNamespace('se', undefined)).toBe(false);
        });

        it('matches on the extension id, which can differ from the namespace', () => {
            stateEngine.registerExtension({ namespace: 'pp', id: 'pretty-panels' });
            expect(ownsNamespace('pretty-panels', 'pp')).toBe(true);
            expect(ownsNamespace('pp', 'pp')).toBe(false);
        });
    });

    describe('registerExtension', () => {
        it('stores id/namespace/name/registeredAt, defaulting id and name to the namespace', () => {
            const record = stateEngine.registerExtension({ namespace: 'pp' });
            expect(record).toMatchObject({ id: 'pp', namespace: 'pp', name: 'pp' });
            expect(typeof record.registeredAt).toBe('number');
        });

        it('keeps caller-supplied metadata', () => {
            const record = stateEngine.registerExtension({ namespace: 'pp', name: 'Pretty Panels', version: '1.2' });
            expect(record).toMatchObject({ name: 'Pretty Panels', version: '1.2' });
        });

        it('persists into settings.extensions', () => {
            stateEngine.registerExtension({ namespace: 'pp' });
            expect(settings.snapshot().extensions.pp.namespace).toBe('pp');
        });

        it('rejects a duplicate namespace and keeps the original record', () => {
            stateEngine.registerExtension({ namespace: 'pp', name: 'First' });
            expect(stateEngine.registerExtension({ namespace: 'pp', name: 'Second' })).toBeNull();
            expect(getExtensionsStore().pp.name).toBe('First');
        });

        it('rejects missing info / missing namespace', () => {
            expect(stateEngine.registerExtension(undefined)).toBeNull();
            expect(stateEngine.registerExtension({ name: 'no namespace' })).toBeNull();
        });

        it('cannot claim the built-in namespace', () => {
            expect(stateEngine.registerExtension({ namespace: 'se' })).toBeNull();
        });
    });

    describe('getRegisteredExtensions / getExtensionsStore', () => {
        it('lists every registered extension including the built-in one', () => {
            registerNamespaces('pp', 'zz');
            expect(stateEngine.getRegisteredExtensions().map((e) => e.namespace).sort()).toEqual(['pp', 'se', 'zz']);
        });

        it('the built-in record carries the lazily-created instanceId only after first use', () => {
            expect(getExtensionsStore().se.instanceId).toBeUndefined();
            const id = ensureInstanceId();
            expect(getExtensionsStore().se.instanceId).toBe(id);
        });
    });

    // Intentionally still empty stubs (not part of any implementation pass) -
    // listed so they show up as pending rather than silently untested.
    it.todo('createNamespace');
    it.todo('getNamespaces');
});
