// @vitest-environment jsdom
//
// Requirements spec 1.37: an increment's step can come from another
// variable (increment.deltaVariable) instead of the fixed increment.delta.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { runDeterministicIncrements } from '../src/core/deterministic-engine.js';
import { incrementDelta } from '../src/core/increment-delta.js';
import { getVar, setVar } from '../src/core/chat-state.js';
import * as variableUiSchema from '../src/ui/manager-modal/variable-ui-schema.js';
import { buildInlineVariableEditor } from '../src/ui/manager-modal/ui-templates.js';

vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

let instanceId;

const create = (name, extra = {}) => stateEngine.createVariable('pp', instanceId, {
    namespace: 'pp', presetName: 'Demo', name, type: 'number', ...extra,
});
const live = (name) => stateEngine.getVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', variableName: name });
const stored = (name) => getVar('chat-1', `pp__${name}`)?.value;
const put = (name, value) => setVar('chat-1', `pp__${name}`, value, live(name));

const counter = (extra = {}) => create('counter', {
    defaultValue: 10,
    behaviors: { increment: true, prompted: false },
    increment: { delta: 1, triggers: 'ai', deltaVariable: 'pp__step' },
    ...extra,
});

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
    stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
});

describe('increment.deltaVariable (spec 1.37)', () => {
    it('a number steps by the named variable\'s current value, following it as it changes', () => {
        create('step', { defaultValue: 3 });
        counter();
        put('step', 3);
        put('counter', 10);

        runDeterministicIncrements('chat-1', 'ai');
        expect(stored('counter')).toBe(13);

        put('step', -5);
        runDeterministicIncrements('chat-1', 'ai');
        expect(stored('counter')).toBe(8);
    });

    it('accepts a numeric string from the source (a calculated or string result)', () => {
        create('step', { type: 'string', defaultValue: '4' });
        counter();
        put('step', '4');
        put('counter', 10);
        runDeterministicIncrements('chat-1', 'ai');
        expect(stored('counter')).toBe(14);
    });

    it.each([
        ['does not exist', null],
        ['holds no number', 'lots'],
        ['is empty', ''],
    ])('falls back to the fixed delta, with a warning, when the source %s', (_label, value) => {
        if (value !== null) {
            create('step', { type: 'string', defaultValue: '' });
            put('step', value);
        }
        counter({ increment: { delta: 2, triggers: 'ai', deltaVariable: 'pp__step' } });
        put('counter', 10);
        runDeterministicIncrements('chat-1', 'ai');
        expect(stored('counter')).toBe(12);
        expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('delta variable "pp__step" has no usable value'));
    });

    it('without a deltaVariable the fixed delta is used, exactly as before', () => {
        counter({ increment: { delta: 2, triggers: 'ai' } });
        put('counter', 10);
        runDeterministicIncrements('chat-1', 'ai');
        expect(stored('counter')).toBe(12);
    });

    it('a datetime steps by a duration string or a number of seconds from the source', () => {
        create('jump', { type: 'string', defaultValue: '' });
        create('clock', {
            type: 'datetime', defaultValue: 0,
            behaviors: { increment: true, prompted: false },
            increment: { delta: '1h', triggers: 'ai', deltaVariable: 'pp__jump' },
        });
        put('clock', 0);

        put('jump', '2d');
        runDeterministicIncrements('chat-1', 'ai');
        expect(stored('clock')).toBe(2 * 86400);

        put('jump', 90);
        runDeterministicIncrements('chat-1', 'ai');
        expect(stored('clock')).toBe(2 * 86400 + 90);

        // Not a duration: the fixed "1h" step.
        put('jump', 'banana');
        runDeterministicIncrements('chat-1', 'ai');
        expect(stored('clock')).toBe(2 * 86400 + 90 + 3600);
    });

    it('is ignored for types that do not step by an amount', () => {
        const def = { ...blankDefinition(), name: 'pp__flag', type: 'boolean', increment: { delta: 1, deltaVariable: 'pp__step' } };
        expect(incrementDelta('chat-1', def)).toBe(1);
    });
});

describe('increment.deltaVariable through the API', () => {
    it('is stored trimmed', () => {
        create('step');
        counter({ increment: { delta: 1, triggers: 'ai', deltaVariable: '  pp__step  ' } });
        expect(live('counter').increment.deltaVariable).toBe('pp__step');
    });

    it('rejects a non-string name', () => {
        expect(counter({ increment: { delta: 1, triggers: 'ai', deltaVariable: 42 } })).toBeFalsy();
        expect(live('counter')).toBeFalsy();
    });

    it('rejects a variable naming itself', () => {
        expect(counter({ increment: { delta: 1, triggers: 'ai', deltaVariable: 'pp__counter' } })).toBeFalsy();
    });

    it('updateVariable can set and clear it', () => {
        create('step');
        counter({ increment: { delta: 1, triggers: 'ai' } });
        const ref = { namespace: 'pp', presetName: 'Demo', variableName: 'counter' };
        stateEngine.updateVariable('pp', instanceId, ref, { increment: { delta: 1, triggers: 'ai', deltaVariable: 'pp__step' } });
        expect(live('counter').increment.deltaVariable).toBe('pp__step');
        stateEngine.updateVariable('pp', instanceId, ref, { increment: { delta: 1, triggers: 'ai', deltaVariable: '' } });
        expect(live('counter').increment.deltaVariable).toBe('');
    });
});

describe('increment.deltaVariable in the manager editor', () => {
    const others = [
        { name: 'pp__step', type: 'number', label: 'Step' },
        { name: 'pp__calc', type: 'calculated' },
        { name: 'pp__words', type: 'string' },
        { name: 'pp__flag', type: 'boolean' },
    ];
    const optionsOf = (html) => {
        const el = document.createElement('div');
        el.innerHTML = html;
        const select = el.querySelector('[data-field="increment.deltaVariable"]');
        return select ? [...select.options].map((o) => o.value) : null;
    };
    const editor = (extra) => buildInlineVariableEditor({
        ...blankDefinition(), name: 'pp__counter', behaviors: { increment: true, prompted: false }, ...extra,
    }, true, others);

    it('a number offers number and calculated variables', () => {
        expect(optionsOf(editor({ type: 'number' }))).toEqual(['', 'pp__step', 'pp__calc']);
    });

    it('a datetime also offers string variables (durations such as "3h")', () => {
        expect(optionsOf(editor({ type: 'datetime', increment: { ...blankDefinition().increment, delta: '1h' } })))
            .toEqual(['', 'pp__step', 'pp__calc', 'pp__words']);
    });

    it('keeps a stored name that is no longer offered, marked, instead of dropping it', () => {
        const html = editor({ type: 'number', increment: { ...blankDefinition().increment, deltaVariable: 'pp__gone' } });
        expect(optionsOf(html)).toContain('pp__gone');
        expect(html).toContain('not a suitable variable in this preset');
    });

    it('other types have no such control', () => {
        expect(optionsOf(editor({ type: 'boolean' }))).toBe(null);
    });

    it('the collected value is saved trimmed, and described in the summary', () => {
        const out = variableUiSchema.normalizeCollectedValues({ type: 'number', increment: { delta: '1', deltaVariable: ' pp__step ' } });
        expect(out.increment.deltaVariable).toBe('pp__step');
    });
});
