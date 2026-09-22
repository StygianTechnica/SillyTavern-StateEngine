// Independent Preset scheduling (requirements spec 1.32) - pure calendar
// math: parseScheduleTarget()/scheduleAfterRun(). "now" is REAL wall-clock
// time, controlled here with vi.useFakeTimers()/setSystemTime() (the same
// technique tests/api/notification-api.test.js already uses), never a
// datetime VARIABLE - this module has no chat/preset/variable concept at
// all, on purpose (see its own header comment).

import settings from './harness/settings.js';
import { parseScheduleTarget, scheduleAfterRun, SCHEDULE_MODES, MAX_REPEAT_ADVANCE_STEPS } from '../src/core/schedule-engine.js';

const ts = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

afterEach(() => { vi.useRealTimers(); });

describe('SCHEDULE_MODES', () => {
    it('lists exactly the four modes this pass supports (threshold is deliberately not one of them)', () => {
        expect(SCHEDULE_MODES).toEqual(['interval', 'atTime', 'delay', 'repeat']);
    });
});

describe('parseScheduleTarget', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(ts(2026, 9, 22, 12, 0, 0)); });

    it('rejects an unknown mode', () => {
        expect(parseScheduleTarget({ mode: 'nonsense', value: '10 minutes' })).toMatchObject({ ok: false, error: expect.stringContaining('schedule.mode') });
        expect(parseScheduleTarget({ value: '10 minutes' })).toMatchObject({ ok: false });
    });

    it('rejects an unknown calendar', () => {
        expect(parseScheduleTarget({ mode: 'interval', value: '10 minutes', calendar: 'nope' })).toMatchObject({ ok: false, error: expect.stringContaining('calendar "nope"') });
    });

    it('rejects a missing/blank value', () => {
        expect(parseScheduleTarget({ mode: 'interval', value: '' })).toMatchObject({ ok: false, error: expect.stringContaining('required') });
        expect(parseScheduleTarget({ mode: 'interval', value: '   ' })).toMatchObject({ ok: false });
        expect(parseScheduleTarget({ mode: 'interval' })).toMatchObject({ ok: false });
    });

    describe('interval / delay - bare durations, no verb needed', () => {
        it.each(['interval', 'delay'])('%s: "10 minutes" -> now + 10 real minutes', (mode) => {
            const r = parseScheduleTarget({ mode, value: '10 minutes' });
            expect(r).toMatchObject({ ok: true });
            expect(r.nextRun).toBe(ts(2026, 9, 22, 12, 10, 0));
        });

        it.each(['interval', 'delay'])('%s: "1 hour", "2 days", "1mo" all resolve via the real calendar engine', (mode) => {
            expect(parseScheduleTarget({ mode, value: '1 hour' }).nextRun).toBe(ts(2026, 9, 22, 13, 0, 0));
            expect(parseScheduleTarget({ mode, value: '2 days' }).nextRun).toBe(ts(2026, 9, 24, 12, 0, 0));
            expect(parseScheduleTarget({ mode, value: '1mo' }).nextRun).toBe(ts(2026, 10, 22, 12, 0, 0));
        });

        it.each(['interval', 'delay'])('%s: a phrase that already has its own verb also works ("advance 3 hours")', (mode) => {
            expect(parseScheduleTarget({ mode, value: 'advance 3 hours' }).nextRun).toBe(ts(2026, 9, 22, 15, 0, 0));
        });

        it.each(['interval', 'delay'])('%s: refuses an absolute past moment (not a forward duration)', (mode) => {
            const r = parseScheduleTarget({ mode, value: '2020-01-01 00:00:00' });
            expect(r).toMatchObject({ ok: false, error: expect.stringContaining('forward duration') });
        });

        it.each(['interval', 'delay'])('%s: refuses unparseable text', (mode) => {
            expect(parseScheduleTarget({ mode, value: 'whenever, I guess' })).toMatchObject({ ok: false });
        });
    });

    describe('atTime - absolute, used exactly as resolved (even if already past)', () => {
        it('an absolute future date/time resolves to that exact moment', () => {
            const r = parseScheduleTarget({ mode: 'atTime', value: '2026-09-25 06:00:00' });
            expect(r).toMatchObject({ ok: true, nextRun: ts(2026, 9, 25, 6, 0, 0) });
        });

        it('a duration typed by mistake still resolves (advance-fallback applies here too)', () => {
            expect(parseScheduleTarget({ mode: 'atTime', value: '1 day' }).nextRun).toBe(ts(2026, 9, 23, 12, 0, 0));
        });

        it('an ALREADY-PAST absolute moment is accepted as-is (overdue, not reinterpreted)', () => {
            const r = parseScheduleTarget({ mode: 'atTime', value: '2020-01-01 00:00:00' });
            expect(r).toMatchObject({ ok: true, nextRun: ts(2020, 1, 1, 0, 0, 0) });
        });

        it('"dawn"/"midnight"/"sunrise"/"sunset" are honestly unsupported - confirmed gap, not silently guessed at', () => {
            for (const phrase of ['dawn', 'midnight', 'next sunrise', 'every sunset', 'tomorrow at dawn']) {
                expect(parseScheduleTarget({ mode: 'atTime', value: phrase }), phrase).toMatchObject({ ok: false });
            }
        });

        it('"next season"/"move to <season>" DO work when the calendar defines seasons', () => {
            settings.get().calendars.fantasy = {
                id: 'fantasy', label: 'Fantasy', unit: 'seconds',
                secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24, leapYearRule: 'none',
                months: [{ name: 'A', days: 30 }, { name: 'B', days: 30 }, { name: 'C', days: 30 }, { name: 'D', days: 30 }],
                seasons: [{ name: 'Spring', startMonth: 1, startDay: 1 }, { name: 'Summer', startMonth: 3, startDay: 1 }],
            };
            const r = parseScheduleTarget({ mode: 'atTime', value: 'next season', calendar: 'fantasy' });
            expect(r.ok).toBe(true);
        });
    });

    describe('repeat - always a future occurrence, iteratively advanced if needed', () => {
        it('a plain forward duration behaves like interval/delay', () => {
            expect(parseScheduleTarget({ mode: 'repeat', value: '1 hour' }).nextRun).toBe(ts(2026, 9, 22, 13, 0, 0));
        });

        it('a past ABSOLUTE date has no sensible "next occurrence" and is refused, not silently advanced', () => {
            // "2026-09-01" alone resolves to midnight that day - already behind "now"
            // (2026-09-22 12:00). Unlike a relative/recurring phrase, re-resolving an
            // absolute date against a different "current" baseline still returns the
            // SAME fixed point every time (toScalar ignores currentScalar entirely) -
            // there is no future occurrence to advance to, so repeat mode correctly
            // refuses it (this is what atTime is for) rather than pretending one
            // exists. Caught by this test itself, not assumed.
            const r = parseScheduleTarget({ mode: 'repeat', value: '2026-09-01' });
            expect(r).toMatchObject({ ok: false, error: expect.stringContaining('never resolves to a future occurrence') });
        });

        it('a phrase that cannot resolve at all still refuses cleanly', () => {
            expect(parseScheduleTarget({ mode: 'repeat', value: 'whenever' })).toMatchObject({ ok: false });
        });

        it('never loops forever: MAX_REPEAT_ADVANCE_STEPS bounds the advancement', () => {
            expect(MAX_REPEAT_ADVANCE_STEPS).toBeGreaterThan(0);
            expect(MAX_REPEAT_ADVANCE_STEPS).toBeLessThan(1_000_000); // sane cap, not "practically infinite"
        });
    });
});

describe('scheduleAfterRun', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(ts(2026, 9, 22, 12, 0, 0)); });

    it('interval: always reschedules (repeat is inert for this mode - request 3A is unconditional)', () => {
        expect(scheduleAfterRun({ mode: 'interval', value: '1 hour', repeat: false })).toMatchObject({ enabled: true, nextRun: ts(2026, 9, 22, 13, 0, 0) });
        expect(scheduleAfterRun({ mode: 'interval', value: '1 hour', repeat: true })).toMatchObject({ enabled: true, nextRun: ts(2026, 9, 22, 13, 0, 0) });
    });

    it('delay: always disables, regardless of repeat (one-shot by definition - request 3C)', () => {
        expect(scheduleAfterRun({ mode: 'delay', value: '1 hour', repeat: false })).toEqual({ enabled: false, nextRun: null });
        expect(scheduleAfterRun({ mode: 'delay', value: '1 hour', repeat: true })).toEqual({ enabled: false, nextRun: null });
    });

    it('atTime: disables unless repeat is explicitly true (request 3B - the one mode where repeat actually matters)', () => {
        expect(scheduleAfterRun({ mode: 'atTime', value: '2026-10-01 00:00', repeat: false })).toEqual({ enabled: false, nextRun: null });
        expect(scheduleAfterRun({ mode: 'atTime', value: '2026-10-01 00:00', repeat: true })).toEqual({ enabled: true, nextRun: null });
    });

    it('repeat mode: always stays enabled and always recomputes a fresh future occurrence', () => {
        const r = scheduleAfterRun({ mode: 'repeat', value: '1 day', repeat: false });
        expect(r).toMatchObject({ enabled: true, nextRun: ts(2026, 9, 23, 12, 0, 0) });
    });

    it('an unparseable schedule (calendar deleted, garbage value) disables rather than throwing', () => {
        expect(scheduleAfterRun({ mode: 'repeat', value: 'whenever' })).toEqual({ enabled: false, nextRun: null });
        expect(scheduleAfterRun({ mode: 'interval', value: 'whenever' })).toEqual({ enabled: false, nextRun: null });
    });
});
