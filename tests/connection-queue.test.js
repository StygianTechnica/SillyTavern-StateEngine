import { describe, it, expect, vi } from 'vitest';
import { connectionKeyFor, enqueueOnConnection, pendingOnConnection } from '../src/core/connection-queue.js';
import { callBackgroundLLM } from '../src/core/background-llm.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('connectionKeyFor', () => {
    it('is the connection callBackgroundLLM tries first', () => {
        expect(connectionKeyFor({ stateEngineProfileId: 'p1', connectionProfileId: 'p2' })).toBe('p1');
        expect(connectionKeyFor({ connectionProfileId: 'p2' })).toBe('p2');
        expect(connectionKeyFor({})).toBe('');
        expect(connectionKeyFor(undefined)).toBe('');
    });
});

describe('enqueueOnConnection', () => {
    it('runs calls on one connection one at a time, in order', async () => {
        const order = [];
        const first = deferred();
        const a = enqueueOnConnection('same', () => { order.push('a'); return first.promise; });
        const b = enqueueOnConnection('same', async () => { order.push('b'); return 'b'; });
        await Promise.resolve();
        await Promise.resolve();
        expect(order).toEqual(['a']);
        expect(pendingOnConnection('same')).toBe(2);
        first.resolve('a');
        expect(await a).toBe('a');
        expect(await b).toBe('b');
        expect(order).toEqual(['a', 'b']);
        await vi.waitFor(() => expect(pendingOnConnection('same')).toBe(0));
    });

    it('runs calls on different connections side by side', async () => {
        const slow = deferred();
        const order = [];
        const a = enqueueOnConnection('one', () => { order.push('a'); return slow.promise; });
        const b = enqueueOnConnection('two', async () => { order.push('b'); return 'b'; });
        expect(await b).toBe('b');
        expect(order).toEqual(['a', 'b']);
        slow.resolve('a');
        expect(await a).toBe('a');
    });

    it('a failed call never blocks the line', async () => {
        const a = enqueueOnConnection('flaky', async () => { throw new Error('boom'); });
        const b = enqueueOnConnection('flaky', async () => 'next');
        await expect(a).rejects.toThrow('boom');
        expect(await b).toBe('next');
    });
});

describe('callBackgroundLLM', () => {
    it('queues requests to the same connection', async () => {
        const first = deferred();
        const calls = [];
        const context = {
            generateRaw: vi.fn(({ prompt }) => {
                calls.push(prompt);
                return calls.length === 1 ? first.promise : Promise.resolve('second');
            }),
        };
        const a = callBackgroundLLM(context, {}, 'one', 100);
        const b = callBackgroundLLM(context, {}, 'two', 100);
        await vi.waitFor(() => expect(calls).toEqual(['one']));
        first.resolve('first');
        expect(await a).toBe('first');
        expect(await b).toBe('second');
        expect(calls).toEqual(['one', 'two']);
    });
});
