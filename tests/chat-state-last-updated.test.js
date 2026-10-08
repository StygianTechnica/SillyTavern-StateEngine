// chat-state.js saveChatState() stamps lastUpdated on every write, so "the most
// recent chat" (findPreviousChat, the Variable Management list) means the chat
// most recently written to - not the one most recently created. The harness mocks
// chat-state.js, so the REAL module is loaded here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import settings from './harness/settings.js';
import { blankDefinition } from '../src/core/variable-schema.js';

const realChatState = await vi.importActual('../src/core/chat-state.js');

const def = { ...blankDefinition(), id: 'v-n', name: 'se__n', type: 'number' };

beforeEach(() => {
    settings.reset();
    vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('lastUpdated', () => {
    it('is the time of the last write, not of creation', () => {
        vi.setSystemTime(1000);
        realChatState.setVar('chat-a', def.name, 1, def);
        expect(realChatState.loadChatState('chat-a').lastUpdated).toBe(1000);

        vi.setSystemTime(5000);
        realChatState.setVar('chat-a', def.name, 2, def);
        expect(realChatState.loadChatState('chat-a').lastUpdated).toBe(5000);
    });

    it('an older chat written to after a newer one was created becomes the more recent', () => {
        vi.setSystemTime(1000);
        realChatState.setVar('older', def.name, 1, def);
        vi.setSystemTime(2000);
        realChatState.setVar('newer', def.name, 1, def);
        vi.setSystemTime(3000);
        realChatState.setVar('older', def.name, 5, def);

        const { older, newer } = settings.get().variableStore.chats;
        expect(older.lastUpdated).toBeGreaterThan(newer.lastUpdated);
    });
});
