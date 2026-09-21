import { describe, it, expect, beforeEach, vi } from 'vitest';
import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import * as apiIndex from '../../src/api/index.js';
import { getSettings, migrateAllSettings } from '../../src/core/settings-core.js';
import { subscribeToNotifications, resetNotificationRuntimeForTests } from '../../src/core/notification-core.js';

const WRONG_INSTANCE = 'State Engine API call rejected: wrong instance';
let instanceId;

const noop = () => {};
const register = (id = 'open', fn = noop, ext = 'pp') => stateEngine.registerNotificationCallback(ext, instanceId, id, fn);
const notify = (n, ext = 'pp') => stateEngine.notify(ext, instanceId, n);
const clear = (id, ext = 'pp') => stateEngine.clearNotification(ext, instanceId, id);

beforeEach(() => {
    resetNotificationRuntimeForTests();
    instanceId = ensureInstanceId();
    registerNamespaces('pp', 'zz');
});

describe('surface', () => {
    it('the four requested functions (plus callback registration) are on the API and its exports', () => {
        for (const name of ['notify', 'clearNotification', 'getNotifications', 'invokeNotificationCallback', 'registerNotificationCallback', 'unregisterNotificationCallback']) {
            expect(typeof stateEngine[name], name).toBe('function');
            expect(typeof apiIndex[name], name).toBe('function');
        }
    });

    it('settings start with an empty notifications list', () => {
        expect(getSettings().notifications).toEqual([]);
        expect(stateEngine.getNotifications()).toEqual([]);
    });
});

describe('identity', () => {
    it('every write rejects a wrong instance id and changes nothing', () => {
        register();
        expect(() => stateEngine.notify('pp', 'nope', { message: 'x' })).toThrow(WRONG_INSTANCE);
        expect(() => stateEngine.clearNotification('pp', 'nope', 'pp::a')).toThrow(WRONG_INSTANCE);
        expect(() => stateEngine.registerNotificationCallback('pp', 'nope', 'c', noop)).toThrow(WRONG_INSTANCE);
        expect(() => stateEngine.unregisterNotificationCallback('pp', 'nope', 'c')).toThrow(WRONG_INSTANCE);
        expect(stateEngine.getNotifications()).toEqual([]);
    });

    it('an extension that owns no namespace is rejected', () => {
        expect(() => stateEngine.notify('stranger', instanceId, { message: 'x' })).toThrow(/does not own a namespace/);
        expect(() => stateEngine.registerNotificationCallback('stranger', instanceId, 'c', noop)).toThrow(/does not own a namespace/);
    });

    it('the source is the caller\'s namespace, whatever it claims', () => {
        const id = notify({ message: 'hello' });
        expect(stateEngine.getNotifications()[0].source).toBe('pp');
        expect(id.startsWith('pp::')).toBe(true);
        expect(() => notify({ message: 'x', source: 'zz' })).toThrow(/unknown field 'source'/);
    });

    it('a callback registered by one extension is not usable by another', () => {
        register('open', noop, 'pp');
        expect(() => notify({ message: 'x', callbackId: 'open' }, 'zz')).toThrow(/has not been registered/);
    });

    it('an extension cannot clear another extension\'s notification', () => {
        const id = notify({ message: 'mine' }, 'pp');
        expect(() => clear(id, 'zz')).toThrow(/belongs to 'pp'/);
        expect(stateEngine.getNotifications()).toHaveLength(1);
        expect(clear(id, 'pp')).toBe(true);
    });
});

describe('notify', () => {
    it('stores id, source, severity, message, timestamp and callbackId', () => {
        register('open');
        const before = Date.now();
        const id = notify({ message: '  Pick a target  ', severity: 'warning', callbackId: 'open', id: 'target' });
        expect(id).toBe('pp::target');
        const [n] = stateEngine.getNotifications();
        expect(n).toEqual({ id: 'pp::target', source: 'pp', severity: 'warning', message: 'Pick a target', timestamp: n.timestamp, callbackId: 'open' });
        expect(n.timestamp).toBeGreaterThanOrEqual(before);
    });

    it('defaults: severity "info", no callback, a generated id', () => {
        const id = notify({ message: 'plain' });
        const [n] = stateEngine.getNotifications();
        expect(n.severity).toBe('info');
        expect(n.callbackId).toBe(null);
        expect(n.id).toBe(id);
        expect(id).toMatch(/^pp::.+/);
        expect(notify({ message: 'plain' })).not.toBe(id);
    });

    it('accepts every severity and nothing else', () => {
        for (const severity of ['info', 'success', 'warning', 'error']) expect(() => notify({ message: 'm', severity })).not.toThrow();
        expect(() => notify({ message: 'm', severity: 'panic' })).toThrow(/severity must be one of/);
    });

    it('rejects a bad notification and stores nothing', () => {
        for (const bad of [undefined, null, 'text', [], {}, { message: '' }, { message: '   ' }, { message: 5 }]) {
            expect(() => notify(bad), JSON.stringify(bad)).toThrow(/Notification rejected/);
        }
        expect(() => notify({ message: 'x'.repeat(501) })).toThrow(/longer than 500/);
        expect(() => notify({ message: 'x', id: 'bad id!' })).toThrow(/id must be/);
        expect(() => notify({ message: 'x', callbackId: 'not-registered' })).toThrow(/has not been registered/);
        expect(() => notify({ message: 'x', callbackId: 'bad id!' })).toThrow(/callbackId must be/);
        expect(() => notify({ message: 'x', junk: 1 })).toThrow(/unknown field 'junk'/);
        expect(stateEngine.getNotifications()).toEqual([]);
    });

    it('notifying again with the same id REPLACES it: new text, fresh timestamp, moved to the end', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1000);
            notify({ message: 'first', id: 'a' });
            notify({ message: 'other', id: 'b' });
            vi.setSystemTime(5000);
            notify({ message: 'second', id: 'a', severity: 'error' });
            const list = stateEngine.getNotifications();
            expect(list.map((n) => n.id)).toEqual(['pp::b', 'pp::a']);
            expect(list[1]).toMatchObject({ message: 'second', severity: 'error', timestamp: 5000 });
        } finally {
            vi.useRealTimers();
        }
    });

    it('the same local id in two extensions is two notifications', () => {
        notify({ message: 'one', id: 'same' }, 'pp');
        notify({ message: 'two', id: 'same' }, 'zz');
        expect(stateEngine.getNotifications().map((n) => n.id)).toEqual(['pp::same', 'zz::same']);
    });

    it('does not auto-expire: a very old notification is still there', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(0);
            notify({ message: 'old' });
            vi.setSystemTime(1000 * 60 * 60 * 24 * 365);
            expect(stateEngine.getNotifications()).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('persistence: a notification stores a callback ID, never a function', () => {
    it('the settings blob round-trips through JSON with the notification intact', () => {
        register('open', () => 'never serialized');
        notify({ message: 'keep me', callbackId: 'open', id: 'k' });
        const snapshot = settings.snapshot();
        expect(snapshot.notifications).toEqual([{ id: 'pp::k', source: 'pp', severity: 'info', message: 'keep me', timestamp: snapshot.notifications[0].timestamp, callbackId: 'open' }]);
        expect(JSON.stringify(snapshot)).not.toContain('never serialized');
        for (const value of Object.values(snapshot.notifications[0])) expect(typeof value).not.toBe('function');
    });

    it('every change is saved', () => {
        register('open');
        context.saveSettingsDebounced.mockClear();
        const id = notify({ message: 'x', callbackId: 'open' });
        expect(context.saveSettingsDebounced).toHaveBeenCalled();
        context.saveSettingsDebounced.mockClear();
        clear(id);
        expect(context.saveSettingsDebounced).toHaveBeenCalled();
    });

    it('a corrupted stored list is repaired on load', () => {
        getSettings().notifications = 'garbage';
        migrateAllSettings(getSettings());
        expect(getSettings().notifications).toEqual([]);
        getSettings().notifications = [null, 5, { id: 'a' }, { id: 'pp::ok', message: 'kept', source: 'pp', severity: 'info', timestamp: 1, callbackId: null }];
        migrateAllSettings(getSettings());
        expect(getSettings().notifications.map((n) => n.id)).toEqual(['pp::ok']);
    });

    it('reads return copies, so editing one cannot change the registry', () => {
        notify({ message: 'safe' });
        stateEngine.getNotifications()[0].message = 'hacked';
        expect(stateEngine.getNotifications()[0].message).toBe('safe');
    });
});

describe('clearNotification', () => {
    it('removes one and reports it; clearing a missing one is false, not an error', () => {
        const id = notify({ message: 'x' });
        expect(clear(id)).toBe(true);
        expect(clear(id)).toBe(false);
        expect(clear('pp::never')).toBe(false);
        expect(() => clear('')).toThrow(/id must be/);
    });
});

describe('callbacks', () => {
    it('registerNotificationCallback needs a function and a valid id', () => {
        expect(() => register('open', 'not a function')).toThrow(/must be a function/);
        expect(() => register('bad id', noop)).toThrow(/callbackId must be/);
        expect(register('open', noop)).toBe(true);
    });

    it('unregister removes it; notifying with it afterwards is refused', () => {
        register('open');
        expect(stateEngine.unregisterNotificationCallback('pp', instanceId, 'open')).toBe(true);
        expect(stateEngine.unregisterNotificationCallback('pp', instanceId, 'open')).toBe(false);
        expect(() => notify({ message: 'x', callbackId: 'open' })).toThrow(/has not been registered/);
    });

    it('registering the same id again replaces the function (an extension reloading)', async () => {
        const first = vi.fn();
        const second = vi.fn();
        register('open', first);
        register('open', second);
        const id = notify({ message: 'x', callbackId: 'open' });
        await stateEngine.invokeNotificationCallback(id);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });
});

describe('invokeNotificationCallback', () => {
    it('runs the callback with a copy of the notification, THEN removes it', async () => {
        let presentDuringCallback;
        const fn = vi.fn((n) => { presentDuringCallback = stateEngine.getNotifications().some((x) => x.id === n.id); });
        register('open', fn);
        const id = notify({ message: 'do it', callbackId: 'open', severity: 'success' });

        await expect(stateEngine.invokeNotificationCallback(id)).resolves.toBe(true);

        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn.mock.calls[0][0]).toMatchObject({ id, source: 'pp', message: 'do it', severity: 'success', callbackId: 'open' });
        expect(presentDuringCallback).toBe(true);
        expect(stateEngine.getNotifications()).toEqual([]);
    });

    it('awaits an async callback before removing', async () => {
        let finished = false;
        register('slow', async () => { await new Promise((r) => setTimeout(r, 20)); finished = true; });
        const id = notify({ message: 'x', callbackId: 'slow' });
        const running = stateEngine.invokeNotificationCallback(id);
        expect(stateEngine.getNotifications()).toHaveLength(1);
        await running;
        expect(finished).toBe(true);
        expect(stateEngine.getNotifications()).toEqual([]);
    });

    it('a notification with no callback is simply dismissed', async () => {
        const id = notify({ message: 'fyi' });
        await expect(stateEngine.invokeNotificationCallback(id)).resolves.toBe(true);
        expect(stateEngine.getNotifications()).toEqual([]);
    });

    it('an unknown id resolves false and does nothing', async () => {
        notify({ message: 'stay' });
        await expect(stateEngine.invokeNotificationCallback('pp::nope')).resolves.toBe(false);
        expect(stateEngine.getNotifications()).toHaveLength(1);
    });

    it('a callback that throws (or rejects) keeps the notification so it can be retried', async () => {
        let attempts = 0;
        register('flaky', () => { attempts += 1; if (attempts === 1) throw new Error('first try fails'); });
        const id = notify({ message: 'x', callbackId: 'flaky' });
        await expect(stateEngine.invokeNotificationCallback(id)).rejects.toThrow('first try fails');
        expect(stateEngine.getNotifications()).toHaveLength(1);
        await expect(stateEngine.invokeNotificationCallback(id)).resolves.toBe(true);
        expect(stateEngine.getNotifications()).toEqual([]);

        register('async-fail', async () => { throw new Error('async failure'); });
        const id2 = notify({ message: 'y', callbackId: 'async-fail' });
        await expect(stateEngine.invokeNotificationCallback(id2)).rejects.toThrow('async failure');
        expect(stateEngine.getNotifications()).toHaveLength(1);
    });

    it('after a reload the stored notification is listed but its action is unavailable until re-registered', async () => {
        register('open', vi.fn());
        const id = notify({ message: 'survives', callbackId: 'open' });
        resetNotificationRuntimeForTests(); // the page reloaded: callbacks are gone, settings are not
        expect(stateEngine.getNotifications()).toHaveLength(1);
        await expect(stateEngine.invokeNotificationCallback(id)).rejects.toThrow(/has not registered callback 'open'/);
        expect(stateEngine.getNotifications()).toHaveLength(1);

        const fn = vi.fn();
        register('open', fn); // the extension loaded again
        await expect(stateEngine.invokeNotificationCallback(id)).resolves.toBe(true);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('a second click while the action is running does not run it twice', async () => {
        let release;
        const fn = vi.fn(() => new Promise((r) => { release = r; }));
        register('open', fn);
        const id = notify({ message: 'x', callbackId: 'open' });
        const first = stateEngine.invokeNotificationCallback(id);
        await expect(stateEngine.invokeNotificationCallback(id)).rejects.toThrow(/already running/);
        release();
        await first;
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('a callback may clear its own notification', async () => {
        register('self', (n) => { clear(n.id); });
        const id = notify({ message: 'x', callbackId: 'self' });
        await expect(stateEngine.invokeNotificationCallback(id)).resolves.toBe(true);
        expect(stateEngine.getNotifications()).toEqual([]);
    });
});

describe('change subscription', () => {
    it('listeners hear every add, replace and removal; a throwing listener breaks nothing', () => {
        const seen = vi.fn();
        subscribeToNotifications(() => { throw new Error('bad listener'); });
        subscribeToNotifications(seen);
        const id = notify({ message: 'a', id: 'a' });
        notify({ message: 'b', id: 'a' });
        clear(id);
        expect(seen).toHaveBeenCalledTimes(3);
        expect(stateEngine.getNotifications()).toEqual([]);
    });

    it('unsubscribe stops it', () => {
        const seen = vi.fn();
        const stop = subscribeToNotifications(seen);
        stop();
        notify({ message: 'a' });
        expect(seen).not.toHaveBeenCalled();
    });
});
