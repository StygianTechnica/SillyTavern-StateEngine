// Boolean "flag mode" (requirements spec 1.28): a boolean that starts false, can be
// set to true by an automatic write path, and can only move back to false through a
// MANUAL write. Core rules (schema, the write-path gate), plus World Info and the
// expression language treating a flag exactly like any other boolean, and export/
// import round-tripping it like any other definition field.
//
// The write-path gate lives in chat-state.js, which the harness normally mocks
// (tests/harness/chat-state.mock.js does not implement it) - so the gate tests below
// reach for the REAL module via vi.importActual, the same pattern image-variables.test.js
// already uses for exactly this reason.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { blankDefinition, getDefaultValue } from '../src/core/variable-schema.js';
import * as wi from '../src/world-info/wi-conditions.js';
import { addPresetToChat } from '../src/core/preset-manager.js';
import { evaluateExpression } from '../src/core/expression-dsl.js';
import { exportPreset, importPresetDetailed } from '../src/core/preset-export.js';

const realChatState = await vi.importActual('../src/core/chat-state.js');

const flagDef = (extra = {}) => ({ ...blankDefinition(), id: 'v-flag', name: 'se__flag', type: 'boolean', flagMode: true, ...extra });
const plainBoolDef = (extra = {}) => ({ ...blankDefinition(), id: 'v-plain', name: 'se__plain', type: 'boolean', ...extra });

beforeEach(() => settings.reset());

describe('schema', () => {
    it('a blank definition has flagMode: false', () => {
        expect(blankDefinition().flagMode).toBe(false);
    });

    it('getDefaultValue always starts a flag-mode boolean at false, whatever defaultValue says', () => {
        expect(getDefaultValue(flagDef())).toBe(false);
        expect(getDefaultValue(flagDef({ defaultValue: 'true' }))).toBe(false);
        expect(getDefaultValue(flagDef({ defaultValue: true }))).toBe(false);
    });

    it('an ordinary boolean (flagMode false or absent) is unaffected', () => {
        expect(getDefaultValue(plainBoolDef({ defaultValue: 'true' }))).toBe(true);
        expect(getDefaultValue(plainBoolDef({ defaultValue: 'false' }))).toBe(false);
        expect(getDefaultValue({ ...blankDefinition(), type: 'boolean', defaultValue: 'true' })).toBe(true); // no flagMode field at all
    });

    it('flagMode on a non-boolean type is simply inert', () => {
        const d = { ...blankDefinition(), type: 'string', flagMode: true, defaultValue: 'hi' };
        expect(getDefaultValue(d)).toBe('hi');
    });
});

describe('the write-path gate (setVar)', () => {
    it('an automatic write can set it to true', () => {
        const d = flagDef();
        realChatState.setVar('chat-1', d.name, true, d);
        expect(realChatState.getVar('chat-1', d.name).value).toBe(true);
    });

    it('once true, an automatic write attempting false is refused - the value stays true', () => {
        const d = flagDef();
        realChatState.setVar('chat-1', d.name, true, d);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        realChatState.setVar('chat-1', d.name, false, d);
        expect(realChatState.getVar('chat-1', d.name).value).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('flag-mode boolean'));
        warn.mockRestore();
    });

    it('the refusal is total: no macro-store mirror write either', () => {
        const d = flagDef();
        realChatState.setVar('chat-1', d.name, true, d);
        context.saveSettingsDebounced.mockClear();
        realChatState.setVar('chat-1', d.name, false, d);
        // a real write would call saveSettingsDebounced (persistSettings) again
        expect(context.saveSettingsDebounced).not.toHaveBeenCalled();
        expect(context.variables.local.get(d.name)).toBe(true);
    });

    it('a "false-ish" attempt is refused the same way a real false is: string, number, raw JSON-style values', () => {
        for (const attempt of [false, 'false', 'no', 0, 'off']) {
            const d = flagDef({ name: `se__flag_${String(attempt)}` });
            realChatState.setVar('chat-1', d.name, true, d);
            realChatState.setVar('chat-1', d.name, attempt, d);
            expect(realChatState.getVar('chat-1', d.name).value, String(attempt)).toBe(true);
        }
    });

    it('a manual write (options.manual: true) CAN reset it back to false', () => {
        const d = flagDef();
        realChatState.setVar('chat-1', d.name, true, d);
        realChatState.setVar('chat-1', d.name, false, d, { manual: true });
        expect(realChatState.getVar('chat-1', d.name).value).toBe(false);
    });

    it('while still false, an automatic write to false is a harmless no-op (nothing to protect)', () => {
        const d = flagDef();
        realChatState.setVar('chat-1', d.name, false, d);
        expect(realChatState.getVar('chat-1', d.name).value).toBe(false);
    });

    it('setting true again while already true is not a "reset" and is never blocked - it is a real write, not a silent no-op', () => {
        const d = flagDef();
        realChatState.setVar('chat-1', d.name, true, d);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        context.saveSettingsDebounced.mockClear();
        realChatState.setVar('chat-1', d.name, true, d);
        expect(realChatState.getVar('chat-1', d.name).value).toBe(true);
        expect(context.saveSettingsDebounced).toHaveBeenCalled(); // a genuine write happened, not an early-return block
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('an ordinary boolean (no flagMode) can always be flipped back to false automatically', () => {
        const d = plainBoolDef();
        realChatState.setVar('chat-1', d.name, true, d);
        realChatState.setVar('chat-1', d.name, false, d);
        expect(realChatState.getVar('chat-1', d.name).value).toBe(false);
    });

    it('the first-ever write for a chat (nothing stored yet) is never treated as a "reset", even to false', () => {
        const d = flagDef();
        realChatState.setVar('chat-1', d.name, false, d); // e.g. seeding, or a "continue" copy from a source chat
        expect(realChatState.getVar('chat-1', d.name).value).toBe(false);
    });
});

describe('the write-path gate (applyIncrement / toggle)', () => {
    it('toggling a false flag sets it true', () => {
        const d = flagDef();
        realChatState.setVar('chat-1', d.name, false, d);
        realChatState.applyIncrement('chat-1', d.name, 1, d);
        expect(realChatState.getVar('chat-1', d.name).value).toBe(true);
    });

    it('toggling an already-true flag is a no-op - it never flips back to false', () => {
        const d = flagDef();
        realChatState.setVar('chat-1', d.name, true, d);
        realChatState.applyIncrement('chat-1', d.name, 1, d);
        expect(realChatState.getVar('chat-1', d.name).value).toBe(true);
    });

    it('an ordinary boolean still toggles both ways', () => {
        const d = plainBoolDef();
        realChatState.setVar('chat-1', d.name, true, d);
        realChatState.applyIncrement('chat-1', d.name, 1, d);
        expect(realChatState.getVar('chat-1', d.name).value).toBe(false);
        realChatState.applyIncrement('chat-1', d.name, 1, d);
        expect(realChatState.getVar('chat-1', d.name).value).toBe(true);
    });

    it('applyIncrement never accepts a manual bypass - nothing that calls it is a manual UI action', () => {
        const d = flagDef();
        realChatState.setVar('chat-1', d.name, true, d);
        realChatState.applyIncrement('chat-1', d.name, 1, d, { manual: true });
        expect(realChatState.getVar('chat-1', d.name).value).toBe(true);
    });
});

describe('World Info conditions: is_true / is_false are unaffected', () => {
    let presetId;
    const setup = (flagMode) => {
        presetId = 'p1';
        getSettings().presets[presetId] = {
            id: presetId, name: 'P', namespace: 'se', description: '', triggers: ['ai'], showInTracker: true,
            variables: { flag: { ...blankDefinition(), id: 'flag', name: 'se__flag', type: 'boolean', flagMode } },
        };
        addPresetToChat('chat-1', presetId);
    };

    it('is_true / is_false read the current value exactly like any boolean', () => {
        setup(true);
        context.variables.local.set('se__flag', false);
        expect(wi.evaluateCondition('flag', 'is_true')).toBe(false);
        expect(wi.evaluateCondition('flag', 'is_false')).toBe(true);
        context.variables.local.set('se__flag', true);
        expect(wi.evaluateCondition('flag', 'is_true')).toBe(true);
        expect(wi.evaluateCondition('flag', 'is_false')).toBe(false);
    });

    it('flagMode is not a reason to exclude the variable from the condition editor', () => {
        setup(true);
        const names = wi.getAvailableVariablesForConditions().map((v) => v.name);
        expect(names).toContain('flag');
    });
});

describe('expression language: a flag behaves as a normal boolean', () => {
    it('typeof, negation and boolean operators all work identically', () => {
        const deps = ['ready'];
        expect(evaluateExpression('ready', deps, { ready: true })).toEqual({ ok: true, value: true });
        expect(evaluateExpression('!ready', deps, { ready: true })).toEqual({ ok: true, value: false });
        expect(evaluateExpression('ready && true', deps, { ready: true })).toEqual({ ok: true, value: true });
        expect(evaluateExpression('ready ? "done" : "pending"', deps, { ready: false })).toEqual({ ok: true, value: 'pending' });
    });
});

describe('export / import: flagMode and the default value round-trip like any other field', () => {
    it('exportPreset carries flagMode untouched', () => {
        getSettings().presets.p1 = {
            id: 'p1', name: 'P', namespace: 'se', description: '', triggers: ['ai'], showInTracker: true,
            variables: { v: flagDef() },
        };
        const data = exportPreset('p1');
        expect(data.variables.v.flagMode).toBe(true);
        expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    });

    it('importPresetDetailed keeps flagMode on the newly created variable', () => {
        const data = { name: 'Imported', variables: { v: flagDef() } };
        const result = importPresetDetailed(data);
        const imported = Object.values(getSettings().presets[result.presetId].variables)[0];
        expect(imported.flagMode).toBe(true);
        expect(imported.type).toBe('boolean');
    });
});
