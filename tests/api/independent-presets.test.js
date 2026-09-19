import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { stateEngine } from '../../src/api/index.js';
import { getVar } from '../../src/core/chat-state.js';
import { callBackgroundLLM } from '../../src/core/background-llm.js';

// The LLM call itself is the one thing this suite fakes on top of the
// harness - everything around it (transcript, classification, parsing,
// writes) is the real independent-presets pipeline.
vi.mock('../../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));

const extensionId = 'se';
let instanceId;

const run = (name = 'Demo') => stateEngine.runIndependentPreset(extensionId, instanceId, 'chat-1', { namespace: 'se', name });
const configure = (config, name = 'Demo') => stateEngine.configureIndependentPreset(extensionId, instanceId, 'se', name, config);
const prompted = (name, extra = {}) => stateEngine.createVariable(extensionId, instanceId, {
    namespace: 'se', presetName: 'Demo', name, type: 'string', defaultValue: 'calm',
    behaviors: { prompted: true, increment: false }, prompted: { instructions: 'infer it' }, ...extra,
});

beforeEach(() => {
    instanceId = ensureInstanceId();
    stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Demo' });
    stateEngine.activatePreset(extensionId, instanceId, 'chat-1', 'se', 'Demo');
    context.chat = [{ is_user: true, mes: '<b>hello</b> there' }, { is_user: false, name: 'Bot', mes: 'hi' }];
    callBackgroundLLM.mockReset();
});

describe('independent-presets (identity-enforced)', () => {
    describe('configureIndependentPreset', () => {
        it('stores the config on the preset and persists it', () => {
            expect(configure({ connectionProfileId: 'profile-x', maxTokens: 500 })).toEqual({ connectionProfileId: 'profile-x', maxTokens: 500 });
            const preset = Object.values(settings.snapshot().presets).find((p) => p.name === 'Demo');
            expect(preset.independentConfig.connectionProfileId).toBe('profile-x');
            expect(context.saveSettingsDebounced).toHaveBeenCalled();
        });

        it('merges into the existing config rather than replacing it', () => {
            configure({ connectionProfileId: 'profile-x' });
            expect(configure({ temperature: 0.5 })).toEqual({ connectionProfileId: 'profile-x', temperature: 0.5 });
        });

        it('returns null for a missing preset', () => {
            expect(configure({}, 'Missing')).toBeNull();
        });
    });

    describe('runIndependentPreset', () => {
        it('returns a Promise (the async pipeline is preserved behind the synchronous identity check)', () => {
            expect(run('Missing')).toBeInstanceOf(Promise);
        });

        it('resolves false for a missing preset, and never calls the LLM', async () => {
            expect(await run('Missing')).toBe(false);
            expect(callBackgroundLLM).not.toHaveBeenCalled();
        });

        it('resolves false when the preset has nothing prompted to update', async () => {
            stateEngine.createVariable(extensionId, instanceId, { namespace: 'se', presetName: 'Demo', name: 'n', type: 'number', defaultValue: 1 });
            expect(await run()).toBe(false);
            expect(callBackgroundLLM).not.toHaveBeenCalled();
        });

        it('applies a prompted update returned by the model', async () => {
            prompted('mood');
            callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');

            expect(await run()).toBe(true);
            expect(getVar('chat-1', 'se__mood').value).toBe('tense');
        });

        it('builds the prompt from the chat transcript with markup stripped', async () => {
            prompted('mood');
            callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
            await run();

            const messages = callBackgroundLLM.mock.calls[0][2];
            expect(messages[0].content).toContain('User: hello there');
            expect(messages[0].content).toContain('Bot: hi');
            expect(messages[0].content).not.toContain('<b>');
            expect(messages[0].content).toContain('"se__mood"');
        });

        it('routes to the preset\'s own connection profile and token limit via a settings copy', async () => {
            prompted('mood');
            configure({ connectionProfileId: 'profile-x', maxTokens: 500, temperature: 0.2 });
            callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
            await run();

            const [, effectiveSettings, , maxTokens] = callBackgroundLLM.mock.calls[0];
            expect(effectiveSettings.stateEngineProfileId).toBe('profile-x');
            expect(effectiveSettings.stateEngineTemperature).toBe(0.2);
            expect(maxTokens).toBe(500);
            // ...without touching the real persisted settings
            expect(settings.get().stateEngineProfileId).not.toBe('profile-x');
        });

        it('applies a prompted increment when the model answers true, ignores false', async () => {
            stateEngine.createVariable(extensionId, instanceId, {
                namespace: 'se', presetName: 'Demo', name: 'count', type: 'number', defaultValue: 0,
                behaviors: { prompted: true, increment: true }, increment: { delta: 2 },
            });
            callBackgroundLLM.mockResolvedValue('{"se__count":true}');
            expect(await run()).toBe(true);
            expect(getVar('chat-1', 'se__count').value).toBe(2);

            callBackgroundLLM.mockResolvedValue('{"se__count":false}');
            expect(await run()).toBe(false);
            expect(getVar('chat-1', 'se__count').value).toBe(2);
        });

        it('leaves a variable alone when the model omits it', async () => {
            prompted('mood');
            callBackgroundLLM.mockResolvedValue('{"something_else":"x"}');
            expect(await run()).toBe(false);
            expect(getVar('chat-1', 'se__mood').value).toBe('calm');
        });

        it('resolves false on an unparseable model response, and releases the lock', async () => {
            prompted('mood');
            callBackgroundLLM.mockResolvedValue('not json at all');
            expect(await run()).toBe(false);

            callBackgroundLLM.mockResolvedValue('{"se__mood":"ok"}');
            expect(await run()).toBe(true);
        });

        it('does not run two independent presets at once', async () => {
            prompted('mood');
            let release;
            callBackgroundLLM.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

            const first = run();
            expect(await run()).toBe(false); // second call refused while the first is in flight
            expect(callBackgroundLLM).toHaveBeenCalledTimes(1);

            release('{"se__mood":"tense"}');
            expect(await first).toBe(true);
        });
    });
});
