import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { format, formatPartial, formatScalar, listCalendars, getCalendarDefinition } from '../src/core/calendar-engine.js';
import { getMacroValue } from '../src/core/macro-store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ts = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;

const T = ts(2026, 9, 18, 22, 55, 7); // 2026-09-18 22:55:07

let instanceId;
beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
});

describe('calendar formatting', () => {
    describe('format()', () => {
        it('full', () => expect(format('gregorian', T, { style: 'full' })).toBe('2026-09-18 22:55:07'));
        it('date', () => expect(format('gregorian', T, { style: 'date' })).toBe('2026-09-18'));
        it('time', () => expect(format('gregorian', T, { style: 'time' })).toBe('22:55:07'));
        it('month', () => expect(format('gregorian', T, { style: 'month' })).toBe('September'));
        it('year', () => expect(format('gregorian', T, { style: 'year' })).toBe('2026'));

        it('custom: "MMM DD"', () => {
            expect(format('gregorian', T, { style: 'custom', pattern: 'MMM DD' })).toBe('Sep 18');
        });

        it('custom: every token, with literal text kept', () => {
            expect(format('gregorian', T, { style: 'custom', pattern: 'YYYY/MM/DD HH:mm:ss' })).toBe('2026/09/18 22:55:07');
            expect(format('gregorian', T, { style: 'custom', pattern: 'MMMM DD, YYYY at HH:mm' })).toBe('September 18, 2026 at 22:55');
        });

        it('custom: tokens are case-sensitive (MM month, mm minute) and never re-read produced text', () => {
            const may = ts(2026, 5, 3, 4, 5, 6);
            expect(format('gregorian', may, { style: 'custom', pattern: 'MM mm' })).toBe('05 05');
            expect(format('gregorian', may, { style: 'custom', pattern: 'MMMM' })).toBe('May');
            expect(format('gregorian', may, { style: 'custom', pattern: 'MMM' })).toBe('May');
            expect(format('gregorian', T, { style: 'custom', pattern: 'MMMM' })).toBe('September'); // not re-tokenized
            expect(format('gregorian', T, { style: 'custom', pattern: 'no tokens' })).toBe('no tokens');
        });

        it('defaults to "full", and tolerates missing or null options and an ignored locale', () => {
            expect(format('gregorian', T)).toBe('2026-09-18 22:55:07');
            expect(format('gregorian', T, null)).toBe('2026-09-18 22:55:07');
            expect(format('gregorian', T, { locale: 'fr-FR' })).toBe('2026-09-18 22:55:07');
        });

        it('pads, and handles the epoch and dates before it', () => {
            expect(format('gregorian', 0)).toBe('1970-01-01 00:00:00');
            expect(format('gregorian', ts(2026, 1, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05');
            expect(format('gregorian', -1)).toBe('1969-12-31 23:59:59');
        });

        it('rejects a bad scalar, an unknown style, and custom without a pattern', () => {
            expect(() => format('gregorian', NaN)).toThrow();
            expect(() => format('gregorian', '5')).toThrow();
            expect(() => format('gregorian', T, { style: 'weekday' })).toThrow(/Unknown format style/);
            expect(() => format('gregorian', T, { style: 'custom' })).toThrow(/requires a pattern/);
            expect(() => format('gregorian', T, { style: 'custom', pattern: '' })).toThrow(/requires a pattern/);
        });

        it('formatScalar is now the never-throws wrapper over format(full)', () => {
            expect(formatScalar('gregorian', T)).toBe(format('gregorian', T, { style: 'full' }));
            expect(formatScalar('gregorian', 'junk')).toBeNull();
        });
    });

    describe('formatPartial()', () => {
        it('returns only the requested fields: month as its name, day as a number', () => {
            expect(formatPartial('gregorian', T, ['month', 'day'])).toEqual({ month: 'September', day: 18 });
        });

        it('covers year, time-only, and every field', () => {
            expect(formatPartial('gregorian', T, ['year'])).toEqual({ year: 2026 });
            expect(formatPartial('gregorian', T, ['hour', 'minute', 'second'])).toEqual({ hour: 22, minute: 55, second: 7 });
            expect(formatPartial('gregorian', T, ['year', 'month', 'day', 'hour', 'minute', 'second']))
                .toEqual({ year: 2026, month: 'September', day: 18, hour: 22, minute: 55, second: 7 });
        });

        it('no fields, no keys', () => {
            expect(formatPartial('gregorian', T)).toEqual({});
            expect(formatPartial('gregorian', T, [])).toEqual({});
        });

        it('rejects an unknown field, a non-array, and a bad scalar', () => {
            expect(() => formatPartial('gregorian', T, ['weekday'])).toThrow(/Unknown datetime field/);
            expect(() => formatPartial('gregorian', T, 'month')).toThrow(/array/);
            expect(() => formatPartial('gregorian', NaN, ['month'])).toThrow();
        });
    });

    describe('calendars the engine cannot format with', () => {
        // Fantasy calendars format by their own rules since spec 1.22 (see
        // tests/fantasy-calendar.test.js); what still throws is a definition the
        // engine cannot convert with, and an id that does not exist.
        beforeEach(() => {
            settings.get().calendars.harptos = {
                id: 'harptos', label: 'Harptos', unit: 'seconds', secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24,
                months: [{ name: 'Hammer', days: 30 }], leapYearRule: 'gregorian',
            };
        });

        it('format throws for a calendar whose leap rule does not fit its months', () => {
            expect(() => format('harptos', T)).toThrow(/twelve Gregorian months/);
            expect(() => format('harptos', T, { style: 'month' })).toThrow(/twelve Gregorian months/);
        });

        it('formatPartial throws', () => {
            expect(() => formatPartial('harptos', T, ['month'])).toThrow(/twelve Gregorian months/);
        });

        it('and so does a calendar that does not exist', () => {
            expect(() => format('nope', T)).toThrow('Unknown calendar "nope"');
            expect(() => format(undefined, T)).toThrow('Unknown calendar');
        });
    });

    describe('calendar definitions (calendar-engine)', () => {
        it('listCalendars returns settings.calendars, getCalendarDefinition one entry or null', () => {
            expect(listCalendars()).toBe(settings.get().calendars);
            expect(Object.keys(listCalendars())).toEqual(['gregorian', 'faerun_inspired', 'three_moons', 'solar_cycle']);
            expect(getCalendarDefinition('gregorian')).toBe(settings.get().calendars.gregorian);
            expect(getCalendarDefinition('nope')).toBeNull();
        });
    });

    describe('API layer', () => {
        it('is exposed on stateEngine', () => {
            for (const fn of ['getCalendarDefinitions', 'getCalendarDefinition', 'formatDateTime', 'formatDateTimePartial']) {
                expect(typeof stateEngine[fn], fn).toBe('function');
            }
        });

        it('getCalendarDefinitions()', () => {
            const all = stateEngine.getCalendarDefinitions('pp', instanceId);
            expect(Object.keys(all)).toEqual(['gregorian', 'faerun_inspired', 'three_moons', 'solar_cycle']);
            expect(all.gregorian.label).toBe('Gregorian Calendar');
            expect(all.gregorian.months).toHaveLength(12);
        });

        it('getCalendarDefinition()', () => {
            expect(stateEngine.getCalendarDefinition('pp', instanceId, 'gregorian').id).toBe('gregorian');
            expect(stateEngine.getCalendarDefinition('pp', instanceId, 'nope')).toBeNull();
        });

        it('formatDateTime()', () => {
            expect(stateEngine.formatDateTime('pp', instanceId, 'gregorian', T)).toBe('2026-09-18 22:55:07');
            expect(stateEngine.formatDateTime('pp', instanceId, 'gregorian', T, { style: 'month' })).toBe('September');
            expect(stateEngine.formatDateTime('pp', instanceId, 'gregorian', T, { style: 'custom', pattern: 'MMM DD' })).toBe('Sep 18');
        });

        it('formatDateTimePartial()', () => {
            expect(stateEngine.formatDateTimePartial('pp', instanceId, 'gregorian', T, ['month', 'day'])).toEqual({ month: 'September', day: 18 });
        });

        it('the built-in "se" extension can use them too', () => {
            expect(stateEngine.formatDateTime('se', instanceId, 'gregorian', 0, { style: 'year' })).toBe('1970');
        });

        it('formatting failures throw rather than return null', () => {
            expect(() => stateEngine.formatDateTime('pp', instanceId, 'harptos', T)).toThrow('Unknown calendar "harptos"');
            expect(() => stateEngine.formatDateTimePartial('pp', instanceId, 'harptos', T, ['day'])).toThrow('Unknown calendar "harptos"');
        });

        describe('identity', () => {
            const calls = {
                getCalendarDefinitions: (ext, inst) => stateEngine.getCalendarDefinitions(ext, inst),
                getCalendarDefinition: (ext, inst) => stateEngine.getCalendarDefinition(ext, inst, 'gregorian'),
                formatDateTime: (ext, inst) => stateEngine.formatDateTime(ext, inst, 'gregorian', T),
                formatDateTimePartial: (ext, inst) => stateEngine.formatDateTimePartial(ext, inst, 'gregorian', T, ['day']),
            };

            for (const [name, call] of Object.entries(calls)) {
                it(`${name} rejects a wrong or missing instanceId`, () => {
                    for (const bad of ['not-the-instance', undefined, null, 42]) {
                        expect(() => call('pp', bad)).toThrow('State Engine API call rejected: wrong instance');
                    }
                });

                it(`${name} rejects an extension that owns no namespace`, () => {
                    expect(() => call('stranger', instanceId)).toThrow(/does not own a namespace/);
                });
            }
        });
    });

    describe('macro store and tracker', () => {
        it('the macro store still shows scalar seconds', () => {
            const def = { ...blankDefinition(), name: 'clock', type: 'datetime', defaultValue: 0 };
            context.variables.local.set('clock', T);
            expect(getMacroValue(context, def)).toBe(T);
            expect(typeof getMacroValue(context, def)).toBe('number');
        });

        it('tracker-panel-ui formats through calendarEngine.format (no manual formatting left)', () => {
            const src = readFileSync(join(ROOT, 'src', 'ui', 'tracker-panel-ui.js'), 'utf8');
            expect(src).toContain("import { format } from '../core/calendar-engine.js'");
            expect(src).toContain("{ style: 'full' }");
            expect(src).not.toContain('formatScalar');
        });
    });

    describe('documentation', () => {
        const req = readFileSync(join(ROOT, 'docs', 'STATE ENGINE REQUIREMENTS SPECIFICATION.md'), 'utf8');
        const api = readFileSync(join(ROOT, 'docs', 'STATE ENGINE API SPECIFICATION.md'), 'utf8');

        it('requirements spec has 1.21.5 Calendar Formatting inside 1.21', () => {
            const at = req.indexOf('1.21.5 Calendar Formatting');
            expect(at).toBeGreaterThan(req.indexOf('1.21 Datetime Variables'));
            expect(at).toBeLessThan(req.indexOf('SECTION 2 — MODULE BOUNDARIES'));
            const section = req.slice(at, req.indexOf('SECTION 2 — MODULE BOUNDARIES'));
            for (const phrase of ['scalar seconds', 'calendarEngine.format()', 'ONLY official formatting mechanism', 'macro store', 'formatPartial', 'readable through the API layer', 'override formatting rules later']) {
                expect(section, phrase).toContain(phrase);
            }
        });

        it('requirements spec Section 6 records that calendar-engine.js owns formatting', () => {
            const section6 = req.slice(req.indexOf('SECTION 6 — SCHEMA RULES'), req.indexOf('SECTION 7'));
            expect(section6).toContain('calendar-engine.js now owns all formatting logic for datetime variables');
        });

        it('API spec documents the Calendar Formatting API', () => {
            expect(api).toContain('CALENDAR FORMATTING API');
            for (const fn of ['getCalendarDefinitions', 'getCalendarDefinition', 'formatDateTime', 'formatDateTimePartial']) {
                expect(api, fn).toContain(fn);
            }
            expect(api).toContain('Unknown calendar');
            expect(api).toContain('scalar\n  seconds');
        });
    });
});
