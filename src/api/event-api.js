// Event API
//
// registerEventSource() is a namespace-scoped declaration only — it does
// not itself attach a SillyTavern eventSource.on() listener (there is no
// "subscribe"/"unregisterEventSource" function in this API surface to pair
// with one). fireEvent() dispatches through
// src/events/event-engine.js's dispatchNamespacedEvent(), which emits on
// the same eventSource instance event-engine.js's own built-in listeners
// are registered on — any code that wants to react to a namespaced event
// listens on that same bus via
// SillyTavern.getContext().eventSource.on(eventName, ...).

import { LOG_PREFIX, getSettings, persistSettings } from '../core/settings-core.js';
import { validateNamespace } from './namespace-manager.js';
import { dispatchNamespacedEvent } from '../events/event-engine.js';

function getEventSourcesStore() {
    const settings = getSettings();
    if (!settings.eventSources || typeof settings.eventSources !== 'object') {
        settings.eventSources = {};
    }
    return settings.eventSources;
}

// info: { namespace, eventName, ... }. Stored under the qualified key
// "namespace.eventName" so fireEvent()'s namespace-prefix check and this
// registry agree on the same addressing.
export function registerEventSource(info) {
    try {
        if (!info || !info.namespace || !info.eventName) {
            console.warn(LOG_PREFIX, 'registerEventSource requires info.namespace and info.eventName');
            return null;
        }
        if (!validateNamespace(info.namespace)) {
            console.warn(LOG_PREFIX, `registerEventSource: namespace "${info.namespace}" is not registered`);
            return null;
        }
        const qualified = `${info.namespace}.${info.eventName}`;
        const store = getEventSourcesStore();
        store[qualified] = { ...info, eventName: qualified, registeredAt: Date.now() };
        persistSettings();
        return qualified;
    } catch (err) {
        console.warn(LOG_PREFIX, 'registerEventSource failed (gracefully handled)', err);
        return null;
    }
}

// eventName must already be namespace-qualified ("pp.rollDice"). Only the
// namespace prefix is validated here (per this pass's instructions) — not
// whether this exact event was previously registered via
// registerEventSource(), so an unregistered-but-namespace-valid event name
// still dispatches.
export function fireEvent(chatId, eventName) {
    try {
        if (!eventName || typeof eventName !== 'string' || !eventName.includes('.')) {
            console.warn(LOG_PREFIX, `fireEvent: "${eventName}" is not a namespace-qualified event name`);
            return false;
        }
        const namespace = eventName.slice(0, eventName.indexOf('.'));
        if (!validateNamespace(namespace)) {
            console.warn(LOG_PREFIX, `fireEvent: namespace "${namespace}" is not registered`);
            return false;
        }
        return dispatchNamespacedEvent(chatId, eventName);
    } catch (err) {
        console.warn(LOG_PREFIX, 'fireEvent failed (gracefully handled)', err);
        return false;
    }
}
