// Boolean "flag mode" (requirements spec 1.28): the variable API (createVariable /
// updateVariable), and the prompted engines (the main one and independent presets)
// leaving an already-true flag out of the prompt entirely.
//
// The prompted-engine assertions need the REAL chat-state.js (its write-path gate is
// what actually stops a "false" answer from sticking) - the harness's simplified mock
// does not implement it - so chat-state is re-mocked to its own real implementation,
// the same pattern tests/tracker-refresh.test.js already established for this reason.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import { getVar, setVar } from '../../src/core/chat-state.js';
import { runPromptedStateUpdate } from '../../src/core/prompted-engine.js';
import { callBackgroundLLM } from '../../src/core/background-llm.js';

vi.mock('../../src/core/chat-state.js', async () => vi.importActual('../../src/core/chat-state.js'));
vi.mock('../../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

let instanceId;
const create = (name, extra = {}, ext = 'pp') => stateEngine.createVariable(ext, instanceId, { namespace: ext, presetName: 'Demo', name, type: 'boolean', ...extra });
const update = (name, patch, ext = 'pp') => stateEngine.updateVariable(ext, instanceId, { namespace: ext, presetName: 'Demo', variableName: name }, patch);
const read = (name, ext = 'pp') => stateEngine.getVariable(ext, instanceId, { namespace: ext, presetName: 'Demo', variableName: name });

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
    stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
    callBackgroundLLM.mockReset();
});

describe('createVariable / updateVariable: flagMode', () => {
    it('creates a flag-mode boolean, forced to start false even with a truthy default', () => {
        expect(create('ready', { flagMode: true })).toMatchObject({ type: 'boolean', flagMode: true, defaultValue: false });
        expect(create('primed', { flagMode: true, defaultValue: true })).toMatchObject({ flagMode: true, defaultValue: false });
    });

    it('flagMode must be a real boolean, or nothing is stored', () => {
        expect(create('bad', { flagMode: 'true' })).toBe(null);
        expect(create('bad2', { flagMode: 1 })).toBe(null);
        expect(read('bad')).toBeUndefined();
    });

    it('flagMode defaults to false (an ordinary boolean) when omitted', () => {
        expect(create('plain').flagMode).toBe(false);
    });

    it('updateVariable can turn flagMode on or off', () => {
        create('ready');
        expect(update('ready', { flagMode: true })).toMatchObject({ flagMode: true, defaultValue: false });
        expect(update('ready', { flagMode: false })).toMatchObject({ flagMode: false });
    });

    it('defaultValue is forced false whenever type is boolean and flagMode is true - even a patch that explicitly gives true', () => {
        create('thing', { type: 'string', flagMode: false });
        expect(update('thing', { type: 'boolean', flagMode: true })).toMatchObject({ defaultValue: false });
        expect(update('thing', { defaultValue: true })).toMatchObject({ flagMode: true, defaultValue: false });
    });

    it('flagMode on a non-boolean type is accepted (inert) rather than rejected, like itemType on a non-array', () => {
        const v = stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', name: 'note', type: 'string', flagMode: true, defaultValue: 'hi' });
        expect(v).toMatchObject({ type: 'string', flagMode: true, defaultValue: 'hi' });
    });
});

describe('the prompted engine leaves a spent flag out of the prompt entirely', () => {
    const flag = (name, extra = {}) => create(name, { flagMode: true, behaviors: { prompted: true, increment: false }, prompted: { instructions: `set ${name} when it happens` }, ...extra });
    const runAi = async () => {
        context.chat = [{ is_user: true, mes: 'hello there' }, { is_user: false, name: 'Bot', mes: 'hi' }];
        await runPromptedStateUpdate('ai');
    };
    const systemPrompt = () => callBackgroundLLM.mock.calls[0][2][0].content;

    it('a still-false flag is asked about, with wording that says it is one-way', async () => {
        flag('twist');
        callBackgroundLLM.mockResolvedValue('{"pp__twist":true}');
        await runAi();
        expect(systemPrompt()).toContain('pp__twist');
        expect(systemPrompt()).toMatch(/one-way flag/);
        await vi.waitFor(() => expect(getVar('chat-1', 'pp__twist')?.value).toBe(true));
    });

    it('once true, it is left out of the prompt on every later run - even alongside other variables that still update', async () => {
        flag('twist');
        create('mood', { type: 'string', defaultValue: 'calm', flagMode: false, behaviors: { prompted: true, increment: false }, prompted: { instructions: 'infer mood' } });
        callBackgroundLLM.mockResolvedValue('{"pp__twist":true,"pp__mood":"tense"}');
        await runAi();
        await vi.waitFor(() => expect(getVar('chat-1', 'pp__twist')?.value).toBe(true));

        callBackgroundLLM.mockClear();
        callBackgroundLLM.mockResolvedValue('{"pp__mood":"calm"}');
        await runAi();
        expect(systemPrompt()).not.toContain('pp__twist');
        expect(systemPrompt()).toContain('pp__mood');
    });

    it('even if a later prompted run somehow still named it, the answer false could never stick (defense in depth)', async () => {
        const d = flag('twist');
        setVar('chat-1', d.name, true, d); // already fired, out of band
        // Simulate the write path directly (what a prompted "false" answer would attempt).
        setVar('chat-1', d.name, false, d);
        expect(getVar('chat-1', d.name).value).toBe(true);
    });

    it('with only a spent flag and nothing else prompted, the LLM is not called at all', async () => {
        const d = flag('twist');
        setVar('chat-1', d.name, true, d);
        await runAi();
        expect(callBackgroundLLM).not.toHaveBeenCalled();
    });

    it('a flag-mode boolean used as a prompted INCREMENT (true/false trigger) is excluded once it has fired too', async () => {
        const d = create('surge', { flagMode: true, behaviors: { prompted: true, increment: true }, prompted: { instructions: 'trigger the surge' } });
        callBackgroundLLM.mockResolvedValue('{"pp__surge":true}');
        await runAi();
        await vi.waitFor(() => expect(getVar('chat-1', d.name)?.value).toBe(true));

        callBackgroundLLM.mockClear();
        callBackgroundLLM.mockResolvedValue('{}');
        await runAi();
        expect(callBackgroundLLM).not.toHaveBeenCalled(); // nothing left to ask
    });

    it('an ordinary (non-flag) prompted boolean keeps being asked every run, true or false', async () => {
        create('awake', { flagMode: false, behaviors: { prompted: true, increment: false }, prompted: { instructions: 'is the character awake' } });
        callBackgroundLLM.mockResolvedValue('{"pp__awake":true}');
        await runAi();
        await vi.waitFor(() => expect(getVar('chat-1', 'pp__awake')?.value).toBe(true));

        callBackgroundLLM.mockClear();
        callBackgroundLLM.mockResolvedValue('{"pp__awake":false}');
        await runAi();
        expect(systemPrompt()).toContain('pp__awake');
        await vi.waitFor(() => expect(getVar('chat-1', 'pp__awake')?.value).toBe(false));
    });
});

describe('independent presets: the same flag-exclusion rule', () => {
    it('a spent flag is left out of an independent preset\'s prompt too', async () => {
        const d = create('unlocked', { flagMode: true, behaviors: { prompted: true, increment: false }, prompted: { instructions: 'unlock it' } });
        setVar('chat-1', d.name, true, d);
        context.chat = [{ is_user: true, mes: 'hi' }, { is_user: false, name: 'Bot', mes: 'hey' }];
        callBackgroundLLM.mockResolvedValue('{}');

        const ran = stateEngine.runIndependentPreset('pp', instanceId, 'chat-1', { namespace: 'pp', name: 'Demo' });
        expect(typeof ran).toBe('object'); // a Promise, not a synchronous throw
        await ran;
        expect(callBackgroundLLM).not.toHaveBeenCalled();
    });
});
