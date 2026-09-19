import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import {
    format, formatPartial, incrementScalar, isValidDelta, resolveInstruction, toScalar, toStructured, fromStructured,
    validateCalendarDefinition, createCalendar, previewCalendarDefinition, generateRandomCalendarDefinition,
    listCalendars, getCalendarDefinition,
} from '../src/core/calendar-engine.js';
import { runDeterministicIncrements } from '../src/core/deterministic-engine.js';
import { runPromptedStateUpdate } from '../src/core/prompted-engine.js';
import { callBackgroundLLM } from '../src/core/background-llm.js';
import { getVar } from '../src/core/chat-state.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { describeConstraint } from '../src/ui/formatting-utils.js';
import { renderTrackerPanel } from '../src/ui/tracker-panel-ui.js';
import * as variableUiSchema from '../src/ui/manager-modal/variable-ui-schema.js';
import * as uiTemplates from '../src/ui/manager-modal/ui-templates.js';
import * as calendarUiSchema from '../src/ui/manager-modal/calendar-ui-schema.js';
import { setManagerApi, clonePreset } from '../src/ui/manager-modal/preset-manager.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

// A fantasy calendar for every test to share.
//   10 months x 30 days = a 300-day year; a day is 20h x 50m x 50s = 50000s.
//   Year 1, Frostwane 1, 00:00:00 is scalar 0.
//   Seasons by day of the year: Spring 31-105, Summer 106-180, Autumn 181-255,
//   Winter 256-30 (wraps the year end), each 75 days long.
//   One cycle: Silver Moon, 28 days.
const MONTHS = ['Frostwane', 'Thawmoot', 'Seedrise', 'Brightreach', 'Highsun', 'Emberfall', 'Harvestide', 'Stormfall', 'Duskwane', 'Deepfrost'];
const PER_DAY = 20 * 50 * 50;
const ALDORIA = () => ({
    id: 'aldoria', label: 'Calendar of Aldoria', unit: 'seconds',
    secondsPerMinute: 50, minutesPerHour: 50, hoursPerDay: 20,
    months: MONTHS.map((name) => ({ name, days: 30 })),
    seasons: [
        { name: 'Spring', startDay: 31, endDay: 105 },
        { name: 'Summer', startDay: 106, endDay: 180 },
        { name: 'Autumn', startDay: 181, endDay: 255 },
        { name: 'Winter', startDay: 256, endDay: 30 },
    ],
    cycles: [{ name: 'Silver Moon', length: 28 }],
    leapYearRule: 'none',
    formattingRules: {
        era: 'AR',
        patterns: { full: 'MMMM D, YYYY ERA HH:mm:ss', date: 'D MMMM YYYY ERA', short: 'D MMM YYYY' },
    },
    nlRules: {
        unitAliases: { moon: 'cycle', tenday: { unit: 'day', multiplier: 10 } },
        advanceVerbs: ['let time pass'],
    },
});

// The same calendar with no formattingRules / nlRules - the fantasy defaults.
const PLAIN = () => {
    const def = ALDORIA();
    def.id = 'plain';
    delete def.formattingRules;
    delete def.nlRules;
    return def;
};

// Scalar for a moment in a calendar, computed by hand (an independent oracle
// for the engine's own conversion): 300-day years, epoch year 1.
const at = (year, month, day, hour = 0, minute = 0, second = 0) =>
    ((year - 1) * 300 + (month - 1) * 30 + (day - 1)) * PER_DAY + (hour * 50 + minute) * 50 + second;

let instanceId;
beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    createCalendar(ALDORIA());
    createCalendar(PLAIN());
    callBackgroundLLM.mockReset();
});

const api = (fn, ...args) => stateEngine[fn]('pp', instanceId, ...args);
const STORMFALL_17 = at(1203, 8, 17, 12); // Stormfall is month 8; day of year 227 -> Autumn

// ---------------------------------------------------------------------------

describe('fantasy calendar: definitions and CRUD', () => {
    it('the test calendar is valid, and the hand-built oracle agrees with the engine', () => {
        expect(validateCalendarDefinition(ALDORIA())).toEqual({ valid: true, errors: [] });
        expect(fromStructured('aldoria', { year: 1203, month: 8, day: 17, hour: 12 })).toBe(STORMFALL_17);
        expect(toStructured('aldoria', STORMFALL_17)).toEqual({ year: 1203, month: 8, day: 17, hour: 12, minute: 0, second: 0 });
        expect(toStructured('aldoria', 0)).toEqual({ year: 1, month: 1, day: 1, hour: 0, minute: 0, second: 0 });
        expect(toStructured('aldoria', -1)).toEqual({ year: 0, month: 10, day: 30, hour: 19, minute: 49, second: 49 });
    });

    describe('createCalendarDefinition', () => {
        it('stores the definition at version 1 and returns a copy', () => {
            const def = { ...ALDORIA(), id: 'made' };
            const created = api('createCalendarDefinition', def);
            expect(created).toMatchObject({ id: 'made', label: 'Calendar of Aldoria', version: 1 });
            expect(settings.get().calendars.made).toMatchObject({ id: 'made', version: 1 });
            expect(created).not.toBe(settings.get().calendars.made);
            def.label = 'changed afterwards';
            expect(settings.get().calendars.made.label).toBe('Calendar of Aldoria');
        });

        it('persists to the settings blob', () => {
            context.saveSettingsDebounced.mockClear();
            api('createCalendarDefinition', { ...ALDORIA(), id: 'kept' });
            expect(context.saveSettingsDebounced).toHaveBeenCalled();
            expect(settings.snapshot().calendars.kept.months).toHaveLength(10);
        });

        it('refuses an id that is already used, and an invalid definition, writing nothing', () => {
            expect(() => api('createCalendarDefinition', { ...ALDORIA(), id: 'aldoria' })).toThrow(/already exists/);
            expect(() => api('createCalendarDefinition', { ...ALDORIA(), id: 'gregorian' })).toThrow(/already exists/);
            expect(() => api('createCalendarDefinition', { ...ALDORIA(), id: 'bad', hoursPerDay: 0 })).toThrow(/hoursPerDay/);
            expect(settings.get().calendars.bad).toBeUndefined();
        });
    });

    describe('validation', () => {
        const errorsOf = (patch) => validateCalendarDefinition({ ...ALDORIA(), ...patch }).errors.join(' | ');

        it.each([
            ['a non-object', null, /must be an object/],
            ['a bad id', { id: 'has space' }, /id must be/],
            ['a prototype-style id', { id: '__proto__' }, /id must be/],
            ['a missing label', { label: ' ' }, /label/],
            ['a unit other than seconds', { unit: 'days' }, /unit must be "seconds"/],
            ['a fractional clock constant', { minutesPerHour: 2.5 }, /minutesPerHour/],
            ['an unknown top-level field', { calendarKind: 'x' }, /Unknown field "calendarKind"/],
            ['no months', { months: [] }, /months must be/],
            ['a month with no days', { months: [{ name: 'A', days: 0 }] }, /months\[0\]\.days/],
            ['duplicate month names', { months: [{ name: 'A', days: 5 }, { name: 'a', days: 5 }] }, /used twice/],
            ['an unsupported leapYearRule', { leapYearRule: 'shieldmeet' }, /leapYearRule/],
            ['a gregorian rule on non-Gregorian months', { leapYearRule: 'gregorian', seasons: undefined }, /twelve Gregorian months/],
            ['a season outside the year', { seasons: [{ name: 'X', startDay: 1, endDay: 301 }] }, /startDay and endDay/],
            ['overlapping seasons', { seasons: [{ name: 'A', startDay: 1, endDay: 50 }, { name: 'B', startDay: 50, endDay: 60 }] }, /overlaps/],
            ['a wrapping season overlapping another', { seasons: [{ name: 'A', startDay: 250, endDay: 20 }, { name: 'B', startDay: 10, endDay: 40 }] }, /overlaps/],
            ['a cycle with no length', { cycles: [{ name: 'Moon', length: 0 }] }, /cycles\[0\]\.length/],
            ['duplicate cycle names', { cycles: [{ name: 'M', length: 5 }, { name: 'm', length: 6 }] }, /used twice/],
            ['unknown formattingRules', { formattingRules: { colour: 'red' } }, /unknown field "colour"/],
            ['an empty pattern', { formattingRules: { patterns: { full: '' } } }, /patterns\.full/],
            ['redefining "custom"', { formattingRules: { patterns: { custom: 'D' } } }, /cannot redefine "custom"/],
            ['unknown nlRules', { nlRules: { chatty: true } }, /unknown field "chatty"/],
            ['an alias for an unknown unit', { nlRules: { unitAliases: { moon: 'fortnight' } } }, /unitAliases\.moon/],
            ['a bad alias multiplier', { nlRules: { unitAliases: { tenday: { unit: 'day', multiplier: 0 } } } }, /multiplier/],
            ['a bad version', { version: 0 }, /version/],
        ])('rejects %s', (_label, patch, message) => {
            const result = patch === null ? validateCalendarDefinition(null) : { errors: [errorsOf(patch)] };
            expect(result.errors.join(' ')).toMatch(message);
        });

        it('reports every problem at once', () => {
            const { valid, errors } = validateCalendarDefinition({ ...ALDORIA(), label: '', hoursPerDay: 0 });
            expect(valid).toBe(false);
            expect(errors.length).toBeGreaterThanOrEqual(2);
        });

        it('accepts a calendar with only the required fields, and the built-in Gregorian one', () => {
            const { seasons, cycles, formattingRules, nlRules, leapYearRule, ...minimal } = ALDORIA();
            expect(validateCalendarDefinition(minimal).valid).toBe(true);
            expect(validateCalendarDefinition(getCalendarDefinition('gregorian')).valid).toBe(true);
        });
    });

    describe('updateCalendarDefinition', () => {
        it('merges the patch, re-validates, and bumps the version each time', () => {
            const updated = api('updateCalendarDefinition', 'aldoria', { label: 'Aldoria, revised' });
            expect(updated).toMatchObject({ id: 'aldoria', label: 'Aldoria, revised', version: 2 });
            expect(updated.months).toHaveLength(10); // untouched fields are kept
            expect(api('updateCalendarDefinition', 'aldoria', { hoursPerDay: 24 }).version).toBe(3);
            expect(getCalendarDefinition('aldoria').hoursPerDay).toBe(24);
        });

        it('a null patch value removes an optional field', () => {
            const updated = api('updateCalendarDefinition', 'aldoria', { seasons: null, cycles: null, nlRules: null });
            expect(updated.seasons).toBeUndefined();
            expect(updated.cycles).toBeUndefined();
            expect(updated.nlRules).toBeUndefined();
            expect(updated.formattingRules.era).toBe('AR');
        });

        it('an invalid result changes nothing', () => {
            expect(() => api('updateCalendarDefinition', 'aldoria', { months: [] })).toThrow(/Invalid calendar definition/);
            expect(() => api('updateCalendarDefinition', 'aldoria', { seasons: [{ name: 'X', startDay: 900, endDay: 901 }] })).toThrow(/Invalid/);
            expect(getCalendarDefinition('aldoria')).toMatchObject({ version: 1 });
            expect(getCalendarDefinition('aldoria').months).toHaveLength(10);
        });

        it('cannot change the id or the version, and needs an existing, editable calendar', () => {
            expect(() => api('updateCalendarDefinition', 'aldoria', { id: 'renamed' })).toThrow(/id cannot be changed/);
            expect(api('updateCalendarDefinition', 'aldoria', { version: 99 }).version).toBe(2);
            expect(() => api('updateCalendarDefinition', 'nope', { label: 'x' })).toThrow(/Unknown calendar/);
            expect(() => api('updateCalendarDefinition', 'gregorian', { label: 'x' })).toThrow(/built-in/);
            expect(() => api('updateCalendarDefinition', 'aldoria', 'label')).toThrow(/patch must be an object/);
        });
    });

    describe('deleteCalendarDefinition', () => {
        it('removes the calendar and persists', () => {
            expect(api('deleteCalendarDefinition', 'plain')).toBe(true);
            expect(getCalendarDefinition('plain')).toBeNull();
            expect(settings.snapshot().calendars.plain).toBeUndefined();
        });

        it('refuses the built-in calendar and unknown ids', () => {
            expect(() => api('deleteCalendarDefinition', 'gregorian')).toThrow(/built-in/);
            expect(() => api('deleteCalendarDefinition', 'nope')).toThrow(/Unknown calendar/);
            expect(getCalendarDefinition('gregorian')).not.toBeNull();
        });

        it('refuses a calendar a datetime variable still uses, until the variable is gone', () => {
            stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
            stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', name: 'clock', type: 'datetime', calendar: 'aldoria' });
            expect(() => api('deleteCalendarDefinition', 'aldoria')).toThrow(/still used by 1 variable\(s\): pp__clock/);
            expect(getCalendarDefinition('aldoria')).not.toBeNull();

            stateEngine.deleteVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', variableName: 'clock' });
            expect(api('deleteCalendarDefinition', 'aldoria')).toBe(true);
        });
    });

    describe('listCalendarDefinitions / getCalendarDefinition', () => {
        it('lists every calendar as an array, the built-in first', () => {
            const list = api('listCalendarDefinitions');
            expect(list.map((c) => c.id)).toEqual(['gregorian', 'faerun_inspired', 'three_moons', 'solar_cycle', 'aldoria', 'plain']);
            expect(Object.keys(listCalendars())).toEqual(['gregorian', 'faerun_inspired', 'three_moons', 'solar_cycle', 'aldoria', 'plain']);
        });

        it('gets one by id, or null', () => {
            expect(api('getCalendarDefinition', 'aldoria').label).toBe('Calendar of Aldoria');
            expect(api('getCalendarDefinition', 'nope')).toBeNull();
        });
    });

    describe('identity', () => {
        const calls = {
            createCalendarDefinition: (e, i) => stateEngine.createCalendarDefinition(e, i, { ...ALDORIA(), id: 'x1' }),
            updateCalendarDefinition: (e, i) => stateEngine.updateCalendarDefinition(e, i, 'aldoria', { label: 'x' }),
            deleteCalendarDefinition: (e, i) => stateEngine.deleteCalendarDefinition(e, i, 'plain'),
            listCalendarDefinitions: (e, i) => stateEngine.listCalendarDefinitions(e, i),
            generateRandomCalendarDefinition: (e, i) => stateEngine.generateRandomCalendarDefinition(e, i, { seed: 1 }),
            assignCalendarToVariable: (e, i) => stateEngine.assignCalendarToVariable(e, i, { namespace: 'pp', presetName: 'Demo', variableName: 'clock' }, 'aldoria'),
        };
        for (const [name, call] of Object.entries(calls)) {
            it(`${name} rejects a wrong instanceId and an extension that owns no namespace`, () => {
                expect(() => call('pp', 'not-the-instance')).toThrow('State Engine API call rejected: wrong instance');
                expect(() => call('stranger', instanceId)).toThrow(/does not own a namespace|not own/);
            });
        }
    });

    describe('assignCalendarToVariable', () => {
        const ref = { namespace: 'pp', presetName: 'Demo', variableName: 'clock' };
        beforeEach(() => {
            stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
            stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', name: 'clock', type: 'datetime', defaultValue: 0 });
            stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', name: 'hp', type: 'number', defaultValue: 1 });
        });

        it('points a datetime variable at another calendar', () => {
            expect(api('assignCalendarToVariable', ref, 'aldoria').calendar).toBe('aldoria');
            expect(api('getVariable', ref).calendar).toBe('aldoria');
            // the stored default is still scalar seconds - read through the new calendar
            expect(api('getVariable', ref).defaultValue).toBe(0);
        });

        it('refuses an unknown calendar, an unknown variable and a non-datetime variable', () => {
            expect(() => api('assignCalendarToVariable', ref, 'nope')).toThrow(/does not exist/);
            expect(() => api('assignCalendarToVariable', { ...ref, variableName: 'ghost' }, 'aldoria')).toThrow(/not found/);
            expect(() => api('assignCalendarToVariable', { ...ref, variableName: 'hp' }, 'aldoria')).toThrow(/not a datetime/);
            expect(api('getVariable', ref).calendar).toBe('gregorian');
        });
    });
});

// ---------------------------------------------------------------------------

describe('fantasy calendar: formatting', () => {
    it('custom month names: the calendar\'s own default pattern (no formattingRules)', () => {
        expect(format('plain', STORMFALL_17)).toBe('Stormfall 17, 1203 12:00:00');
        expect(format('plain', STORMFALL_17, { style: 'date' })).toBe('Stormfall 17, 1203');
        expect(format('plain', STORMFALL_17, { style: 'time' })).toBe('12:00:00');
        expect(format('plain', STORMFALL_17, { style: 'month' })).toBe('Stormfall');
        expect(format('plain', STORMFALL_17, { style: 'year' })).toBe('1203');
    });

    it('a year is not zero-padded, and scalar 0 is year 1', () => {
        expect(format('plain', 0)).toBe('Frostwane 1, 1 00:00:00');
        expect(format('plain', 0, { style: 'custom', pattern: 'YYYY/MM/DD' })).toBe('1/01/01');
    });

    it('custom patterns: formattingRules.patterns replaces a built-in style', () => {
        expect(format('aldoria', STORMFALL_17)).toBe('Stormfall 17, 1203 AR 12:00:00');
        expect(format('aldoria', STORMFALL_17, { style: 'full' })).toBe('Stormfall 17, 1203 AR 12:00:00');
        expect(format('aldoria', STORMFALL_17, { style: 'date' })).toBe('17 Stormfall 1203 AR');
        expect(format('aldoria', STORMFALL_17, { style: 'time' })).toBe('12:00:00'); // not overridden -> default
    });

    it('custom patterns: a style the calendar names itself, and the "custom" style with tokens', () => {
        expect(format('aldoria', STORMFALL_17, { style: 'short' })).toBe('17 Sto 1203');
        expect(format('aldoria', STORMFALL_17, { style: 'custom', pattern: 'DD/MM (MMMM) YYYY HH:mm:ss' })).toBe('17/08 (Stormfall) 1203 12:00:00');
        expect(() => format('aldoria', STORMFALL_17, { style: 'nope' })).toThrow('Unknown format style "nope"');
        expect(() => format('aldoria', STORMFALL_17, { style: 'custom' })).toThrow('Custom format style requires a pattern');
    });

    it('MMM uses formattingRules.monthAbbreviationLength', () => {
        api('updateCalendarDefinition', 'aldoria', { formattingRules: { ...ALDORIA().formattingRules, monthAbbreviationLength: 5 } });
        expect(format('aldoria', STORMFALL_17, { style: 'short' })).toBe('17 Storm 1203');
    });

    it('seasons: the SEASON token and formatPartial', () => {
        expect(format('aldoria', STORMFALL_17, { style: 'custom', pattern: 'D MMMM, SEASON' })).toBe('17 Stormfall, Autumn');
        expect(formatPartial('aldoria', STORMFALL_17, ['season'])).toEqual({ season: 'Autumn' });
        // each season's first and last day, including the wrapping winter
        const seasonOf = (month, day) => formatPartial('aldoria', at(5, month, day), ['season']).season;
        expect(seasonOf(2, 1)).toBe('Spring');    // day 31
        expect(seasonOf(4, 15)).toBe('Spring');   // day 105
        expect(seasonOf(4, 16)).toBe('Summer');   // day 106
        expect(seasonOf(9, 15)).toBe('Autumn');   // day 255
        expect(seasonOf(9, 16)).toBe('Winter');   // day 256
        expect(seasonOf(10, 30)).toBe('Winter');  // day 300
        expect(seasonOf(1, 1)).toBe('Winter');    // day 1, the wrapped tail
        expect(seasonOf(1, 30)).toBe('Winter');   // day 30
    });

    it('cycles: the CYCLE / CDAY tokens and formatPartial', () => {
        const days = (1203 - 1) * 300 + 7 * 30 + 16; // days since the epoch at Stormfall 17
        const cycleDay = (days % 28) + 1;
        expect(format('aldoria', STORMFALL_17, { style: 'custom', pattern: 'CYCLE day CDAY' })).toBe(`Silver Moon day ${cycleDay}`);
        expect(formatPartial('aldoria', STORMFALL_17, ['cycle', 'cycleDay'])).toEqual({ cycle: 'Silver Moon', cycleDay });
        expect(formatPartial('aldoria', 0, ['cycleDay'])).toEqual({ cycleDay: 1 });
        expect(formatPartial('aldoria', 28 * PER_DAY, ['cycleDay'])).toEqual({ cycleDay: 1 }); // a full cycle later
        expect(formatPartial('aldoria', -1, ['cycleDay'])).toEqual({ cycleDay: 28 });
    });

    it('formattingRules.monthNames / seasonNames replace the names shown', () => {
        api('updateCalendarDefinition', 'plain', { formattingRules: { monthNames: MONTHS.map((m) => m.toUpperCase()), seasonNames: ['Bloom', 'Blaze', 'Fall', 'Freeze'] } });
        expect(format('plain', STORMFALL_17)).toBe('STORMFALL 17, 1203 12:00:00');
        expect(formatPartial('plain', STORMFALL_17, ['month', 'season'])).toEqual({ month: 'STORMFALL', season: 'Fall' });
    });

    it('a calendar without seasons or cycles gives null / empty for them', () => {
        expect(formatPartial('gregorian', 0, ['season', 'cycle', 'cycleDay'])).toEqual({ season: null, cycle: null, cycleDay: null });
        expect(format('plain', 0, { style: 'custom', pattern: '[SEASON]' })).toBe('[Winter]');
        api('updateCalendarDefinition', 'plain', { seasons: null, cycles: null });
        expect(format('plain', 0, { style: 'custom', pattern: '[SEASON][CYCLE][CDAY]' })).toBe('[][][]');
    });

    it('Gregorian is unchanged: no fantasy tokens, padded years, the original tokens', () => {
        const t = Date.UTC(2026, 8, 18, 22, 55, 7) / 1000;
        expect(format('gregorian', t)).toBe('2026-09-18 22:55:07');
        expect(format('gregorian', t, { style: 'custom', pattern: 'SEASON D ERA' })).toBe('SEASON D ERA');
        expect(format('gregorian', -62135596800, { style: 'custom', pattern: 'YYYY' })).toBe('0001'); // Gregorian years stay padded
    });

    it('goes through the API formatting functions too', () => {
        expect(api('formatDateTime', 'aldoria', STORMFALL_17)).toBe('Stormfall 17, 1203 AR 12:00:00');
        expect(api('formatDateTimePartial', 'aldoria', STORMFALL_17, ['month', 'day', 'season'])).toEqual({ month: 'Stormfall', day: 17, season: 'Autumn' });
    });

    it('a fantasy calendar\'s default written form reads back as a scalar (year required)', () => {
        expect(toScalar('plain', 'Stormfall 17, 1203 12:00:00')).toBe(STORMFALL_17);
        expect(toScalar('plain', 'stormfall 17, 1203')).toBe(at(1203, 8, 17));
        expect(toScalar('plain', 'Stormfall 17')).toBeNull(); // no year: not an absolute moment
        expect(toScalar('plain', '1203-08-17 12:00:00')).toBe(STORMFALL_17); // numeric ISO always works
        expect(toScalar('plain', 'Frobozz 17, 1203')).toBeNull();
    });
});

// ---------------------------------------------------------------------------

describe('fantasy calendar: increments', () => {
    it('1mo, 1y and 1d follow the calendar\'s own months and year length', () => {
        expect(incrementScalar('aldoria', STORMFALL_17, '1mo')).toBe(at(1203, 9, 17, 12));
        expect(incrementScalar('aldoria', at(1203, 10, 5), '1mo')).toBe(at(1204, 1, 5)); // rolls into the next year
        expect(incrementScalar('aldoria', STORMFALL_17, '1y')).toBe(at(1204, 8, 17, 12));
        expect(incrementScalar('aldoria', STORMFALL_17, '-1mo')).toBe(at(1203, 7, 17, 12));
        expect(incrementScalar('aldoria', STORMFALL_17, '1d')).toBe(at(1203, 8, 18, 12));
        expect(incrementScalar('aldoria', at(1203, 10, 30), '1d')).toBe(at(1204, 1, 1)); // the year is 300 days
        expect(incrementScalar('aldoria', STORMFALL_17, '2h')).toBe(at(1203, 8, 17, 14)); // hours are 2500 s here
        expect(incrementScalar('aldoria', STORMFALL_17, '1w')).toBe(at(1203, 8, 24, 12));
    });

    it('1mo clamps to a shorter month, like Jan 31 + 1mo', () => {
        createCalendar({
            id: 'uneven', label: 'Uneven', unit: 'seconds', secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24,
            months: [{ name: 'Long', days: 30 }, { name: 'Short', days: 10 }, { name: 'Mid', days: 20 }],
        });
        const day = 24 * 3600;
        const d = (y, m, dd) => ((y - 1) * 60 + [0, 30, 40][m - 1] + dd - 1) * day;
        expect(incrementScalar('uneven', d(3, 1, 30), '1mo')).toBe(d(3, 2, 10));
        expect(incrementScalar('uneven', d(3, 3, 20), '1mo')).toBe(d(4, 1, 20));
        expect(incrementScalar('uneven', d(3, 1, 30), '3mo')).toBe(d(4, 1, 30)); // 3 months = a year here
        expect(incrementScalar('uneven', d(3, 1, 30), '1y')).toBe(d(4, 1, 30));
    });

    describe('1cycle', () => {
        it('is the first cycle\'s length in days', () => {
            expect(incrementScalar('aldoria', STORMFALL_17, '1cycle')).toBe(STORMFALL_17 + 28 * PER_DAY);
            expect(incrementScalar('aldoria', STORMFALL_17, '3 cycles')).toBe(STORMFALL_17 + 84 * PER_DAY);
            expect(incrementScalar('aldoria', STORMFALL_17, '-1cycle')).toBe(STORMFALL_17 - 28 * PER_DAY);
            expect(incrementScalar('aldoria', STORMFALL_17, '0.5cycle')).toBe(STORMFALL_17 + 14 * PER_DAY);
        });

        it('combines with other units', () => {
            expect(incrementScalar('aldoria', STORMFALL_17, '1cycle 2h')).toBe(STORMFALL_17 + 28 * PER_DAY + 2 * 2500);
        });

        it('keeps the cycle day the same one cycle later', () => {
            const before = formatPartial('aldoria', STORMFALL_17, ['cycleDay']);
            const after = formatPartial('aldoria', incrementScalar('aldoria', STORMFALL_17, '1cycle'), ['cycleDay']);
            expect(after).toEqual(before);
        });
    });

    describe('1season', () => {
        it('keeps the position within the season and the time of day', () => {
            // Stormfall 17 = day 227 = 46 days into Autumn (starts day 181); next is Winter (day 256)
            // -> day 302, i.e. day 2 of the FOLLOWING year (winter wraps the year end).
            expect(incrementScalar('aldoria', STORMFALL_17, '1season')).toBe(at(1204, 1, 2, 12));
            // four seasons is a year, landing on the same day
            expect(incrementScalar('aldoria', STORMFALL_17, '4season')).toBe(at(1204, 8, 17, 12));
            // back one season: Summer, 46 days in (day 106 + 46 = 152 = Emberfall 2)
            expect(incrementScalar('aldoria', STORMFALL_17, '-1season')).toBe(at(1203, 6, 2, 12));
        });

        it('from the wrapped tail of winter, moves to spring of the same year', () => {
            // Frostwane 2 of 1204 is 46 days into the winter that began in 1203. Next = Spring
            // 1204, day 31 + 46 = 77 = Seedrise 17.
            expect(incrementScalar('aldoria', at(1204, 1, 2, 12), '1season')).toBe(at(1204, 3, 17, 12));
            // and back from it: Autumn 1203, day 181 + 46 = 227
            expect(incrementScalar('aldoria', at(1204, 1, 2, 12), '-1season')).toBe(at(1203, 8, 17, 12));
        });

        it('clamps to the target season\'s length', () => {
            createCalendar({
                ...ALDORIA(), id: 'lopsided', formattingRules: undefined, nlRules: undefined, cycles: undefined,
                seasons: [{ name: 'Long', startDay: 1, endDay: 200 }, { name: 'Short', startDay: 201, endDay: 210 }],
            });
            // day 150 of Long, +1 season: only 10 days in Short -> its last day (210)
            expect(incrementScalar('lopsided', at(7, 1, 1) + 149 * PER_DAY, '1season')).toBe(at(7, 1, 1) + 209 * PER_DAY);
            // and Short's day 5 - 1 season = Long's day 5 of the same year
            expect(incrementScalar('lopsided', at(7, 1, 1) + 204 * PER_DAY, '-1season')).toBe(at(7, 1, 1) + 4 * PER_DAY);
        });

        it('cannot step from a date that is inside no season', () => {
            createCalendar({
                ...ALDORIA(), id: 'gappy', formattingRules: undefined, nlRules: undefined, cycles: undefined,
                seasons: [{ name: 'Summer', startDay: 100, endDay: 150 }],
            });
            expect(() => incrementScalar('gappy', at(3, 1, 10), '1season')).toThrow(/not inside any season/);
            expect(incrementScalar('gappy', at(3, 1, 1) + 99 * PER_DAY, '1season')).toBe(at(4, 1, 1) + 99 * PER_DAY);
        });
    });

    describe('what is and is not a valid delta', () => {
        it('accepts fantasy units on a calendar that has them', () => {
            for (const delta of ['1mo', '1y', '1season', '1cycle', '2 seasons', '1season 2d', '-1cycle']) {
                expect(isValidDelta('aldoria', delta), delta).toBe(true);
            }
        });

        it('rejects them where the calendar has none (and keeps every 1.21 unit valid)', () => {
            expect(isValidDelta('gregorian', '1season')).toBe(false);
            expect(isValidDelta('gregorian', '1cycle')).toBe(false);
            api('updateCalendarDefinition', 'plain', { seasons: null, cycles: null });
            expect(isValidDelta('plain', '1season')).toBe(false);
            expect(isValidDelta('plain', '1cycle')).toBe(false);
            for (const delta of ['1s', '1h', '1d', '1w', '1mo', '1y']) expect(isValidDelta('gregorian', delta)).toBe(true);
            expect(() => incrementScalar('gregorian', 0, '1season')).toThrow(/no seasons/);
        });

        it('seasons must be whole numbers, and unknown units are refused', () => {
            expect(isValidDelta('aldoria', '0.5season')).toBe(false);
            expect(isValidDelta('aldoria', '1fortnight')).toBe(false);
        });

        it('unit aliases from nlRules extend the grammar', () => {
            expect(incrementScalar('aldoria', STORMFALL_17, '1moon')).toBe(STORMFALL_17 + 28 * PER_DAY);
            expect(incrementScalar('aldoria', STORMFALL_17, '1 tenday')).toBe(STORMFALL_17 + 10 * PER_DAY);
            expect(isValidDelta('plain', '1moon')).toBe(false); // that alias belongs to aldoria
        });
    });

    describe('deterministic increments', () => {
        const ref = { namespace: 'pp', presetName: 'Demo', variableName: 'clock' };
        const stored = () => getVar('chat-1', 'pp__clock')?.value;
        const makeClock = (calendar, delta) => {
            stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
            stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
            stateEngine.createVariable('pp', instanceId, {
                namespace: 'pp', presetName: 'Demo', name: 'clock', type: 'datetime', calendar, defaultValue: STORMFALL_17,
                behaviors: { increment: true, prompted: false }, increment: { delta, triggers: 'ai' },
            });
        };

        it.each([['1season', at(1204, 1, 2, 12)], ['1cycle', STORMFALL_17 + 28 * PER_DAY], ['1mo', at(1203, 9, 17, 12)], ['1y', at(1204, 8, 17, 12)]])(
            'a fantasy delta of %s advances the variable', (delta, expected) => {
                makeClock('aldoria', delta);
                runDeterministicIncrements('chat-1', 'ai');
                expect(stored()).toBe(expected);
            });

        it('a fantasy delta on a calendar without it is skipped with a warning', () => {
            makeClock('gregorian', '1season');
            runDeterministicIncrements('chat-1', 'ai');
            expect(stored()).toBe(STORMFALL_17);
            expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('invalid delta "1season" for calendar "gregorian"'));
            expect(api('getVariable', ref).calendar).toBe('gregorian');
        });
    });
});

// ---------------------------------------------------------------------------

describe('fantasy calendar: natural language', () => {
    const resolve = (text, from = STORMFALL_17, calendar = 'aldoria') => resolveInstruction(calendar, from, text);

    it('"advance 1 season"', () => {
        expect(resolve('advance 1 season')).toBe(at(1204, 1, 2, 12));
        expect(resolve('Advance 2 seasons.')).toBe(at(1204, 3, 17, 12));
        expect(resolve('move forward 1 season')).toBe(at(1204, 1, 2, 12));
        expect(resolve('rewind 1 season')).toBe(at(1203, 6, 2, 12));
        expect(resolve('go back 1 season')).toBe(at(1203, 6, 2, 12));
    });

    it('"next cycle" and its opposites', () => {
        expect(resolve('next cycle')).toBe(STORMFALL_17 + 28 * PER_DAY);
        expect(resolve('following cycle')).toBe(STORMFALL_17 + 28 * PER_DAY);
        expect(resolve('previous cycle')).toBe(STORMFALL_17 - 28 * PER_DAY);
        expect(resolve('last cycle')).toBe(STORMFALL_17 - 28 * PER_DAY);
        expect(resolve('next season')).toBe(at(1204, 1, 2, 12));
        expect(resolve('next month')).toBe(at(1203, 9, 17, 12));
        expect(resolve('Next Year!')).toBe(at(1204, 8, 17, 12));
    });

    it('"move to Stormfall 17": that day this year, at midnight', () => {
        expect(resolve('move to Stormfall 17', at(1203, 2, 3, 9))).toBe(at(1203, 8, 17));
        expect(resolve('MOVE TO STORMFALL 17', at(1203, 2, 3, 9))).toBe(at(1203, 8, 17));
        expect(resolve('set time to Stormfall 17', at(1210, 2, 3, 9))).toBe(at(1210, 8, 17));
        expect(resolve('advance to Stormfall 17', at(1203, 2, 3, 9))).toBe(at(1203, 8, 17));
        expect(resolve('Stormfall 17', at(1203, 2, 3, 9))).toBe(at(1203, 8, 17)); // bare answer
    });

    it('a target can carry a year, a time, an ordinal and the day-first order', () => {
        expect(resolve('move to Stormfall 17, 1300')).toBe(at(1300, 8, 17));
        expect(resolve('move to Stormfall 17 1300 at 14:30')).toBe(at(1300, 8, 17, 14, 30));
        expect(resolve('move to the 17th of Stormfall')).toBe(at(1203, 8, 17));
        expect(resolve('move to 3 Duskwane 1250')).toBe(at(1250, 9, 3));
        expect(resolve('move to Stormfall 17 at 6:15:20')).toBe(at(1203, 8, 17, 6, 15, 20));
    });

    it('reads a numeric date and the calendar\'s own written date exactly', () => {
        expect(resolve('1203-08-17 12:00:00')).toBe(STORMFALL_17);
        expect(resolve('set time to 1300-01-01', STORMFALL_17, 'plain')).toBe(at(1300, 1, 1));
        expect(resolve('Stormfall 17, 1203 12:00:00', 0, 'plain')).toBe(STORMFALL_17);
        expect(resolve(5000)).toBe(5000);
        expect(resolve('3600')).toBe(3600);
    });

    it('the calendar\'s nlRules add verbs and unit words', () => {
        expect(resolve('let time pass 2 days')).toBe(at(1203, 8, 19, 12));
        expect(resolve('advance 2 moons')).toBe(STORMFALL_17 + 56 * PER_DAY);
        expect(resolve('next tenday')).toBe(STORMFALL_17 + 10 * PER_DAY);
        // the same words mean nothing on a calendar without those rules
        expect(resolve('let time pass 2 days', STORMFALL_17, 'plain')).toBeNull();
        expect(resolve('advance 2 moons', STORMFALL_17, 'plain')).toBeNull();
        api('updateCalendarDefinition', 'plain', { nlRules: { rewindVerbs: ['unwind'], setVerbs: ['make it'] } });
        expect(resolve('unwind 1 day', STORMFALL_17, 'plain')).toBe(at(1203, 8, 16, 12));
        expect(resolve('make it Stormfall 20', STORMFALL_17, 'plain')).toBe(at(1203, 8, 20));
    });

    it('returns null - never throws - for anything it does not understand', () => {
        for (const bad of ['', '   ', 'whenever', 'move to Frobozz 3', 'move to Stormfall 31', 'next fortnight', 'advance 1 fortnight',
            'advance 1.5 seasons', 'move to Stormfall 17 at 25:00', null, undefined, {}, NaN]) {
            expect(() => resolve(bad), String(bad)).not.toThrow();
            expect(resolve(bad), String(bad)).toBeNull();
        }
        expect(resolveInstruction('nope', 0, 'next cycle')).toBeNull();
        expect(resolve('advance 1 season', 'x')).toBeNull();
    });

    it('fantasy phrases do not work on a calendar that lacks the feature; 1.21 phrases still do', () => {
        const T = Date.UTC(2026, 8, 18, 12) / 1000;
        expect(resolveInstruction('gregorian', T, 'advance 1 season')).toBeNull();
        expect(resolveInstruction('gregorian', T, 'next cycle')).toBeNull();
        expect(resolveInstruction('gregorian', T, 'advance 3 hours')).toBe(T + 3 * 3600);
        expect(resolveInstruction('gregorian', T, 'rewind 2 days')).toBe(T - 2 * 86400);
        expect(resolveInstruction('gregorian', T, 'set time to 2027-01-01 08:30')).toBe(Date.UTC(2027, 0, 1, 8, 30) / 1000);
        expect(resolveInstruction('gregorian', T, 'a while later')).toBeNull();
        expect(resolveInstruction('gregorian', T, 'move to December 25')).toBe(Date.UTC(2026, 11, 25) / 1000);
    });

    describe('in a prompted update', () => {
        const stored = () => getVar('chat-1', 'pp__clock')?.value;
        beforeEach(() => {
            stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
            stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
            stateEngine.createVariable('pp', instanceId, {
                namespace: 'pp', presetName: 'Demo', name: 'clock', type: 'datetime', calendar: 'aldoria', defaultValue: STORMFALL_17,
                behaviors: { prompted: true, increment: false }, prompted: { instructions: 'track the in-story time' },
            });
            context.chat = [{ is_user: true, mes: 'we wait' }, { is_user: false, name: 'Bot', mes: 'Seasons turn.' }];
        });

        it.each([['advance 1 season', at(1204, 1, 2, 12)], ['next cycle', STORMFALL_17 + 28 * PER_DAY], ['move to Duskwane 3', at(1203, 9, 3)]])(
            'the model answers "%s"', async (answer, expected) => {
                callBackgroundLLM.mockResolvedValue(JSON.stringify({ pp__clock: answer }));
                await runPromptedStateUpdate('ai');
                await vi.waitFor(() => expect(stored()).toBe(expected));
            });

        it('shows the model the date through the calendar\'s own format, and how to answer in it', async () => {
            callBackgroundLLM.mockResolvedValue('{"pp__clock":"next cycle"}');
            await runPromptedStateUpdate('ai');
            const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
            expect(prompt).toContain('currently "Stormfall 17, 1203 AR 12:00:00"');
            expect(prompt).toContain('Calendar of Aldoria calendar');
            expect(prompt).toContain('"advance 1 season"');
            expect(prompt).toContain('"next cycle"');
            expect(prompt).not.toContain(String(STORMFALL_17));
        });

        it('describeConstraint keeps the Gregorian wording, and omits season/cycle where there are none', () => {
            expect(describeConstraint({ type: 'datetime', calendar: 'gregorian' })).toContain('"YYYY-MM-DD HH:MM:SS"');
            api('updateCalendarDefinition', 'plain', { seasons: null, cycles: null });
            const plain = describeConstraint({ type: 'datetime', calendar: 'plain' });
            expect(plain).not.toContain('season');
            expect(plain).not.toContain('cycle');
        });
    });
});

// ---------------------------------------------------------------------------

describe('fantasy calendar: random generator', () => {
    it('produces a valid calendar definition', () => {
        for (let seed = 1; seed <= 40; seed++) {
            const def = generateRandomCalendarDefinition({ seed });
            expect(validateCalendarDefinition(def), `seed ${seed}`).toEqual({ valid: true, errors: [] });
        }
        expect(validateCalendarDefinition(generateRandomCalendarDefinition()).valid).toBe(true); // unseeded
    });

    it('is deterministic for a seed and varies between seeds', () => {
        expect(generateRandomCalendarDefinition({ seed: 7 })).toEqual(generateRandomCalendarDefinition({ seed: 7 }));
        expect(generateRandomCalendarDefinition({ seed: 'moon' })).toEqual(generateRandomCalendarDefinition({ seed: 'moon' }));
        expect(generateRandomCalendarDefinition({ seed: 7 })).not.toEqual(generateRandomCalendarDefinition({ seed: 8 }));
    });

    it('honours its options', () => {
        const def = generateRandomCalendarDefinition({ seed: 3, id: 'mine', label: 'My World', monthCount: 5, seasonCount: 3, includeCycle: false });
        expect(def).toMatchObject({ id: 'mine', label: 'My World', unit: 'seconds' });
        expect(def.months).toHaveLength(5);
        expect(def.seasons).toHaveLength(3);
        expect(def.cycles).toBeUndefined();
        expect(generateRandomCalendarDefinition({ seed: 3, seasonCount: 0 }).seasons).toBeUndefined();
        expect(() => generateRandomCalendarDefinition({ monthCount: 2 })).toThrow(/monthCount/);
        expect(() => generateRandomCalendarDefinition({ seasonCount: 99 })).toThrow(/seasonCount/);
    });

    it('seasons cover the whole year without overlap, and the calendar works end to end', () => {
        const def = generateRandomCalendarDefinition({ seed: 11 });
        const yearDays = def.months.reduce((n, m) => n + m.days, 0);
        expect(def.seasons[0].startDay).toBe(1);
        expect(def.seasons.at(-1).endDay).toBe(yearDays);
        createCalendar(def);
        const start = fromStructured(def.id, { year: 100, month: 2, day: 3, hour: 1 });
        expect(format(def.id, start)).toContain('100');
        expect(formatPartial(def.id, start, ['month']).month).toBe(def.months[1].name);
        expect(incrementScalar(def.id, start, '1season')).toBeGreaterThan(start);
        expect(incrementScalar(def.id, start, '1cycle')).toBe(start + def.cycles[0].length * def.hoursPerDay * def.minutesPerHour * def.secondsPerMinute);
        expect(resolveInstruction(def.id, start, 'next cycle')).toBe(incrementScalar(def.id, start, '1cycle'));
        expect(resolveInstruction(def.id, start, 'advance 1 moon')).toBe(incrementScalar(def.id, start, '1cycle'));
    });

    it('never picks an id that is already taken, and does not store what it makes', () => {
        const first = generateRandomCalendarDefinition({ seed: 5 });
        createCalendar(first);
        const second = generateRandomCalendarDefinition({ seed: 5 });
        expect(second.id).not.toBe(first.id);
        expect(getCalendarDefinition(second.id)).toBeNull();
    });

    it('is available through the API, still unstored', () => {
        const def = api('generateRandomCalendarDefinition', { seed: 2 });
        expect(validateCalendarDefinition(def).valid).toBe(true);
        expect(api('getCalendarDefinition', def.id)).toBeNull();
        expect(api('createCalendarDefinition', def)).toMatchObject({ id: def.id, version: 1 });
    });
});

// ---------------------------------------------------------------------------

describe('fantasy calendar: preview of an unsaved draft', () => {
    it('runs the real engine over the draft and leaves nothing behind', () => {
        const before = Object.keys(settings.get().calendars);
        const result = previewCalendarDefinition({ ...ALDORIA(), id: 'draft' }, { scalarText: '1203-08-17 12:00:00', delta: '1season', instruction: 'next cycle' });
        expect(result.valid).toBe(true);
        expect(result.full).toBe('Stormfall 17, 1203 AR 12:00:00');
        expect(result.partial).toMatchObject({ month: 'Stormfall', season: 'Autumn', cycle: 'Silver Moon' });
        expect(result.incremented).toMatchObject({ scalar: at(1204, 1, 2, 12), error: null });
        expect(result.resolved.scalar).toBe(STORMFALL_17 + 28 * PER_DAY);
        expect(Object.keys(settings.get().calendars)).toEqual(before);
    });

    it('defaults to day 1 at midday, reports bad input, and refuses an invalid draft', () => {
        expect(previewCalendarDefinition({ ...ALDORIA(), id: 'draft' }).full).toBe('Frostwane 1, 1 AR 10:00:00');
        expect(previewCalendarDefinition({ ...ALDORIA(), id: 'draft' }, { scalarText: 'nonsense' }).scalarError).toMatch(/Could not read/);
        expect(previewCalendarDefinition({ ...PLAIN(), id: 'draft' }, { delta: '1fortnight' }).incremented.error).toMatch(/unknown unit/);
        expect(previewCalendarDefinition({ ...PLAIN(), id: 'draft' }, { instruction: 'gibberish' }).resolved.text).toBeNull();
        const invalid = previewCalendarDefinition({ ...ALDORIA(), months: [] });
        expect(invalid.valid).toBe(false);
        expect(invalid.errors.join(' ')).toMatch(/months/);
        expect(settings.get().calendars.__preview__).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------

describe('fantasy calendar: UI', () => {
    describe('the Calendars tab', () => {
        it('the modal has a Calendars tab button and a calendars pane, and events are wired', () => {
            const modal = read('src', 'ui', 'manager-modal', 'manager-modal.js');
            expect(modal).toMatch(/<button class="se-manager-tab-btn" data-tab="calendars">[\s\S]*Calendars/);
            expect(modal).toContain('data-tab="calendars" id="se-manager-calendars-tab"');
            expect(modal).toContain('uiRender.renderCalendarsTab(managerApi)');
            const events = read('src', 'ui', 'manager-modal', 'ui-events.js');
            expect(events).toContain("tab === 'calendars'");
            for (const handler of ['#se-cal-new', '#se-cal-random', '.se-cal-edit', '.se-cal-duplicate', '.se-cal-export', '#se-cal-import', '.se-cal-delete', '#se-cal-save', '#se-cal-preview-run']) {
                expect(events, handler).toContain(handler);
            }
        });

        it('renders the list with a row per calendar and the create / random / import buttons', () => {
            const rows = Object.values(listCalendars()).map((c) => uiTemplates.buildCalendarRow(c, 'Example: x', 2)).join('');
            const html = uiTemplates.buildCalendarsTabContainer(rows, '');
            for (const id of ['se-cal-new', 'se-cal-random', 'se-cal-import']) expect(html).toContain(`id="${id}"`);
            for (const id of ['gregorian', 'aldoria', 'plain']) expect(html).toContain(`data-calendar-id="${id}"`);
            expect(html).toContain('Calendar of Aldoria');
            expect(html).toContain('10 months, 300 days/year');
            expect(html).toContain('4 seasons');
            expect(html).toContain('used by 2 variable(s)');
            expect(uiTemplates.buildCalendarsTabContainer('', '')).toContain('No calendars.');
        });

        it('the built-in row offers duplicate and export but not edit or delete; others offer all four', () => {
            const builtin = uiTemplates.buildCalendarRow(getCalendarDefinition('gregorian'));
            expect(builtin).toContain('se-cal-duplicate');
            expect(builtin).toContain('se-cal-export');
            expect(builtin).not.toContain('se-cal-edit');
            expect(builtin).not.toContain('se-cal-delete');
            const custom = uiTemplates.buildCalendarRow(getCalendarDefinition('aldoria'));
            for (const cls of ['se-cal-edit', 'se-cal-duplicate', 'se-cal-export', 'se-cal-delete']) expect(custom).toContain(cls);
        });

        it('escapes what it shows', () => {
            const html = uiTemplates.buildCalendarRow({ id: 'x', label: '<script>alert(1)</script>', months: [], version: 1 });
            expect(html).not.toContain('<script>');
            expect(html).toContain('&lt;script&gt;');
        });
    });

    describe('the calendar editor', () => {
        const editor = (def) => uiTemplates.buildCalendarEditor(calendarUiSchema.editorValuesFromDefinition(def));

        it('has every field the spec lists', () => {
            const html = editor(getCalendarDefinition('aldoria'));
            for (const field of ['id', 'label', 'hoursPerDay', 'minutesPerHour', 'secondsPerMinute', 'era', 'monthAbbreviationLength', 'patternsText',
                'monthNamesText', 'seasonNamesText', 'unitAliasesText', 'advanceVerbsText', 'rewindVerbsText', 'setVerbsText']) {
                expect(html, field).toContain(`data-cal-field="${field}"`);
            }
            expect(html).toContain('se-cal-months');
            expect(html).toContain('se-cal-seasons');
            expect(html).toContain('se-cal-cycles');
            for (const id of ['se-cal-save', 'se-cal-cancel', 'se-cal-preview-run', 'se-cal-preview-output']) expect(html).toContain(`id="${id}"`);
        });

        it('lists a row per month, season and cycle, filled in', () => {
            const html = editor(getCalendarDefinition('aldoria'));
            expect(html.match(/se-cal-month-row/g)).toHaveLength(10);
            expect(html.match(/se-cal-season-row/g)).toHaveLength(4);
            expect(html.match(/se-cal-cycle-row/g)).toHaveLength(1);
            expect(html).toContain('value="Stormfall"');
            expect(html).toContain('value="Silver Moon"');
            expect(html).toContain('full = MMMM D, YYYY ERA HH:mm:ss');
            expect(html).toContain('moon = cycle');
            expect(html).toContain('tenday = day * 10');
        });

        it('a new calendar can set its id; an existing one cannot', () => {
            expect(uiTemplates.buildCalendarEditor(calendarUiSchema.blankCalendarEditorValues())).toContain('New calendar');
            expect(uiTemplates.buildCalendarEditor(calendarUiSchema.blankCalendarEditorValues())).not.toMatch(/data-cal-field="id"[^>]*readonly/);
            expect(editor(getCalendarDefinition('aldoria'))).toMatch(/data-cal-field="id"[^>]*readonly/);
        });

        it('form values -> definition -> a saved calendar', () => {
            const values = {
                ...calendarUiSchema.blankCalendarEditorValues(),
                id: 'ashen', label: 'Ashen Reckoning', hoursPerDay: '18', minutesPerHour: '40', secondsPerMinute: '40',
                months: [{ name: 'Cinder', days: '25' }, { name: 'Soot', days: '35' }, { name: '', days: '' }],
                seasons: [{ name: 'Burn', startDay: '1', endDay: '30' }, { name: 'Bank', startDay: '31', endDay: '60' }],
                cycles: [{ name: 'Ember Moon', length: '9' }],
                era: 'AE', patternsText: 'full = MMMM D, YYYY ERA\ndate = D MMM = tricky',
                unitAliasesText: 'moon = cycle\ntenday = day * 10\n(garbage line)', advanceVerbsText: 'let it burn\n\n',
            };
            const def = calendarUiSchema.definitionFromEditorValues(values);
            expect(def).toMatchObject({
                id: 'ashen', hoursPerDay: 18, leapYearRule: 'none',
                months: [{ name: 'Cinder', days: 25 }, { name: 'Soot', days: 35 }],
                seasons: [{ name: 'Burn', startDay: 1, endDay: 30 }, { name: 'Bank', startDay: 31, endDay: 60 }],
                cycles: [{ name: 'Ember Moon', length: 9 }],
                formattingRules: { era: 'AE', patterns: { full: 'MMMM D, YYYY ERA', date: 'D MMM = tricky' } },
                nlRules: { unitAliases: { moon: 'cycle', tenday: { unit: 'day', multiplier: 10 } }, advanceVerbs: ['let it burn'] },
            });
            expect(validateCalendarDefinition(def).valid).toBe(true);
            expect(api('createCalendarDefinition', def)).toMatchObject({ id: 'ashen', version: 1 });
            expect(format('ashen', 0)).toBe('Cinder 1, 1 AE');
        });

        it('leaves out empty sections, so a saved edit can remove them', () => {
            const def = calendarUiSchema.definitionFromEditorValues({ ...calendarUiSchema.editorValuesFromDefinition(getCalendarDefinition('aldoria')), seasons: [], cycles: [], era: '', patternsText: '', unitAliasesText: '', advanceVerbsText: '' });
            expect(def).not.toHaveProperty('seasons');
            expect(def).not.toHaveProperty('cycles');
            expect(def).not.toHaveProperty('formattingRules');
            expect(def).not.toHaveProperty('nlRules');
            const patch = calendarUiSchema.updatePatchFromDefinition(def);
            expect(patch).not.toHaveProperty('id');
            expect(patch).toMatchObject({ seasons: null, cycles: null, formattingRules: null, nlRules: null });
            const updated = api('updateCalendarDefinition', 'aldoria', patch);
            expect(updated.seasons).toBeUndefined();
            expect(updated.version).toBe(2);
        });

        it('a stored calendar survives the editor round trip unchanged', () => {
            for (const id of ['aldoria', 'plain']) {
                const stored = getCalendarDefinition(id);
                const { version, ...expected } = stored;
                expect(calendarUiSchema.definitionFromEditorValues(calendarUiSchema.editorValuesFromDefinition(stored))).toEqual(expected);
            }
            const random = generateRandomCalendarDefinition({ seed: 21 });
            expect(calendarUiSchema.definitionFromEditorValues(calendarUiSchema.editorValuesFromDefinition(random))).toEqual(random);
        });

        it('a Gregorian-rule calendar keeps its leap days through the editor', () => {
            const copy = { ...JSON.parse(JSON.stringify(getCalendarDefinition('gregorian'))), id: 'greg2' };
            delete copy.version;
            createCalendar(copy);
            const values = calendarUiSchema.editorValuesFromDefinition(getCalendarDefinition('greg2'));
            expect(values.leapYearRule).toBe('gregorian');
            expect(calendarUiSchema.definitionFromEditorValues(values).months[1]).toEqual({ name: 'February', days: 28, leap: 29 });
            expect(uiTemplates.buildCalendarEditor(values)).toContain('data-leap="29"');
        });

        it('bad numbers are not defaulted away - validation reports them', () => {
            const def = calendarUiSchema.definitionFromEditorValues({ ...calendarUiSchema.blankCalendarEditorValues(), id: 'x', label: 'X', hoursPerDay: 'many', months: [{ name: 'A', days: '' }] });
            const { valid, errors } = validateCalendarDefinition(def);
            expect(valid).toBe(false);
            expect(errors.join(' ')).toMatch(/hoursPerDay/);
            expect(errors.join(' ')).toMatch(/days/);
        });

        it('the preview panel shows results, errors and unparsed instructions', () => {
            const ok = uiTemplates.buildCalendarPreviewOutput(previewCalendarDefinition({ ...ALDORIA(), id: 'd' }, { delta: '1season', instruction: 'nonsense' }));
            expect(ok).toContain('Frostwane 1, 1 AR 10:00:00');
            expect(ok).toContain('Season: Winter');
            expect(ok).toContain('Silver Moon: day 1');
            expect(ok).toContain('+ 1season');
            expect(ok).toContain('not understood');
            const bad = uiTemplates.buildCalendarPreviewOutput(previewCalendarDefinition({ ...ALDORIA(), months: [] }));
            expect(bad).toContain('se-cal-preview-errors');
        });
    });

    describe('the variable editor', () => {
        const blank = (extra = {}) => variableUiSchema.mergeDefinition(blankDefinition(), { name: 'clock', type: 'datetime', defaultValue: 0, ...extra });

        it('shows a calendar selector for a datetime, listing every calendar with the current one selected', () => {
            const html = uiTemplates.buildInlineVariableEditor(blank({ calendar: 'aldoria' }), true, []);
            expect(html).toContain('data-field="calendar"');
            expect(html).toContain('<option value="gregorian" >Gregorian Calendar</option>');
            expect(html).toContain('<option value="aldoria" selected>Calendar of Aldoria</option>');
            expect(html).toContain('<option value="plain" >');
        });

        it('defaults the selection to Gregorian, and shows nothing for other types', () => {
            expect(uiTemplates.buildInlineVariableEditor(blank(), true, [])).toContain('<option value="gregorian" selected>');
            for (const type of ['number', 'string', 'boolean', 'enum', 'array', 'calculated']) {
                expect(uiTemplates.buildInlineVariableEditor(blank({ type, enumValues: [] }), true, []), type).not.toContain('data-field="calendar"');
            }
        });

        it('takes the calendar list it is given', () => {
            const html = uiTemplates.buildInlineVariableEditor(blank(), true, [], { only: { id: 'only', label: 'The Only One' } });
            expect(html).toContain('The Only One');
            expect(html).not.toContain('Calendar of Aldoria');
        });

        it('escapes calendar labels', () => {
            const html = uiTemplates.buildInlineVariableEditor(blank(), true, [], { x: { id: 'x', label: '"><b>' } });
            expect(html).not.toContain('<b>');
        });
    });

    describe('normalizeCollectedValues', () => {
        it('accepts an existing calendar', () => {
            expect(variableUiSchema.normalizeCollectedValues({ type: 'datetime', calendar: 'aldoria' }).calendar).toBe('aldoria');
        });

        it('an unknown calendar is not stored - it falls back to Gregorian', () => {
            expect(variableUiSchema.normalizeCollectedValues({ type: 'datetime', calendar: 'nope' }).calendar).toBe('gregorian');
            expect(variableUiSchema.normalizeCollectedValues({ type: 'datetime', calendar: '' }).calendar).toBe('gregorian');
        });

        it('leaves calendar out when the editor had no selector', () => {
            expect(variableUiSchema.normalizeCollectedValues({ type: 'number', defaultValue: '3' })).not.toHaveProperty('calendar');
        });

        it('converts the default through the chosen calendar, not the stored one', () => {
            expect(variableUiSchema.normalizeCollectedValues({ type: 'datetime', calendar: 'aldoria', defaultValue: '1203-08-17 12:00:00' }).defaultValue).toBe(STORMFALL_17);
            expect(variableUiSchema.normalizeCollectedValues({ type: 'datetime', calendar: 'aldoria', defaultValue: 'Stormfall 17, 1203 AR 12:00:00' }).defaultValue).toBe(0); // aldoria's own pattern has an era: display-only
            expect(variableUiSchema.normalizeCollectedValues({ type: 'datetime', calendar: 'plain', defaultValue: 'Stormfall 17, 1203 12:00:00' }).defaultValue).toBe(STORMFALL_17);
        });
    });

    describe('the tracker panel', () => {
        let realJq;
        let body;
        // Just enough jQuery for renderTrackerPanel(): elements that remember
        // their classes, text, attributes and children.
        const el = () => {
            let content = '';
            const node = {
                length: 1, classes: new Set(), children: [], attrs: {},
                addClass(c) { String(c).split(/\s+/).filter(Boolean).forEach((x) => node.classes.add(x)); return node; },
                text(t) { content = String(t); return node; },
                append(...kids) { node.children.push(...kids); return node; },
                prepend(...kids) { node.children.unshift(...kids); return node; },
                empty() { node.children = []; return node; },
                attr(k, v) { if (v !== undefined) node.attrs[k] = v; return node; },
                css() { return node; }, html() { return node; }, on() { return node; },
                textValue: () => content,
            };
            return node;
        };
        const walk = (node, visit) => { visit(node); (node.children || []).forEach((c) => walk(c, visit)); };
        const find = (cls) => { const out = []; walk(body, (n) => { if (n.classes?.has(cls)) out.push(n); }); return out; };

        beforeEach(() => {
            realJq = globalThis.$;
            body = el();
            globalThis.$ = (selector) => (selector === '#se_tracker_body' ? body : el());
            stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
            stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
        });
        afterEach(() => { globalThis.$ = realJq; });

        const clock = (calendar) => stateEngine.createVariable('pp', instanceId, {
            namespace: 'pp', presetName: 'Demo', name: 'clock', type: 'datetime', calendar, defaultValue: STORMFALL_17,
        });

        it('shows a fantasy date through format(), with its season and cycle underneath', () => {
            clock('aldoria');
            renderTrackerPanel();
            const cycleDay = (((1203 - 1) * 300 + 226) % 28) + 1;
            expect(find('se-tracker-value').map((n) => n.textValue())).toEqual(['Stormfall 17, 1203 AR 12:00:00']);
            expect(find('se-tracker-datetime-detail').map((n) => n.textValue())).toEqual([`Autumn · Silver Moon day ${cycleDay}`]);
        });

        it('a calendar with neither shows just the date', () => {
            clock('gregorian');
            renderTrackerPanel();
            expect(find('se-tracker-value')).toHaveLength(1);
            expect(find('se-tracker-datetime-detail')).toHaveLength(0);
        });

        it('the tracker source still formats through format() with { style: "full" }', () => {
            const src = read('src', 'ui', 'tracker-panel-ui.js');
            expect(src).toContain("format(def.calendar || DEFAULT_CALENDAR_ID, Number(scalar), { style: 'full' })");
            expect(src).toContain('formatPartial');
        });
    });
});

// ---------------------------------------------------------------------------

describe('fantasy calendar: preset cloning', () => {
    it('a cloned preset keeps each datetime variable\'s calendar', () => {
        stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
        stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', name: 'clock', type: 'datetime', calendar: 'aldoria', defaultValue: STORMFALL_17 });
        stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', name: 'greg', type: 'datetime', defaultValue: 0 });
        const sourceId = Object.keys(settings.get().presets).find((id) => settings.get().presets[id].name === 'Demo');

        setManagerApi({ getSettings: settings.get, persistSettings: settings.persist });
        const cloneId = clonePreset(sourceId, 'Demo copy');
        const clones = Object.values(settings.get().presets[cloneId].variables);

        expect(clones).toHaveLength(2);
        const calendarOf = (base) => clones.find((d) => d.name.startsWith(base)).calendar;
        expect(calendarOf('pp__clock')).toBe('aldoria');
        expect(calendarOf('pp__greg')).toBe('gregorian');
        expect(clones.every((d) => d.unit === 'seconds')).toBe(true);
        // it is a real copy: not the source's variables
        expect(clones.map((d) => d.id)).not.toContain(Object.values(settings.get().presets[sourceId].variables)[0].id);
    });
});

// ---------------------------------------------------------------------------

describe('fantasy calendar: documentation', () => {
    const req = read('docs', 'STATE ENGINE REQUIREMENTS SPECIFICATION.md');
    const apiDoc = read('docs', 'STATE ENGINE API SPECIFICATION.md');

    it('requirements spec has 1.22 and its subsections, before Section 2', () => {
        const start = req.indexOf('1.22 Fantasy Calendar Definitions');
        expect(start).toBeGreaterThan(req.indexOf('1.21.5 Calendar Formatting'));
        const section = req.slice(start, req.indexOf('SECTION 2 — MODULE BOUNDARIES'));
        for (const heading of ['1.22.1 Calendar CRUD Rules', '1.22.2 Calendar Formatting Rules', '1.22.3 Calendar Increment Rules',
            '1.22.4 Calendar Natural Language Rules', '1.22.5 Random Calendar Generator']) {
            expect(section, heading).toContain(heading);
        }
        for (const phrase of ['settings.calendars', 'secondsPerMinute', 'minutesPerHour', 'hoursPerDay', 'months: [{ name, days }]',
            'seasons: optional [{ name, startDay, endDay }]', 'cycles: optional [{ name, length }]', 'leapYearRule', 'formattingRules', 'nlRules',
            'def.calendar', 'versioned and persisted', 'validated before saving', 'accessible via API',
            'createCalendarDefinition()', 'updateCalendarDefinition()', 'deleteCalendarDefinition()', 'listCalendarDefinitions()', 'getCalendarDefinition()',
            'calendarEngine.format() must dispatch', 'calendarEngine.incrementScalar() must dispatch', 'calendarEngine.resolveInstruction() must dispatch',
            'generateRandomCalendarDefinition() must produce a valid calendar definition']) {
            expect(section, phrase).toContain(phrase);
        }
    });

    it('API spec documents the Calendar Definition API as Section 11, keeping Section 10 as formatting', () => {
        expect(apiDoc).toContain('SECTION 10 — CALENDAR FORMATTING API');
        const section = apiDoc.slice(apiDoc.indexOf('SECTION 11 — CALENDAR DEFINITION API'));
        expect(section.length).toBeGreaterThan(1000);
        for (const fn of ['createCalendarDefinition', 'updateCalendarDefinition', 'deleteCalendarDefinition', 'listCalendarDefinitions',
            'getCalendarDefinition', 'generateRandomCalendarDefinition', 'assignCalendarToVariable', 'Calendar Assignment API',
            'Calendar Formatting API (already implemented)', 'formatDateTime', 'formatDateTimePartial']) {
            expect(section, fn).toContain(fn);
        }
    });

    it('every function the API spec lists exists on stateEngine', () => {
        for (const fn of ['createCalendarDefinition', 'updateCalendarDefinition', 'deleteCalendarDefinition', 'listCalendarDefinitions',
            'getCalendarDefinition', 'generateRandomCalendarDefinition', 'assignCalendarToVariable', 'formatDateTime', 'formatDateTimePartial']) {
            expect(typeof stateEngine[fn], fn).toBe('function');
        }
    });
});
