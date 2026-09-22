import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { blankDefinition, getDefaultValue } from '../src/core/variable-schema.js';
import { validateValueStrict, coerceValue } from '../src/core/variable-validation.js';
import {
    getCalendar, toStructured, fromStructured, incrementScalar,
    parseDateTime, toScalar, formatScalar, isValidDelta, resolveInstruction,
    normalizeForDatetimeMode,
} from '../src/core/calendar-engine.js';
import { runDeterministicIncrements } from '../src/core/deterministic-engine.js';
import { runPromptedStateUpdate } from '../src/core/prompted-engine.js';
import { callBackgroundLLM } from '../src/core/background-llm.js';
import { getVar } from '../src/core/chat-state.js';
import { formatValueForDisplay, describeConstraint } from '../src/ui/formatting-utils.js';
import { renderTrackerPanel, resolveTrackerEdit } from '../src/ui/tracker-panel-ui.js';
import * as variableUiSchema from '../src/ui/manager-modal/variable-ui-schema.js';
import { buildInlineVariableEditor } from '../src/ui/manager-modal/ui-templates.js';

// Only the LLM call and the two UI status hooks prompted-engine.js reaches
// for are faked; everything else in that module runs for real.
vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

// The harness swaps chat-state for an in-memory mock; the datetime branches of
// applyIncrement()/resetValueIfTypeChanged() live in the REAL module, so that
// one is loaded directly where they are under test.
const realChatState = await vi.importActual('../src/core/chat-state.js');
const { setStatus } = await import('../src/ui/settings-panel-ui.js');

const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'STATE ENGINE REQUIREMENTS SPECIFICATION.md');

// Scalar seconds for a UTC date - Date is the independent oracle the
// calendar engine's own arithmetic is checked against.
const ts = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;

let instanceId;

const create = (name, extra = {}) => stateEngine.createVariable('pp', instanceId, {
    namespace: 'pp', presetName: 'Demo', name, type: 'datetime', ...extra,
});
const live = (name) => stateEngine.getVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', variableName: name });
const stored = (name) => getVar('chat-1', `pp__${name}`)?.value;

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
    stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
    callBackgroundLLM.mockReset();
});

describe('datetime variables', () => {
    describe('calendar definitions (settings.calendars)', () => {
        it('ships a Gregorian calendar with twelve months and a leap February', () => {
            const g = settings.get().calendars.gregorian;
            expect(g).toMatchObject({
                id: 'gregorian', label: 'Gregorian Calendar', unit: 'seconds',
                secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24, leapYearRule: 'gregorian',
            });
            expect(g.months).toHaveLength(12);
            expect(g.months[1]).toEqual({ name: 'February', days: 28, leap: 29 });
            expect(g.months.reduce((n, m) => n + m.days, 0)).toBe(365);
        });

        it('getCalendar returns the definition by id, or null', () => {
            expect(getCalendar('gregorian')).toBe(settings.get().calendars.gregorian);
            expect(getCalendar('nope')).toBeNull();
            expect(getCalendar(undefined)).toBeNull();
            expect(getCalendar('toString')).toBeNull();
        });

        it('getSettings restores "gregorian" if it is missing, and keeps other calendars', () => {
            const s = settings.get();
            s.calendars = { moonphase: { id: 'moonphase', leapYearRule: 'none' } };
            expect(settings.get().calendars.gregorian.id).toBe('gregorian');
            expect(settings.get().calendars.moonphase.id).toBe('moonphase');
        });

        it('the built-in defaults are not shared with (or mutable through) the live settings', () => {
            settings.get().calendars.gregorian.months[0].days = 99;
            settings.reset();
            expect(settings.get().calendars.gregorian.months[0].days).toBe(31);
        });
    });

    describe('conversion', () => {
        it('scalar -> structured', () => {
            expect(toStructured('gregorian', 0)).toEqual({ year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
            expect(toStructured('gregorian', ts(2026, 9, 18, 22, 55, 7))).toEqual({ year: 2026, month: 9, day: 18, hour: 22, minute: 55, second: 7 });
            expect(toStructured('gregorian', ts(2024, 2, 29, 23, 59, 59))).toEqual({ year: 2024, month: 2, day: 29, hour: 23, minute: 59, second: 59 });
            expect(toStructured('gregorian', ts(2000, 12, 31))).toMatchObject({ year: 2000, month: 12, day: 31 });
        });

        it('scalar -> structured before the epoch, and floors a fractional scalar', () => {
            expect(toStructured('gregorian', -1)).toEqual({ year: 1969, month: 12, day: 31, hour: 23, minute: 59, second: 59 });
            expect(toStructured('gregorian', 1.9)).toMatchObject({ year: 1970, second: 1 });
        });

        it('structured -> scalar', () => {
            expect(fromStructured('gregorian', { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 })).toBe(0);
            expect(fromStructured('gregorian', { year: 2026, month: 9, day: 18, hour: 22, minute: 55, second: 7 })).toBe(ts(2026, 9, 18, 22, 55, 7));
            expect(fromStructured('gregorian', { year: 2024, month: 2, day: 29 })).toBe(ts(2024, 2, 29));
        });

        it('round-trips across a wide range of moments, agreeing with Date', () => {
            let seed = 12345;
            const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
            for (let i = 0; i < 2000; i++) {
                const scalar = Math.floor((rand() - 0.5) * 2 * 4e10); // about +/-1270 years around 1970
                const d = new Date(scalar * 1000);
                const s = toStructured('gregorian', scalar);
                expect(s).toEqual({
                    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
                    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
                });
                expect(fromStructured('gregorian', s)).toBe(scalar);
            }
        });

        it('knows the Gregorian leap-year rule (divisible by 4, not by 100, unless by 400)', () => {
            for (const [year, leap] of [[2024, true], [2023, false], [1900, false], [2000, true], [2100, false]]) {
                const feb29 = () => fromStructured('gregorian', { year, month: 2, day: 29 });
                if (leap) expect(feb29).not.toThrow();
                else expect(feb29).toThrow(/day must be 1-28/);
            }
        });

        it('fromStructured rejects impossible fields instead of rolling them over', () => {
            const bad = [
                { year: 2026, month: 13, day: 1 }, { year: 2026, month: 0, day: 1 }, { year: 2026, month: 2, day: 30 },
                { year: 2026, month: 4, day: 31 }, { year: 2026, month: 1, day: 1, hour: 24 },
                { year: 2026, month: 1, day: 1, minute: 60 }, { year: 2026, month: 1, day: 1, second: 60 },
                { year: 2026.5, month: 1, day: 1 }, { month: 1, day: 1 }, null,
            ];
            for (const s of bad) expect(() => fromStructured('gregorian', s)).toThrow();
        });

        it('rejects an unknown calendar and a non-finite scalar', () => {
            expect(() => toStructured('nope', 0)).toThrow(/Unknown calendar/);
            expect(() => fromStructured('nope', { year: 1, month: 1, day: 1 })).toThrow(/Unknown calendar/);
            expect(() => incrementScalar('nope', 0, '1h')).toThrow(/Unknown calendar/);
            expect(() => toStructured('gregorian', NaN)).toThrow();
            expect(() => toStructured('gregorian', '5')).toThrow();
        });

        it('refuses a calendar whose leap-year rule is not implemented (fantasy bones only)', () => {
            settings.get().calendars.harptos = {
                id: 'harptos', label: 'Harptos', unit: 'seconds', secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24,
                months: [{ name: 'Hammer', days: 30 }], leapYearRule: 'every-four-years-shieldmeet',
            };
            expect(getCalendar('harptos').id).toBe('harptos');
            expect(() => toStructured('harptos', 0)).toThrow(/not implemented/);
            expect(() => incrementScalar('harptos', 0, '1d')).toThrow(/not implemented/);
            expect(toScalar('harptos', '2026-01-01')).toBeNull();
            expect(formatScalar('harptos', 0)).toBeNull();
        });

        it('parseDateTime / toScalar / formatScalar', () => {
            expect(parseDateTime('gregorian', '2026-09-18 22:00')).toBe(ts(2026, 9, 18, 22));
            expect(parseDateTime('gregorian', '2026-09-18T22:00:05')).toBe(ts(2026, 9, 18, 22, 0, 5));
            expect(parseDateTime('gregorian', '2026-09-18T22:00:05Z')).toBe(ts(2026, 9, 18, 22, 0, 5));
            expect(parseDateTime('gregorian', '2026-09-18')).toBe(ts(2026, 9, 18));
            for (const bad of ['2026-02-30', '2026-13-01', '2026-09-18 25:00', 'tomorrow', '', '2026', 7, null]) {
                expect(parseDateTime('gregorian', bad)).toBeNull();
            }

            expect(toScalar('gregorian', 3600)).toBe(3600);
            expect(toScalar('gregorian', ' 3600 ')).toBe(3600);
            expect(toScalar('gregorian', '-90.5')).toBe(-90.5);
            expect(toScalar('gregorian', '2026-09-18 22:00')).toBe(ts(2026, 9, 18, 22));
            for (const bad of [NaN, Infinity, 'abc', '', {}, [], true, null, undefined]) expect(toScalar('gregorian', bad)).toBeNull();

            expect(formatScalar('gregorian', ts(2026, 9, 18, 22, 55))).toBe('2026-09-18 22:55:00');
            expect(formatScalar('gregorian', 0)).toBe('1970-01-01 00:00:00');
            expect(formatScalar('gregorian', 'garbage')).toBeNull();
            expect(formatScalar('nope', 0)).toBeNull();
        });

        // A real report (2026-09-22): entering a date like "2026-09-22" (or
        // with a time, "2026-09-22 00:00:00") into the manager modal's
        // default-value box was refused as "not a date-time", with no hint
        // why - the "-" the user typed/pasted had silently become a
        // visually-identical Unicode lookalike (a non-breaking hyphen, in
        // the reported case), which ISO_DATETIME never matched. Root-caused
        // by reproducing the exact input, not assumed. Fixed in toScalar()
        // (the one root every real caller already goes through - the
        // manager modal, prompted LLM answers, deltaSource jumps, World
        // Info conditions, tracker editing - see its own comment for the
        // full character list) rather than in parseDateTime() itself, which
        // stays a strict ISO matcher on purpose.
        it('toScalar normalizes Unicode dash lookalikes to a plain hyphen before parsing', () => {
            const lookalikes = ['‐', '‑', '‒', '–', '—', '―', '−'];
            for (const dash of lookalikes) {
                const dateOnly = `2026${dash}09${dash}22`;
                const withTime = `2026${dash}09${dash}22 00:00:00`;
                expect(toScalar('gregorian', dateOnly), JSON.stringify(dash)).toBe(ts(2026, 9, 22));
                expect(toScalar('gregorian', withTime), JSON.stringify(dash)).toBe(ts(2026, 9, 22));
            }
            // A negative number using the Unicode minus sign (U+2212) also
            // now parses, incidentally, from the same normalization.
            expect(toScalar('gregorian', '−90.5')).toBe(-90.5);
            // Midnight (00:00:00) is an entirely ordinary moment - nothing
            // about the all-zero time was ever special-cased or rejected.
            expect(toScalar('gregorian', '2026-09-22 00:00:00')).toBe(ts(2026, 9, 22));
            // parseDateTime() itself is deliberately NOT changed - it stays
            // a strict ISO matcher; only toScalar (the forgiving entry point
            // every real caller uses) normalizes first.
            expect(parseDateTime('gregorian', '2026‑09‑22')).toBeNull();
        });
    });

    describe('creation', () => {
        it('creates a datetime variable with a numeric defaultValue', () => {
            const def = create('clock', { defaultValue: 3600 });
            expect(def).toBeTruthy();
            expect(def).toMatchObject({ type: 'datetime', name: 'pp__clock', defaultValue: 3600, calendar: 'gregorian', unit: 'seconds' });
            expect(live('clock').defaultValue).toBe(3600);
            expect(stored('clock')).toBe(3600); // seeded with the default
        });

        it('creates a datetime variable with an ISO defaultValue, stored as scalar seconds', () => {
            const def = create('clock', { defaultValue: '2026-09-18 22:00' });
            expect(def.defaultValue).toBe(ts(2026, 9, 18, 22));
            expect(stored('clock')).toBe(ts(2026, 9, 18, 22));
        });

        it('defaults to scalar 0 when no defaultValue is given', () => {
            create('clock');
            expect(stored('clock')).toBe(0);
        });

        it('rejects an invalid defaultValue and writes nothing', () => {
            for (const bad of ['not a date', '2026-02-30 10:00', '2026-13-01', '', NaN, Infinity, {}, [], true]) {
                expect(create('clock', { defaultValue: bad })).toBeNull();
                expect(live('clock')).toBeUndefined();
            }
            expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('defaultValue'));
        });

        it('rejects a calendar that does not exist and a unit other than seconds', () => {
            expect(create('clock', { calendar: 'harptos' })).toBeNull();
            expect(create('clock', { unit: 'days' })).toBeNull();
            expect(live('clock')).toBeUndefined();
        });

        it('rejects a calendar the engine cannot convert with, only when a datetime uses it', () => {
            settings.get().calendars.harptos = { id: 'harptos', leapYearRule: 'other', months: [{ name: 'A', days: 30 }], secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 };
            // Existing calendar, unimplemented rule: the numeric default still converts to no scalar
            // problem (it is already a number), but an ISO default cannot be converted.
            expect(create('clock', { calendar: 'harptos', defaultValue: '2026-01-01' })).toBeNull();
        });

        it('blankDefinition carries calendar and unit but never defaults to datetime', () => {
            const d = blankDefinition();
            expect(d.calendar).toBe('gregorian');
            expect(d.unit).toBe('seconds');
            expect(d.type).not.toBe('datetime');
        });

        it('getDefaultValue: numeric as-is, ISO converted, anything else 0', () => {
            const dt = (defaultValue, extra = {}) => ({ ...blankDefinition(), type: 'datetime', defaultValue, ...extra });
            expect(getDefaultValue(dt(1234))).toBe(1234);
            expect(getDefaultValue(dt(-50))).toBe(-50);
            expect(getDefaultValue(dt('2026-09-18 22:00'))).toBe(ts(2026, 9, 18, 22));
            expect(getDefaultValue(dt('86400'))).toBe(86400);
            for (const bad of ['nonsense', '', null, undefined, NaN, {}, '2026-02-30']) expect(getDefaultValue(dt(bad))).toBe(0);
            expect(getDefaultValue(dt('2026-09-18', { calendar: undefined }))).toBe(ts(2026, 9, 18));
        });

        it('updateVariable applies the same rules', () => {
            create('clock', { defaultValue: 100 });
            const ref = { namespace: 'pp', presetName: 'Demo', variableName: 'clock' };
            expect(stateEngine.updateVariable('pp', instanceId, ref, { defaultValue: 'garbage' })).toBeNull();
            expect(live('clock').defaultValue).toBe(100);
            expect(stateEngine.updateVariable('pp', instanceId, ref, { calendar: 'harptos' })).toBeNull();
            expect(live('clock').calendar).toBe('gregorian');

            const updated = stateEngine.updateVariable('pp', instanceId, ref, { defaultValue: '2027-01-01 00:00' });
            expect(updated.defaultValue).toBe(ts(2027, 1, 1));
            expect(live('clock').defaultValue).toBe(ts(2027, 1, 1));
        });

        it('an unrelated update leaves a datetime variable alone', () => {
            create('clock', { defaultValue: 100 });
            const ref = { namespace: 'pp', presetName: 'Demo', variableName: 'clock' };
            const updated = stateEngine.updateVariable('pp', instanceId, ref, { label: 'Clock' });
            expect(updated).toMatchObject({ label: 'Clock', defaultValue: 100, calendar: 'gregorian' });
        });

        it('converts a stored value when a variable becomes a datetime (real chat-state)', () => {
            const numberDef = { ...blankDefinition(), name: 'x', type: 'number' };
            const asDatetime = { ...numberDef, type: 'datetime', defaultValue: 999 };

            realChatState.setVar('chat-1', 'x', 7200, numberDef);
            realChatState.resetValueIfTypeChanged('chat-1', asDatetime);
            expect(realChatState.getVar('chat-1', 'x')?.value ?? realChatState.loadChatState('chat-1').variables.x.value).toBe(7200);

            const stringDef = { ...numberDef, type: 'string' };
            realChatState.setVar('chat-1', 'x', '2026-09-18 22:00', stringDef);
            realChatState.resetValueIfTypeChanged('chat-1', asDatetime);
            expect(realChatState.loadChatState('chat-1').variables.x.value).toBe(ts(2026, 9, 18, 22));

            realChatState.setVar('chat-1', 'x', 'soon', stringDef);
            realChatState.resetValueIfTypeChanged('chat-1', asDatetime);
            expect(realChatState.loadChatState('chat-1').variables.x.value).toBe(999); // unconvertible -> the default
        });

        it('a value that is not a datetime still resets to the new default when another type is chosen', () => {
            const dtDef = { ...blankDefinition(), name: 'x', type: 'datetime' };
            realChatState.setVar('chat-1', 'x', 5000, dtDef);
            realChatState.resetValueIfTypeChanged('chat-1', { ...dtDef, type: 'number', defaultValue: 3 });
            expect(realChatState.loadChatState('chat-1').variables.x.value).toBe(3);
        });
    });

    describe('validation and coercion', () => {
        const def = { ...blankDefinition(), type: 'datetime', defaultValue: 42 };

        it('validateValueStrict accepts numbers, numeric strings and ISO strings', () => {
            expect(validateValueStrict(def, 3600)).toEqual({ valid: true, value: 3600, error: undefined });
            expect(validateValueStrict(def, '3600').value).toBe(3600);
            expect(validateValueStrict(def, '2026-09-18 22:00')).toMatchObject({ valid: true, value: ts(2026, 9, 18, 22) });
            expect(validateValueStrict(def, '2026-09-18T22:00:30').value).toBe(ts(2026, 9, 18, 22, 0, 30));
        });

        it('validateValueStrict rejects invalid formats and falls back to the default', () => {
            for (const bad of ['tomorrow', '2026-02-30', '2026-09-18 25:00', NaN, Infinity, {}, [], true, '']) {
                const r = validateValueStrict(def, bad);
                expect(r.valid).toBe(false);
                expect(r.value).toBe(42);
                expect(r.error).toMatch(/not a valid datetime/);
            }
        });

        it('null/undefined mean "the default", like every other type', () => {
            expect(validateValueStrict(def, undefined)).toMatchObject({ valid: true, value: 42 });
            expect(coerceValue(def, null)).toBe(42);
        });

        it('coerceValue follows the same rules', () => {
            expect(coerceValue(def, 100)).toBe(100);
            expect(coerceValue(def, '100')).toBe(100);
            expect(coerceValue(def, '2026-09-18 22:00')).toBe(ts(2026, 9, 18, 22));
            expect(coerceValue(def, 'garbage')).toBe(42);
            expect(coerceValue(def, {})).toBe(42);
        });
    });

    describe('increments', () => {
        // [delta, start, expected]
        const CASES = [
            ['1h', ts(2026, 9, 18, 22), ts(2026, 9, 18, 23)],
            ['1h', ts(2026, 9, 18, 23, 30), ts(2026, 9, 19, 0, 30)],
            ['1d', ts(2026, 9, 18, 22), ts(2026, 9, 19, 22)],
            ['1d', ts(2026, 12, 31, 12), ts(2027, 1, 1, 12)],
            ['1d', ts(2024, 2, 28), ts(2024, 2, 29)], // leap day exists
            ['1d', ts(2026, 2, 28), ts(2026, 3, 1)], // ...and not in a common year
            // months: variable lengths
            ['1mo', ts(2026, 1, 15, 8), ts(2026, 2, 15, 8)],
            ['1mo', ts(2026, 1, 31), ts(2026, 2, 28)], // clamped to a 28-day February
            ['1mo', ts(2024, 1, 31), ts(2024, 2, 29)], // ...29 in a leap year
            ['1mo', ts(2026, 3, 31, 6, 30), ts(2026, 4, 30, 6, 30)], // 31 -> 30, time kept
            ['1mo', ts(2026, 12, 15), ts(2027, 1, 15)], // year rollover
            ['1mo', ts(2026, 8, 31), ts(2026, 9, 30)],
            ['12mo', ts(2026, 5, 5), ts(2027, 5, 5)],
            // years: leap years
            ['1y', ts(2026, 9, 18, 22), ts(2027, 9, 18, 22)],
            ['1y', ts(2023, 3, 1), ts(2024, 3, 1)], // spans Feb 29 2024: 366 days
            ['1y', ts(2024, 3, 1), ts(2025, 3, 1)], // 365 days
            ['1y', ts(2024, 2, 29), ts(2025, 2, 28)], // leap day -> last day of Feb
            ['1y', ts(2024, 2, 29), ts(2025, 2, 28)],
            ['4y', ts(2024, 2, 29), ts(2028, 2, 29)],
            ['100y', ts(2000, 2, 29), ts(2100, 2, 28)], // 2100 is not a leap year
            // other spellings and shapes
            ['3 hours', ts(2026, 9, 18), ts(2026, 9, 18, 3)],
            ['90m', ts(2026, 9, 18), ts(2026, 9, 18, 1, 30)],
            ['45s', ts(2026, 9, 18), ts(2026, 9, 18, 0, 0, 45)],
            ['2w', ts(2026, 9, 18), ts(2026, 10, 2)],
            ['1.5h', ts(2026, 9, 18), ts(2026, 9, 18, 1, 30)],
            ['1d 2h', ts(2026, 9, 18), ts(2026, 9, 19, 2)],
            ['1y, 2mo and 3d', ts(2026, 1, 10), ts(2027, 3, 13)],
            ['1 month', ts(2026, 1, 31), ts(2026, 2, 28)],
            ['-1d', ts(2026, 9, 18, 22), ts(2026, 9, 17, 22)],
            ['-1mo', ts(2026, 3, 31), ts(2026, 2, 28)],
            ['-1y', ts(2024, 2, 29), ts(2023, 2, 28)],
            ['3600', 0, 3600], // a bare number is seconds
            [3600, 0, 3600],
        ];

        describe('calendar.incrementScalar', () => {
            it.each(CASES)('%s from %i is %i', (delta, start, expected) => {
                expect(incrementScalar('gregorian', start, delta)).toBe(expected);
            });

            it('1h and 1d are exactly 3600 and 86400 seconds', () => {
                expect(incrementScalar('gregorian', 0, '1h')).toBe(3600);
                expect(incrementScalar('gregorian', 0, '1d')).toBe(86400);
            });

            it('month and year steps are calendar-aware (28-31 days, 365-366 days)', () => {
                const days = (from, delta) => (incrementScalar('gregorian', from, delta) - from) / 86400;
                expect([days(ts(2026, 1, 1), '1mo'), days(ts(2026, 2, 1), '1mo'), days(ts(2026, 4, 1), '1mo'), days(ts(2024, 2, 1), '1mo')])
                    .toEqual([31, 28, 30, 29]);
                expect([days(ts(2023, 3, 1), '1y'), days(ts(2024, 3, 1), '1y')]).toEqual([366, 365]);
            });

            it('rejects a bad delta, a bad scalar, and fractional months/years', () => {
                for (const bad of ['', '   ', 'banana', '1x', 'h', '1h 2', '1.5mo', '0.5y', NaN, null, undefined, {}, '1h and']) {
                    expect(() => incrementScalar('gregorian', 0, bad), String(bad)).toThrow();
                }
                expect(() => incrementScalar('gregorian', NaN, '1h')).toThrow();
                expect(() => incrementScalar('gregorian', '5', '1h')).toThrow();
            });

            it('isValidDelta mirrors what incrementScalar accepts', () => {
                expect(isValidDelta('gregorian', '1mo')).toBe(true);
                expect(isValidDelta('gregorian', 5)).toBe(true);
                expect(isValidDelta('gregorian', 'banana')).toBe(false);
                expect(isValidDelta('nope', '1h')).toBe(false);
            });

            // A real report (2026-09-22): a deltaSource string variable
            // (requirements spec 1.31) prompted with natural phrasing like
            // "One Month" or "one day" never advanced the datetime at all -
            // DELTA_TOKEN's amount group is `\d+`, which a spelled-out
            // number never matches, so the delta silently failed to parse
            // (console.warn'd and discarded - both the datetime value and
            // the source left untouched) with no visible reason. Root-
            // caused by reproducing the exact reported input through the
            // real resolveInstruction()/applyDatetimeDeltaTriggers() path,
            // not assumed. Fixed the same way the Unicode-dash-lookalike
            // report was: normalized before the strict token parser ever
            // runs, in parseDeltaFor() (calendar-engine.js) - the one root
            // every duration-string caller already funnels through
            // (deltaSource jumps, a legacy increment.delta "Advance by",
            // independent-preset interval/delay/repeat schedule values).
            it('accepts spelled-out cardinal numbers ("one month", "a day", "twenty-five days"), case-insensitively', () => {
                expect(incrementScalar('gregorian', 0, 'one month')).toBe(incrementScalar('gregorian', 0, '1mo'));
                expect(incrementScalar('gregorian', 0, 'One Day')).toBe(86400);
                expect(incrementScalar('gregorian', 0, 'a day')).toBe(86400);
                expect(incrementScalar('gregorian', 0, 'an hour')).toBe(3600);
                expect(incrementScalar('gregorian', 0, 'twenty-five days')).toBe(25 * 86400);
                expect(incrementScalar('gregorian', 0, 'twenty five days')).toBe(25 * 86400); // no hyphen, same result
                expect(incrementScalar('gregorian', 0, 'thirty days')).toBe(30 * 86400);
                expect(incrementScalar('gregorian', 0, 'two years, three months and one day'))
                    .toBe(incrementScalar('gregorian', 0, '2y, 3mo and 1d'));
            });

            it('the deltaSource path (resolveInstruction with the "advance " fallback) resolves the exact reported phrasing', () => {
                const now = ts(2026, 9, 18, 12);
                expect(resolveInstruction('gregorian', now, 'advance One Month')).toBe(incrementScalar('gregorian', now, '1mo'));
                expect(resolveInstruction('gregorian', now, 'advance one day')).toBe(now + 86400);
            });

            it('a spelled-out number never corrupts "and" (the delta list separator) or a word merely containing "a"/"an"', () => {
                expect(incrementScalar('gregorian', 0, '1y, 2mo and 3d')).toBe(incrementScalar('gregorian', 0, '1y 2mo 3d'));
                // "advance" itself contains "a" and "an" as substrings, not
                // as standalone words - must not become "1dv1nce" or similar.
                expect(resolveInstruction('gregorian', 0, 'advance 1 day')).toBe(86400);
            });

            it('still rejects real gibberish - the normalization only recognizes actual number words', () => {
                for (const bad of ['banana', 'zillion days', 'many months', 'a couple of days']) {
                    expect(() => incrementScalar('gregorian', 0, bad), bad).toThrow();
                }
            });
        });

        describe('applyIncrement (real chat-state)', () => {
            const def = () => ({ ...blankDefinition(), name: 'when', type: 'datetime', behaviors: { increment: true, prompted: false } });

            it.each(CASES.filter((c) => typeof c[0] === 'string'))('%s from %i is %i', (delta, start, expected) => {
                realChatState.setVar('chat-1', 'when', start, def());
                realChatState.applyIncrement('chat-1', 'when', delta, def());
                expect(realChatState.loadChatState('chat-1').variables.when.value).toBe(expected);
            });

            it('does NOT treat a datetime as a number increment', () => {
                realChatState.setVar('chat-1', 'when', ts(2026, 1, 31), def());
                realChatState.applyIncrement('chat-1', 'when', '1mo', def());
                const value = realChatState.loadChatState('chat-1').variables.when.value;
                expect(value).toBe(ts(2026, 2, 28));
                expect(value).not.toBe(ts(2026, 1, 31) + 1); // Number(value) + Number(delta) would be NaN or +1
            });

            it('mirrors the new scalar into the macro store', () => {
                const d = def();
                realChatState.setVar('chat-1', 'when', 0, d);
                realChatState.applyIncrement('chat-1', 'when', '1d', d);
                expect(context.variables.local.get('when')).toBe(86400);
            });

            it('starts from the default value when nothing has been stored yet', () => {
                const d = { ...def(), defaultValue: '2026-09-18 22:00' };
                realChatState.applyIncrement('chat-1', 'fresh', '1h', d);
                expect(realChatState.loadChatState('chat-1').variables.fresh.value).toBe(ts(2026, 9, 18, 23));
            });

            it('repairs a non-numeric stored value from its ISO form, and leaves the value alone on a bad delta', () => {
                const d = def();
                realChatState.setVar('chat-1', 'when', 0, d);
                realChatState.loadChatState('chat-1').variables.when.value = '2026-09-18 22:00';
                realChatState.applyIncrement('chat-1', 'when', '1h', d);
                expect(realChatState.loadChatState('chat-1').variables.when.value).toBe(ts(2026, 9, 18, 23));

                realChatState.applyIncrement('chat-1', 'when', 'banana', d);
                expect(realChatState.loadChatState('chat-1').variables.when.value).toBe(ts(2026, 9, 18, 23));
            });

            // Datetime mode (requirements spec 1.36): applyIncrement() writes
            // entry.value directly rather than through setVar() (this
            // module's own header comment), so the normalization setVar
            // applies for every OTHER write path is repeated here - checked
            // directly against the real module, not just through the mock
            // every other test in this describe block for datetime mode
            // exercises (tests/harness/chat-state.mock.js mirrors this same
            // rule, for those other suites).
            it('normalizes a "dateOnly" tick, exactly like setVar does', () => {
                const d = { ...def(), datetimeMode: 'dateOnly' };
                realChatState.setVar('chat-1', 'when', ts(2026, 9, 18), d);
                realChatState.applyIncrement('chat-1', 'when', '30h', d);
                expect(realChatState.loadChatState('chat-1').variables.when.value).toBe(ts(2026, 9, 19));
            });
        });

        describe('deterministic increments (runDeterministicIncrements)', () => {
            const makeIncrementing = (name, delta, start, extra = {}) => create(name, {
                defaultValue: start,
                behaviors: { increment: true, prompted: false },
                increment: { delta, triggers: 'ai' },
                ...extra,
            });

            it.each([
                ['+1h', '1h', ts(2026, 9, 18, 22), ts(2026, 9, 18, 23)],
                ['+1d', '1d', ts(2026, 9, 18, 22), ts(2026, 9, 19, 22)],
                ['+1mo (Jan 31 -> Feb 28)', '1mo', ts(2026, 1, 31), ts(2026, 2, 28)],
                ['+1mo (Jan 31 -> Feb 29, leap)', '1mo', ts(2024, 1, 31), ts(2024, 2, 29)],
                ['+1y (leap day)', '1y', ts(2024, 2, 29), ts(2025, 2, 28)],
                ['+1y (over a leap February)', '1y', ts(2023, 3, 1), ts(2024, 3, 1)],
            ])('%s', (_label, delta, start, expected) => {
                makeIncrementing('clock', delta, start);
                runDeterministicIncrements('chat-1', 'ai');
                expect(stored('clock')).toBe(expected);
            });

            it('advances again on every trigger', () => {
                makeIncrementing('clock', '1d', ts(2026, 2, 27));
                runDeterministicIncrements('chat-1', 'ai');
                runDeterministicIncrements('chat-1', 'ai');
                expect(stored('clock')).toBe(ts(2026, 3, 1));
            });

            it('only fires on its own trigger', () => {
                makeIncrementing('clock', '1d', 0);
                runDeterministicIncrements('chat-1', 'user');
                expect(stored('clock')).toBe(0);
            });

            it('skips a variable whose delta the calendar cannot parse, and carries on with the rest', () => {
                makeIncrementing('broken', 'banana', 500);
                makeIncrementing('fine', '1h', 0);
                runDeterministicIncrements('chat-1', 'ai');
                expect(stored('broken')).toBe(500);
                expect(stored('fine')).toBe(3600);
                expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('datetime increment skipped for "pp__broken"'));
            });

            it('a plain numeric delta on a datetime is seconds', () => {
                makeIncrementing('clock', 90, 0);
                runDeterministicIncrements('chat-1', 'ai');
                expect(stored('clock')).toBe(90);
            });

            it('leaves non-datetime variables on plain numeric addition', () => {
                stateEngine.createVariable('pp', instanceId, {
                    namespace: 'pp', presetName: 'Demo', name: 'n', type: 'number', defaultValue: 5,
                    behaviors: { increment: true, prompted: false }, increment: { delta: 2, triggers: 'ai' },
                });
                runDeterministicIncrements('chat-1', 'ai');
                expect(stored('n')).toBe(7);
            });
        });

        describe('prompted updates', () => {
            const runAi = async () => {
                context.chat = [{ is_user: true, mes: 'they wait until the evening' }, { is_user: false, name: 'Bot', mes: 'Hours pass.' }];
                await runPromptedStateUpdate('ai');
            };
            const promptedClock = (extra = {}) => create('clock', {
                defaultValue: '2026-09-18 12:00',
                behaviors: { prompted: true, increment: false },
                prompted: { instructions: 'track the in-story time' },
                ...extra,
            });
            const systemPrompt = () => callBackgroundLLM.mock.calls[0][2][0].content;

            it.each([
                ['advance 3 hours', ts(2026, 9, 18, 15)],
                ['advance 1 day', ts(2026, 9, 19, 12)],
                ['advance 1 month', ts(2026, 10, 18, 12)],
                ['set time to 2026-09-18 22:00', ts(2026, 9, 18, 22)],
                ['move forward 1 day', ts(2026, 9, 19, 12)],
                ['Advance 2 hours.', ts(2026, 9, 18, 14)],
                ['rewind 2 hours', ts(2026, 9, 18, 10)],
                ['2027-01-01 08:30', ts(2027, 1, 1, 8, 30)],
            ])('the model answers "%s"', async (answer, expected) => {
                promptedClock();
                callBackgroundLLM.mockResolvedValue(JSON.stringify({ pp__clock: answer }));

                await runAi();

                await vi.waitFor(() => expect(stored('clock')).toBe(expected));
            });

            it('advances relative to the value at the time the answer is applied', async () => {
                promptedClock();
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"advance 1 day"}');
                await runAi();
                await vi.waitFor(() => expect(stored('clock')).toBe(ts(2026, 9, 19, 12)));

                await runAi();
                await vi.waitFor(() => expect(stored('clock')).toBe(ts(2026, 9, 20, 12)));
            });

            it('skips (and logs) an answer it cannot understand, leaving the value alone', async () => {
                promptedClock();
                create('other', { defaultValue: 0, behaviors: { prompted: true, increment: false } });
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"a while later","pp__other":"advance 1 hour"}');

                await runAi();
                await vi.waitFor(() => expect(stored('other')).toBe(3600));

                expect(stored('clock')).toBe(ts(2026, 9, 18, 12));
                expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('could not understand'));
            });

            it('shows the model the current time as a date and explains how to answer', async () => {
                promptedClock();
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"advance 1 hour"}');

                await runAi();

                expect(systemPrompt()).toContain('currently "2026-09-18 12:00:00"');
                expect(systemPrompt()).toContain('advance 3 hours');
                expect(systemPrompt()).not.toContain(String(ts(2026, 9, 18, 12)));
            });

            // A real report (2026-09-22): the messages array sent to the LLM
            // ends with a SEPARATE synthetic instruction turn ("Output the
            // JSON object now...", below) - a variable's own prompted
            // instructions saying "look at the latest message" had no
            // reliable way to mean the actual last roleplay line instead of
            // that wrapper. The system prompt now explicitly labels it.
            it('explicitly labels the actual last chat message "Most recent roleplay message", separate from earlier history', async () => {
                promptedClock();
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"advance 1 hour"}');

                await runAi();

                expect(systemPrompt()).toContain('Recent conversation:\nUser: they wait until the evening');
                expect(systemPrompt()).toContain('Most recent roleplay message:\nBot: Hours pass.');
                // The actual last message in the API call is a different,
                // synthetic turn entirely - never confused with the label above.
                const messages = callBackgroundLLM.mock.calls[0][2];
                expect(messages[messages.length - 1].content).toBe('Output the JSON object now. JSON only, no other text.');
            });

            it('the header establishes the "Most recent roleplay message" term for a variable\'s own instructions to reference', async () => {
                promptedClock();
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"advance 1 hour"}');

                await runAi();

                expect(systemPrompt()).toContain('Most recent roleplay message');
                expect(systemPrompt()).toMatch(/latest message.*Most recent roleplay message/s);
            });

            it('a prompted INCREMENT runs the configured delta through the calendar', async () => {
                create('scene', {
                    defaultValue: '2026-01-31 09:00',
                    behaviors: { prompted: true, increment: true },
                    increment: { delta: '1mo', triggers: 'ai' },
                    prompted: { instructions: 'true if a month passed' },
                });
                callBackgroundLLM.mockResolvedValue('{"pp__scene":true}');

                await runAi();

                await vi.waitFor(() => expect(stored('scene')).toBe(ts(2026, 2, 28, 9)));
            });

            // Automatic prompt chunking (requirements spec 1.20, rewritten
            // 2026-09-22): a datetime variable participates in the main
            // prompted update exactly like every other prompted variable -
            // there is no separate "batch" a caller could move it out of any
            // more (that manual-scoping system never matched what was
            // actually asked for; see the requirements spec entry).
            it('is part of the main prompt, with no way to exclude it via any manual scoping', async () => {
                promptedClock();
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"advance 1 hour"}');
                await runAi();
                expect(systemPrompt()).toContain('"pp__clock"');
            });

            it('resolveInstruction understands natural language and refuses the rest', () => {
                const now = ts(2026, 9, 18, 12);
                const r = (text) => resolveInstruction('gregorian', now, text);
                expect(r('advance 3 hours')).toBe(now + 3 * 3600);
                expect(r('move forward 1 day')).toBe(now + 86400);
                expect(r('skip ahead 2 days and 3 hours')).toBe(now + 2 * 86400 + 3 * 3600);
                expect(r('advance the time by 30 minutes')).toBe(now + 1800);
                expect(r('go back 1 hour')).toBe(now - 3600);
                expect(r('set the date to 2030-05-06')).toBe(ts(2030, 5, 6));
                expect(r('2030-05-06 07:08:09')).toBe(ts(2030, 5, 6, 7, 8, 9));
                expect(r(500)).toBe(500);
                expect(r('500')).toBe(500);
                for (const bad of ['make it evening', 'advance', 'advance soon', 'advance 1.5 months', 'set time to noon', '', null, undefined, {}, NaN]) {
                    expect(r(bad), String(bad)).toBeNull();
                }
                expect(resolveInstruction('nope', now, 'advance 1 hour')).toBeNull();
            });

            it('describeConstraint tells the model how to answer a datetime', () => {
                expect(describeConstraint({ type: 'datetime' })).toMatch(/YYYY-MM-DD HH:MM:SS.*advance 3 hours/s);
            });
        });
    });

    describe('semantic time of day (spec 1.35)', () => {
        describe('calendar-engine.resolveInstruction with { semanticTimeOfDay: true }', () => {
            const now = ts(2026, 9, 18, 12); // noon
            const r = (text) => resolveInstruction('gregorian', now, text, { semanticTimeOfDay: true });

            it('maps every canonical phrase to its hour, same day, when enabled', () => {
                expect(r('morning')).toBe(ts(2026, 9, 18, 8));
                expect(r('dawn')).toBe(ts(2026, 9, 18, 6));
                expect(r('sunrise')).toBe(ts(2026, 9, 18, 6));
                expect(r('noon')).toBe(ts(2026, 9, 18, 12));
                expect(r('afternoon')).toBe(ts(2026, 9, 18, 15));
                expect(r('evening')).toBe(ts(2026, 9, 18, 18));
                expect(r('sunset')).toBe(ts(2026, 9, 18, 19));
                expect(r('night')).toBe(ts(2026, 9, 18, 21));
                expect(r('midnight')).toBe(ts(2026, 9, 18, 0));
            });

            it('accepts an optional "the" prefix and any case', () => {
                expect(r('the morning')).toBe(ts(2026, 9, 18, 8));
                expect(r('Evening')).toBe(ts(2026, 9, 18, 18));
                expect(r('  THE NIGHT  ')).toBe(ts(2026, 9, 18, 21));
            });

            it('"the next X" variants advance one day before applying the canonical time', () => {
                expect(r('the next morning')).toBe(ts(2026, 9, 19, 8));
                expect(r('the next night')).toBe(ts(2026, 9, 19, 21));
                expect(r('the next evening')).toBe(ts(2026, 9, 19, 18));
            });

            it('generalizes "next X" (with or without "the") to every canonical phrase, not just the three examples', () => {
                expect(r('next dawn')).toBe(ts(2026, 9, 19, 6));
                expect(r('the next midnight')).toBe(ts(2026, 9, 19, 0));
                expect(r('next noon')).toBe(ts(2026, 9, 19, 12));
            });

            it('can move the clock backwards within the same day - a literal target time, not a forward-only nudge', () => {
                // "now" is noon; asking for "morning" (08:00) is earlier the same day.
                expect(r('morning')).toBe(ts(2026, 9, 18, 8));
                expect(r('morning')).toBeLessThan(now);
            });

            it('is still just a target time - a duration in the SAME answer never applies alongside it', () => {
                // No duration grammar runs once a semantic phrase matches -
                // there is no combined "morning and 3 hours" concept.
                expect(r('morning')).toBe(ts(2026, 9, 18, 8));
            });

            it('falls back to null when the calendar cannot represent the canonical hour', () => {
                settings.get().calendars.short = {
                    id: 'short', label: 'Short Day', leapYearRule: 'none',
                    months: [{ name: 'A', days: 30 }], secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 10,
                };
                // night -> hour 21, but this calendar only has hours 0-9.
                expect(resolveInstruction('short', 0, 'night', { semanticTimeOfDay: true })).toBeNull();
                // noon -> hour 12, also out of range; morning -> hour 8 is fine.
                expect(resolveInstruction('short', 0, 'noon', { semanticTimeOfDay: true })).toBeNull();
                expect(resolveInstruction('short', 0, 'morning', { semanticTimeOfDay: true })).not.toBeNull();
            });

            it('is completely inert unless explicitly enabled - no regression for existing datetime variables', () => {
                expect(resolveInstruction('gregorian', now, 'morning')).toBeNull();
                expect(resolveInstruction('gregorian', now, 'the next evening')).toBeNull();
                // The pre-existing natural-language grammar is unaffected either way.
                expect(resolveInstruction('gregorian', now, 'advance 3 hours', { semanticTimeOfDay: true })).toBe(now + 3 * 3600);
            });

            it('non-phrase text is still refused, exactly as before', () => {
                for (const bad of ['make it evening', 'the mornings', 'nextmorning', '']) {
                    expect(r(bad), String(bad)).toBeNull();
                }
            });
        });

        describe('schema and validation', () => {
            it('blankDefinition defaults timeSemanticMode to "none"', () => {
                expect(blankDefinition().timeSemanticMode).toBe('none');
            });

            it('createVariable accepts "semanticTimeOfDay" and persists it', () => {
                const def = create('clock', { timeSemanticMode: 'semanticTimeOfDay' });
                expect(def.timeSemanticMode).toBe('semanticTimeOfDay');
                expect(live('clock').timeSemanticMode).toBe('semanticTimeOfDay');
            });

            it('rejects anything else and writes nothing', () => {
                expect(create('clock', { timeSemanticMode: 'always' })).toBeNull();
                expect(live('clock')).toBeUndefined();
                expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('timeSemanticMode'));
            });

            it('updateVariable can toggle it, and an unrelated update leaves it alone', () => {
                create('clock', { timeSemanticMode: 'semanticTimeOfDay' });
                const ref = { namespace: 'pp', presetName: 'Demo', variableName: 'clock' };
                const untouched = stateEngine.updateVariable('pp', instanceId, ref, { label: 'Clock' });
                expect(untouched.timeSemanticMode).toBe('semanticTimeOfDay');

                const toggledOff = stateEngine.updateVariable('pp', instanceId, ref, { timeSemanticMode: 'none' });
                expect(toggledOff.timeSemanticMode).toBe('none');
            });
        });

        describe('prompted updates', () => {
            const runAi = async () => {
                context.chat = [{ is_user: true, mes: 'they say goodnight' }, { is_user: false, name: 'Bot', mes: 'The scene fades.' }];
                await runPromptedStateUpdate('ai');
            };
            const semanticClock = (extra = {}) => create('clock', {
                defaultValue: '2026-09-18 12:00',
                behaviors: { prompted: true, increment: false },
                prompted: { instructions: 'track the in-story time' },
                timeSemanticMode: 'semanticTimeOfDay',
                ...extra,
            });

            it.each([
                ['the next morning', ts(2026, 9, 19, 8)],
                ['the next evening', ts(2026, 9, 19, 18)],
                ['midnight', ts(2026, 9, 18, 0)],
                ['sunset', ts(2026, 9, 18, 19)],
            ])('a variable with timeSemanticMode "semanticTimeOfDay" understands the model answering "%s"', async (answer, expected) => {
                semanticClock();
                callBackgroundLLM.mockResolvedValue(JSON.stringify({ pp__clock: answer }));

                await runAi();

                await vi.waitFor(() => expect(stored('clock')).toBe(expected));
                // The tracker's own display formatting reads straight off the
                // stored scalar, so the semantic interpretation shows up
                // normalized the same way any other resolved datetime does.
                expect(formatValueForDisplay(stored('clock'), live('clock'))).toBe(formatScalar('gregorian', expected));
            });

            it('a plain datetime (timeSemanticMode "none", the default) does NOT understand a semantic phrase - no regression', async () => {
                semanticClock({ timeSemanticMode: 'none' });
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"the next morning"}');

                await runAi();

                await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('could not understand')));
                expect(stored('clock')).toBe(ts(2026, 9, 18, 12)); // unchanged
            });

            it('an ordinary duration/verb answer still works exactly as before on a semantic-enabled variable', async () => {
                semanticClock();
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"advance 3 hours"}');

                await runAi();

                await vi.waitFor(() => expect(stored('clock')).toBe(ts(2026, 9, 18, 15)));
            });
        });
        // deltaSource's own cooperation (or lack of it) with timeSemanticMode
        // needs the REAL calculated-engine.js (this file's harness uses the
        // simplified mock every OTHER suite here relies on) - covered instead
        // in tests/calculated-datetime.test.js, which already mocks in the
        // real module for exactly this reason.
    });

    describe('datetime mode (spec 1.36)', () => {
        describe('calendar-engine.normalizeForDatetimeMode', () => {
            it('"full" (and anything not "dateOnly"/"timeOnly") is a pure no-op', () => {
                const t = ts(2026, 9, 18, 22, 55, 30);
                expect(normalizeForDatetimeMode('gregorian', t, 'full')).toBe(t);
                expect(normalizeForDatetimeMode('gregorian', t, undefined)).toBe(t);
                expect(normalizeForDatetimeMode('gregorian', t, 'bogus')).toBe(t);
            });

            it('"dateOnly" truncates the time-of-day to 00:00:00, keeping the date', () => {
                expect(normalizeForDatetimeMode('gregorian', ts(2026, 9, 18, 22, 55, 30), 'dateOnly')).toBe(ts(2026, 9, 18));
            });

            it('"timeOnly" pins the date to the calendar\'s reference moment (day 0), keeping the time', () => {
                expect(normalizeForDatetimeMode('gregorian', ts(2026, 9, 18, 22, 55, 30), 'timeOnly')).toBe(ts(1970, 1, 1, 22, 55, 30));
            });

            it('a fantasy calendar\'s "timeOnly" reference is ITS OWN epoch (year 1, month 1, day 1), not Gregorian 1970', () => {
                settings.get().calendars.fantasy = {
                    id: 'fantasy', label: 'Fantasy', unit: 'seconds',
                    secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24, leapYearRule: 'none',
                    months: [{ name: 'Frostmoon', days: 40 }, { name: 'Sunmoon', days: 40 }],
                };
                const scalar = fromStructured('fantasy', { year: 5, month: 2, day: 10, hour: 14, minute: 0, second: 0 });
                const normalized = normalizeForDatetimeMode('fantasy', scalar, 'timeOnly');
                expect(toStructured('fantasy', normalized)).toMatchObject({ year: 1, month: 1, day: 1, hour: 14, minute: 0, second: 0 });
            });

            it('rolls the date forward naturally when a "dateOnly" scalar already carries more than 24h worth of seconds - no special-cased rollover logic needed', () => {
                // Applying a 30-hour delta first (ordinary scalar arithmetic,
                // unrestricted - 1.36's own design note) already lands on
                // day+1 at 06:00; normalizing then just drops that leftover
                // 6 hours, which is what "roll the date forward when
                // accumulated time exceeds 24 hours" describes as an outcome.
                const advanced = incrementScalar('gregorian', ts(2026, 9, 18), '30h');
                expect(normalizeForDatetimeMode('gregorian', advanced, 'dateOnly')).toBe(ts(2026, 9, 19));
            });

            it('a non-number scalar or an unknown calendar passes through unchanged rather than throwing', () => {
                expect(normalizeForDatetimeMode('gregorian', NaN, 'dateOnly')).toBeNaN();
                expect(normalizeForDatetimeMode('gregorian', undefined, 'dateOnly')).toBeUndefined();
                expect(normalizeForDatetimeMode('nope', 1000, 'dateOnly')).toBe(1000);
            });
        });

        describe('schema and validation', () => {
            it('blankDefinition defaults datetimeMode to "full"', () => {
                expect(blankDefinition().datetimeMode).toBe('full');
            });

            it('createVariable accepts "dateOnly"/"timeOnly" and persists them', () => {
                expect(create('a', { datetimeMode: 'dateOnly' }).datetimeMode).toBe('dateOnly');
                expect(create('b', { datetimeMode: 'timeOnly' }).datetimeMode).toBe('timeOnly');
                expect(live('a').datetimeMode).toBe('dateOnly');
            });

            it('rejects anything else and writes nothing', () => {
                expect(create('clock', { datetimeMode: 'yearOnly' })).toBeNull();
                expect(live('clock')).toBeUndefined();
                expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('datetimeMode'));
            });

            it('normalizes defaultValue at save time - "Date only"/"Time only" never even START inconsistent', () => {
                expect(create('a', { datetimeMode: 'dateOnly', defaultValue: '2026-09-18 22:00' }).defaultValue).toBe(ts(2026, 9, 18));
                expect(create('b', { datetimeMode: 'timeOnly', defaultValue: '2026-09-18 22:00' }).defaultValue).toBe(ts(1970, 1, 1, 22));
                expect(stored('a')).toBe(ts(2026, 9, 18)); // seeded from the already-normalized default
                expect(stored('b')).toBe(ts(1970, 1, 1, 22));
            });

            it('"Date only" forces timeSemanticMode to "none", even if both were requested together - it can never use it', () => {
                const def = create('clock', { datetimeMode: 'dateOnly', timeSemanticMode: 'semanticTimeOfDay' });
                expect(def.timeSemanticMode).toBe('none');
                expect(live('clock').timeSemanticMode).toBe('none');
            });

            it('"Time only" and "full" may combine freely with timeSemanticMode', () => {
                expect(create('a', { datetimeMode: 'timeOnly', timeSemanticMode: 'semanticTimeOfDay' }).timeSemanticMode).toBe('semanticTimeOfDay');
                expect(create('b', { datetimeMode: 'full', timeSemanticMode: 'semanticTimeOfDay' }).timeSemanticMode).toBe('semanticTimeOfDay');
            });

            it('updateVariable can toggle it, and an unrelated update leaves it alone', () => {
                create('clock', { datetimeMode: 'dateOnly' });
                const ref = { namespace: 'pp', presetName: 'Demo', variableName: 'clock' };
                const untouched = stateEngine.updateVariable('pp', instanceId, ref, { label: 'Clock' });
                expect(untouched.datetimeMode).toBe('dateOnly');

                const toggled = stateEngine.updateVariable('pp', instanceId, ref, { datetimeMode: 'full' });
                expect(toggled.datetimeMode).toBe('full');
            });

            // The prompted-engine.js write path re-checks the same rule at
            // runtime (defense in depth: the manager-modal's own inline
            // editor writes preset.variables directly, bypassing
            // checkedDatetime - same reason deltaSource is re-checked there
            // too), so it never depends solely on save-time validation having
            // run. Confirmed structurally, the same way this codebase's own
            // calendar-format.test.js/fantasy-calendar.test.js already check
            // a source-level guarantee rather than fabricate bypassed state.
            it('prompted-engine.js re-gates semantic parsing on datetimeMode, not just on the stored timeSemanticMode', () => {
                const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'prompted-engine.js'), 'utf8');
                expect(src).toMatch(/datetimeMode\s*!==\s*'dateOnly'\s*&&\s*def\.timeSemanticMode\s*===\s*'semanticTimeOfDay'/);
            });
        });

        describe('write-path normalization (chat-state.js: setVar and applyIncrement)', () => {
            it('a deterministic tick on a "dateOnly" variable applies the full delta then truncates the time', () => {
                create('clock', {
                    datetimeMode: 'dateOnly', defaultValue: ts(2026, 9, 18),
                    behaviors: { increment: true, prompted: false }, increment: { delta: '30h', triggers: 'ai' },
                });
                runDeterministicIncrements('chat-1', 'ai');
                expect(stored('clock')).toBe(ts(2026, 9, 19)); // rolled forward a day, time truncated
            });

            it('a deterministic tick on a "timeOnly" variable with a pure day/week/month/year delta has NO visible effect - "ignored"', () => {
                create('clock', {
                    datetimeMode: 'timeOnly', defaultValue: ts(1970, 1, 1, 10),
                    behaviors: { increment: true, prompted: false }, increment: { delta: '3d', triggers: 'ai' },
                });
                runDeterministicIncrements('chat-1', 'ai');
                expect(stored('clock')).toBe(ts(1970, 1, 1, 10)); // unchanged - only the date moved, then got pinned back
            });

            it('a deterministic tick on a "timeOnly" variable with an hour delta advances the time and stays pinned to the reference date', () => {
                create('clock', {
                    datetimeMode: 'timeOnly', defaultValue: ts(1970, 1, 1, 10),
                    behaviors: { increment: true, prompted: false }, increment: { delta: '3h', triggers: 'ai' },
                });
                runDeterministicIncrements('chat-1', 'ai');
                expect(stored('clock')).toBe(ts(1970, 1, 1, 13));
            });

            it('the manual tracker edit path (setVar) normalizes too - not just the automatic paths', () => {
                const def = create('clock', { datetimeMode: 'dateOnly', defaultValue: ts(2026, 9, 18) });
                const edit = resolveTrackerEdit(def, '2026-09-20 15:30:00');
                expect(edit.ok).toBe(true);
                realChatState.setVar('chat-1', 'pp__clock', edit.value, def, { manual: true });
                expect(stored('clock')).toBe(ts(2026, 9, 20)); // time dropped by setVar itself
            });
        });

        describe('prompted updates', () => {
            const runAi = (userText = 'they wait') => async () => {
                context.chat = [{ is_user: true, mes: userText }, { is_user: false, name: 'Bot', mes: 'Time passes.' }];
                await runPromptedStateUpdate('ai');
            };
            const modeClock = (extra = {}) => create('clock', {
                defaultValue: '2026-09-18 12:00',
                behaviors: { prompted: true, increment: false },
                prompted: { instructions: 'track the in-story time' },
                ...extra,
            });

            it('"Date only": "advance 30 hours" rolls the date forward and normalizes the time away', async () => {
                modeClock({ datetimeMode: 'dateOnly' });
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"advance 30 hours"}');
                await runAi()();
                await vi.waitFor(() => expect(stored('clock')).toBe(ts(2026, 9, 19)));
            });

            it('"Date only": an absolute date/time answer keeps only the date', async () => {
                modeClock({ datetimeMode: 'dateOnly' });
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"set time to 2026-10-01 08:30"}');
                await runAi()();
                await vi.waitFor(() => expect(stored('clock')).toBe(ts(2026, 10, 1)));
            });

            it('"Time only": an ordinary hour delta advances the time and stays pinned to the reference date', async () => {
                modeClock({ datetimeMode: 'timeOnly', defaultValue: '1970-01-01 10:00' });
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"advance 3 hours"}');
                await runAi()();
                await vi.waitFor(() => expect(stored('clock')).toBe(ts(1970, 1, 1, 13)));
            });

            it('"Time only" with timeSemanticMode enabled understands "the next morning" - the day-advance has no visible effect, only the hour matters', async () => {
                modeClock({ datetimeMode: 'timeOnly', timeSemanticMode: 'semanticTimeOfDay', defaultValue: '1970-01-01 12:00' });
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"the next morning"}');
                await runAi()();
                await vi.waitFor(() => expect(stored('clock')).toBe(ts(1970, 1, 1, 8)));
            });

            it('"Date only" ignores a semantic phrase outright, even though it reads as ordinary text - skipped like any other unparseable answer', async () => {
                // checkedDatetime() already forces timeSemanticMode to 'none'
                // for a dateOnly variable at save time (schema/validation
                // above); this confirms the real, END-TO-END user-visible
                // behavior that guarantee is for: the model's own natural
                // phrase is simply not understood, not silently turned into
                // a no-op or a partial jump.
                modeClock({ datetimeMode: 'dateOnly', timeSemanticMode: 'semanticTimeOfDay' });
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"the next morning"}');
                await runAi()();
                await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('could not understand')));
                // Unchanged from its own already-normalized default - dateOnly
                // dropped the "12:00" at creation time (schema/validation above).
                expect(stored('clock')).toBe(ts(2026, 9, 18));
            });

            it('"full" mode is a complete no-op for this feature - unchanged from before it existed', async () => {
                modeClock({ datetimeMode: 'full' });
                callBackgroundLLM.mockResolvedValue('{"pp__clock":"advance 3 hours"}');
                await runAi()();
                await vi.waitFor(() => expect(stored('clock')).toBe(ts(2026, 9, 18, 15)));
            });
        });
    });

    describe('UI', () => {
        const dt = (extra = {}) => ({ ...blankDefinition(), name: 'clock', type: 'datetime', ...extra });

        it('displays structured time, not the scalar', () => {
            expect(formatValueForDisplay(ts(2026, 9, 18, 22, 55), dt())).toBe('2026-09-18 22:55:00');
            expect(formatValueForDisplay(0, dt())).toBe('1970-01-01 00:00:00');
            expect(formatValueForDisplay(ts(2026, 9, 18, 22, 55), dt({ calendar: undefined }))).toBe('2026-09-18 22:55:00');
        });

        it('shows a value it cannot convert as stored rather than throwing', () => {
            expect(formatValueForDisplay('junk', dt())).toBe('junk');
            expect(formatValueForDisplay(5, dt({ calendar: 'nope' }))).toBe('5');
        });

        it('other types display exactly as before', () => {
            expect(formatValueForDisplay(5, { type: 'number' })).toBe('5');
            expect(formatValueForDisplay(true, { type: 'boolean' })).toBe('true');
            expect(formatValueForDisplay('', { type: 'string' })).toBe('—');
        });

        describe('the tracker panel (renderTrackerPanel)', () => {
            let realJq;
            let body;

            // Just enough of jQuery for renderTrackerPanel(): elements that
            // remember their classes, text and children.
            const el = () => {
                let content = '';
                const node = {
                    length: 1, classes: new Set(), children: [],
                    addClass(c) { String(c).split(/\s+/).filter(Boolean).forEach((x) => node.classes.add(x)); return node; },
                    text(t) { content = String(t); return node; },
                    append(...kids) { node.children.push(...kids); return node; },
                    prepend(...kids) { node.children.unshift(...kids); return node; },
                    empty() { node.children = []; return node; },
                    attr() { return node; }, html() { return node; }, on() { return node; },
                    textValue: () => content,
                };
                return node;
            };
            const walk = (node, visit) => { visit(node); (node.children || []).forEach((c) => walk(c, visit)); };
            const valuesShown = () => {
                const out = [];
                walk(body, (n) => { if (n.classes?.has('se-tracker-value')) out.push(n.textValue()); });
                return out;
            };

            beforeEach(() => {
                realJq = globalThis.$;
                body = el();
                globalThis.$ = (selector) => (selector === '#se_tracker_body' ? body : el());
            });
            afterEach(() => { globalThis.$ = realJq; });

            it('displays the datetime as structured time', () => {
                create('clock', { defaultValue: '2026-09-18 22:55:00' });
                renderTrackerPanel();
                expect(valuesShown()).toEqual(['2026-09-18 22:55:00']);
            });

            it('follows the stored value as it changes', () => {
                create('clock', { defaultValue: '2026-09-18 22:55:00', behaviors: { increment: true, prompted: false }, increment: { delta: '1d', triggers: 'ai' } });
                runDeterministicIncrements('chat-1', 'ai');
                renderTrackerPanel();
                expect(valuesShown()).toEqual(['2026-09-19 22:55:00']);
            });

            // Datetime mode (requirements spec 1.36): "suppress time display
            // in the tracker" / "suppress date display in the tracker".
            it('a "Date only" variable shows only the date', () => {
                create('clock', { defaultValue: '2026-09-18 22:55:00', datetimeMode: 'dateOnly' });
                renderTrackerPanel();
                expect(valuesShown()).toEqual(['2026-09-18']);
            });

            it('a "Time only" variable shows only the time', () => {
                create('clock', { defaultValue: '2026-09-18 22:55:00', datetimeMode: 'timeOnly' });
                renderTrackerPanel();
                expect(valuesShown()).toEqual(['22:55:00']);
            });
        });

        describe('tracker editing (resolveTrackerEdit)', () => {
            const d = dt();

            it('accepts an ISO string or a scalar number', () => {
                expect(resolveTrackerEdit(d, '2026-09-18 22:55:00')).toEqual({ ok: true, value: ts(2026, 9, 18, 22, 55) });
                expect(resolveTrackerEdit(d, '2026-09-18')).toEqual({ ok: true, value: ts(2026, 9, 18) });
                expect(resolveTrackerEdit(d, ' 3600 ')).toEqual({ ok: true, value: 3600 });
                expect(resolveTrackerEdit(d, 3600)).toEqual({ ok: true, value: 3600 });
            });

            it('refuses anything else instead of resetting the clock to the default', () => {
                for (const bad of ['', '   ', 'soon', '2026-02-30', '2026-09-18 25:00', null, undefined]) {
                    const r = resolveTrackerEdit({ ...d, defaultValue: 999 }, bad);
                    expect(r.ok, String(bad)).toBe(false);
                    expect(r.error).toBeTruthy();
                }
            });

            it('leaves every other type on coerceValue', () => {
                expect(resolveTrackerEdit({ type: 'number', min: null, max: null, defaultValue: 0 }, '12')).toEqual({ ok: true, value: 12 });
                expect(resolveTrackerEdit({ type: 'number', min: null, max: null, defaultValue: 0 }, 'x')).toEqual({ ok: true, value: 0 });
            });

            it('setStatus is not touched by the pure helper', () => {
                resolveTrackerEdit(d, 'junk');
                expect(setStatus).not.toHaveBeenCalled();
            });

            // Datetime mode (requirements spec 1.36): "Time only"'s edit box
            // shows just "HH:mm:ss" (datetimeEditText, exercised through the
            // tracker panel below); a bare time typed back must round-trip
            // through resolveTrackerEdit even though toScalar/parseDateTime
            // require a date prefix - completed with the calendar's own
            // reference date (1970-01-01 for Gregorian) before parsing.
            it('a "Time only" variable accepts a bare "HH:mm" or "HH:mm:ss"', () => {
                const timeOnly = { ...d, datetimeMode: 'timeOnly' };
                expect(resolveTrackerEdit(timeOnly, '22:55')).toEqual({ ok: true, value: ts(1970, 1, 1, 22, 55) });
                expect(resolveTrackerEdit(timeOnly, '22:55:30')).toEqual({ ok: true, value: ts(1970, 1, 1, 22, 55, 30) });
                expect(resolveTrackerEdit(timeOnly, ' 6:05 ')).toEqual({ ok: true, value: ts(1970, 1, 1, 6, 5) });
            });

            it('"Time only" still accepts a full ISO date/time unchanged (normalization happens on write, not here)', () => {
                const timeOnly = { ...d, datetimeMode: 'timeOnly' };
                expect(resolveTrackerEdit(timeOnly, '2026-09-18 22:55:00')).toEqual({ ok: true, value: ts(2026, 9, 18, 22, 55) });
            });

            it('a bare time is NOT treated specially for "full" or "Date only" - a malformed date, refused as usual', () => {
                for (const mode of [undefined, 'full', 'dateOnly']) {
                    const r = resolveTrackerEdit({ ...d, datetimeMode: mode }, '22:55');
                    expect(r.ok, String(mode)).toBe(false);
                }
            });
        });

        describe('inline editor', () => {
            it('saves the default as scalar seconds converted from an ISO string', () => {
                const out = variableUiSchema.normalizeCollectedValues({ type: 'datetime', defaultValue: '2026-09-18 22:00' });
                expect(out.defaultValue).toBe(ts(2026, 9, 18, 22));
            });

            it('also takes a plain number of seconds, and falls back to 0 for junk', () => {
                expect(variableUiSchema.normalizeCollectedValues({ type: 'datetime', defaultValue: '7200' }).defaultValue).toBe(7200);
                expect(variableUiSchema.normalizeCollectedValues({ type: 'datetime', defaultValue: 'junk' }).defaultValue).toBe(0);
            });

            it('keeps a datetime\'s increment delta as a duration string; a number\'s stays numeric', () => {
                expect(variableUiSchema.normalizeCollectedValues({ type: 'datetime', increment: { delta: ' 1mo ' } }).increment.delta).toBe('1mo');
                expect(variableUiSchema.normalizeCollectedValues({ type: 'number', increment: { delta: '5' } }).increment.delta).toBe(5);
            });

            it('offers increment behavior for datetimes and describes it', () => {
                expect(variableUiSchema.canIncrement('datetime')).toBe(true);
                expect(variableUiSchema.canIncrement('string')).toBe(false);
                const text = variableUiSchema.describeVariable({ ...dt(), name: 'clock', behaviors: { increment: true }, increment: { delta: '1d', triggers: 'ai' } });
                expect(text).toContain('advances the time by 1d');
            });

            it('the editor form offers the Date & time type, an ISO default and an "Advance by" field', () => {
                const d = { ...variableUiSchema.mergeDefinition(blankDefinition(), dt({ defaultValue: '2026-09-18 22:00:00' })) };
                d.increment.delta = '1h';
                const html = buildInlineVariableEditor(d, true, []);
                expect(html).toContain('<option value="datetime" selected>');
                expect(html).toContain('value="2026-09-18 22:00:00"');
                expect(html).toContain('Advance by');
                expect(html).toContain('value="1h"');
            });

            it('offers a "Semantic time of day" select for a datetime, defaulting to off', () => {
                const d = { ...variableUiSchema.mergeDefinition(blankDefinition(), dt()) };
                const html = buildInlineVariableEditor(d, true, []);
                expect(html).toContain('data-field="timeSemanticMode"');
                expect(html).toContain('<option value="none" selected>');
                expect(html).not.toContain('<option value="semanticTimeOfDay" selected>');
                expect(html).toContain('morning');
                expect(html).toContain('the next evening');
            });

            it('marks "semanticTimeOfDay" as selected when the definition has it on', () => {
                const d = { ...variableUiSchema.mergeDefinition(blankDefinition(), dt({ timeSemanticMode: 'semanticTimeOfDay' })) };
                const html = buildInlineVariableEditor(d, true, []);
                expect(html).toContain('<option value="semanticTimeOfDay" selected>');
                expect(html).not.toContain('<option value="none" selected>');
            });

            it('is not offered at all for a non-datetime type', () => {
                const d = { ...variableUiSchema.mergeDefinition(blankDefinition(), { type: 'string' }) };
                const html = buildInlineVariableEditor(d, true, []);
                expect(html).not.toContain('data-field="timeSemanticMode"');
            });

            // Datetime mode (requirements spec 1.36)
            it('offers a "Datetime mode" select for a datetime, defaulting to "full"', () => {
                const d = { ...variableUiSchema.mergeDefinition(blankDefinition(), dt()) };
                const html = buildInlineVariableEditor(d, true, []);
                expect(html).toContain('data-field="datetimeMode"');
                expect(html).toContain('<option value="full" selected>');
                expect(html).not.toContain('<option value="dateOnly" selected>');
                expect(html).not.toContain('<option value="timeOnly" selected>');
            });

            it('marks "dateOnly"/"timeOnly" as selected when the definition has them', () => {
                const dateOnly = { ...variableUiSchema.mergeDefinition(blankDefinition(), dt({ datetimeMode: 'dateOnly' })) };
                expect(buildInlineVariableEditor(dateOnly, true, [])).toContain('<option value="dateOnly" selected>');
                const timeOnly = { ...variableUiSchema.mergeDefinition(blankDefinition(), dt({ datetimeMode: 'timeOnly' })) };
                expect(buildInlineVariableEditor(timeOnly, true, [])).toContain('<option value="timeOnly" selected>');
            });

            it('hides the "Semantic time of day" section for "Date only" - it can never use it', () => {
                const dateOnly = { ...variableUiSchema.mergeDefinition(blankDefinition(), dt({ datetimeMode: 'dateOnly' })) };
                const html = buildInlineVariableEditor(dateOnly, true, []);
                expect(html).not.toContain('data-field="timeSemanticMode"');
            });

            it('still offers "Semantic time of day" for "full" and "Time only"', () => {
                for (const datetimeMode of ['full', 'timeOnly']) {
                    const d = { ...variableUiSchema.mergeDefinition(blankDefinition(), dt({ datetimeMode })) };
                    expect(buildInlineVariableEditor(d, true, []), datetimeMode).toContain('data-field="timeSemanticMode"');
                }
            });
        });
    });

    describe('spec', () => {
        const spec = readFileSync(SPEC_PATH, 'utf8');
        const section = spec.slice(spec.indexOf('1.21 Datetime Variables'), spec.indexOf('SECTION 2'));

        it('has a "1.21 Datetime Variables" section', () => {
            expect(spec).toMatch(/^1\.21 Datetime Variables/m);
            expect(section.length).toBeGreaterThan(2000);
        });

        it('documents every rule the feature was specified with', () => {
            for (const phrase of [
                'SCALAR', 'in seconds',
                'references its calendar by ID', 'calendar', '"gregorian"',
                'settings.calendars',
                'HOW to convert scalar time to structured time',
                'incrementScalar', 'toStructured', 'fromStructured', 'getCalendar',
                'Deterministic increments', 'Prompted increments',
                'batch "time"',
                'sees a datetime as a number', 'no datetime',
                'UI', 'calendar.toStructured()',
            ]) {
                expect(section, phrase).toContain(phrase);
            }
        });

        it('documents that fantasy calendars are pluggable and points to 1.22 for their implementation', () => {
            const fantasy = section.slice(section.indexOf('Fantasy calendars'));
            expect(fantasy).toMatch(/pluggable/);
            expect(fantasy).toMatch(/superseded: see 1\.22/);
            expect(fantasy).toMatch(/still\s+refused/);
        });

        it('records the 1.20 batching change and lists calendar-engine.js among the modules', () => {
            expect(section).toContain('CHANGE TO 1.20');
            expect(spec).toMatch(/^calendar-engine\.js$/m);
        });
    });
});
