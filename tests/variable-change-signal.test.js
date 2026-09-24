// The REAL chat-state.js write paths must emit the change signal - the
// harness mocks chat-state.js for every other suite, so it is loaded with
// vi.importActual here.
import context from './harness/context.js';
import { VARIABLES_CHANGED_EVENT, notifyVariablesChanged } from '../src/core/variable-change-signal.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let realChatState;

beforeEach(async () => {
    realChatState = await vi.importActual('../src/core/chat-state.js');
    context.eventSource.emit = vi.fn();
});

describe('variable change signal', () => {
    it('coalesces a burst into one event per chat', async () => {
        notifyVariablesChanged('chat-1');
        notifyVariablesChanged('chat-1');
        notifyVariablesChanged('chat-2');
        expect(context.eventSource.emit).not.toHaveBeenCalled();
        await flush();
        expect(context.eventSource.emit.mock.calls).toEqual([
            [VARIABLES_CHANGED_EVENT, 'chat-1'],
            [VARIABLES_CHANGED_EVENT, 'chat-2'],
        ]);
    });

    it('never throws when a listener fails', async () => {
        context.eventSource.emit = vi.fn(() => Promise.reject(new Error('boom')));
        notifyVariablesChanged('chat-1');
        await flush();
        expect(context.eventSource.emit).toHaveBeenCalledTimes(1);
    });

    it('fires from the real setVar() (via saveChatState)', async () => {
        realChatState.setVar('chat-9', 'se__x', 5, { name: 'se__x', type: 'number', scope: 'chat' });
        await flush();
        expect(context.eventSource.emit).toHaveBeenCalledWith(VARIABLES_CHANGED_EVENT, 'chat-9');
    });

    it('fires (for every chat) from the real deleteVariableValueEverywhere()', async () => {
        realChatState.setVar('chat-9', 'se__x', 5, { name: 'se__x', type: 'number', scope: 'chat' });
        await flush();
        context.eventSource.emit.mockClear();
        realChatState.deleteVariableValueEverywhere('se__x');
        await flush();
        expect(context.eventSource.emit).toHaveBeenCalledWith(VARIABLES_CHANGED_EVENT, null);
    });
});
