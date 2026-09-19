// Fake SillyTavern extension context - the object SillyTavern.getContext()
// returns inside the real extension. One shared singleton, reset in place
// between tests (resetContext) so every module that already captured a
// reference to it keeps seeing the live object.

import { vi } from 'vitest';

// Must be the very first thing that runs: src/core/settings-core.js touches
// `window` at module load, and this file is the first import in setup.js.
globalThis.window ??= globalThis;

function mapStore() {
    // macro-store.js uses .has/.get/.set/.del (SillyTavern's variable store
    // uses `del`, not `delete`).
    const m = new Map();
    m.del = (key) => m.delete(key);
    return m;
}

function makeEventSource() {
    return {
        listeners: {},
        on(event, fn) { (this.listeners[event] ??= []).push(fn); },
        // Listeners are invoked synchronously (in registration order) so a
        // test can assert on side effects immediately after fireEvent().
        emit(event, ...args) {
            return Promise.all((this.listeners[event] || []).map((fn) => fn(...args)));
        },
    };
}

const context = {
    extensionSettings: {},
    chatId: 'chat-1',
    chat: [],
    name1: 'User',
    name2: 'Character',
    variables: { local: mapStore(), global: mapStore() },
    eventSource: makeEventSource(),
    eventTypes: {},
    saveSettingsDebounced: vi.fn(),
    registerMacro: vi.fn(),
    unregisterMacro: vi.fn(),
    generateRaw: vi.fn(async () => ''),
};

export function resetContext() {
    context.extensionSettings = {};
    context.chatId = 'chat-1';
    context.chat = [];
    context.variables = { local: mapStore(), global: mapStore() };
    context.eventSource = makeEventSource();
    context.saveSettingsDebounced.mockClear();
    context.registerMacro.mockClear();
    context.unregisterMacro.mockClear();
    context.generateRaw.mockClear();
    return context;
}

// jQuery-shaped no-op: several UI modules only touch `$` inside functions,
// but a few reference it on import paths.
const jq = () => ({ length: 0, on() { return this; }, off() { return this; }, find() { return jq(); }, empty() { return this; } });

export function installContext() {
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.$ = jq;
    globalThis.jQuery = jq;
}

export default context;
