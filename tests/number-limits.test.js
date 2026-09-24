// @vitest-environment jsdom
//
// Optional number limits (def.min / def.max): settable in the manager
// editor, both optional (blank = no limit, never a default), and enforced
// on every write when set - including the two paths that used to skip
// them: setVar() (prompted updates, extensions, seeding) and
// applyIncrement()'s numeric branch. Runs against the REAL chat-state.js.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import settings from './harness/settings.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { buildInlineVariableEditor } from '../src/ui/manager-modal/ui-templates.js';
import { canIncrement, normalizeCollectedValues } from '../src/ui/manager-modal/variable-ui-schema.js';
import { setVar, getVar, applyIncrement } from '../src/core/chat-state.js';

vi.mock('../src/core/chat-state.js', async () => vi.importActual('../src/core/chat-state.js'));

const number = (over = {}) => ({ ...blankDefinition(), name: 'se__gold', type: 'number', ...over });

beforeEach(() => {
    settings.reset();
});

describe('the editor', () => {
    const dom = (def) => {
        const el = document.createElement('div');
        el.innerHTML = buildInlineVariableEditor(def, canIncrement(def.type), []);
        return el;
    };

    it('offers optional Min and Max for a number, blank when unset', () => {
        const el = dom(number());
        const min = el.querySelector('[data-field="min"]');
        const max = el.querySelector('[data-field="max"]');
        expect(min.type).toBe('number');
        expect(max.type).toBe('number');
        expect(min.value).toBe('');
        expect(max.value).toBe('');
        expect(min.placeholder).toBe('no limit');
    });

    it('shows stored limits', () => {
        const el = dom(number({ min: -5, max: 250 }));
        expect(el.querySelector('[data-field="min"]').value).toBe('-5');
        expect(el.querySelector('[data-field="max"]').value).toBe('250');
    });

    it.each(['string', 'boolean', 'enum', 'datetime', 'calculated'])('offers no limits for %s', (type) => {
        const el = dom({ ...blankDefinition(), name: 'se__x', type });
        expect(el.querySelector('[data-field="min"]')).toBe(null);
        expect(el.querySelector('[data-field="max"]')).toBe(null);
    });

    it('collects blank as "no limit" (null) and numbers as numbers - never a default', () => {
        expect(normalizeCollectedValues({ min: '', max: '' })).toMatchObject({ min: null, max: null });
        expect(normalizeCollectedValues({ min: '0', max: '100.5' })).toMatchObject({ min: 0, max: 100.5 });
        expect(normalizeCollectedValues({ min: 'abc', max: ' ' })).toMatchObject({ min: null, max: null });
    });
});

describe('enforcement', () => {
    it('setVar keeps a limited number within min/max', () => {
        const def = number({ min: 0, max: 100 });
        setVar('chat-1', def.name, 150, def);
        expect(getVar('chat-1', def.name).value).toBe(100);
        setVar('chat-1', def.name, -3, def);
        expect(getVar('chat-1', def.name).value).toBe(0);
    });

    it('setVar stores numeric text (a prompted answer) as a clamped number', () => {
        const def = number({ max: 20 });
        setVar('chat-1', def.name, '35', def);
        expect(getVar('chat-1', def.name).value).toBe(20);
    });

    it('an unlimited number is never clamped', () => {
        const def = number();
        setVar('chat-1', def.name, 500, def);
        expect(getVar('chat-1', def.name).value).toBe(500);
        setVar('chat-1', def.name, -500, def);
        expect(getVar('chat-1', def.name).value).toBe(-500);
    });

    it('only one limit: only that side is enforced', () => {
        const def = number({ min: 10 });
        setVar('chat-1', def.name, 5, def);
        expect(getVar('chat-1', def.name).value).toBe(10);
        setVar('chat-1', def.name, 9999, def);
        expect(getVar('chat-1', def.name).value).toBe(9999);
    });

    it('increments stop at the limits', () => {
        const def = number({ min: 0, max: 10 });
        setVar('chat-1', def.name, 8, def);
        applyIncrement('chat-1', def.name, 5, def);
        expect(getVar('chat-1', def.name).value).toBe(10);
        applyIncrement('chat-1', def.name, -25, def);
        expect(getVar('chat-1', def.name).value).toBe(0);
    });

    it('increments of an unlimited number are unchanged', () => {
        const def = number();
        setVar('chat-1', def.name, 98, def);
        applyIncrement('chat-1', def.name, 5, def);
        expect(getVar('chat-1', def.name).value).toBe(103);
    });
});
