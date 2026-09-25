import { describe, it, expect, beforeEach, vi } from 'vitest';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import {
    format, formatPartial, fromStructured, toStructured, toDateTimeParts, validateCalendarDefinition, createCalendar, updateCalendar,
} from '../src/core/calendar-engine.js';
import * as calendarUiSchema from '../src/ui/manager-modal/calendar-ui-schema.js';

vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

// 4 months x 10 days; a day is 10h x 20m x 30s = 6000s.
const PER_DAY = 10 * 20 * 30;
const base = (id, extra = {}) => ({
    id, label: id, unit: 'seconds', secondsPerMinute: 30, minutesPerHour: 20, hoursPerDay: 10,
    months: ['A', 'B', 'C', 'D'].map((name) => ({ name, days: 10 })), leapYearRule: 'none', ...extra,
});
const NAMES = ['Oneday', 'Twoday', 'Threeday', 'Fourday', 'Fiveday'];

let instanceId;
beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    createCalendar(base('named', { daysPerWeek: 5, weekdayNames: NAMES, weekdayShortNames: ['1d', '2d', '3d', '4d', '5d'] }));
    createCalendar(base('numeric', { daysPerWeek: 6 }));
    createCalendar(base('noweek'));
});

describe('weekday calculation', () => {
    it('named weekdays: index from whole days since the epoch, names from the lists', () => {
        expect(toStructured('named', 0)).toMatchObject({ weekdayIndex: 0, weekdayName: 'Oneday', weekdayShortName: '1d' });
        expect(toStructured('named', 7 * PER_DAY + 5)).toMatchObject({ weekdayIndex: 2, weekdayName: 'Threeday', weekdayShortName: '3d' });
        // Before the epoch still lands on a valid weekday.
        expect(toStructured('named', -1)).toMatchObject({ weekdayIndex: 4, weekdayName: 'Fiveday' });
    });

    it('short names are optional', () => {
        createCalendar(base('noshort', { daysPerWeek: 5, weekdayNames: NAMES }));
        expect(toStructured('noshort', PER_DAY)).toMatchObject({ weekdayIndex: 1, weekdayName: 'Twoday', weekdayShortName: null });
    });

    it('daysPerWeek without names: numeric weekdays only', () => {
        expect(toStructured('numeric', 13 * PER_DAY)).toMatchObject({ weekdayIndex: 1, weekdayName: null, weekdayShortName: null });
    });

    it('no weekday concept: every weekday field is null', () => {
        expect(toStructured('noweek', 13 * PER_DAY)).toMatchObject({ weekdayIndex: null, weekdayName: null, weekdayShortName: null });
    });

    it('Gregorian uses Sakamoto: 1970-01-01 was a Thursday, 2000-02-29 a Tuesday, 1900-03-01 a Thursday', () => {
        const g = (y, m, d) => toStructured('gregorian', fromStructured('gregorian', { year: y, month: m, day: d }));
        expect(g(1970, 1, 1)).toMatchObject({ weekdayIndex: 4, weekdayName: 'Thursday', weekdayShortName: 'Thu' });
        expect(g(2000, 2, 29)).toMatchObject({ weekdayIndex: 2, weekdayName: 'Tuesday' });
        expect(g(1900, 3, 1)).toMatchObject({ weekdayIndex: 4, weekdayName: 'Thursday' });
        expect(g(2026, 9, 25)).toMatchObject({ weekdayName: 'Friday' });
        // Every day agrees with plain day counting (1970-01-01 = Thursday).
        for (let days = -800; days < 800; days += 37) {
            expect(toStructured('gregorian', days * 86400).weekdayIndex).toBe((((days + 4) % 7) + 7) % 7);
        }
    });

    it('built-in fantasy calendars: Faerûn has tendays, Three-Moon and Solar-Cycle have no weekdays', () => {
        expect(validateCalendarDefinition(settings.get().calendars.faerun_inspired).errors).toEqual([]);
        expect(toStructured('faerun_inspired', 0)).toMatchObject({ weekdayIndex: 0, weekdayName: 'Firstday', weekdayShortName: '1st' });
        expect(toStructured('faerun_inspired', 19 * 86400)).toMatchObject({ weekdayIndex: 9, weekdayName: 'Tenthday', weekdayShortName: '10th' });
        for (const id of ['three_moons', 'solar_cycle']) {
            expect(validateCalendarDefinition(settings.get().calendars[id]).errors).toEqual([]);
            expect(toStructured(id, 12345678)).toMatchObject({ weekdayIndex: null, weekdayName: null, weekdayShortName: null });
        }
    });

    it('a Faerûn calendar saved before weekdays existed gets its tendays', () => {
        const cal = settings.get().calendars.faerun_inspired;
        delete cal.daysPerWeek; delete cal.weekdayNames; delete cal.weekdayShortNames;
        settings.get();
        expect(cal.daysPerWeek).toBe(10);
        expect(cal.weekdayNames).toHaveLength(10);
    });

    it('the built-in Gregorian weekday fields are backfilled onto older saved settings', () => {
        const cal = settings.get().calendars.gregorian;
        delete cal.daysPerWeek; delete cal.weekdayNames; delete cal.weekdayShortNames;
        settings.get();
        expect(cal.weekdayNames).toEqual(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
        expect(cal.daysPerWeek).toBe(7);
    });
});

describe('weekday formatting', () => {
    it('{weekday}, {weekday_short} and {weekday_index} tokens', () => {
        const t = 7 * PER_DAY;
        expect(format('named', t, { style: 'custom', pattern: '{weekday} ({weekday_short}, #{weekday_index}) {monthName} {day}' }))
            .toBe('Threeday (3d, #2) A 8');
    });

    it('a null value outputs nothing', () => {
        expect(format('numeric', PER_DAY, { style: 'custom', pattern: '[{weekday}|{weekday_short}|{weekday_index}]' })).toBe('[||1]');
        expect(format('noweek', PER_DAY, { style: 'custom', pattern: '[{weekday}|{weekday_short}|{weekday_index}]' })).toBe('[||]');
    });

    it('formatPartial accepts the weekday fields', () => {
        expect(formatPartial('named', PER_DAY, ['weekdayIndex', 'weekdayName', 'weekdayShortName']))
            .toEqual({ weekdayIndex: 1, weekdayName: 'Twoday', weekdayShortName: '2d' });
    });
});

describe('time primitives', () => {
    it('toDateTimeParts exposes time and calendar clock metadata', () => {
        const parts = toDateTimeParts('named', PER_DAY + (3 * 20 + 7) * 30 + 12.25);
        expect(parts.time).toEqual({ hour: 3, minute: 7, second: 12, fraction: 0.25 });
        expect(parts.calendar).toEqual({ id: 'named', hoursPerDay: 10, minutesPerHour: 20, secondsPerMinute: 30, daysPerWeek: 5 });
        expect(parts).toMatchObject({ year: 1, month: 1, day: 2, weekdayName: 'Twoday' });
        expect(toDateTimeParts('noweek', 0).calendar.daysPerWeek).toBeNull();
    });

    it('is on the public API as getDateTimeParts', () => {
        expect(stateEngine.getDateTimeParts('pp', instanceId, 'gregorian', 0).calendar)
            .toMatchObject({ hoursPerDay: 24, minutesPerHour: 60, secondsPerMinute: 60, daysPerWeek: 7 });
    });
});

describe('weekday validation', () => {
    const errorsOf = (extra) => validateCalendarDefinition(base('v', extra)).errors;

    it('accepts no weekdays, numeric weekdays, and matching names', () => {
        expect(errorsOf({})).toEqual([]);
        expect(errorsOf({ daysPerWeek: null, weekdayNames: null, weekdayShortNames: null })).toEqual([]);
        expect(errorsOf({ daysPerWeek: 3 })).toEqual([]);
        expect(errorsOf({ daysPerWeek: 2, weekdayNames: ['X', 'Y'], weekdayShortNames: ['x', 'y'] })).toEqual([]);
    });

    it('rejects names without a week length, a length mismatch, and mismatched short names', () => {
        expect(errorsOf({ weekdayNames: ['X'] }).join()).toContain('needs daysPerWeek');
        expect(errorsOf({ daysPerWeek: 3, weekdayNames: ['X', 'Y'] }).join()).toContain('exactly daysPerWeek (3)');
        expect(errorsOf({ daysPerWeek: 2, weekdayNames: ['X', 'Y'], weekdayShortNames: ['x'] }).join()).toContain('same number');
        expect(errorsOf({ daysPerWeek: 2, weekdayShortNames: ['x', 'y'] }).join()).toContain('same number');
        expect(errorsOf({ daysPerWeek: 0 }).join()).toContain('daysPerWeek');
    });

    it('a Gregorian-rule calendar needs a 7-day week', () => {
        const def = { ...structuredClone(settings.get().calendars.gregorian), id: 'g2', daysPerWeek: 5, weekdayNames: null, weekdayShortNames: null };
        expect(validateCalendarDefinition(def).errors.join()).toContain('7-day week');
    });

    it('updateCalendar with null removes the weekday fields', () => {
        const updated = updateCalendar('named', { daysPerWeek: null, weekdayNames: null, weekdayShortNames: null });
        expect(updated.daysPerWeek).toBeUndefined();
        expect(toStructured('named', 0).weekdayIndex).toBeNull();
    });
});

describe('calendar editor weekday fields', () => {
    it('round-trips a definition with weekdays', () => {
        const def = settings.get().calendars.named;
        const values = calendarUiSchema.editorValuesFromDefinition(def);
        expect(values.daysPerWeek).toBe(5);
        expect(values.weekdayNamesText).toBe(NAMES.join('\n'));
        const back = calendarUiSchema.definitionFromEditorValues(values);
        expect(back).toMatchObject({ daysPerWeek: 5, weekdayNames: NAMES, weekdayShortNames: ['1d', '2d', '3d', '4d', '5d'] });
    });

    it('a blank week length drops the name lists; an update patch clears them', () => {
        const values = { ...calendarUiSchema.blankCalendarEditorValues(), id: 'x', label: 'x', weekdayNamesText: 'A\nB' };
        const def = calendarUiSchema.definitionFromEditorValues(values);
        expect(def.daysPerWeek).toBeUndefined();
        expect(def.weekdayNames).toBeUndefined();
        expect(calendarUiSchema.updatePatchFromDefinition(def)).toMatchObject({ daysPerWeek: null, weekdayNames: null, weekdayShortNames: null });
    });

    it('a week length without names gives numeric weekdays', () => {
        const values = { ...calendarUiSchema.blankCalendarEditorValues(), daysPerWeek: '8' };
        const def = calendarUiSchema.definitionFromEditorValues(values);
        expect(def.daysPerWeek).toBe(8);
        expect(def.weekdayNames).toBeUndefined();
    });
});
