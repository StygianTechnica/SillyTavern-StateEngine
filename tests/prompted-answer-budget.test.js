// Answers cut off (2026-10-28): the main update sizes its chunks by the
// answer the model may write back as well as by the prompt, narrows that
// budget when an answer comes back cut off (and widens it again once
// answers come back whole), and asks once more for what an answer left out.
// The reported chat: a small model's 1500-token answer stopped before the
// characters' thought, mood and intent - asked last - every turn.

import context from './harness/context.js';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { runPromptedStateUpdate, adaptAnswerScale, answerBudget, leftoverOf, ANSWER_SCALE_MIN } from '../src/core/prompted-engine.js';
import { chunkPromptUnits } from '../src/core/prompt-chunking.js';
import { callBackgroundLLM } from '../src/core/background-llm.js';
import { getVar } from '../src/core/chat-state.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

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
    settings.get().promptedAnswerScale = 1;
    settings.get().promptedCompleteStreak = 0;
});

describe('chunks sized by the answer', () => {
    it('splits where the answers would not fit, even when the questions do', () => {
        const units = [1, 2, 3, 4].map((i) => ({ id: i, size: 10, answer: 300 }));
        expect(chunkPromptUnits(units, 1000).length).toBe(1);
        expect(chunkPromptUnits(units, 1000, 650).map((c) => c.map((u) => u.id))).toEqual([[1, 2], [3, 4]]);
        // A unit bigger than the whole budget still gets its own chunk.
        expect(chunkPromptUnits([{ size: 1, answer: 5000 }], 1000, 650).length).toBe(1);
    });

    it('narrows the active budget after a cut, and widens it back after answers come back whole', () => {
        const s = { responseLength: 1000, promptedAnswerScale: 1, promptedCompleteStreak: 0 };
        const full = answerBudget(s);
        expect(adaptAnswerScale(s, { cut: true })).toEqual({ scale: 0.75, changed: true });
        expect(answerBudget(s)).toBe(Math.round(full * 0.75));
        for (let i = 0; i < 6; i++) adaptAnswerScale(s, { cut: true });
        expect(s.promptedAnswerScale).toBe(ANSWER_SCALE_MIN);
        // Four whole answers: not yet; the fifth grows it by a tenth.
        for (let i = 0; i < 4; i++) expect(adaptAnswerScale(s, { cut: false }).changed).toBe(false);
        expect(adaptAnswerScale(s, { cut: false })).toEqual({ scale: 0.28, changed: true });
        // Never past the configured size.
        const top = { promptedAnswerScale: 1, promptedCompleteStreak: 4 };
        expect(adaptAnswerScale(top, { cut: false })).toEqual({ scale: 1, changed: false });
    });

    it('finds what a cut-off answer never reached, and a runtime key left out', () => {
        const a = { name: 'pp__a' };
        const b = { name: 'pp__b' };
        const runtime = [{ type: 'character', defs: [] }];
        expect(leftoverOf({ pp__a: 'x' }, { updateVars: [a, b], runtime, cut: true })).toEqual({ updateVars: [b], incrementVars: [], runtime });
        // Whole answer: a plain variable left out is the model's choice; the characters' key is not.
        expect(leftoverOf({ pp__a: 'x' }, { updateVars: [a, b], runtime, cut: false })).toEqual({ updateVars: [], incrementVars: [], runtime });
        expect(leftoverOf({ pp__a: 'x', pp__b: 'y', __characters: {} }, { updateVars: [a, b], runtime })).toBeNull();
    });
});

describe('the main update after a cut-off answer', () => {
    it('asks once more for what was cut off, and chunks smaller from then on', async () => {
        createPromptedVar('mood');
        createPromptedVar('weather');
        const asked = [];
        callBackgroundLLM.mockImplementation(async (_ctx, _settings, messages) => {
            const body = messages[0].content;
            asked.push(['mood', 'weather'].filter((n) => body.includes(`"pp__${n}"`)));
            // The first answer stops partway through its second value.
            return asked.length === 1 ? '{"pp__mood":"tense","pp__weather":"sto' : '{"pp__weather":"stormy"}';
        });

        await runAi();

        await vi.waitFor(() => expect(stored('weather')).toBe('stormy'));
        expect(stored('mood')).toBe('tense');
        expect(asked).toEqual([['mood', 'weather'], ['weather']]);
        expect(settings.get().promptedAnswerScale).toBe(0.75);
    });

    it('asks only once more, however the second answer goes', async () => {
        createPromptedVar('mood');
        createPromptedVar('weather');
        callBackgroundLLM.mockResolvedValue('{"pp__mood":"tense","pp__weather":"sto');

        await runAi();

        await vi.waitFor(() => expect(callBackgroundLLM).toHaveBeenCalledTimes(2));
        await new Promise((r) => setTimeout(r, 20));
        expect(callBackgroundLLM).toHaveBeenCalledTimes(2);
    });

    it('makes no second call when the answer comes back whole', async () => {
        createPromptedVar('mood');
        callBackgroundLLM.mockResolvedValue('{"pp__mood":"tense"}');

        await runAi();

        await vi.waitFor(() => expect(stored('mood')).toBe('tense'));
        await new Promise((r) => setTimeout(r, 20));
        expect(callBackgroundLLM).toHaveBeenCalledTimes(1);
        expect(settings.get().promptedCompleteStreak).toBe(1);
    });
});
