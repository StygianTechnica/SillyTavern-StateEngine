// @vitest-environment jsdom
//
// "Extension updates available": one notification through the Notification Core,
// driven by the same endpoints SillyTavern's extension manager uses.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../tests/harness/context.js';
import { stateEngine } from '../src/api/index.js';
import { resetNotificationRuntimeForTests } from '../src/core/notification-core.js';
import {
    checkForExtensionUpdates, registerUpdateNotificationCallback, openExtensionManager, watchForExtensionManager,
    onStateEngineUpdate, postUpdateNotification, UPDATE_NOTIFICATION_MESSAGE, UPDATE_NOTIFICATION_KEY, OPEN_MANAGER_CALLBACK_ID,
} from '../src/events/extension-updates.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

const json = (body, ok = true) => ({ ok, json: async () => body });

// A fake SillyTavern server: `installed` is what /discover lists, `versions` maps a
// folder name to what /version answers ('outdated' | 'current' | 'error' | 'garbage').
function fakeServer({ installed, versions = {}, discoverOk = true }) {
    const calls = { discover: 0, version: [], active: 0, maxActive: 0 };
    const fetchImpl = vi.fn(async (url, init) => {
        if (url === '/api/extensions/discover') {
            calls.discover += 1;
            if (!discoverOk) return json([], false);
            return json(installed);
        }
        if (url === '/api/extensions/version') {
            const body = JSON.parse(init.body);
            calls.version.push(body);
            calls.active += 1;
            calls.maxActive = Math.max(calls.maxActive, calls.active);
            await new Promise((r) => setTimeout(r, 2));
            calls.active -= 1;
            const state = versions[body.extensionName] ?? 'current';
            if (state === 'error') throw new Error('network down');
            if (state === 'garbage') return json({ nothing: true });
            if (state === 'notok') return json({}, false);
            return json({ isUpToDate: state !== 'outdated', currentBranchName: 'main', currentCommitHash: 'abc', remoteUrl: 'x' });
        }
        throw new Error(`unexpected request ${url}`);
    });
    return { fetchImpl, calls };
}

const tp = (name, type = 'local') => ({ type, name: `third-party/${name}` });
const notes = () => stateEngine.getNotifications();

beforeEach(() => {
    resetNotificationRuntimeForTests();
    registerUpdateNotificationCallback();
    document.body.innerHTML = '';
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the notification', () => {
    it('one outdated extension -> exactly one notification, with the requested content', async () => {
        const { fetchImpl } = fakeServer({ installed: [tp('A'), tp('B'), tp('C')], versions: { B: 'outdated' } });
        const result = await checkForExtensionUpdates('test', fetchImpl);

        expect(result).toMatchObject({ checked: 3, outdated: 1, notified: true });
        expect(notes()).toHaveLength(1);
        expect(notes()[0]).toMatchObject({
            id: `se::${UPDATE_NOTIFICATION_KEY}`,
            source: 'se',
            severity: 'warning',
            message: 'One or more extensions have updates available.',
            callbackId: OPEN_MANAGER_CALLBACK_ID,
        });
        expect(UPDATE_NOTIFICATION_MESSAGE).toBe('One or more extensions have updates available.');
    });

    it('several outdated extensions still make ONE notification, not one each', async () => {
        const { fetchImpl } = fakeServer({ installed: [tp('A'), tp('B'), tp('C')], versions: { A: 'outdated', B: 'outdated', C: 'outdated' } });
        const result = await checkForExtensionUpdates('test', fetchImpl);
        expect(result.outdated).toBe(3);
        expect(notes()).toHaveLength(1);
    });

    it('nothing outdated -> nothing is posted', async () => {
        const { fetchImpl } = fakeServer({ installed: [tp('A'), tp('B')] });
        const result = await checkForExtensionUpdates('test', fetchImpl);
        expect(result).toMatchObject({ checked: 2, outdated: 0, notified: false });
        expect(notes()).toEqual([]);
    });

    it('checking again while it is still outdated REPLACES the notification (no duplicates)', async () => {
        const { fetchImpl } = fakeServer({ installed: [tp('A')], versions: { A: 'outdated' } });
        await checkForExtensionUpdates('startup', fetchImpl);
        const first = notes()[0];
        await new Promise((r) => setTimeout(r, 5));
        await checkForExtensionUpdates('manager', fetchImpl);
        await checkForExtensionUpdates('update', fetchImpl);
        expect(notes()).toHaveLength(1);
        expect(notes()[0].id).toBe(first.id);
        expect(notes()[0].timestamp).toBeGreaterThanOrEqual(first.timestamp);
    });

    it('once everything is up to date, a leftover notification is cleared', async () => {
        const outdated = fakeServer({ installed: [tp('A')], versions: { A: 'outdated' } });
        await checkForExtensionUpdates('startup', outdated.fetchImpl);
        expect(notes()).toHaveLength(1);
        const current = fakeServer({ installed: [tp('A')] });
        await checkForExtensionUpdates('manager', current.fetchImpl);
        expect(notes()).toEqual([]);
    });

    it('it never touches other extensions\' notifications', async () => {
        stateEngine.notify('se', (await import('../src/api/identity.js')).ensureInstanceId(), { message: 'something else', id: 'other' });
        const { fetchImpl } = fakeServer({ installed: [tp('A')] });
        await checkForExtensionUpdates('test', fetchImpl);
        expect(notes().map((n) => n.id)).toEqual(['se::other']);
    });
});

describe('what counts', () => {
    it('only third-party extensions are checked, by folder name, with the global flag', async () => {
        const server = fakeServer({ installed: [{ type: 'system', name: 'regex' }, tp('Mine'), tp('Shared', 'global')] });
        await checkForExtensionUpdates('test', server.fetchImpl);
        expect(server.calls.version).toEqual([
            { extensionName: 'Mine', global: false },
            { extensionName: 'Shared', global: true },
        ]);
    });

    it('an extension that cannot answer is ignored, not treated as outdated', async () => {
        const { fetchImpl } = fakeServer({ installed: [tp('A'), tp('B'), tp('C'), tp('D')], versions: { A: 'error', B: 'garbage', C: 'notok' } });
        const result = await checkForExtensionUpdates('test', fetchImpl);
        expect(result).toMatchObject({ checked: 1, outdated: 0 });
        expect(notes()).toEqual([]);
    });

    it('a check that cannot answer at all leaves the notification exactly as it was', async () => {
        const outdated = fakeServer({ installed: [tp('A')], versions: { A: 'outdated' } });
        await checkForExtensionUpdates('startup', outdated.fetchImpl);
        const before = JSON.stringify(notes());

        await checkForExtensionUpdates('x', fakeServer({ installed: [], discoverOk: false }).fetchImpl);
        expect(JSON.stringify(notes())).toBe(before);

        await checkForExtensionUpdates('x', fakeServer({ installed: [tp('A')], versions: { A: 'error' } }).fetchImpl);
        expect(JSON.stringify(notes())).toBe(before);

        const throwing = vi.fn(async () => { throw new Error('offline'); });
        await expect(checkForExtensionUpdates('x', throwing)).resolves.toMatchObject({ notified: false });
        expect(JSON.stringify(notes())).toBe(before);
    });

    it('no third-party extensions installed -> nothing to report', async () => {
        const { fetchImpl } = fakeServer({ installed: [{ type: 'system', name: 'regex' }] });
        await expect(checkForExtensionUpdates('test', fetchImpl)).resolves.toMatchObject({ checked: 0, outdated: 0 });
        expect(notes()).toEqual([]);
    });
});

describe('how it checks', () => {
    it('at most 5 version checks run at a time (as SillyTavern does)', async () => {
        const installed = Array.from({ length: 14 }, (_, i) => tp(`E${i}`));
        const server = fakeServer({ installed });
        await checkForExtensionUpdates('test', server.fetchImpl);
        expect(server.calls.version).toHaveLength(14);
        expect(server.calls.maxActive).toBeLessThanOrEqual(5);
        expect(server.calls.maxActive).toBeGreaterThan(1);
    });

    it('overlapping triggers share one run', async () => {
        const server = fakeServer({ installed: [tp('A'), tp('B')], versions: { A: 'outdated' } });
        const [a, b, c] = await Promise.all([
            checkForExtensionUpdates('startup', server.fetchImpl),
            checkForExtensionUpdates('manager', server.fetchImpl),
            checkForExtensionUpdates('update', server.fetchImpl),
        ]);
        expect(server.calls.discover).toBe(1);
        expect(server.calls.version).toHaveLength(2);
        expect(a).toBe(b);
        expect(b).toBe(c);
        expect(notes()).toHaveLength(1);
    });

    it('a later check runs again once the earlier one has finished', async () => {
        const server = fakeServer({ installed: [tp('A')] });
        await checkForExtensionUpdates('startup', server.fetchImpl);
        await checkForExtensionUpdates('manager', server.fetchImpl);
        expect(server.calls.discover).toBe(2);
    });

    it('there is no polling and no per-message check in the source', () => {
        const src = read('src', 'events', 'extension-updates.js');
        expect(src).not.toMatch(/setInterval/);
        expect(src).not.toMatch(/MESSAGE_RECEIVED|MESSAGE_SENT|USER_MESSAGE_RENDERED|CHARACTER_MESSAGE_RENDERED/);
        expect(read('src', 'events', 'event-engine.js')).not.toContain('checkForExtensionUpdates');
    });

    it('it only reads: nothing here calls the update endpoints', () => {
        const src = read('src', 'events', 'extension-updates.js');
        expect(src).not.toContain('/api/extensions/update');
        expect(src).not.toContain('/api/extensions/install');
    });
});

describe('clicking the notification', () => {
    it('opens the extension manager and then the notification is removed', async () => {
        const manager = document.createElement('div');
        manager.id = 'extensions_details';
        const opened = vi.fn();
        manager.addEventListener('click', opened);
        document.body.appendChild(manager);

        const id = postUpdateNotification();
        await expect(stateEngine.invokeNotificationCallback(id)).resolves.toBe(true);
        expect(opened).toHaveBeenCalledTimes(1);
        expect(notes()).toEqual([]);
    });

    it('if the manager button is missing it says so and the notification stays', async () => {
        expect(() => openExtensionManager()).toThrow(/#extensions_details/);
        const id = postUpdateNotification();
        await expect(stateEngine.invokeNotificationCallback(id)).rejects.toThrow(/#extensions_details/);
        expect(notes()).toHaveLength(1);
    });
});

describe('when it runs', () => {
    it('watching for the extension manager: the popup with a list triggers one debounced check', () => {
        vi.useFakeTimers();
        const onList = vi.fn();
        const stop = watchForExtensionManager(onList);
        const popup = (inner) => {
            const dialog = document.createElement('dialog');
            dialog.innerHTML = inner;
            document.body.appendChild(dialog);
        };
        return (async () => {
            popup('<div class="extensions_info"><div class="extension_block"></div></div>');
            await Promise.resolve();
            expect(onList).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1100);
            expect(onList).toHaveBeenCalledTimes(1);

            // the manager re-draws after an update: another popup -> another check
            popup('<div class="extensions_info"></div>');
            popup('<div class="extensions_info"></div>');
            await vi.advanceTimersByTimeAsync(1100);
            expect(onList).toHaveBeenCalledTimes(2); // both draws settle into one check

            stop();
            popup('<div class="extensions_info"></div>');
            await vi.advanceTimersByTimeAsync(2000);
            expect(onList).toHaveBeenCalledTimes(2);
        })();
    });

    it('other popups, and ordinary page changes, do not trigger it', async () => {
        vi.useFakeTimers();
        const onList = vi.fn();
        const stop = watchForExtensionManager(onList);
        const other = document.createElement('dialog');
        other.innerHTML = '<div class="some_other_popup"></div>';
        document.body.appendChild(other);
        document.body.appendChild(document.createElement('div'));
        const loose = document.createElement('div'); // not a popup: ignored (the guard keeps the observer cheap)
        loose.innerHTML = '<div class="extensions_info"></div>';
        document.body.appendChild(loose);
        await vi.advanceTimersByTimeAsync(3000);
        expect(onList).not.toHaveBeenCalled();
        stop();
    });

    it('SillyTavern\'s update hook: State Engine\'s manifest names it, index.js exports it, and it starts a check without waiting', async () => {
        const manifest = JSON.parse(read('manifest.json'));
        expect(manifest.hooks).toEqual({ update: 'onStateEngineUpdate' });
        expect(read('index.js')).toMatch(/export \{ onStateEngineUpdate \}/);

        const fetchSpy = vi.fn(async () => json([]));
        vi.stubGlobal('fetch', fetchSpy);
        try {
            expect(onStateEngineUpdate()).toBeUndefined(); // synchronous, nothing to await
            await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/extensions/discover'));
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('the startup check and the notifier are wired in index.js', () => {
        const src = read('index.js');
        expect(src).toContain('initExtensionUpdateNotifier();');
        expect(src).toContain("void checkForExtensionUpdates('startup');");
    });
});
