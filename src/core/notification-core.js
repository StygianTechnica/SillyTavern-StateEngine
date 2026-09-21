// State Engine — Notification Core: the registry behind the notification button
// and panel (src/ui/notification-ui.js) and the notification API
// (src/api/notification-api.js).
//
// TWO registries, deliberately different in how they persist:
//
//   notifications  settings.notifications - a plain array of
//                  { id, source, severity, message, timestamp, callbackId }.
//                  Persisted with the rest of the settings, so a notification
//                  survives a reload. Functions are NEVER stored here: a
//                  notification only names its callback (callbackId).
//
//   callbacks      an in-memory Map of "<namespace>::<callbackId>" -> function.
//                  Functions cannot be serialized, so this is rebuilt every
//                  page load by each extension registering its callbacks again
//                  (which is what "extensions register callbacks by ID" means).
//                  Until an extension has done that, its persisted
//                  notifications are still listed but cannot run their action.
//
// This module does no identity checking - callers are the API layer (which
// does) and the panel (State Engine's own UI). Nothing here expires a
// notification: one stays until it is cleared, or its callback has run.

import { LOG_PREFIX, getSettings, persistSettings } from './settings-core.js';

export const NOTIFICATION_SEVERITIES = Object.freeze(['info', 'success', 'warning', 'error']);
export const DEFAULT_SEVERITY = 'info';

// Where a notification's id is joined to its source: "<namespace>::<localId>".
const ID_SEPARATOR = '::';

const callbacks = new Map();
const listeners = new Set();
const running = new Set(); // notification ids whose callback is in flight

const callbackKey = (namespace, callbackId) => `${namespace}${ID_SEPARATOR}${callbackId}`;

function store() {
    const settings = getSettings();
    if (!Array.isArray(settings.notifications)) settings.notifications = [];
    return settings.notifications;
}

export function notificationId(namespace, localId) {
    return `${namespace}${ID_SEPARATOR}${localId}`;
}

// ---- change listeners (the button/panel re-render from these) --------------

// Registers `listener()`; returns a function that removes it. A listener that
// throws never stops the others, or the change itself.
export function subscribeToNotifications(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function changed() {
    for (const listener of [...listeners]) {
        try { listener(); } catch (err) { console.warn(LOG_PREFIX, 'notification listener failed (gracefully handled)', err); }
    }
}

// ---- notifications ----------------------------------------------------------

// Copies, oldest first - the stored objects are never handed out.
export function listNotifications() {
    return store().map((n) => ({ ...n }));
}

export function getNotification(id) {
    const found = store().find((n) => n.id === id);
    return found ? { ...found } : null;
}

// Adds a notification, or REPLACES the one with the same id (same source and
// local id): the replacement takes the new message/severity/callback and a fresh
// timestamp, and moves to the end. `record` must already be validated - see
// notification-api.js. Persists. Returns the stored copy.
export function putNotification(record) {
    const list = store();
    const stored = {
        id: record.id,
        source: record.source,
        severity: record.severity,
        message: record.message,
        timestamp: record.timestamp ?? Date.now(),
        callbackId: record.callbackId ?? null,
    };
    const at = list.findIndex((n) => n.id === stored.id);
    if (at !== -1) list.splice(at, 1);
    list.push(stored);
    persistSettings();
    changed();
    return { ...stored };
}

// Removes a notification. Returns whether one was removed. Persists.
export function removeNotification(id) {
    const list = store();
    const at = list.findIndex((n) => n.id === id);
    if (at === -1) return false;
    list.splice(at, 1);
    persistSettings();
    changed();
    return true;
}

// ---- callbacks --------------------------------------------------------------

// Registers (or replaces - an extension that reloads registers again) the
// function called for notifications naming `callbackId` in `namespace`.
export function setCallback(namespace, callbackId, fn) {
    callbacks.set(callbackKey(namespace, callbackId), fn);
}

// Returns whether a callback was removed.
export function deleteCallback(namespace, callbackId) {
    return callbacks.delete(callbackKey(namespace, callbackId));
}

export function hasCallback(namespace, callbackId) {
    return callbacks.has(callbackKey(namespace, callbackId));
}

// ---- invoking ----------------------------------------------------------------

// Runs the callback a notification names, then removes the notification.
//   - unknown id                      -> resolves false (nothing happened)
//   - no callbackId                   -> just removes it, resolves true
//   - callback not registered (its extension has not loaded, or was removed)
//                                     -> REJECTS, notification kept
//   - callback throws / rejects       -> REJECTS with that error, notification
//                                     kept, so the user can try again
//   - callback returns (or resolves)  -> notification removed, resolves true
// Removal happens only AFTER the callback succeeds. The callback is called with
// a copy of the notification. A second call for a notification that is already
// running rejects rather than running the action twice (a double click).
export async function runNotification(id) {
    const notification = getNotification(id);
    if (!notification) return false;

    if (notification.callbackId) {
        if (running.has(id)) throw new Error(`Notification '${id}' is already running its action`);
        const fn = callbacks.get(callbackKey(notification.source, notification.callbackId));
        if (typeof fn !== 'function') {
            throw new Error(`The action for this notification is not available: extension '${notification.source}' has not registered callback '${notification.callbackId}' (is it loaded?)`);
        }
        running.add(id);
        try {
            await fn({ ...notification });
        } finally {
            running.delete(id);
        }
    }

    removeNotification(id); // already gone if the callback cleared it itself
    return true;
}

// For tests: forgets every registered callback, running flag and listener (the
// callback map lives in memory only, so it outlives a test's settings reset).
export function resetNotificationRuntimeForTests() {
    callbacks.clear();
    running.clear();
    listeners.clear();
}
