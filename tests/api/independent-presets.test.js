import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { stateEngine } from '../../src/api/index.js';
import { getVar, setVar } from '../../src/core/chat-state.js';
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

// ---------------------------------------------------------------------------
// 1.29: CRUD, context modes, batching, enabled/disabled, status, export/import.
// ---------------------------------------------------------------------------

import { getSettings } from '../../src/core/settings-core.js';
import { exportPreset, importPresetDetailed } from '../../src/core/preset-export.js';
import { independentContextMode, isEmptyIndependentContext } from '../../src/api/independent-presets.js';

const create = (over = {}) => {
    const created = stateEngine.createIndependentPreset(extensionId, instanceId, { namespace: 'se', name: 'Indy', ...over });
    // Real usage activates a preset for the chat it will seed/write into;
    // independent presets don't require this to RUN (they read preset.variables
    // directly, regardless of chat-preset bindings - see runIndependentPreset's
    // own comment), but without it a variable that is never written has no
    // seeded entry at all, so tests that check an untouched variable's value
    // activate it, matching how a real extension would set one up.
    if (created) stateEngine.activatePreset(extensionId, instanceId, 'chat-1', 'se', created.name);
    return created;
};
const update = (patch, name = 'Indy') => stateEngine.updateIndependentPreset(extensionId, instanceId, 'se', name, patch);
const del = (name = 'Indy') => stateEngine.deleteIndependentPreset(extensionId, instanceId, 'se', name);
const list = () => stateEngine.listIndependentPresets(extensionId, instanceId, 'se');
const toggle = (enabled, name = 'Indy') => stateEngine.toggleIndependentPreset(extensionId, instanceId, 'se', name, enabled);
const setContext = (ctx, name = 'Indy') => stateEngine.updateIndependentPresetContext(extensionId, instanceId, 'se', name, ctx);
const status = (name = 'Indy') => stateEngine.getIndependentPresetStatus('se', name);
// Re-activating is a safe, idempotent no-op for a preset already active
// (addPresetToChat only ever ADDS a missing seed, never resets an existing
// value) - done here so a variable added to the preset AFTER create()'s own
// one-time activation is still seeded before the run reads/writes it.
const runIndy = (name = 'Indy') => {
    stateEngine.activatePreset(extensionId, instanceId, 'chat-1', 'se', name);
    return stateEngine.runIndependentPreset(extensionId, instanceId, 'chat-1', { namespace: 'se', name });
};
const promptedOn = (presetName, varName, extra = {}) => stateEngine.createVariable(extensionId, instanceId, {
    namespace: 'se', presetName, name: varName, type: 'string', defaultValue: 'calm',
    behaviors: { prompted: true, increment: false }, prompted: { instructions: 'infer it' }, ...extra,
});

describe('1.29 CRUD', () => {
    it('createIndependentPreset makes a real preset, flagged, with its config', () => {
        const created = create({ batch: 'extra', temperature: 0.4, maxTokens: 200 });
        expect(created).toMatchObject({ name: 'Indy', namespace: 'se', independentPreset: true });
        expect(created.independentConfig).toEqual({ batch: 'extra', temperature: 0.4, maxTokens: 200 });
        // It really is a preset - the regular preset machinery sees it too.
        expect(stateEngine.listPresets(extensionId, instanceId, 'se').some((p) => p.name === 'Indy')).toBe(true);
    });

    it('rejects the same namespace.name collision rule as a regular preset, and unknown fields are simply not config', () => {
        create();
        expect(create()).toBeNull();
        const c = create({ name: 'Indy2', bogus: 'x' });
        expect(c.independentConfig.bogus).toBeUndefined();
    });

    it('updateIndependentPreset renames, edits config, and merges (never replaces) unrelated fields', () => {
        create({ batch: 'extra' });
        expect(update({ temperature: 0.9 })).toMatchObject({ independentConfig: { batch: 'extra', temperature: 0.9 } });
        expect(update({ name: 'Renamed' })).toMatchObject({ name: 'Renamed' });
        expect(update({ batch: 'core' }, 'Renamed').independentConfig).toEqual({ batch: 'core', temperature: 0.9 });
    });

    it('update/delete/toggle refuse a preset that is not an independent preset - a regular preset is untouched', () => {
        stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Regular' });
        expect(update({ temperature: 0.5 }, 'Regular')).toBeNull();
        expect(del('Regular')).toBe(false);
        expect(toggle(false, 'Regular')).toBeNull();
        expect(stateEngine.listPresets(extensionId, instanceId, 'se').some((p) => p.name === 'Regular')).toBe(true);
    });

    it('deleteIndependentPreset removes the preset and its variables, like deletePreset', () => {
        create();
        promptedOn('Indy', 'mood');
        expect(del()).toBe(true);
        expect(stateEngine.listPresets(extensionId, instanceId, 'se').some((p) => p.name === 'Indy')).toBe(false);
        expect(del()).toBe(false); // already gone
    });

    it('listIndependentPresets returns only flagged presets, never regular ones (created via either API)', () => {
        create({ name: 'IndyA' });
        create({ name: 'IndyB' });
        stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Regular' });
        const names = list().map((p) => p.name).sort();
        expect(names).toEqual(['IndyA', 'IndyB']);
    });

    it('toggleIndependentPreset flips independentConfig.enabled and returns the new value', () => {
        create();
        expect(toggle(false)).toBe(false);
        expect(status().enabled).toBe(false);
        expect(toggle(true)).toBe(true);
        expect(status().enabled).toBe(true);
    });
});

describe('1.29 independent context: extension-provided / chat-history / explicit-empty', () => {
    it('never called -> chat-history mode (the existing default behavior, byte for byte)', () => {
        expect(independentContextMode(undefined)).toEqual({ mode: 'chat-history' });
        expect(independentContextMode({})).toEqual({ mode: 'chat-history' });
    });

    it('null or an empty object -> empty mode; a non-empty value of any shape -> extension mode, untouched', () => {
        for (const empty of [null, undefined, {}]) expect(isEmptyIndependentContext(empty), JSON.stringify(empty)).toBe(true);
        // '' and 0 and false and [] are NOT "null or an empty object" per the literal rule
        for (const notEmpty of [0, '', false, [], 'hi', { a: 1 }, [1], { toString: () => 'x' }]) {
            expect(isEmptyIndependentContext(notEmpty), JSON.stringify(notEmpty)).toBe(false);
        }
        expect(independentContextMode({ context: null })).toEqual({ mode: 'empty' });
        expect(independentContextMode({ context: {} })).toEqual({ mode: 'empty' });
        expect(independentContextMode({ context: { scene: 'a tavern' } })).toEqual({ mode: 'extension', context: { scene: 'a tavern' } });
    });

    it('updateIndependentPresetContext stores it verbatim and refuses a non-independent preset', () => {
        create();
        expect(setContext({ scene: 'a tavern', npcs: ['Bob'] })).toBe(true);
        expect(status().contextMode).toBe('extension');
        stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Regular' });
        expect(setContext({ a: 1 }, 'Regular')).toBe(false);
    });

    it('mode A: an extension-provided context reaches the prompt untouched, and chat history is NOT required', async () => {
        create();
        promptedOn('Indy', 'mood');
        setContext({ scene: 'a tavern', danger: 3 });
        context.chat = undefined; // proves chat is not read in this mode
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');

        expect(await runIndy()).toBe(true);
        const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
        expect(prompt).toContain('Independent context:');
        expect(prompt).toContain('"scene": "a tavern"');
        expect(prompt).toContain('"danger": 3');
        expect(prompt).not.toContain('Recent conversation');
        expect(prompt).not.toContain('No conversation yet');
    });

    it('a string context is used as-is, not JSON-quoted', async () => {
        create();
        promptedOn('Indy', 'mood');
        setContext('The room is on fire.');
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        await runIndy();
        expect(callBackgroundLLM.mock.calls[0][2][0].content).toContain('Independent context:\nThe room is on fire.');
    });

    it('mode B: no context ever supplied -> the existing chat-history transcript, unchanged', async () => {
        create();
        promptedOn('Indy', 'mood');
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        await runIndy();
        const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
        expect(prompt).toContain('Recent conversation:');
        expect(prompt).toContain('User: hello there');
        expect(prompt).not.toContain('Independent context:');
    });

    it('mode B still requires the chat to exist - unlike A/C, it depends on it', async () => {
        create();
        promptedOn('Indy', 'mood');
        context.chat = undefined;
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        expect(await runIndy()).toBe(false);
        expect(callBackgroundLLM).not.toHaveBeenCalled();
    });

    it('mode C: explicit null or {} -> no context section at all, purely variables, and chat is NOT required', async () => {
        create();
        promptedOn('Indy', 'mood');
        setContext(null);
        context.chat = undefined;
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');

        expect(await runIndy()).toBe(true);
        const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
        expect(prompt).not.toContain('Independent context:');
        expect(prompt).not.toContain('Recent conversation');
        expect(prompt).not.toContain('No conversation yet');
        expect(prompt).toContain('Update variables:');
    });

    it('an empty OBJECT context behaves identically to null', async () => {
        create();
        promptedOn('Indy', 'mood');
        setContext({});
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        await runIndy();
        expect(callBackgroundLLM.mock.calls[0][2][0].content).not.toContain('Independent context:');
    });
});

describe('1.29 variable batching', () => {
    it('only the configured batch is asked about; other batches are left alone, even with prompted behavior', async () => {
        create({ batch: 'extra' });
        promptedOn('Indy', 'core_var'); // batch: core (default) - not selected
        stateEngine.assignBatch(extensionId, instanceId, 'core_var', 'extra');
        promptedOn('Indy', 'other_extra');
        stateEngine.assignBatch(extensionId, instanceId, 'other_extra', 'something_else');

        callBackgroundLLM.mockResolvedValue('{"se__core_var":"x","se__other_extra":"y"}');
        await runIndy();

        const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
        expect(prompt).toContain('se__core_var');
        expect(prompt).not.toContain('se__other_extra');
        expect(getVar('chat-1', 'se__other_extra').value).toBe('calm'); // untouched - not even asked
    });

    it('with no batch configured, the default is "core" - unchanged from before this pass', async () => {
        create();
        promptedOn('Indy', 'mood'); // defaults to batch "core"
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        expect(await runIndy()).toBe(true);
    });
});

describe('1.29 per-preset history limit', () => {
    it('overrides the global message count, in chat-history mode', async () => {
        create({ historyLimit: 1 });
        promptedOn('Indy', 'mood');
        context.chat = [{ is_user: true, mes: 'first' }, { is_user: false, name: 'Bot', mes: 'second' }, { is_user: true, mes: 'third' }];
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        await runIndy();
        const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
        expect(prompt).toContain('third');
        expect(prompt).not.toContain('first');
        expect(prompt).not.toContain('second');
    });

    it('is unused in extension/empty context modes', async () => {
        create({ historyLimit: 1 });
        promptedOn('Indy', 'mood');
        setContext({ a: 1 });
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        await runIndy();
        expect(callBackgroundLLM.mock.calls[0][2][0].content).not.toContain('Recent conversation');
    });
});

describe('1.29 enabled / disabled', () => {
    it('disabled: the LLM is never called, nothing runs, and status records why', async () => {
        create({ enabled: false });
        promptedOn('Indy', 'mood');
        expect(await runIndy()).toBe(false);
        expect(callBackgroundLLM).not.toHaveBeenCalled();
        expect(status().lastOutcome).toBe('skipped-disabled');
        expect(getVar('chat-1', 'se__mood').value).toBe('calm');
    });

    it('re-enabling lets it run again', async () => {
        create({ enabled: false });
        promptedOn('Indy', 'mood');
        await runIndy();
        toggle(true);
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        expect(await runIndy()).toBe(true);
    });

    it('a disabled preset never even claims the concurrency lock (a healthy preset can still run)', async () => {
        create({ name: 'Off', enabled: false });
        create({ name: 'On' });
        promptedOn('On', 'mood');
        await runIndy('Off');
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        expect(await runIndy('On')).toBe(true);
    });
});

describe('1.29 status', () => {
    it('never-run before the first call', () => {
        create();
        expect(status()).toMatchObject({ lastRunAt: null, lastOutcome: 'never-run', lastError: null, changedVariables: [] });
    });

    it('records "updated" and which variables changed', async () => {
        create();
        promptedOn('Indy', 'mood');
        promptedOn('Indy', 'stance', { name: 'stance' });
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}'); // stance omitted by the model
        await runIndy();
        const s = status();
        expect(s.lastOutcome).toBe('updated');
        expect(s.changedVariables).toEqual(['se__mood']);
        expect(typeof s.lastRunAt).toBe('number');
    });

    it('records "no-op" when the model answers but writes nothing usable', async () => {
        create();
        promptedOn('Indy', 'mood');
        callBackgroundLLM.mockResolvedValue('{"something_else":"x"}');
        await runIndy();
        expect(status()).toMatchObject({ lastOutcome: 'no-op', changedVariables: [] });
    });

    it('records a parse failure', async () => {
        create();
        promptedOn('Indy', 'mood');
        callBackgroundLLM.mockResolvedValue('not json');
        await runIndy();
        expect(status()).toMatchObject({ lastOutcome: 'skipped-parse-error', lastError: expect.any(String) });
    });

    it('records skipped-nothing-to-update when the batch has nothing prompted', async () => {
        create();
        stateEngine.createVariable(extensionId, instanceId, { namespace: 'se', presetName: 'Indy', name: 'n', type: 'number', defaultValue: 1 });
        await runIndy();
        expect(status().lastOutcome).toBe('skipped-nothing-to-update');
    });

    it('getIndependentPresetStatus returns null for a missing or non-independent preset', () => {
        expect(stateEngine.getIndependentPresetStatus('se', 'Missing')).toBeNull();
        stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Regular' });
        expect(stateEngine.getIndependentPresetStatus('se', 'Regular')).toBeNull();
    });

    it('reflects the configured batch and context mode', () => {
        create({ batch: 'extra' });
        setContext({ a: 1 });
        expect(status()).toMatchObject({ batch: 'extra', contextMode: 'extension' });
    });
});

describe('1.29 export / import', () => {
    it('independentPreset, independentConfig (including context) round-trip through export', () => {
        create({ batch: 'extra', temperature: 0.3 });
        setContext({ scene: 'a tavern' });
        const presetId = Object.keys(getSettings().presets).find((id) => getSettings().presets[id].name === 'Indy');
        const data = exportPreset(presetId);
        expect(data.independentPreset).toBe(true);
        expect(data.independentConfig).toEqual({ batch: 'extra', temperature: 0.3, context: { scene: 'a tavern' } });
    });

    it('independentStatus is stripped from the export - a freshly imported preset never appears to have already run', async () => {
        create();
        promptedOn('Indy', 'mood');
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        await runIndy();
        expect(status().lastRunAt).not.toBeNull();

        const presetId = Object.keys(getSettings().presets).find((id) => getSettings().presets[id].name === 'Indy');
        const data = exportPreset(presetId);
        expect(data.independentStatus).toBeUndefined();
    });

    it('a non-JSON-serializable context is dropped from the export (with a warning), everything else still exports', () => {
        create();
        const circular = {};
        circular.self = circular;
        setContext(circular);
        const presetId = Object.keys(getSettings().presets).find((id) => getSettings().presets[id].name === 'Indy');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const data = exportPreset(presetId);
        expect(data.independentConfig.context).toBeUndefined();
        expect(data.independentPreset).toBe(true); // the rest of the preset still exported
        expect(warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('not JSON-serializable'));
        warn.mockRestore();
    });

    it('importPresetDetailed strips a stray independentStatus even if the source data carries one (defense in depth)', () => {
        const data = {
            name: 'Hand Crafted', independentPreset: true,
            independentConfig: { batch: 'core' },
            independentStatus: { lastRunAt: 12345, lastOutcome: 'updated', changedVariables: ['x'] },
            variables: {},
        };
        const result = importPresetDetailed(data);
        expect(getSettings().presets[result.presetId].independentStatus).toBeUndefined();
    });

    it('importPresetDetailed restores independentPreset/independentConfig on the new preset, and variable references rewrite exactly like a regular preset', () => {
        create({ batch: 'extra' });
        const calc = stateEngine.createVariable(extensionId, instanceId, { namespace: 'se', presetName: 'Indy', name: 'hp', type: 'number', defaultValue: 10 });
        stateEngine.createVariable(extensionId, instanceId, {
            namespace: 'se', presetName: 'Indy', name: 'hpDoubled', type: 'calculated', expression: `${calc.name} * 2`,
        });
        const presetId = Object.keys(getSettings().presets).find((id) => getSettings().presets[id].name === 'Indy');
        const data = exportPreset(presetId);

        const result = importPresetDetailed(data);
        const imported = getSettings().presets[result.presetId];
        expect(imported.independentPreset).toBe(true);
        expect(imported.independentConfig).toEqual({ batch: 'extra' });
        expect(imported.independentStatus).toBeUndefined();
        // the calculated variable's expression follows the renamed sibling, exactly as clonePreset/import already guarantee for any preset
        const importedCalc = Object.values(imported.variables).find((v) => v.type === 'calculated');
        const importedHp = Object.values(imported.variables).find((v) => v.name.includes('hp') && v.type === 'number');
        expect(importedCalc.expression).toContain(importedHp.name);
    });

    it('an imported independent preset works: it runs and writes exactly like the original', async () => {
        create();
        promptedOn('Indy', 'mood');
        const presetId = Object.keys(getSettings().presets).find((id) => getSettings().presets[id].name === 'Indy');
        const data = exportPreset(presetId);
        const result = importPresetDetailed(data);
        const importedName = getSettings().presets[result.presetId].name;

        callBackgroundLLM.mockResolvedValue(`{"${result.nameMap['se__mood']}":"tense"}`);
        expect(await stateEngine.runIndependentPreset(extensionId, instanceId, 'chat-1', { namespace: 'se', name: importedName })).toBe(true);
    });
});

describe('1.29 compliance: no WI / calendar / image / other-preset / chat-system-message leakage', () => {
    it('the prompt never contains another preset\'s variables', async () => {
        create();
        promptedOn('Indy', 'mood');
        stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Other' });
        promptedOn('Other', 'secret');
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        await runIndy();
        expect(callBackgroundLLM.mock.calls[0][2][0].content).not.toContain('se__secret');
    });

    it('the system message is built fresh, not reused from SillyTavern\'s own chat completion pipeline', async () => {
        create();
        promptedOn('Indy', 'mood');
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        await runIndy();
        const messages = callBackgroundLLM.mock.calls[0][2];
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe('system');
        expect(messages[1]).toEqual({ role: 'user', content: 'Output the JSON object now. JSON only, no other text.' });
    });

    it('nothing here ever touches SillyTavern\'s own chat array or metadata - only the isolated variable store', async () => {
        create();
        promptedOn('Indy', 'mood');
        const before = JSON.stringify(context.chat);
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        await runIndy();
        expect(JSON.stringify(context.chat)).toBe(before);
    });
});

describe('1.29 write-path validation: the same rules as every other write', () => {
    it('an array-typed prompted variable answered with a non-array is rejected, exactly like the main engine', async () => {
        create();
        stateEngine.createVariable(extensionId, instanceId, {
            namespace: 'se', presetName: 'Indy', name: 'items', type: 'array', itemType: 'string', defaultValue: [],
            behaviors: { prompted: true, increment: false }, prompted: { instructions: 'list items' },
        });
        callBackgroundLLM.mockResolvedValue('{"se__items":"not an array"}');
        expect(await runIndy()).toBe(false);
        expect(getVar('chat-1', 'se__items').value).toEqual([]);
    });

    it('a flag-mode boolean already true is left out of the prompt here too (1.28 interaction)', async () => {
        create();
        const flag = stateEngine.createVariable(extensionId, instanceId, {
            namespace: 'se', presetName: 'Indy', name: 'fired', type: 'boolean', flagMode: true,
            behaviors: { prompted: true, increment: false }, prompted: { instructions: 'fire once' },
        });
        setVar('chat-1', flag.name, true, flag);
        expect(await runIndy()).toBe(false);
        expect(callBackgroundLLM).not.toHaveBeenCalled();
    });
});
