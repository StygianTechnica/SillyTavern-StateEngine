// Stand-in for src/events/event-engine.js: only dispatchNamespacedEvent()
// matters to the API layer - it emits on the context's event bus, which is
// where a test attaches listeners (context.eventSource.on(...)).

import { vi } from 'vitest';
import context from './context.js';

export const dispatchNamespacedEvent = vi.fn((chatId, eventName) => {
    context.eventSource.emit(eventName, chatId);
    return true;
});

// The real registerEvents() wires SillyTavern's built-in events; nothing here.
export const registerEvents = vi.fn();
