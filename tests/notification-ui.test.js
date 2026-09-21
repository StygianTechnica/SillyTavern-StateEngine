// @vitest-environment jsdom
//
// The notification button and panel, run in a real DOM against the send-bar
// markup copied from SillyTavern 1.18 (#leftSendForm holds #options_button,
// #extensionsMenuButton and other extensions' buttons).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../tests/harness/context.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { resetNotificationRuntimeForTests } from '../src/core/notification-core.js';
import {
    initNotificationUi, teardownNotificationUi, renderNotificationUi, openNotificationPanel, closeNotificationPanel,
    isNotificationPanelOpen, activateNotification, badgeText, formatAge, escapeText, notificationItemHtml,
} from '../src/ui/notification-ui.js';

const SEND_BAR = `
    <div id="leftSendForm" class="alignContentCenter">
        <div id="options_button" class="fa-solid fa-bars interactable" tabindex="0"></div>
        <div id="extensionsMenuButton" class="fa-solid fa-magic-wand-sparkles interactable" tabindex="0"></div>
        <div id="lbc-trigger" class="interactable" tabindex="0"></div>
    </div>
`;

let instanceId;
const notify = (n, ext = 'pp') => stateEngine.notify(ext, instanceId, n);
const register = (id, fn) => stateEngine.registerNotificationCallback('pp', instanceId, id, fn);
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    resetNotificationRuntimeForTests();
    document.body.innerHTML = SEND_BAR;
    instanceId = ensureInstanceId();
    registerNamespaces('pp', 'zz');
    initNotificationUi();
});

afterEach(() => {
    teardownNotificationUi();
    document.body.innerHTML = '';
});

describe('the button', () => {
    it('is added to the send bar, exactly once, and is grey with no badge when there is nothing', () => {
        const buttons = $$('#se_notification_button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].parentElement.id).toBe('leftSendForm');
        expect(buttons[0].classList.contains('se-has-notifications')).toBe(false);
        expect(buttons[0].querySelector('.se-notification-badge').hidden).toBe(true);
        initNotificationUi();
        initNotificationUi();
        expect($$('#se_notification_button')).toHaveLength(1);
    });

    it('lights up with a count badge as soon as a notification exists, and goes grey when they are gone', () => {
        const id = notify({ message: 'one' });
        const button = $('#se_notification_button');
        expect(button.classList.contains('se-has-notifications')).toBe(true);
        const badge = button.querySelector('.se-notification-badge');
        expect(badge.hidden).toBe(false);
        expect(badge.textContent).toBe('1');

        notify({ message: 'two' });
        expect(badge.textContent).toBe('2');

        stateEngine.clearNotification('pp', instanceId, id);
        expect(badge.textContent).toBe('1');
        stateEngine.clearNotification('pp', instanceId, stateEngine.getNotifications()[0].id);
        expect(button.classList.contains('se-has-notifications')).toBe(false);
        expect(badge.hidden).toBe(true);
    });

    it('has an accessible name that includes the count', () => {
        expect($('#se_notification_button').getAttribute('aria-label')).toContain('none');
        notify({ message: 'x' });
        notify({ message: 'y' });
        expect($('#se_notification_button').getAttribute('aria-label')).toContain('(2)');
    });

    it('comes back if SillyTavern rebuilt the send bar', () => {
        $('#se_notification_button').remove();
        renderNotificationUi();
        expect($$('#se_notification_button')).toHaveLength(1);
    });

    it('does nothing (and does not throw) when there is no send bar', () => {
        teardownNotificationUi();
        document.body.innerHTML = '';
        expect(() => initNotificationUi()).not.toThrow();
        expect(openNotificationPanel()).toBe(false);
    });

    it('shows notifications that were already stored when the page loaded', () => {
        teardownNotificationUi();
        notify({ message: 'from last session' });
        document.body.innerHTML = SEND_BAR;
        initNotificationUi();
        expect($('#se_notification_button').classList.contains('se-has-notifications')).toBe(true);
        expect($('#se_notification_button .se-notification-badge').textContent).toBe('1');
    });
});

describe('the panel', () => {
    it('opens and closes from the button; Escape and a click elsewhere close it', () => {
        expect(isNotificationPanelOpen()).toBe(false);
        click($('#se_notification_button'));
        expect(isNotificationPanelOpen()).toBe(true);
        expect($('#se_notification_button').getAttribute('aria-expanded')).toBe('true');
        click($('#se_notification_button'));
        expect(isNotificationPanelOpen()).toBe(false);

        click($('#se_notification_button'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(isNotificationPanelOpen()).toBe(false);

        click($('#se_notification_button'));
        click(document.body);
        expect(isNotificationPanelOpen()).toBe(false);
        expect($('#se_notification_button').getAttribute('aria-expanded')).toBe('false');
    });

    it('a click inside the panel does not close it', () => {
        notify({ message: 'x' });
        click($('#se_notification_button'));
        click($('.se-notification-header'));
        expect(isNotificationPanelOpen()).toBe(true);
    });

    it('says so when there are none', () => {
        click($('#se_notification_button'));
        expect($('.se-notification-empty').textContent).toBe('No notifications.');
    });

    it('lists every notification, newest first, with severity, source and message', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000_000);
            notify({ message: 'oldest', severity: 'info' });
            vi.setSystemTime(2_000_000);
            notify({ message: 'newest', severity: 'error' });
        } finally {
            vi.useRealTimers();
        }
        click($('#se_notification_button'));
        const items = $$('.se-notification-item');
        expect(items.map((i) => i.querySelector('.se-notification-message').textContent)).toEqual(['newest', 'oldest']);
        expect(items[0].classList.contains('se-sev-error')).toBe(true);
        expect(items[1].classList.contains('se-sev-info')).toBe(true);
        expect(items[0].querySelector('.se-notification-meta').textContent).toContain('pp');
        expect($('.se-notification-header').textContent).toBe('Notifications (2)');
    });

    it('updates live while it is open', () => {
        click($('#se_notification_button'));
        expect($$('.se-notification-item')).toHaveLength(0);
        notify({ message: 'arrives while open' });
        expect($$('.se-notification-item')).toHaveLength(1);
    });

    it('renders stored text as text, never as HTML', () => {
        notify({ message: '<img src=x onerror="alert(1)"> & "quotes"' });
        click($('#se_notification_button'));
        expect($('.se-notification-message').textContent).toBe('<img src=x onerror="alert(1)"> & "quotes"');
        expect($('.se-notification-message img')).toBe(null);
        expect(escapeText('<a href="x">\'</a>&')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&lt;/a&gt;&amp;');
    });
});

describe('clicking a notification', () => {
    it('runs the extension\'s callback and then removes the notification', async () => {
        const fn = vi.fn();
        register('open', fn);
        notify({ message: 'do the thing', callbackId: 'open' });
        click($('#se_notification_button'));

        click($('.se-notification-message'));
        await flush();

        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn.mock.calls[0][0]).toMatchObject({ message: 'do the thing', source: 'pp', callbackId: 'open' });
        expect(stateEngine.getNotifications()).toEqual([]);
        expect($$('.se-notification-item')).toHaveLength(0);
        expect($('#se_notification_button').classList.contains('se-has-notifications')).toBe(false);
        expect(isNotificationPanelOpen()).toBe(true); // the panel stays open, now empty
    });

    it('works from the keyboard (Enter and Space on a focused item)', async () => {
        const fn = vi.fn();
        register('open', fn);
        notify({ message: 'a', callbackId: 'open' });
        notify({ message: 'b', callbackId: 'open' });
        click($('#se_notification_button'));
        $$('.se-notification-item')[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await flush();
        $$('.se-notification-item')[0].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        await flush();
        expect(fn).toHaveBeenCalledTimes(2);
        expect(stateEngine.getNotifications()).toEqual([]);
    });

    it('only the clicked notification is affected', async () => {
        const fn = vi.fn();
        register('open', fn);
        notify({ message: 'keep', id: 'keep' });
        notify({ message: 'run', id: 'run', callbackId: 'open' });
        click($('#se_notification_button'));
        click($$('.se-notification-item').find((i) => i.textContent.includes('run')));
        await flush();
        expect(stateEngine.getNotifications().map((n) => n.id)).toEqual(['pp::keep']);
    });

    it('a notification with no callback is dismissed by clicking it', async () => {
        notify({ message: 'just so you know' });
        click($('#se_notification_button'));
        click($('.se-notification-item'));
        await flush();
        expect(stateEngine.getNotifications()).toEqual([]);
    });

    it('a failing callback leaves the notification and shows why on it', async () => {
        register('boom', () => { throw new Error('the extension blew up'); });
        notify({ message: 'x', callbackId: 'boom' });
        click($('#se_notification_button'));
        click($('.se-notification-item'));
        await flush();
        expect(stateEngine.getNotifications()).toHaveLength(1);
        const error = $('.se-notification-failure');
        expect(error.hidden).toBe(false);
        expect(error.textContent).toBe('the extension blew up');
        // still there after another notification makes the list redraw
        notify({ message: 'another' });
        expect($$('.se-notification-failure').some((e) => !e.hidden && e.textContent === 'the extension blew up')).toBe(true);
    });

    it('an action whose extension has not loaded says so and stays', async () => {
        register('open', vi.fn());
        notify({ message: 'x', callbackId: 'open' });
        resetNotificationRuntimeForTests();
        initNotificationUi();
        click($('#se_notification_button'));
        click($('.se-notification-item'));
        await flush();
        expect(stateEngine.getNotifications()).toHaveLength(1);
        expect($('.se-notification-failure').textContent).toContain('has not registered callback');
    });

    it('a double click runs the action once', async () => {
        let release;
        const fn = vi.fn(() => new Promise((r) => { release = r; }));
        register('open', fn);
        const id = notify({ message: 'x', callbackId: 'open' });
        click($('#se_notification_button'));
        const first = activateNotification(id);
        expect(await activateNotification(id)).toBe(false);
        release();
        await first;
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('the x dismisses without running anything', async () => {
        const fn = vi.fn();
        register('open', fn);
        notify({ message: 'x', callbackId: 'open' });
        click($('#se_notification_button'));
        click($('.se-notification-dismiss'));
        await flush();
        expect(fn).not.toHaveBeenCalled();
        expect(stateEngine.getNotifications()).toEqual([]);
    });
});

describe('helpers', () => {
    it('badgeText: nothing for zero, the number, then 99+', () => {
        expect(badgeText(0)).toBe('');
        expect(badgeText(-3)).toBe('');
        expect(badgeText(NaN)).toBe('');
        expect(badgeText(7)).toBe('7');
        expect(badgeText(99)).toBe('99');
        expect(badgeText(100)).toBe('99+');
    });

    it('formatAge', () => {
        const now = 10_000_000_000;
        expect(formatAge(now - 5_000, now)).toBe('just now');
        expect(formatAge(now - 5 * 60_000, now)).toBe('5 min ago');
        expect(formatAge(now - 3 * 3_600_000, now)).toBe('3 h ago');
        expect(formatAge(now - 2 * 86_400_000, now)).toBe('2 d ago');
        expect(formatAge(now + 5_000, now)).toBe('just now');
    });

    it('an unknown severity is drawn as info', () => {
        expect(notificationItemHtml({ id: 'a', source: 's', severity: 'weird', message: 'm', timestamp: 0 })).toContain('se-sev-info');
    });

    it('an error-severity row is not confused with the failure message element', () => {
        const html = notificationItemHtml({ id: 'a', source: 's', severity: 'error', message: 'm', timestamp: 0 });
        expect(html.match(/se-notification-failure/g)).toHaveLength(1);
        expect(html).toContain('se-sev-error');
        expect(html).not.toMatch(/class="se-notification-item se-notification-error/);
    });

    it('closeNotificationPanel is safe with no panel', () => {
        teardownNotificationUi();
        expect(() => closeNotificationPanel()).not.toThrow();
    });
});
