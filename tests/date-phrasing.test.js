// Requirements spec 1.38: date phrasing a story actually uses - narrative
// lead-ins, abbreviated months, a leading weekday - and a date without a
// time keeping the current time of day.
import { describe, it, expect, beforeEach } from 'vitest';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { resolveInstruction, getCalendarDefinition } from '../src/core/calendar-engine.js';

const ts = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
const NOW = ts(2026, 10, 7, 14, 30);
const r = (text, calendar = 'gregorian', now = NOW) => resolveInstruction(calendar, now, text);

let instanceId;
beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
});

describe('a date without a time keeps the current time of day', () => {
    it.each([
        ['2025-09-05'],
        ['September 5, 2025'],
        ['5 September 2025'],
        ['set date to September 5, 2025'],
        ['move to September 5, 2025'],
    ])('"%s" -> 2025-09-05 14:30', (text) => {
        expect(r(text)).toBe(ts(2025, 9, 5, 14, 30));
    });

    it('a date with a time uses that time', () => {
        expect(r('2025-09-05 08:00')).toBe(ts(2025, 9, 5, 8));
        expect(r('September 5, 2025 at 08:15')).toBe(ts(2025, 9, 5, 8, 15));
    });

    it('a number of seconds is still that exact moment', () => {
        expect(r('3600')).toBe(3600);
        expect(r(3600)).toBe(3600);
    });

    it('a calendar rule "move to" phrase (nlRules.moveToDay) keeps it too', () => {
        const now = resolveInstruction('faerun_inspired', 0, '1490-01-01 09:00');
        expect(getCalendarDefinition('faerun_inspired').nlRules.moveToDay).toContain('move to');
        expect(resolveInstruction('faerun_inspired', now, 'move to Rainswell 3'))
            .toBe(resolveInstruction('faerun_inspired', now, '1490-02-03 09:00'));
    });

    it('a month and day without a year stays in the current year', () => {
        expect(r('September 5')).toBe(ts(2026, 9, 5, 14, 30));
    });

    it('relative instructions are unchanged', () => {
        expect(r('advance 3 hours')).toBe(NOW + 3 * 3600);
        expect(r('rewind 1 day')).toBe(NOW - 86400);
    });
});

describe('narrative lead-ins are ignored', () => {
    it.each([
        'It was September 5, 2025',
        'it is September 5, 2025.',
        "It's now September 5, 2025",
        'The date is September 5, 2025',
        'the current date is now September 5, 2025',
        'Today is September 5, 2025',
        'Now: September 5, 2025',
        'So it was September 5, 2025',
    ])('"%s"', (text) => {
        expect(r(text)).toBe(ts(2025, 9, 5, 14, 30));
    });

    it('a lead-in alone, or around something that is not a date, is still not understood', () => {
        expect(r('it was')).toBeNull();
        expect(r('it was a dark and stormy night')).toBeNull();
    });
});

describe('abbreviated month names', () => {
    it.each(['Sept 5, 2025', 'Sept. 5, 2025', 'Sep 5 2025', 'sep. 5, 2025', '5 Sept 2025', 'the 5th of Sep. 2025'])('"%s"', (text) => {
        expect(r(text)).toBe(ts(2025, 9, 5, 14, 30));
    });

    it('every Gregorian month has its three-letter form', () => {
        ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].forEach((abbr, i) => {
            expect(r(`${abbr} 1, 2025`), abbr).toBe(ts(2025, i + 1, 1, 14, 30));
        });
    });

    it('fewer than three letters is not a month', () => {
        expect(r('se 5, 2025')).toBeNull();
    });

    it('a prefix two months share is not guessed; a longer, unique one is', () => {
        const base = getCalendarDefinition('faerun_inspired');
        stateEngine.createCalendarDefinition('pp', instanceId, {
            ...base, id: 'twins', label: 'Twins',
            months: base.months.map((m, i) => (i === 7 ? { ...m, name: 'Eleasis' } : i === 8 ? { ...m, name: 'Eleint' } : m)),
            formattingRules: undefined,
        });
        const now = resolveInstruction('twins', 0, '1203-01-01 14:30');
        expect(now).toEqual(expect.any(Number));
        expect(resolveInstruction('twins', now, 'Eleasis 3, 1203')).toEqual(expect.any(Number));
        expect(resolveInstruction('twins', now, 'Ele 3, 1203')).toBeNull();
        expect(resolveInstruction('twins', now, 'Elea 3, 1203')).toBe(resolveInstruction('twins', now, '1203-08-03 14:30'));
        expect(resolveInstruction('twins', now, 'Elei 3, 1203')).toBe(resolveInstruction('twins', now, '1203-09-03 14:30'));
    });
});

describe('a leading weekday is ignored', () => {
    it.each([
        'Friday, September 5, 2025',
        'Fri, Sept 5, 2025',
        'Fri. September 5, 2025',
        'on Friday September 5, 2025',
        'It was Friday, September 5, 2025',
        'Friday, 2025-09-05',
    ])('"%s"', (text) => {
        expect(r(text)).toBe(ts(2025, 9, 5, 14, 30));
    });

    it('only the calendar\'s own weekday names count', () => {
        expect(r('Firstday, September 5, 2025')).toBeNull();
    });

    it('a short weekday name that is also an ordinal does not break a day-first date (Faerun-inspired "1st")', () => {
        const now = resolveInstruction('faerun_inspired', 0, '1490-01-01 09:00');
        expect(now).toEqual(expect.any(Number));
        expect(resolveInstruction('faerun_inspired', now, '1490-02-01 09:00')).toEqual(expect.any(Number));
        expect(resolveInstruction('faerun_inspired', now, '1st of Rainswell 1490'))
            .toBe(resolveInstruction('faerun_inspired', now, '1490-02-01 09:00'));
        expect(resolveInstruction('faerun_inspired', now, 'Firstday, Rainswell 3, 1490'))
            .toBe(resolveInstruction('faerun_inspired', now, '1490-02-03 09:00'));
    });
});

describe('still not understood', () => {
    it.each(['9/5/2025', '5/9/2025', 'sometime in September'])('"%s" (ambiguous or vague)', (text) => {
        expect(r(text)).toBeNull();
    });
});
