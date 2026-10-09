// Requirements spec 1.39: narrative wording around a duration - what a model
// copies out of the message ("Two days passed", "several hours later") - is
// understood, with vague amounts estimated instead of rejected.
import { describe, it, expect } from 'vitest';
import { resolveInstruction, isValidDelta } from '../src/core/calendar-engine.js';

const ts = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
const NOW = ts(2026, 10, 7, 14, 30);
const advance = (text) => {
    const result = resolveInstruction('gregorian', NOW, `advance ${text}`);
    return result === null ? null : result - NOW;
};
const H = 3600;
const D = 86400;

describe('narrative wording around a duration', () => {
    it.each([
        ['Two days passed', 2 * D],
        ['two more days passed', 2 * D],
        ['2 days have passed', 2 * D],
        ['another two days', 2 * D],
        ['a further two days', 2 * D],
        ['10 minutes later', 600],
        ['ten minutes passed.', 600],
        ["it's been three days", 3 * D],
        ['after about an hour', H],
        ['nearly two hours', 2 * H],
        ['a good two hours', 2 * H],
        ['another day', D],
        ['the next day', D],
        ['three hours went by', 3 * H],
    ])('%j -> %i seconds', (text, seconds) => {
        expect(advance(text)).toBe(seconds);
    });
});

describe('vague amounts are estimated', () => {
    it.each([
        ['a couple of days', 2 * D],
        ['a couple hours', 2 * H],
        ['a few minutes', 3 * 60],
        ['several hours', 3 * H],
        ['several days later', 3 * D],
        ['a handful of days', 3 * D],
    ])('%j -> %i seconds', (text, seconds) => {
        expect(advance(text)).toBe(seconds);
    });
});

describe('halves', () => {
    it.each([
        ['half an hour', 30 * 60],
        ['half a day', 12 * H],
        ['an hour and a half', 90 * 60],
        ['two and a half hours', 150 * 60],
    ])('%j -> %i seconds', (text, seconds) => {
        expect(advance(text)).toBe(seconds);
    });

    it('half a month is about 15 days and half a year 6 months (approximated, never refused)', () => {
        expect(advance('half a month')).toBe(15 * D);
        expect(resolveInstruction('gregorian', NOW, 'advance half a year')).toBe(ts(2027, 4, 7, 14, 30));
    });
});

// A real chat (2026-10-09): the model answered "a few minutes since Lucian
// left the gym" - the duration, then where it was counted from.
describe('trailing context after a duration', () => {
    it.each([
        ['a few minutes since Lucian left the gym', 3 * 60],
        ['about an hour since Lucian finished his gym shift', H],
        ['2 days after the battle', 2 * D],
        ['30 minutes, give or take', 30 * 60],
        ['three hours 20 minutes of walking in the rain', 3 * H + 20 * 60],
    ])('%j -> %i seconds', (text, seconds) => {
        expect(advance(text)).toBe(seconds);
    });

    it.each(['later that afternoon', '3 more for the road', 'Lucian left the gym'])('%j is still not a duration (never a bare number of seconds)', (text) => {
        expect(advance(text)).toBeNull();
    });
});

describe('unchanged', () => {
    it('text that already parsed means the same thing', () => {
        expect(advance('1d 2h')).toBe(D + 2 * H);
        expect(advance('1y, 2mo and 3d')).toBe(resolveInstruction('gregorian', NOW, 'advance 1y 2mo 3d') - NOW);
        expect(advance('twenty-five days')).toBe(25 * D);
    });

    it.each(['later', 'no change', 'none', 'banana days'])('%j is still not a duration', (text) => {
        expect(advance(text)).toBeNull();
    });

    it('isValidDelta accepts narrative deltas too (the same parser)', () => {
        expect(isValidDelta('gregorian', 'several hours')).toBe(true);
        expect(isValidDelta('gregorian', 'no change')).toBe(false);
    });
});
