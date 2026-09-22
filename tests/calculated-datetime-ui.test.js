// @vitest-environment jsdom
//
// Calculated-datetime extension (requirements spec 1.31, revised 2026-09-22):
// the manager modal's inline variable editor for deltaSource on a datetime
// variable, and its cooperation with the ORDINARY "Incremented Behavior"
// section every other type already has (a datetime's own automatic
// advancement is that same mechanism now - an earlier separate fixedIncrement/
// tickUnit/accumulate section was removed for being redundant with it and
// positioned in a way that read as a second, unrelated toggle). Phase 1
// (engine/schema/API) is covered by tests/calculated-datetime.test.js; this
// file covers only the UI - the underlying engine behavior is not re-tested
// here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jQuery from 'jquery';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { addPresetToChat, getPresetsForChat, removePresetFromChat } from '../src/core/preset-manager.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { setManagerApi, buildManagerModal } from '../src/ui/manager-modal/manager-modal.js';
import { buildInlineVariableEditor } from '../src/ui/manager-modal/ui-templates.js';
import { canIncrement, normalizeCollectedValues } from '../src/ui/manager-modal/variable-ui-schema.js';

vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/manager-modal-ui.js', () => ({ renderVarTable: vi.fn() }));

const $ = jQuery;

beforeEach(() => {
    settings.reset();
    document.body.innerHTML = '';
    globalThis.$ = globalThis.jQuery = jQuery;
    jQuery.fx.off = true;
    globalThis.alert = vi.fn();
    window.alert = globalThis.alert;
});

afterEach(() => { document.body.innerHTML = ''; });

// ---------------------------------------------------------------------------
describe('the editor template', () => {
    const editor = (over = {}, otherVars = []) => {
        const d = { ...blankDefinition(), name: 'se__clock', type: 'datetime', ...over };
        return buildInlineVariableEditor(d, canIncrement(d.type), otherVars);
    };
    const dom = (html) => { const el = document.createElement('div'); el.innerHTML = html; return el; };

    it('offers only deltaSource near the calendar picker, inert by default', () => {
        const el = dom(editor());
        expect(el.querySelector('[data-field="deltaSource"]').value).toBe('');
        expect(el.querySelector('[data-field="fixedIncrement"]')).toBe(null);
        expect(el.querySelector('[data-field="tickUnit"]')).toBe(null);
        expect(el.querySelector('[data-field="accumulate"]')).toBe(null);
    });

    it('reflects an existing deltaSource', () => {
        const el = dom(editor({ deltaSource: 'se__jump' }, [{ name: 'se__jump', label: '', type: 'string' }]));
        expect(el.querySelector('[data-field="deltaSource"]').value).toBe('se__jump');
    });

    it('the deltaSource dropdown offers only type: string variables from otherVars', () => {
        const el = dom(editor({}, [
            { name: 'se__jump', label: '', type: 'string' },
            { name: 'se__hp', label: 'HP', type: 'number' },
            { name: 'se__mood', label: '', type: 'string' },
        ]));
        const options = [...el.querySelector('[data-field="deltaSource"]').options].map((o) => o.value);
        expect(options).toEqual(['', 'se__jump', 'se__mood']);
    });

    it('a stored deltaSource no longer present among otherVars still appears, flagged', () => {
        const el = dom(editor({ deltaSource: 'se__gone' }, []));
        const opt = el.querySelector('[data-field="deltaSource"] option[value="se__gone"]');
        expect(opt).not.toBe(null);
        expect(opt.selected).toBe(true);
        expect(opt.textContent).toContain('not a String variable in this preset');
    });

    it('no other type offers deltaSource', () => {
        for (const type of ['number', 'string', 'boolean', 'enum', 'array', 'calculated', 'image', 'imageList', 'imageMap']) {
            const el = dom(editor({ type }));
            expect(el.querySelector('[data-field="deltaSource"]'), type).toBe(null);
        }
    });

    it('the "Advance by" field (Incremented Behavior) is what ticks a datetime automatically, with an explanatory note about deltaSource', () => {
        const html = editor({ behaviors: { increment: true, prompted: false }, increment: { delta: '1d', triggers: 'ai' } });
        const el = dom(html);
        expect(el.querySelector('[data-field="increment.delta"]')).not.toBe(null);
        expect(html).toMatch(/Advance by/);
        expect(html).toMatch(/Narrative jump source.*skips this step's next automatic advance/s);
    });

    it('there is no longer a separate "automatic time flow" toggle floating above the calendar picker', () => {
        const html = editor();
        expect(html).not.toMatch(/Advance automatically on every message/);
        expect(html).not.toMatch(/Automatic time flow/);
    });
});

describe('normalizeCollectedValues', () => {
    it('no longer produces fixedIncrement/tickUnit/accumulate for any input', () => {
        const out = normalizeCollectedValues({ type: 'datetime', fixedIncrement: true, tickUnit: '1d', accumulate: true });
        expect('fixedIncrement' in out).toBe(false);
        expect('tickUnit' in out).toBe(false);
        expect('accumulate' in out).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe('the manager modal: saving a datetime\'s deltaSource and its automatic tick', () => {
    let presetId;
    const api = () => ({
        getSettings,
        persistSettings: vi.fn(),
        getCurrentChatId: () => context.chatId,
        getPresetsForChat, addPresetToChat, removePresetFromChat,
        createPreset: vi.fn(), renamePreset: vi.fn(), deletePreset: vi.fn(),
        setStatus: vi.fn(), renderVarTable: vi.fn(), renderTrackerPanel: vi.fn(),
        restoreDefaultPresets: vi.fn(), toggleDebugMode: vi.fn(), getDebugInfo: () => ({}),
        isReservedVariable: () => false, blankDefinition,
        isVariableNameTaken: () => false, generateUniqueVariableName: (n) => n,
        listCalendars: () => getSettings().calendars,
    });
    const stored = (name) => Object.values(getSettings().presets[presetId].variables).find((v) => v.name === name);
    const editor = () => $('.se-manager-variable-editor-inline').filter((_, el) => el.innerHTML.trim() !== '');
    const addVar = (id, def) => { getSettings().presets[presetId].variables[id] = { ...blankDefinition(), id, ...def }; };
    const rerenderVariablesTab = () => {
        $('.se-manager-tab-btn[data-tab="presets"]').trigger('click');
        buildManagerModal();
        $('.se-manager-tab-btn[data-tab="variables"]').trigger('click');
    };

    beforeEach(() => {
        context.chatId = 'chat-1';
        presetId = 'p1';
        getSettings().presets[presetId] = { id: presetId, name: 'Alpha', namespace: 'se', description: '', triggers: ['ai'], showInTracker: false, variables: {} };
        addPresetToChat('chat-1', presetId);
        setManagerApi(api());
        buildManagerModal();
        $('.se-manager-tab-btn[data-tab="variables"]').trigger('click');
    });

    it('saves deltaSource on a new datetime variable', () => {
        addVar('jump', { name: 'se__jump', type: 'string', behaviors: { prompted: true, increment: false } });

        $('#se-manager-new-variable').trigger('click');
        editor().find('[data-field="name"]').val('clock');
        editor().find('[data-field="type"]').val('datetime').trigger('change');
        editor().find('[data-field="deltaSource"]').val('se__jump');
        editor().find('.se-manager-save-variable-inline').trigger('click');

        expect(stored('se__clock')).toMatchObject({ deltaSource: 'se__jump' });
        expect(globalThis.alert).not.toHaveBeenCalled();
    });

    it('turning on "Incremented Behavior" for a datetime saves it through the SAME field every other type uses', () => {
        $('#se-manager-new-variable').trigger('click');
        editor().find('[data-field="name"]').val('clock');
        editor().find('[data-field="type"]').val('datetime').trigger('change');
        editor().find('#se-manager-increment-toggle').prop('checked', true).trigger('change');
        editor().find('[data-field="increment.delta"]').val('1h');
        editor().find('.se-manager-save-variable-inline').trigger('click');

        expect(stored('se__clock')).toMatchObject({ behaviors: { increment: true }, increment: { delta: '1h' } });
    });

    it('leaving everything untouched stores an inert deltaSource', () => {
        $('#se-manager-new-variable').trigger('click');
        editor().find('[data-field="name"]').val('clock');
        editor().find('[data-field="type"]').val('datetime').trigger('change');
        editor().find('.se-manager-save-variable-inline').trigger('click');

        expect(stored('se__clock')).toMatchObject({ deltaSource: '' });
        expect(stored('se__clock').behaviors).toMatchObject({ increment: false });
    });

    // A nonexistent or wrong-type deltaSource can never be *selected* live -
    // the dropdown only ever offers existing String variables (otherVars,
    // filtered), so there is no <option> to .val() it onto. The only way
    // either bad state reaches the save handler is a value ALREADY stored
    // that way (e.g. the source variable was deleted or retyped after being
    // chosen) - rendered as the flagged fallback <option> and left selected,
    // exactly as a real user who never touched the dropdown would leave it.
    it('refuses a deltaSource that does not exist in this preset', () => {
        addVar('clock', { name: 'se__clock', type: 'datetime', deltaSource: 'se__ghost' });
        rerenderVariablesTab();

        $('.se-manager-edit-variable[data-var-id="clock"]').trigger('click');
        expect(editor().find('[data-field="deltaSource"]').val()).toBe('se__ghost'); // the flagged fallback option, still selected
        editor().find('.se-manager-save-variable-inline').trigger('click');

        expect(globalThis.alert).toHaveBeenLastCalledWith(expect.stringContaining('does not exist in this preset'));
        expect(stored('se__clock').deltaSource).toBe('se__ghost'); // refused: nothing written, original value untouched
    });

    it('refuses a deltaSource that is not a String variable', () => {
        addVar('hp', { name: 'se__hp', type: 'number' });
        addVar('clock', { name: 'se__clock', type: 'datetime', deltaSource: 'se__hp' });
        rerenderVariablesTab();

        $('.se-manager-edit-variable[data-var-id="clock"]').trigger('click');
        expect(editor().find('[data-field="deltaSource"]').val()).toBe('se__hp'); // flagged fallback
        editor().find('.se-manager-save-variable-inline').trigger('click');

        expect(globalThis.alert).toHaveBeenLastCalledWith(expect.stringContaining('must be a String variable'));
        expect(stored('se__clock').deltaSource).toBe('se__hp'); // refused: nothing written, original value untouched
    });

    it('the deltaSource dropdown never offers the variable being edited itself', () => {
        addVar('clock', { name: 'se__clock', type: 'datetime' });
        rerenderVariablesTab();

        $('.se-manager-edit-variable[data-var-id="clock"]').trigger('click');
        const options = editor().find('[data-field="deltaSource"] option').map((_, o) => o.value).get();
        expect(options).not.toContain('se__clock');
    });

    it('editing an existing configured datetime variable shows both its deltaSource and its Incremented Behavior settings, and can update them', () => {
        addVar('jump', { name: 'se__jump', type: 'string' });
        addVar('clock', {
            name: 'se__clock', type: 'datetime', deltaSource: 'se__jump',
            behaviors: { increment: true, prompted: false }, increment: { delta: '1d', triggers: 'ai' },
        });
        rerenderVariablesTab();

        $('.se-manager-edit-variable[data-var-id="clock"]').trigger('click');
        expect(editor().find('[data-field="deltaSource"]').val()).toBe('se__jump');
        expect(editor().find('#se-manager-increment-toggle').is(':checked')).toBe(true);
        expect(editor().find('[data-field="increment.delta"]').val()).toBe('1d');

        editor().find('[data-field="increment.delta"]').val('2d');
        editor().find('.se-manager-save-variable-inline').trigger('click');

        expect(stored('se__clock')).toMatchObject({ deltaSource: 'se__jump', increment: { delta: '2d' } });
    });
});
