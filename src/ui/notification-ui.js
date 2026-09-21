// State Engine — notification button and panel (the surface for the
// Notification Core, src/core/notification-core.js).
//
// ONE button in SillyTavern's send bar (#leftSendForm, next to the wand): grey
// while there is nothing to show, highlighted with a count badge while there
// is. Clicking it opens a panel listing every notification, newest first.
// Clicking a notification runs the callback its extension registered and, once
// that has succeeded, removes it (runNotification). A small x dismisses one
// without running anything.
//
// Everything is rebuilt from the registry whenever it changes
// (subscribeToNotifications), so the button, the badge and an open panel can
// never disagree with it. Plain DOM, and every piece of stored text is escaped.

import { LOG_PREFIX } from '../core/settings-core.js';
import { listNotifications, removeNotification, runNotification, subscribeToNotifications } from '../core/notification-core.js';

const BUTTON_ID = 'se_notification_button';
const PANEL_ID = 'se_notification_panel';
const PANEL_WIDTH = 340;
const SEND_BAR_SELECTOR = '#leftSendForm';

const SEVERITY_ICONS = {
    info: 'fa-circle-info',
    success: 'fa-circle-check',
    warning: 'fa-triangle-exclamation',
    error: 'fa-circle-xmark',
};

// Why an action could not run, per notification id - kept so the message is
// still there when the list is redrawn (another notification arriving), and
// forgotten once its notification is gone.
const failures = new Map();

let installed = false;
let unsubscribe = null;

// ---- pure helpers (exported for tests) ---------------------------------------

export function escapeText(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// The badge text for a count: nothing for 0, the number up to 99, then "99+".
export function badgeText(count) {
    if (!Number.isFinite(count) || count <= 0) return '';
    return count > 99 ? '99+' : String(count);
}

// "just now", "5 min ago", "2 h ago", "3 d ago". `now` is injectable for tests.
export function formatAge(timestamp, now = Date.now()) {
    const seconds = Math.max(0, Math.floor((now - Number(timestamp)) / 1000));
    if (!Number.isFinite(seconds) || seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.round(hours / 24)} d ago`;
}

// One row of the panel. Newest-first ordering is the caller's job.
export function notificationItemHtml(notification, now = Date.now(), failure = '') {
    const severity = SEVERITY_ICONS[notification.severity] ? notification.severity : 'info';
    const id = escapeText(notification.id);
    return `
        <div class="se-notification-item se-sev-${severity}" data-id="${id}" role="button" tabindex="0">
            <i class="fa-solid ${SEVERITY_ICONS[severity]} se-notification-icon"></i>
            <div class="se-notification-body">
                <div class="se-notification-message">${escapeText(notification.message)}</div>
                <div class="se-notification-meta">${escapeText(notification.source)} · ${escapeText(formatAge(notification.timestamp, now))}</div>
                <div class="se-notification-failure"${failure ? '' : ' hidden'}>${escapeText(failure)}</div>
            </div>
            <button type="button" class="se-notification-dismiss" data-dismiss="${id}" title="Dismiss" aria-label="Dismiss notification">&times;</button>
        </div>
    `;
}

// ---- the button ----------------------------------------------------------------

function getButton() {
    return document.getElementById(BUTTON_ID);
}

function getPanel() {
    return document.getElementById(PANEL_ID);
}

// Puts the button in the send bar if it is not there (yet, or any more).
// Returns it, or null when the send bar does not exist.
function ensureButton() {
    let button = getButton();
    if (button) return button;
    const bar = document.querySelector(SEND_BAR_SELECTOR);
    if (!bar) return null;

    button = document.createElement('div');
    button.id = BUTTON_ID;
    button.className = 'fa-solid fa-bell interactable se-notification-button';
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<span class="se-notification-badge" hidden></span>';
    bar.appendChild(button);
    return button;
}

function ensurePanel() {
    let panel = getPanel();
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'se-notification-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'State Engine notifications');
    panel.hidden = true;
    panel.innerHTML = '<div class="se-notification-header"></div><div class="se-notification-list"></div>';
    document.body.appendChild(panel);
    return panel;
}

export function isNotificationPanelOpen() {
    const panel = getPanel();
    return !!panel && !panel.hidden;
}

function positionPanel(panel, button) {
    const rect = button.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, Math.max(0, window.innerWidth - 16));
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    panel.style.width = `${width}px`;
    panel.style.left = `${left}px`;
    panel.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
}

// Redraws the button (highlight, badge, labels) and, when open, the panel.
// Safe to call at any time; never throws.
export function renderNotificationUi() {
    try {
        const notifications = listNotifications();
        const count = notifications.length;

        const button = ensureButton();
        if (button) {
            button.classList.toggle('se-has-notifications', count > 0);
            const badge = button.querySelector('.se-notification-badge');
            if (badge) {
                badge.textContent = badgeText(count);
                badge.hidden = count === 0;
            }
            const label = count === 0 ? 'State Engine notifications (none)' : `State Engine notifications (${count})`;
            button.title = label;
            button.setAttribute('aria-label', label);
        }

        // Forget the failure message of a notification that no longer exists.
        const live = new Set(notifications.map((n) => n.id));
        for (const id of [...failures.keys()]) if (!live.has(id)) failures.delete(id);

        const panel = getPanel();
        if (panel && !panel.hidden) fillPanel(panel, notifications);
    } catch (err) {
        console.warn(LOG_PREFIX, 'notification UI render failed (gracefully handled)', err);
    }
}

function fillPanel(panel, notifications) {
    const now = Date.now();
    panel.querySelector('.se-notification-header').textContent = notifications.length === 0
        ? 'Notifications'
        : `Notifications (${notifications.length})`;
    panel.querySelector('.se-notification-list').innerHTML = notifications.length === 0
        ? '<div class="se-notification-empty">No notifications.</div>'
        : [...notifications].reverse().map((n) => notificationItemHtml(n, now, failures.get(n.id) || '')).join('');
}

// ---- open / close ----------------------------------------------------------------

export function openNotificationPanel() {
    const button = ensureButton();
    if (!button) return false;
    const panel = ensurePanel();
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    fillPanel(panel, listNotifications());
    positionPanel(panel, button);
    return true;
}

export function closeNotificationPanel() {
    const panel = getPanel();
    if (panel) panel.hidden = true;
    getButton()?.setAttribute('aria-expanded', 'false');
}

export function toggleNotificationPanel() {
    if (isNotificationPanelOpen()) closeNotificationPanel();
    else openNotificationPanel();
}

// ---- clicking a notification -------------------------------------------------------

// Runs the notification's action, then it disappears (the registry change
// redraws the list). If the action cannot run or fails, the notification stays
// and the reason is shown on it.
export async function activateNotification(id) {
    const item = [...document.querySelectorAll(`#${PANEL_ID} .se-notification-item`)].find((el) => el.getAttribute('data-id') === id);
    if (item?.classList.contains('se-notification-busy')) return false;
    item?.classList.add('se-notification-busy');
    try {
        await runNotification(id);
        failures.delete(id);
        return true;
    } catch (err) {
        const reason = err?.message || String(err);
        console.warn(LOG_PREFIX, `notification '${id}' action failed`, err);
        failures.set(id, reason);
        renderNotificationUi();
        return false;
    } finally {
        item?.classList.remove('se-notification-busy');
    }
}

function onDocumentClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.closest(`#${BUTTON_ID}`)) {
        toggleNotificationPanel();
        return;
    }

    const panel = target.closest(`#${PANEL_ID}`);
    if (!panel) {
        if (isNotificationPanelOpen()) closeNotificationPanel(); // clicked elsewhere
        return;
    }

    const dismiss = target.closest('.se-notification-dismiss');
    if (dismiss) {
        removeNotification(dismiss.getAttribute('data-dismiss'));
        return;
    }
    const item = target.closest('.se-notification-item');
    if (item) activateNotification(item.getAttribute('data-id'));
}

function onDocumentKeydown(event) {
    if (event.key === 'Escape' && isNotificationPanelOpen()) {
        closeNotificationPanel();
        getButton()?.focus();
        return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest(`#${BUTTON_ID}`)) {
        event.preventDefault();
        toggleNotificationPanel();
    } else if (target.classList.contains('se-notification-item')) {
        event.preventDefault();
        activateNotification(target.getAttribute('data-id'));
    }
}

// Installs the button, the listeners and the registry subscription. Safe to
// call more than once.
export function initNotificationUi() {
    if (!installed) {
        installed = true;
        document.addEventListener('click', onDocumentClick);
        document.addEventListener('keydown', onDocumentKeydown);
        unsubscribe = subscribeToNotifications(renderNotificationUi);
    }
    renderNotificationUi();
}

// For tests: removes everything initNotificationUi() installed.
export function teardownNotificationUi() {
    if (installed) {
        document.removeEventListener('click', onDocumentClick);
        document.removeEventListener('keydown', onDocumentKeydown);
        unsubscribe?.();
        unsubscribe = null;
        installed = false;
    }
    getButton()?.remove();
    getPanel()?.remove();
    failures.clear();
}
