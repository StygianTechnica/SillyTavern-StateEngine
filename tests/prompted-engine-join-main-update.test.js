// independentConfig.joinMainUpdate - whether an independent preset that is
// active for a chat also rides the MAIN per-message prompted update
// (prompted-engine.js's runPromptedStateUpdate). Off by default: an
// independent preset only ever runs on its own (runIndependentPreset).

import context from './harness/context.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { runPromptedStateUpdate } from '../src/core/prompted-engine.js';
import { callBackgroundLLM } from '../src/core/background-llm.js';
import { getVar } from '../src/core/chat-state.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

let instanceId;

const stored = (name) => getVar('chat-1', `pp__${name}`)?.value;
const promptedVar = (presetName, name) => stateEngine.createVariable('pp', instanceId, {
    namespace: 'pp', presetName, name, type: 'string', defaultValue: 'calm',
    behaviors: { prompted: true, increment: false }, prompted: { instructions: `describe ${name}` },
});
const run = async (trigger = 'ai') => {
    context.chat = [{ is_user: true, mes: 'they wait' }, { is_user: false, name: 'Bot', mes: 'Time passes.' }];
    await runPromptedStateUpdate(trigger);
};
const askedAbout = () => callBackgroundLLM.mock.calls.map((call) => call[2][0].content).join('\n');

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Regular' });
    stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Regular');
    promptedVar('Regular', 'mood');
    stateEngine.createIndependentPreset('pp', instanceId, { namespace: 'pp', name: 'Indy' });
    stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Indy');
    promptedVar('Indy', 'memo');
    callBackgroundLLM.mockReset();
    callBackgroundLLM.mockResolvedValue('{"pp__mood":"tense","pp__memo":"noted"}');
});

describe('joinMainUpdate', () => {
    it('defaults to false: an active independent preset is left out of the main update', async () => {
        await run();
        await vi.waitFor(() => expect(stored('mood')).toBe('tense'));
        expect(askedAbout()).not.toContain('pp__memo');
        expect(stored('memo')).not.toBe('noted');
    });

    it('also leaves it out of a manual "update all" run', async () => {
        await run('manual-all');
        await vi.waitFor(() => expect(stored('mood')).toBe('tense'));
        expect(askedAbout()).not.toContain('pp__memo');
    });

    it('true: its variables join the same main-update call', async () => {
        expect(stateEngine.configureIndependentPreset('pp', instanceId, 'pp', 'Indy', { joinMainUpdate: true })).toMatchObject({ joinMainUpdate: true });
        await run();
        await vi.waitFor(() => expect(stored('memo')).toBe('noted'));
        expect(stored('mood')).toBe('tense');
        expect(callBackgroundLLM).toHaveBeenCalledTimes(1);
    });

    it('is ignored while the independent preset is disabled', async () => {
        stateEngine.configureIndependentPreset('pp', instanceId, 'pp', 'Indy', { joinMainUpdate: true, enabled: false });
        await run();
        await vi.waitFor(() => expect(stored('mood')).toBe('tense'));
        expect(askedAbout()).not.toContain('pp__memo');
    });

    it('still respects the preset\'s own triggers', async () => {
        stateEngine.configureIndependentPreset('pp', instanceId, 'pp', 'Indy', { joinMainUpdate: true });
        stateEngine.updatePreset('pp', instanceId, 'pp', 'Indy', { triggers: ['user'] });
        await run('ai');
        await vi.waitFor(() => expect(stored('mood')).toBe('tense'));
        expect(askedAbout()).not.toContain('pp__memo');
    });
});
