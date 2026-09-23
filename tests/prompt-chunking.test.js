// Automatic prompt chunking (requirements spec 1.20, rewritten 2026-09-22) -
// the pure size-packing primitive chunkPromptUnits() (src/core/prompt-
// chunking.js). Both prompted-engine.js's main per-message update and
// independent-presets.js build their OWN units from their OWN line-rendering
// conventions and hand them to this one shared function - covered here in
// isolation, with no settings/chat-state/preset concept at all, on purpose
// (matching schedule-engine.js's own "pure math" test file convention).

import context from './harness/context.js';
import settings from './harness/settings.js';
import { chunkPromptUnits } from '../src/core/prompt-chunking.js';
import { computeDefaultMaxPromptedVariableChars, getSettings } from '../src/core/settings-core.js';

const unit = (name, size, kind = 'update') => ({ def: { name }, kind, line: `- "${name}"`, size });

describe('chunkPromptUnits', () => {
    it('[] in, [] out', () => {
        expect(chunkPromptUnits([], 100)).toEqual([]);
        expect(chunkPromptUnits(undefined, 100)).toEqual([]);
        expect(chunkPromptUnits(null, 100)).toEqual([]);
    });

    it('everything fits in ONE chunk when the total is under budget - the common case', () => {
        const units = [unit('a', 10), unit('b', 10), unit('c', 10)];
        const chunks = chunkPromptUnits(units, 100);
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toEqual(units);
    });

    it('a budget of Infinity (or no real budget) never splits', () => {
        const units = [unit('a', 1000), unit('b', 1000), unit('c', 1000)];
        expect(chunkPromptUnits(units, Infinity)).toHaveLength(1);
        expect(chunkPromptUnits(units, undefined)).toHaveLength(1);
        expect(chunkPromptUnits(units, NaN)).toHaveLength(1);
        expect(chunkPromptUnits(units, -5)).toHaveLength(1);
        expect(chunkPromptUnits(units, 0)).toHaveLength(1);
    });

    it('splits into exactly as many chunks as the budget forces, greedily', () => {
        // Each unit is 10; budget 25 -> chunks of [10,10]=20, then [10]=10 (never [10,10,10]=30 > 25).
        const units = [unit('a', 10), unit('b', 10), unit('c', 10), unit('d', 10), unit('e', 10)];
        const chunks = chunkPromptUnits(units, 25);
        expect(chunks.map((c) => c.map((u) => u.def.name))).toEqual([
            ['a', 'b'], ['c', 'd'], ['e'],
        ]);
    });

    it('never reorders units - relative order within and across kinds is preserved exactly', () => {
        const units = [
            unit('a', 10, 'update'), unit('b', 10, 'update'),
            unit('x', 10, 'increment'), unit('y', 10, 'increment'),
        ];
        const chunks = chunkPromptUnits(units, 15); // forces a split after every single unit
        expect(chunks.map((c) => c.map((u) => u.def.name))).toEqual([['a'], ['b'], ['x'], ['y']]);
    });

    it('a single unit larger than the whole budget still gets its own chunk - never dropped', () => {
        const units = [unit('huge', 500), unit('small', 5)];
        const chunks = chunkPromptUnits(units, 100);
        expect(chunks).toEqual([[units[0]], [units[1]]]);
    });

    it('exactly AT budget fits in the same chunk; one byte over starts a new one', () => {
        expect(chunkPromptUnits([unit('a', 50), unit('b', 50)], 100)).toHaveLength(1);
        expect(chunkPromptUnits([unit('a', 50), unit('b', 51)], 100)).toHaveLength(2);
    });

    it('a unit with a missing/non-finite size counts as zero, without corrupting the running total for later units', () => {
        const units = [unit('a', 10), { def: { name: 'weird' }, kind: 'update', line: '- "weird"', size: NaN }, unit('c', 10)];
        const chunks = chunkPromptUnits(units, 100);
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toHaveLength(3);

        // If the non-finite size were used as-is (NaN) instead of falling
        // back to 0, every later budget comparison ("running total + next
        // size > budget") would itself be NaN - which JavaScript always
        // evaluates to false - so NOTHING after the weird unit would ever
        // split again, no matter how large. This forces that distinction:
        // two more full-size units after the weird one still split apart.
        const withMoreAfter = [unit('a', 10), { def: { name: 'weird' }, kind: 'update', line: '- "weird"', size: NaN }, unit('c', 60), unit('d', 60)];
        const split = chunkPromptUnits(withMoreAfter, 100);
        expect(split.map((c) => c.map((u) => u.def.name))).toEqual([['a', 'weird', 'c'], ['d']]);
    });

    it('deterministic: the same units and budget always produce the same chunking', () => {
        const units = [unit('a', 30), unit('b', 40), unit('c', 20), unit('d', 35)];
        const first = chunkPromptUnits(units, 60);
        const second = chunkPromptUnits(units, 60);
        expect(second).toEqual(first);
    });

    it('never mutates its input array or the unit objects', () => {
        const units = [unit('a', 10), unit('b', 10)];
        const snapshot = JSON.stringify(units);
        chunkPromptUnits(units, 5);
        expect(JSON.stringify(units)).toBe(snapshot);
    });
});

// The character-budget default (requirements spec 1.20, rewritten
// 2026-09-22) - the same "derive a sane default from SillyTavern's
// configured context size, clamp it, cache it in settings" convention
// computeDefaultMaxPromptHistoryMessages already established for chat
// history, denominated in characters instead of messages.
describe('computeDefaultMaxPromptedVariableChars', () => {
    it('falls back to 6000 when maxContext is missing or not a usable number', () => {
        for (const bad of [undefined, null, 0, -5, NaN, 'nope']) {
            expect(computeDefaultMaxPromptedVariableChars({ maxContext: bad })).toBe(6000);
        }
        expect(computeDefaultMaxPromptedVariableChars(undefined)).toBe(6000);
    });

    it('scales with maxContext (roughly 4 chars/token, a third of the window)', () => {
        expect(computeDefaultMaxPromptedVariableChars({ maxContext: 8192 })).toBe(Math.round((8192 * 4) / 3));
    });

    it('clamps to [2000, 20000] for a tiny or huge context size', () => {
        expect(computeDefaultMaxPromptedVariableChars({ maxContext: 1 })).toBe(2000);
        expect(computeDefaultMaxPromptedVariableChars({ maxContext: 1000000 })).toBe(20000);
    });
});

describe('getSettings() backfills maxPromptedVariableChars', () => {
    beforeEach(() => { settings.reset(); });

    it('computes it from context.maxContext on first access when null/missing', () => {
        context.maxContext = 8192;
        settings.get().maxPromptedVariableChars = null;
        expect(getSettings().maxPromptedVariableChars).toBe(computeDefaultMaxPromptedVariableChars(context));
    });

    it('leaves an already-set value alone (a user override, or a previously-computed default)', () => {
        settings.get().maxPromptedVariableChars = 12345;
        expect(getSettings().maxPromptedVariableChars).toBe(12345);
    });
});
