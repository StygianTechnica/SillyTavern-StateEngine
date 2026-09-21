// Notification API
//
// One notification surface for every extension: an extension registers an
// ACTIONABLE notification (a message, a severity, and optionally the id of a
// callback it registered); State Engine shows it behind a single button in the
// chat UI and lists it in a panel; clicking it runs the extension's callback
// and then removes it. The registry itself is src/core/notification-core.js
// (settings-backed notifications + an in-memory callback map); this module is
// the identity-checked public face of it. UI lives in src/ui/notification-ui.js.
//
// Writes (notify, clearNotification, registerNotificationCallback,
// unregisterNotificationCallback) take (extensionId, instanceId, ...) first like
// every other write in this API layer (src/api/identity.js), throw on failure,
// and only ever touch the CALLER's own notifications and callbacks - the source
// of a notification is the caller's namespace, never something it supplies.
// Reads (getNotifications) and invokeNotificationCallback (what the panel
// calls when the user clicks) need no identity.

import { genId } from '../core/variable-schema.js';
import { resolveCallerRecord } from './identity.js';
import {
    NOTIFICATION_SEVERITIES, DEFAULT_SEVERITY,
    notificationId, listNotifications, getNotification, putNotification, removeNotification,
    setCallback, deleteCallback, hasCallback, runNotification,
} from '../core/notification-core.js';

const ALLOWED_FIELDS = new Set(['id', 'severity', 'message', 'callbackId']);
const LOCAL_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_MESSAGE_LENGTH = 500;

function reject(reason) {
    throw new Error(`Notification rejected: ${reason}`);
}

function checkLocalId(value, what) {
    if (typeof value !== 'string' || !LOCAL_ID.test(value)) {
        reject(`${what} must be 1-64 characters of letters, digits and _ . : -`);
    }
}

// Registers (or replaces) the function State Engine calls when the user clicks
// a notification of yours that names `callbackId`. Register at load time, every
// load: functions are not saved, so after a reload a stored notification cannot
// run its action until its extension has registered the callback again. The
// function receives a copy of the notification and may be async; if it throws
// (or rejects), the notification stays so the user can try again.
export function registerNotificationCallback(extensionId, instanceId, callbackId, fn) {
    const record = resolveCallerRecord(extensionId, instanceId);
    checkLocalId(callbackId, 'callbackId');
    if (typeof fn !== 'function') reject('the callback must be a function');
    setCallback(record.namespace, callbackId, fn);
    return true;
}

// Returns whether one was removed. Notifications already naming it stay, and
// will report the action as unavailable until it is registered again.
export function unregisterNotificationCallback(extensionId, instanceId, callbackId) {
    const record = resolveCallerRecord(extensionId, instanceId);
    checkLocalId(callbackId, 'callbackId');
    return deleteCallback(record.namespace, callbackId);
}

// notification = { message, severity?, callbackId?, id? }
//   message     required, non-empty text (trimmed, at most 500 characters)
//   severity    "info" (default), "success", "warning" or "error"
//   callbackId  optional: a callback YOU registered with
//               registerNotificationCallback(); without one, clicking just
//               dismisses the notification
//   id          optional: your own key. Notifying again with the same id
//               REPLACES that notification (new text, fresh timestamp) instead
//               of piling up duplicates. Omitted -> one is generated.
// Returns the notification's id (the form "<your namespace>::<key>") - keep it
// for clearNotification(). Validation finishes before anything is stored.
export function notify(extensionId, instanceId, notification) {
    const record = resolveCallerRecord(extensionId, instanceId);

    if (!notification || typeof notification !== 'object' || Array.isArray(notification)) reject('notification must be an object');
    for (const key of Object.keys(notification)) {
        if (!ALLOWED_FIELDS.has(key)) reject(`unknown field '${key}' (allowed: ${[...ALLOWED_FIELDS].join(', ')})`);
    }

    const message = typeof notification.message === 'string' ? notification.message.trim() : '';
    if (!message) reject('message must be a non-empty string');
    if (message.length > MAX_MESSAGE_LENGTH) reject(`message is longer than ${MAX_MESSAGE_LENGTH} characters`);

    const severity = notification.severity ?? DEFAULT_SEVERITY;
    if (!NOTIFICATION_SEVERITIES.includes(severity)) reject(`severity must be one of: ${NOTIFICATION_SEVERITIES.join(', ')}`);

    let callbackId = null;
    if (notification.callbackId !== undefined && notification.callbackId !== null) {
        callbackId = notification.callbackId;
        checkLocalId(callbackId, 'callbackId');
        if (!hasCallback(record.namespace, callbackId)) {
            reject(`callbackId '${callbackId}' has not been registered - call registerNotificationCallback() first`);
        }
    }

    let localId = notification.id;
    if (localId === undefined || localId === null) localId = genId();
    else checkLocalId(localId, 'id');

    return putNotification({
        id: notificationId(record.namespace, localId),
        source: record.namespace,
        severity,
        message,
        callbackId,
    }).id;
}

// Removes one of YOUR notifications. Returns whether it existed (clearing one
// that is already gone - the user clicked it - is not an error). Throws if the
// id belongs to another extension.
export function clearNotification(extensionId, instanceId, id) {
    const record = resolveCallerRecord(extensionId, instanceId);
    if (typeof id !== 'string' || !id) reject('id must be a non-empty string');
    const existing = getNotification(id);
    if (!existing) return false;
    if (existing.source !== record.namespace) {
        throw new Error(`Notification '${id}' belongs to '${existing.source}', not to extension '${extensionId}'`);
    }
    return removeNotification(id);
}

// Every current notification, oldest first, as copies:
// { id, source, severity, message, timestamp, callbackId }. Open to any caller.
export function getNotifications() {
    return listNotifications();
}

// What the panel calls when the user clicks a notification; it is open to any
// caller like the other reads, so use clearNotification() for your own cleanup.
// Runs the notification's callback, then removes it. Returns a Promise:
//   true   the action ran (or there was none) and the notification is gone
//   false  no such notification
//   rejects  the callback is not registered, or it threw - the notification is
//            kept (see runNotification in src/core/notification-core.js)
export function invokeNotificationCallback(id) {
    return runNotification(id);
}
