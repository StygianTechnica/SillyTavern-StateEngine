// Automatic prompt chunking (requirements spec 1.20, rewritten 2026-09-22) -
// the MAIN per-message prompted update (prompted-engine.js's
// runPromptedStateUpdate). This replaced the earlier named-batch system
// (src/api/batching.js, removed): every prompted/incrementable variable
// across the chat's active presets is now classified with no manual
// scoping, then automatically split into size-bounded, SEQUENTIAL LLM calls
// (src/core/prompt-chunking.js) only when the combined list would be too
// large for one call - the common case (everything fits) behaves byte-for-
// byte like the single-call flow always has. Independent presets' own
// chunking is covered separately in tests/api/independent-presets.test.js.

import context from './harness/context.js';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { runPromptedStateUpdate } from '../src/core/prompted-engine.js';
import { callBackgroundLLM } from '../src/core/background-llm.js';
import { getVar } from '../src/core/chat-state.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

const { setStatus } = await import('../src/ui/settings-panel-ui.js');

let instanceId;

const createPromptedVar = (name, extra = {}) => stateEngine.createVariable('pp', instanceId, {
    namespace: 'pp', presetName: 'Demo', name, type: 'string', defaultValue: 'calm',
    behaviors: { prompted: true, increment: false }, prompted: { instructions: `describe ${name}` }, ...extra,
});
const stored = (name) => getVar('chat-1', `pp__${name}`)?.value;
const runAi = async () => {
    context.chat = [{ is_user: true, mes: 'they wait' }, { is_user: false, name: 'Bot', mes: 'Time passes.' }];
    await runPromptedStateUpdate('ai');
};

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
    stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
    callBackgroundLLM.mockReset();
    setStatus.mockReset();
});

describe('automatic prompt chunking - main per-message update', () => {
    it('everything fits in one chunk (the common case): exactly one LLM call, unchanged status text', async () => {
        createPromptedVar('mood');
        createPromptedVar('weather');
        callBackgroundLLM.mockResolvedValue('{"pp__mood":"tense","pp__weather":"stormy"}');

        await runAi();

        await vi.waitFor(() => expect(stored('mood')).toBe('tense'));
        expect(stored('weather')).toBe('stormy');
        expect(callBackgroundLLM).toHaveBeenCalledTimes(1);
        // Exactly the pre-chunking single-call status text - no "part 1 of 1" framing.
        expect(setStatus).toHaveBeenCalledWith('State updated (2/2 variables, 0/0 incremented).');
        expect(setStatus).not.toHaveBeenCalledWith(expect.stringContaining('part'));
    });

    it('an oversized set splits into several SEQUENTIAL calls, each with only its own chunk\'s variables', async () => {
        for (let i = 0; i < 6; i++) createPromptedVar(`v${i}`);
        settings.get().maxPromptedVariableChars = 90;

        const seenInEachCall = [];
        callBackgroundLLM.mockImplementation(async (_ctx, _settings, messages) => {
            const body = messages[0].content;
            const names = [0, 1, 2, 3, 4, 5].filter((i) => body.includes(`pp__v${i}`));
            seenInEachCall.push(names);
            return JSON.stringify(Object.fromEntries(names.map((i) => [`pp__v${i}`, `answer${i}`])));
        });

        await runAi();

        await vi.waitFor(() => expect(stored('v5')).toBe('answer5'));
        expect(callBackgroundLLM.mock.calls.length).toBeGreaterThan(1);
        // Every variable was asked about in EXACTLY one call - chunks partition, never overlap or omit.
        const allSeen = seenInEachCall.flat();
        expect(allSeen.sort()).toEqual([0, 1, 2, 3, 4, 5]);
        expect(new Set(allSeen).size).toBe(6);
        for (let i = 0; i < 6; i++) expect(stored(`v${i}`)).toBe(`answer${i}`);
    });

    it('shows an interim "part N of M" status between chunks, and a combined final status covering all of them', async () => {
        for (let i = 0; i < 4; i++) createPromptedVar(`v${i}`);
        settings.get().maxPromptedVariableChars = 90;
        callBackgroundLLM.mockImplementation(async (_ctx, _settings, messages) => {
            const body = messages[0].content;
            const names = [0, 1, 2, 3].filter((i) => body.includes(`pp__v${i}`));
            return JSON.stringify(Object.fromEntries(names.map((i) => [`pp__v${i}`, `a${i}`])));
        });

        await runAi();

        await vi.waitFor(() => expect(stored('v3')).toBe('a3'));
        const messages = setStatus.mock.calls.map((c) => c[0]);
        expect(messages).toContain('Updating state…');
        expect(messages.some((m) => /^Updating state \(part 1 of \d+\)…$/.test(m))).toBe(true);
        const final = messages[messages.length - 1];
        expect(final).toMatch(/^State updated \(4\/4 variables, 0\/0 incremented\)\.$/);
    });

    it('sequential, never parallel: the second chunk\'s call only starts after the first one\'s promise resolves', async () => {
        createPromptedVar('a');
        createPromptedVar('b');
        settings.get().maxPromptedVariableChars = 30; // forces a and b into separate chunks

        let firstResolved = false;
        let secondCallSawFirstResolved = null;
        let call = 0;
        callBackgroundLLM.mockImplementation(async () => {
            call++;
            if (call === 1) {
                await new Promise((resolve) => setTimeout(resolve, 5));
                firstResolved = true;
                return '{"pp__a":"x"}';
            }
            secondCallSawFirstResolved = firstResolved;
            return '{"pp__b":"y"}';
        });

        await runAi();

        await vi.waitFor(() => expect(stored('b')).toBe('y'));
        expect(secondCallSawFirstResolved).toBe(true);
        expect(stored('a')).toBe('x');
    });

    it('one chunk failing to parse does not stop the remaining chunks from running or writing', async () => {
        for (let i = 0; i < 4; i++) createPromptedVar(`v${i}`);
        settings.get().maxPromptedVariableChars = 90;

        let call = 0;
        callBackgroundLLM.mockImplementation(async (_ctx, _settings, messages) => {
            call++;
            if (call === 1) return 'not json at all';
            const body = messages[0].content;
            const names = [0, 1, 2, 3].filter((i) => body.includes(`pp__v${i}`));
            return JSON.stringify(Object.fromEntries(names.map((i) => [`pp__v${i}`, `a${i}`])));
        });

        await runAi();

        await vi.waitFor(() => expect(callBackgroundLLM.mock.calls.length).toBeGreaterThan(1));
        await vi.waitFor(() => expect([0, 1, 2, 3].some((i) => stored(`v${i}`) !== 'calm')).toBe(true));
        const values = [0, 1, 2, 3].map((i) => stored(`v${i}`));
        expect(values).toContain('calm'); // the failed chunk's variable(s) stayed at default
    });

    it('a background-LLM rejection on a single chunk is logged and the run continues to the next chunk', async () => {
        for (let i = 0; i < 4; i++) createPromptedVar(`v${i}`);
        settings.get().maxPromptedVariableChars = 90;

        let call = 0;
        callBackgroundLLM.mockImplementation(async (_ctx, _settings, messages) => {
            call++;
            if (call === 1) throw new Error('network exploded');
            const body = messages[0].content;
            const names = [0, 1, 2, 3].filter((i) => body.includes(`pp__v${i}`));
            return JSON.stringify(Object.fromEntries(names.map((i) => [`pp__v${i}`, `a${i}`])));
        });

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await runAi();
        await vi.waitFor(() => expect(callBackgroundLLM.mock.calls.length).toBeGreaterThan(1));
        await vi.waitFor(() => expect([0, 1, 2, 3].some((i) => stored(`v${i}`) !== 'calm')).toBe(true));
        warn.mockRestore();
    });

    it('increment (boolean-conditional) variables chunk alongside update variables', async () => {
        createPromptedVar('mood');
        stateEngine.createVariable('pp', instanceId, {
            namespace: 'pp', presetName: 'Demo', name: 'leveledUp', type: 'number', defaultValue: 0,
            behaviors: { prompted: true, increment: true }, increment: { delta: 1, triggers: ['ai'] },
            prompted: { instructions: 'true if the character leveled up' },
        });
        callBackgroundLLM.mockResolvedValue('{"pp__mood":"tense","pp__leveledUp":true}');

        await runAi();

        await vi.waitFor(() => expect(stored('leveledUp')).toBe(1));
        expect(stored('mood')).toBe('tense');
        expect(setStatus).toHaveBeenCalledWith('State updated (1/1 variables, 1/1 incremented).');
    });

    it('a custom maxPromptedVariableChars actually drives the split point - not just the default', async () => {
        createPromptedVar('a');
        createPromptedVar('b');
        callBackgroundLLM.mockResolvedValue('{"pp__a":"x","pp__b":"y"}');

        settings.get().maxPromptedVariableChars = 100000; // generous - fits in one call
        await runAi();
        await vi.waitFor(() => expect(stored('a')).toBe('x'));
        expect(callBackgroundLLM).toHaveBeenCalledTimes(1);

        callBackgroundLLM.mockClear();
        settings.get().maxPromptedVariableChars = 10; // forces a split
        callBackgroundLLM.mockResolvedValue('{}');
        await runAi();
        await vi.waitFor(() => expect(callBackgroundLLM.mock.calls.length).toBeGreaterThan(1));
    });
});
