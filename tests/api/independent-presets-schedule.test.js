// Independent Preset scheduling (requirements spec 1.32): updateIndependentPresetSchedule
// (CRUD/validation/merge), checkAndRunDueSchedules (the due-preset runner),
// and export/import handling of schedule.nextRun. See tests/schedule-engine.test.js
// for the pure calendar-math this all builds on - not re-tested here.

import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { stateEngine } from '../../src/api/index.js';
import { getVar } from '../../src/core/chat-state.js';
import { callBackgroundLLM } from '../../src/core/background-llm.js';
import { exportPreset, importPresetDetailed } from '../../src/core/preset-export.js';

vi.mock('../../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));

const extensionId = 'se';
let instanceId;

const ts = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

const createPreset = (name = 'Demo') => stateEngine.createIndependentPreset(extensionId, instanceId, { namespace: 'se', name });
const schedule = (patch, name = 'Demo') => stateEngine.updateIndependentPresetSchedule(extensionId, instanceId, 'se', name, patch);
const status = (name = 'Demo') => stateEngine.getIndependentPresetStatus('se', name);
const presetOf = (name = 'Demo') => Object.values(settings.get().presets).find((p) => p.name === name);
const prompted = (name, extra = {}) => stateEngine.createVariable(extensionId, instanceId, {
    namespace: 'se', presetName: 'Demo', name, type: 'string', defaultValue: '',
    behaviors: { prompted: true, increment: false }, prompted: { instructions: 'infer it' }, ...extra,
});

beforeEach(() => {
    instanceId = ensureInstanceId();
    createPreset();
    stateEngine.activatePreset(extensionId, instanceId, 'chat-1', 'se', 'Demo');
    context.chat = [{ is_user: true, mes: 'hi' }, { is_user: false, name: 'Bot', mes: 'hi' }];
    callBackgroundLLM.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(ts(2026, 9, 22, 12, 0, 0));
});

afterEach(() => { vi.useRealTimers(); });

describe('updateIndependentPresetSchedule', () => {
    it('refuses on a non-independent / missing preset', () => {
        expect(stateEngine.updateIndependentPresetSchedule(extensionId, instanceId, 'se', 'Missing', { mode: 'interval', value: '1h', enabled: true })).toBeNull();
    });

    it('stores mode/value/calendar/repeat WITHOUT computing nextRun while not enabled', () => {
        const r = schedule({ mode: 'interval', value: '10 minutes' });
        expect(r).toMatchObject({ mode: 'interval', value: '10 minutes', nextRun: null });
    });

    it('computes nextRun the moment enabled becomes true', () => {
        schedule({ mode: 'interval', value: '10 minutes' });
        const r = schedule({ enabled: true });
        expect(r).toMatchObject({ enabled: true, nextRun: ts(2026, 9, 22, 12, 10, 0) });
    });

    it('refuses enabling with no mode/value ever set', () => {
        expect(schedule({ enabled: true })).toBeNull();
        expect(presetOf().independentConfig?.schedule).toBeUndefined();
    });

    it('refuses enabling with an unparseable value, and writes nothing', () => {
        schedule({ mode: 'interval', value: 'whenever' });
        expect(schedule({ enabled: true })).toBeNull();
        expect(presetOf().independentConfig.schedule.enabled).not.toBe(true);
    });

    it('changing value while enabled recomputes nextRun immediately', () => {
        schedule({ mode: 'interval', value: '10 minutes', enabled: true });
        const r = schedule({ value: '1 hour' });
        expect(r.nextRun).toBe(ts(2026, 9, 22, 13, 0, 0));
    });

    it('an unrelated field change (repeat) while enabled does NOT recompute nextRun from a new "now"', () => {
        // A RELATIVE duration is used deliberately, not an absolute date/time:
        // resolving an absolute date ignores "current" entirely, so it would
        // coincidentally produce the same nextRun whether or not this really
        // recomputed - a relative duration's resolution genuinely depends on
        // "now", so only a real skip (not a recompute) keeps nextRun unchanged
        // after time passes.
        schedule({ mode: 'interval', value: '10 minutes', enabled: true });
        const before = presetOf().independentConfig.schedule.nextRun;
        vi.setSystemTime(ts(2026, 9, 23, 0, 0, 0)); // time passes
        const r = schedule({ repeat: true });
        expect(r.nextRun).toBe(before); // untouched - only mode/value/calendar changes recompute
    });

    it('disabling clears nextRun; re-enabling later recomputes fresh from THAT moment, not the original', () => {
        schedule({ mode: 'interval', value: '10 minutes', enabled: true });
        schedule({ enabled: false });
        expect(presetOf().independentConfig.schedule.nextRun).toBeNull();

        vi.setSystemTime(ts(2026, 9, 22, 18, 0, 0)); // 6 hours later
        const r = schedule({ enabled: true });
        expect(r.nextRun).toBe(ts(2026, 9, 22, 18, 10, 0)); // from the NEW "now", not the original 12:00
    });

    it('persists settings on every successful write', () => {
        schedule({ mode: 'interval', value: '10 minutes' });
        expect(context.saveSettingsDebounced).toHaveBeenCalled();
    });
});

describe('checkAndRunDueSchedules', () => {
    it('runs nothing when nothing is due', async () => {
        schedule({ mode: 'interval', value: '10 minutes', enabled: true });
        expect(await stateEngine.checkAndRunDueSchedules('chat-1')).toBe(0);
        expect(callBackgroundLLM).not.toHaveBeenCalled();
    });

    it('runs a due preset and reschedules it (interval)', async () => {
        prompted('mood');
        schedule({ mode: 'interval', value: '10 minutes', enabled: true });
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');

        vi.setSystemTime(ts(2026, 9, 22, 12, 10, 1)); // 1 second past due
        expect(await stateEngine.checkAndRunDueSchedules('chat-1')).toBe(1);

        expect(getVar('chat-1', 'se__mood').value).toBe('tense');
        expect(presetOf().independentConfig.schedule.nextRun).toBe(ts(2026, 9, 22, 12, 20, 1)); // +10m from the run, not the original due time
        expect(presetOf().independentConfig.schedule.enabled).toBe(true); // interval keeps going
    });

    it('one-shot delay disables itself after running', async () => {
        prompted('mood');
        schedule({ mode: 'delay', value: '10 minutes', enabled: true });
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        vi.setSystemTime(ts(2026, 9, 22, 12, 10, 1));

        await stateEngine.checkAndRunDueSchedules('chat-1');
        expect(presetOf().independentConfig.schedule.enabled).toBe(false);
    });

    it('nextRun is updated BEFORE the run resolves, so a slow run is never seen as still-due', async () => {
        prompted('mood');
        schedule({ mode: 'interval', value: '10 minutes', enabled: true });
        let releaseLLM;
        callBackgroundLLM.mockImplementationOnce(() => new Promise((resolve) => { releaseLLM = resolve; }));
        vi.setSystemTime(ts(2026, 9, 22, 12, 10, 1));

        const firstCheck = stateEngine.checkAndRunDueSchedules('chat-1'); // not yet awaited
        await Promise.resolve(); // let the loop reach and update nextRun synchronously before the LLM call resolves
        expect(presetOf().independentConfig.schedule.nextRun).toBe(ts(2026, 9, 22, 12, 20, 1));

        // A second check while the first is still "in flight" (LLM unresolved) sees
        // nextRun already in the future and does nothing - independentRunInProgress
        // is a second, independent line of defense, not the only one.
        expect(await stateEngine.checkAndRunDueSchedules('chat-1')).toBe(0);

        releaseLLM('{"se__mood":"tense"}');
        await firstCheck;
    });

    it('a disabled schedule never runs, even if nextRun is somehow in the past', async () => {
        prompted('mood');
        schedule({ mode: 'interval', value: '10 minutes', enabled: true });
        schedule({ enabled: false });
        // Force a stale-looking nextRun directly (schedule.enabled=false already
        // clears it via the CRUD path - this simulates a hand-edited settings blob).
        presetOf().independentConfig.schedule = { ...presetOf().independentConfig.schedule, nextRun: ts(2020, 1, 1) };

        expect(await stateEngine.checkAndRunDueSchedules('chat-1')).toBe(0);
        expect(callBackgroundLLM).not.toHaveBeenCalled();
    });

    it('a regular (non-independent) preset is never scanned, even with a schedule-shaped independentConfig', async () => {
        stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Regular' });
        const p = presetOf('Regular');
        p.independentConfig = { schedule: { enabled: true, mode: 'interval', value: '1h', nextRun: ts(2020, 1, 1) } };

        expect(await stateEngine.checkAndRunDueSchedules('chat-1')).toBe(0);
    });

    it('multiple due presets all run, sequentially (never overlapping)', async () => {
        prompted('mood');
        schedule({ mode: 'interval', value: '10 minutes', enabled: true }, 'Demo');
        createPreset('Second');
        stateEngine.createVariable(extensionId, instanceId, {
            namespace: 'se', presetName: 'Second', name: 'tone', type: 'string', defaultValue: '',
            behaviors: { prompted: true, increment: false }, prompted: { instructions: 'x' },
        });
        schedule({ mode: 'interval', value: '10 minutes', enabled: true }, 'Second');
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense","se__tone":"grim"}');
        vi.setSystemTime(ts(2026, 9, 22, 12, 10, 1));

        expect(await stateEngine.checkAndRunDueSchedules('chat-1')).toBe(2);
    });

    it('does nothing without a chatId, and never throws', async () => {
        expect(await stateEngine.checkAndRunDueSchedules(undefined)).toBe(0);
        expect(await stateEngine.checkAndRunDueSchedules(null)).toBe(0);
    });

    it('respects the global settings.enabled gate, same as runPromptedStateUpdate/runDeterministicIncrements', async () => {
        prompted('mood');
        schedule({ mode: 'interval', value: '10 minutes', enabled: true });
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        vi.setSystemTime(ts(2026, 9, 22, 12, 10, 1));

        settings.get().enabled = false;
        expect(await stateEngine.checkAndRunDueSchedules('chat-1')).toBe(0);
        expect(callBackgroundLLM).not.toHaveBeenCalled();
    });
});

describe('export/import', () => {
    it('exportPreset strips nextRun but keeps enabled/mode/value/calendar/repeat', () => {
        schedule({ mode: 'interval', value: '10 minutes', repeat: true, enabled: true });
        const presetId = Object.keys(settings.get().presets).find((id) => settings.get().presets[id].name === 'Demo');

        const data = exportPreset(presetId);
        expect(data.independentConfig.schedule).toMatchObject({ mode: 'interval', value: '10 minutes', repeat: true, enabled: true });
        expect(data.independentConfig.schedule.nextRun).toBeUndefined();
    });

    it('importPresetDetailed recomputes a fresh nextRun for THIS install\'s clock, for an enabled schedule', () => {
        schedule({ mode: 'interval', value: '10 minutes', enabled: true });
        const presetId = Object.keys(settings.get().presets).find((id) => settings.get().presets[id].name === 'Demo');
        const data = exportPreset(presetId);

        vi.setSystemTime(ts(2026, 12, 25, 0, 0, 0)); // a much later "now", simulating a different install/time
        const result = importPresetDetailed(data);
        const imported = settings.get().presets[result.presetId];
        expect(imported.independentConfig.schedule.nextRun).toBe(ts(2026, 12, 25, 0, 10, 0));
    });

    it('a schedule referencing a calendar this install does not have imports disabled, not broken', () => {
        schedule({ mode: 'interval', value: '10 minutes', calendar: 'nonexistent-fantasy-calendar', enabled: true });
        const presetId = Object.keys(settings.get().presets).find((id) => settings.get().presets[id].name === 'Demo');
        const raw = exportPreset(presetId);
        // exportPreset itself would already have refused to store an invalid
        // calendar via the CRUD path, so simulate a hand-edited file directly.
        raw.independentConfig.schedule = { mode: 'interval', value: '10 minutes', calendar: 'ghost-calendar', enabled: true };

        const result = importPresetDetailed(raw);
        const imported = settings.get().presets[result.presetId];
        expect(imported.independentConfig.schedule.enabled).toBe(false);
        expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('could not be resumed'));
    });

    it('a disabled schedule imports untouched (no recompute attempted)', () => {
        schedule({ mode: 'interval', value: '10 minutes', enabled: false });
        const presetId = Object.keys(settings.get().presets).find((id) => settings.get().presets[id].name === 'Demo');
        const data = exportPreset(presetId);

        const result = importPresetDetailed(data);
        const imported = settings.get().presets[result.presetId];
        expect(imported.independentConfig.schedule).toMatchObject({ mode: 'interval', value: '10 minutes', enabled: false });
        expect(imported.independentConfig.schedule.nextRun).toBeUndefined();
    });
});
