// Calculated-datetime extension (requirements spec 1.31): fixedIncrement/
// tickUnit ticking, deltaSource jump consumption, the accumulate master
// switch, and the delta-suppresses-the-next-tick interaction, all as
// optional fields on the existing 'datetime' type - no new variable type,
// no change to a plain datetime variable that sets none of them (see
// tests/datetime.test.js for that unchanged behavior).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import context from './harness/context.js';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { recalculateDependents, consumeDatetimeJump } from '../src/core/calculated-engine.js';
import { runDeterministicIncrements } from '../src/core/deterministic-engine.js';
import { runPromptedStateUpdate } from '../src/core/prompted-engine.js';
import { callBackgroundLLM } from '../src/core/background-llm.js';
import { getVar, setVar } from '../src/core/chat-state.js';
import { exportPreset } from '../src/core/preset-export.js';

// The harness replaces calculated-engine.js with a simplified mock (no
// datetime-trigger logic, no consumeDatetimeJump) for every other suite;
// this one needs the real thing. chat-state.js/preset-manager.js stay
// mocked - the mock's applyIncrement already steps datetime through the
// real calendar engine (see chat-state.mock.js), which is all this needs.
vi.mock('../src/core/calculated-engine.js', async () => vi.importActual('../src/core/calculated-engine.js'));
vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'STATE ENGINE REQUIREMENTS SPECIFICATION.md');

const ts = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;

let instanceId;

const createDatetime = (name, extra = {}) => stateEngine.createVariable('pp', instanceId, {
    namespace: 'pp', presetName: 'Demo', name, type: 'datetime', ...extra,
});
const createDeltaSource = (name, extra = {}) => stateEngine.createVariable('pp', instanceId, {
    namespace: 'pp', presetName: 'Demo', name, type: 'string', defaultValue: '',
    behaviors: { prompted: true, increment: false }, prompted: { instructions: 'a time delta' }, ...extra,
});
const live = (name) => stateEngine.getVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', variableName: name });
const stored = (name) => getVar('chat-1', `pp__${name}`)?.value;
const setDelta = (name, text) => { setVar('chat-1', `pp__${name}`, text, live(name)); recalculateDependents('chat-1', `pp__${name}`); };

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
    stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
    callBackgroundLLM.mockReset();
});

describe('calculated-datetime extension', () => {
    describe('schema defaults', () => {
        it('a plain datetime variable gets the new fields at their inert defaults', () => {
            const def = createDatetime('clock');
            expect(def).toMatchObject({ fixedIncrement: false, tickUnit: '1 day', deltaSource: '', accumulate: false });
        });
    });

    describe('validation (createVariable/updateVariable)', () => {
        it('rejects fixedIncrement: true with a tickUnit the calendar cannot parse', () => {
            expect(createDatetime('clock', { fixedIncrement: true, tickUnit: 'banana' })).toBeNull();
            expect(live('clock')).toBeUndefined();
        });

        it('accepts fixedIncrement: true with a valid tickUnit, even without accumulate', () => {
            const def = createDatetime('clock', { fixedIncrement: true, tickUnit: '1h' });
            expect(def).toMatchObject({ fixedIncrement: true, tickUnit: '1h', accumulate: false });
        });

        it('rejects a deltaSource that does not exist in the preset', () => {
            expect(createDatetime('clock', { deltaSource: 'ghost' })).toBeNull();
        });

        it('rejects a deltaSource that is not a string variable', () => {
            stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', name: 'n', type: 'number' });
            expect(createDatetime('clock', { deltaSource: 'pp__n' })).toBeNull();
        });

        it('rejects a deltaSource pointing at the datetime variable itself (via the existence check - it is not yet in the preset while it is being created)', () => {
            expect(createDatetime('clock', { deltaSource: 'pp__clock' })).toBeNull();
        });

        it('rejects a deltaSource pointing at itself on update too (via the type check - it is a datetime, not a string, at this point)', () => {
            createDatetime('clock');
            const ref = { namespace: 'pp', presetName: 'Demo', variableName: 'clock' };
            expect(stateEngine.updateVariable('pp', instanceId, ref, { deltaSource: 'pp__clock' })).toBeNull();
        });

        it('accepts a valid deltaSource and stores it trimmed', () => {
            createDeltaSource('jump');
            const def = createDatetime('clock', { deltaSource: '  pp__jump  ' });
            expect(def.deltaSource).toBe('pp__jump');
        });

        it('updateVariable applies the same rules', () => {
            createDatetime('clock');
            const ref = { namespace: 'pp', presetName: 'Demo', variableName: 'clock' };
            expect(stateEngine.updateVariable('pp', instanceId, ref, { fixedIncrement: true, tickUnit: 'nonsense' })).toBeNull();
            expect(live('clock').fixedIncrement).toBe(false);

            createDeltaSource('jump');
            const updated = stateEngine.updateVariable('pp', instanceId, ref, { deltaSource: 'pp__jump', fixedIncrement: true, tickUnit: '1h', accumulate: true });
            expect(updated).toMatchObject({ deltaSource: 'pp__jump', fixedIncrement: true, tickUnit: '1h', accumulate: true });
        });
    });

    describe('fixedIncrement ticking (deterministic engine)', () => {
        it('does NOT tick when accumulate is false, even though fixedIncrement is true', () => {
            createDatetime('clock', { defaultValue: 0, fixedIncrement: true, tickUnit: '1d', accumulate: false });
            runDeterministicIncrements('chat-1', 'ai');
            expect(stored('clock')).toBe(0);
        });

        it('does NOT tick when fixedIncrement is false, even though accumulate is true', () => {
            createDatetime('clock', { defaultValue: 0, fixedIncrement: false, tickUnit: '1d', accumulate: true });
            runDeterministicIncrements('chat-1', 'ai');
            expect(stored('clock')).toBe(0);
        });

        it('ticks by tickUnit when both fixedIncrement and accumulate are true', () => {
            createDatetime('clock', { defaultValue: 0, fixedIncrement: true, tickUnit: '1d', accumulate: true });
            runDeterministicIncrements('chat-1', 'ai');
            expect(stored('clock')).toBe(86400);
        });

        it('ticks on every deterministic pass regardless of trigger type (no triggers config of its own)', () => {
            createDatetime('clock', { defaultValue: 0, fixedIncrement: true, tickUnit: '1h', accumulate: true });
            runDeterministicIncrements('chat-1', 'user');
            expect(stored('clock')).toBe(3600);
            runDeterministicIncrements('chat-1', 'ai');
            expect(stored('clock')).toBe(7200);
        });

        it('is calendar-aware (month/leap-year arithmetic), same as the legacy increment path', () => {
            createDatetime('clock', { defaultValue: ts(2026, 1, 31), fixedIncrement: true, tickUnit: '1mo', accumulate: true });
            runDeterministicIncrements('chat-1', 'ai');
            expect(stored('clock')).toBe(ts(2026, 2, 28));
        });

        it('a plain (legacy) datetime increment variable is completely unaffected', () => {
            createDatetime('legacy', {
                defaultValue: ts(2026, 9, 18, 22),
                behaviors: { increment: true, prompted: false },
                increment: { delta: '1h', triggers: 'ai' },
            });
            runDeterministicIncrements('chat-1', 'ai');
            expect(stored('legacy')).toBe(ts(2026, 9, 18, 23));
        });
    });

    describe('deltaSource jump consumption', () => {
        it('applies a relative delta ("3 days") to the datetime value', () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: ts(2026, 9, 18, 12), deltaSource: 'pp__jump' });
            setDelta('jump', '3 days');
            expect(stored('clock')).toBe(ts(2026, 9, 21, 12));
        });

        it('resets deltaSource to "" after applying', () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: 0, deltaSource: 'pp__jump' });
            setDelta('jump', '12 hours');
            expect(stored('jump')).toBe('');
        });

        it('understands relative-word phrasing beyond a bare "N unit" delta', () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: ts(2026, 9, 18, 12), deltaSource: 'pp__jump' });
            setDelta('jump', 'skip ahead 2 months');
            expect(stored('clock')).toBe(ts(2026, 11, 18, 12));
        });

        it('an absolute date in the delta text sets the value directly (resolveInstruction\'s existing "set" behavior)', () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: ts(2026, 9, 18, 12), deltaSource: 'pp__jump' });
            setDelta('jump', 'set time to 2030-01-01 00:00');
            expect(stored('clock')).toBe(ts(2030, 1, 1));
        });

        it('leaves both the datetime value and the source untouched when the text cannot be parsed', () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: 500, deltaSource: 'pp__jump' });
            setDelta('jump', 'make it evening somehow');
            expect(stored('clock')).toBe(500);
            expect(stored('jump')).toBe('make it evening somehow');
            expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('could not understand'));
        });

        it('does nothing when the source is written to an empty string (no pending delta)', () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: 500, deltaSource: 'pp__jump' });
            setDelta('jump', '');
            expect(stored('clock')).toBe(500);
        });

        it('a datetime with no deltaSource ignores writes to an unrelated string variable', () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: 500 });
            setDelta('jump', '3 days');
            expect(stored('clock')).toBe(500);
        });

        it('fan-out: two datetime variables sharing one deltaSource both update, source resets once', () => {
            createDeltaSource('jump');
            createDatetime('a', { defaultValue: 0, deltaSource: 'pp__jump' });
            createDatetime('b', { defaultValue: ts(2026, 1, 1), deltaSource: 'pp__jump' });
            setDelta('jump', '1 day');
            expect(stored('a')).toBe(86400);
            expect(stored('b')).toBe(ts(2026, 1, 2));
            expect(stored('jump')).toBe('');
        });

        it('each datetime keeps its own calendar for parsing (fantasy calendar delta)', () => {
            settings.get().calendars.fantasy = {
                id: 'fantasy', label: 'Fantasy', unit: 'seconds',
                secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24, leapYearRule: 'none',
                months: [{ name: 'Frostmoon', days: 40 }, { name: 'Sunmoon', days: 40 }],
            };
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: 0, calendar: 'fantasy', deltaSource: 'pp__jump' });
            setDelta('jump', '1mo');
            expect(stored('clock')).toBe(40 * 86400);
        });
    });

    describe('combined behavior: a jump suppresses the next fixedIncrement tick once', () => {
        it('a tick that happens with no prior jump is unaffected', () => {
            createDatetime('clock', { defaultValue: 0, fixedIncrement: true, tickUnit: '1d', accumulate: true });
            runDeterministicIncrements('chat-1', 'ai');
            expect(stored('clock')).toBe(86400);
        });

        it('a jump right before a tick suppresses that one tick (no double-stepping)', () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: 0, fixedIncrement: true, tickUnit: '1d', accumulate: true, deltaSource: 'pp__jump' });
            setDelta('jump', '3 days');
            expect(stored('clock')).toBe(3 * 86400);

            runDeterministicIncrements('chat-1', 'ai'); // would add +1d if not suppressed
            expect(stored('clock')).toBe(3 * 86400); // unchanged - the tick was skipped
        });

        it('suppression is one-shot: the tick after the suppressed one fires normally again', () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: 0, fixedIncrement: true, tickUnit: '1d', accumulate: true, deltaSource: 'pp__jump' });
            setDelta('jump', '3 days');
            runDeterministicIncrements('chat-1', 'ai'); // suppressed
            runDeterministicIncrements('chat-1', 'ai'); // normal
            expect(stored('clock')).toBe(4 * 86400);
        });

        it('a jump on a variable WITHOUT fixedIncrement never sets a suppression flag (nothing to consume)', () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: 0, deltaSource: 'pp__jump' });
            setDelta('jump', '1 day');
            expect(consumeDatetimeJump('chat-1', 'pp__clock')).toBe(false);
        });

        it('consumeDatetimeJump is one-shot: a second read after the first returns false', () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: 0, fixedIncrement: true, tickUnit: '1d', accumulate: true, deltaSource: 'pp__jump' });
            setDelta('jump', '1 day');
            expect(consumeDatetimeJump('chat-1', 'pp__clock')).toBe(true);
            expect(consumeDatetimeJump('chat-1', 'pp__clock')).toBe(false);
        });
    });

    describe('cycle protection', () => {
        // A true infinite cycle cannot actually form through this trigger in
        // practice: applyDatetimeDeltaTriggers only ever treats a STRING,
        // non-empty stored value as a pending delta, and every successful
        // apply both writes the target a NUMBER (its new scalar) and resets
        // the source to '' - so even a deliberately-crafted deltaSource pair
        // pointing at each other self-terminates after one hop (see
        // calculated-engine.js's applyDatetimeDeltaTriggers for the exact
        // guard). The _visited/depth guard in recalculateDependents is
        // defense-in-depth for that check ever being bypassed (a corrupted
        // stored value, a future code path) - tested directly here as the
        // white-box case it actually guards against, since a black-box cycle
        // isn't otherwise constructible.
        it('recalculateDependents refuses to re-enter a name already in its own recursion chain', () => {
            const already = new Set(['pp__a']);
            expect(() => recalculateDependents('chat-1', 'pp__a', already)).not.toThrow();
            expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('cycle detected'));
        });

        it('refuses once the depth guard is already at its cap, without throwing', () => {
            const atCap = new Set(Array.from({ length: 25 }, (_, i) => `x${i}`));
            expect(() => recalculateDependents('chat-1', 'pp__new', atCap)).not.toThrow();
            expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('depth limit'));
        });

        it('a deltaSource pair pointing at each other self-terminates after one hop (no guard needed)', () => {
            const preset = Object.values(settings.get().presets).find((p) => p.name === 'Demo');
            preset.variables.a = { id: 'a', name: 'pp__a', type: 'datetime', calendar: 'gregorian', deltaSource: 'pp__b', defaultValue: 0 };
            preset.variables.b = { id: 'b', name: 'pp__b', type: 'datetime', calendar: 'gregorian', deltaSource: 'pp__a', defaultValue: 0 };

            // A string is forced into 'pp__a' directly (bypassing setVar's
            // normal datetime write path, which would never store a string)
            // purely to give applyDatetimeDeltaTriggers something to try -
            // the point of this test is that it terminates cleanly either way.
            setVar('chat-1', 'pp__a', 'advance 1 day', preset.variables.a);
            expect(() => recalculateDependents('chat-1', 'pp__a')).not.toThrow();
            expect(getVar('chat-1', 'pp__b')?.value).toBe(86400);
            expect(getVar('chat-1', 'pp__a')?.value).toBe(''); // consumed, reset
        });
    });

    describe('end-to-end: the main prompted update writes deltaSource', () => {
        it('the model answering the delta variable moves the datetime forward', async () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: ts(2026, 9, 18, 12), deltaSource: 'pp__jump' });
            context.chat = [{ is_user: true, mes: 'a week passes' }, { is_user: false, name: 'Bot', mes: 'time moves on' }];
            callBackgroundLLM.mockResolvedValue(JSON.stringify({ pp__jump: '1 week' }));

            await runPromptedStateUpdate('ai');

            await vi.waitFor(() => expect(stored('clock')).toBe(ts(2026, 9, 25, 12)));
            expect(stored('jump')).toBe('');
        });

        it('a plain datetime variable (no deltaSource) still supports its existing direct "update" mode unchanged', async () => {
            createDatetime('clock', {
                defaultValue: ts(2026, 9, 18, 12),
                behaviors: { prompted: true, increment: false },
                prompted: { instructions: 'track time' },
            });
            context.chat = [{ is_user: true, mes: 'hi' }, { is_user: false, name: 'Bot', mes: 'hi' }];
            callBackgroundLLM.mockResolvedValue('{"pp__clock":"advance 3 hours"}');

            await runPromptedStateUpdate('ai');

            await vi.waitFor(() => expect(stored('clock')).toBe(ts(2026, 9, 18, 15)));
        });
    });

    describe('end-to-end: an independent preset writes deltaSource', () => {
        it('the same cascade runs from an independent preset\'s own write path', async () => {
            createDeltaSource('jump');
            createDatetime('clock', { defaultValue: ts(2026, 1, 1), deltaSource: 'pp__jump' });
            context.chat = [{ is_user: true, mes: 'hi' }, { is_user: false, name: 'Bot', mes: 'hi' }];
            callBackgroundLLM.mockResolvedValue('{"pp__jump":"2 days"}');

            const result = await stateEngine.runIndependentPreset('pp', instanceId, 'chat-1', { namespace: 'pp', name: 'Demo' });

            expect(result).toBe(true);
            expect(stored('clock')).toBe(ts(2026, 1, 3));
            expect(stored('jump')).toBe('');
        });
    });

    describe('export/import', () => {
        it('exportPreset serializes the new fields as plain data', () => {
            createDeltaSource('jump');
            createDatetime('clock', { fixedIncrement: true, tickUnit: '1h', accumulate: true, deltaSource: 'pp__jump' });
            const presetId = Object.keys(settings.get().presets).find((id) => settings.get().presets[id].name === 'Demo');

            const data = exportPreset(presetId);
            const clock = Object.values(data.variables).find((v) => v.name === 'pp__clock');
            expect(clock).toMatchObject({ fixedIncrement: true, tickUnit: '1h', accumulate: true, deltaSource: 'pp__jump' });
        });
    });

    describe('spec', () => {
        const spec = readFileSync(SPEC_PATH, 'utf8');
        it('has a "1.31 Calculated Datetime Extension" section documenting the fields and mechanisms', () => {
            expect(spec).toMatch(/^1\.31 Calculated Datetime Extension/m);
            const section = spec.slice(spec.indexOf('1.31 Calculated Datetime Extension'), spec.indexOf('SECTION 2'));
            for (const phrase of ['fixedIncrement', 'tickUnit', 'deltaSource', 'accumulate', 'recalculateDependents', 'cycle']) {
                expect(section, phrase).toContain(phrase);
            }
        });
    });
});
