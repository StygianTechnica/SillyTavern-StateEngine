// @vitest-environment jsdom
//
// Calculated-datetime extension (requirements spec 1.31), Phase 2: the manager
// modal's inline variable editor for fixedIncrement/tickUnit/deltaSource/
// accumulate on a datetime variable. Phase 1 (engine/schema/API) is covered by
// tests/calculated-datetime.test.js; this file covers only the UI added on top
// of it - the underlying engine behavior is not re-tested here.

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

    it('offers fixedIncrement/tickUnit/accumulate/deltaSource, all inert by default', () => {
        const el = dom(editor());
        expect(el.querySelector('[data-field="fixedIncrement"]').checked).toBe(false);
        expect(el.querySelector('[data-field="tickUnit"]').value).toBe('1 day');
        expect(el.querySelector('[data-field="accumulate"]').checked).toBe(false);
        expect(el.querySelector('[data-field="deltaSource"]').value).toBe('');
    });

    it('reflects an existing configured definition', () => {
        const el = dom(editor({ fixedIncrement: true, tickUnit: '1h', accumulate: true, deltaSource: 'se__jump' }, [
            { name: 'se__jump', label: '', type: 'string' },
        ]));
        expect(el.querySelector('[data-field="fixedIncrement"]').checked).toBe(true);
        expect(el.querySelector('[data-field="tickUnit"]').value).toBe('1h');
        expect(el.querySelector('[data-field="accumulate"]').checked).toBe(true);
        expect(el.querySelector('[data-field="deltaSource"]').value).toBe('se__jump');
    });

    it('the tick-amount/accumulate sub-section starts hidden unless fixedIncrement is already on', () => {
        expect(dom(editor()).querySelector('.se-manager-datetime-tick-settings').style.display).toBe('none');
        expect(dom(editor({ fixedIncrement: true })).querySelector('.se-manager-datetime-tick-settings').style.display).toBe('block');
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

    it('no other type offers any of the four fields', () => {
        for (const type of ['number', 'string', 'boolean', 'enum', 'array', 'calculated', 'image', 'imageList', 'imageMap']) {
            const el = dom(editor({ type }));
            for (const field of ['fixedIncrement', 'tickUnit', 'accumulate', 'deltaSource']) {
                expect(el.querySelector(`[data-field="${field}"]`), `${type}.${field}`).toBe(null);
            }
        }
    });
});

describe('normalizeCollectedValues', () => {
    it('coerces fixedIncrement and accumulate to real booleans', () => {
        expect(normalizeCollectedValues({ type: 'datetime', fixedIncrement: true }).fixedIncrement).toBe(true);
        expect(normalizeCollectedValues({ type: 'datetime', fixedIncrement: '' }).fixedIncrement).toBe(false);
        expect(normalizeCollectedValues({ type: 'datetime', accumulate: true }).accumulate).toBe(true);
        expect(normalizeCollectedValues({ type: 'datetime', accumulate: '' }).accumulate).toBe(false);
    });

    it('trims tickUnit', () => {
        expect(normalizeCollectedValues({ type: 'datetime', tickUnit: '  1mo  ' }).tickUnit).toBe('1mo');
    });

    it('leaves fields out entirely when not present (inert for other types)', () => {
        const out = normalizeCollectedValues({ type: 'string' });
        expect('fixedIncrement' in out).toBe(false);
        expect('tickUnit' in out).toBe(false);
        expect('accumulate' in out).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe('the manager modal: saving the calculated-datetime fields', () => {
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

    beforeEach(() => {
        context.chatId = 'chat-1';
        presetId = 'p1';
        getSettings().presets[presetId] = { id: presetId, name: 'Alpha', namespace: 'se', description: '', triggers: ['ai'], showInTracker: false, variables: {} };
        addPresetToChat('chat-1', presetId);
        setManagerApi(api());
        buildManagerModal();
        $('.se-manager-tab-btn[data-tab="variables"]').trigger('click');
    });

    it('saves all four fields on a new datetime variable', () => {
        addVar('jump', { name: 'se__jump', type: 'string', behaviors: { prompted: true, increment: false } });

        $('#se-manager-new-variable').trigger('click');
        editor().find('[data-field="name"]').val('clock');
        editor().find('[data-field="type"]').val('datetime').trigger('change');
        editor().find('[data-field="fixedIncrement"]').prop('checked', true).trigger('change');
        editor().find('[data-field="tickUnit"]').val('1h');
        editor().find('[data-field="accumulate"]').prop('checked', true);
        editor().find('[data-field="deltaSource"]').val('se__jump');
        editor().find('.se-manager-save-variable-inline').trigger('click');

        expect(stored('se__clock')).toMatchObject({ fixedIncrement: true, tickUnit: '1h', accumulate: true, deltaSource: 'se__jump' });
        expect(globalThis.alert).not.toHaveBeenCalled();
    });

    it('leaving everything untouched stores the inert defaults', () => {
        $('#se-manager-new-variable').trigger('click');
        editor().find('[data-field="name"]').val('clock');
        editor().find('[data-field="type"]').val('datetime').trigger('change');
        editor().find('.se-manager-save-variable-inline').trigger('click');

        expect(stored('se__clock')).toMatchObject({ fixedIncrement: false, tickUnit: '1 day', accumulate: false, deltaSource: '' });
    });

    it('checking fixedIncrement reveals the tick-amount/accumulate fields live', () => {
        $('#se-manager-new-variable').trigger('click');
        editor().find('[data-field="type"]').val('datetime').trigger('change');
        expect(editor().find('.se-manager-datetime-tick-settings').css('display')).toBe('none');

        editor().find('[data-field="fixedIncrement"]').prop('checked', true).trigger('change');
        expect(editor().find('.se-manager-datetime-tick-settings').css('display')).toBe('block');
    });

    it('refuses to save an invalid tickUnit and writes nothing', () => {
        $('#se-manager-new-variable').trigger('click');
        editor().find('[data-field="name"]').val('clock');
        editor().find('[data-field="type"]').val('datetime').trigger('change');
        editor().find('[data-field="fixedIncrement"]').prop('checked', true).trigger('change');
        editor().find('[data-field="tickUnit"]').val('banana');
        editor().find('.se-manager-save-variable-inline').trigger('click');

        expect(globalThis.alert).toHaveBeenLastCalledWith(expect.stringContaining('is not a valid duration'));
        expect(stored('se__clock')).toBeUndefined();
    });

    // A nonexistent or wrong-type deltaSource can never be *selected* live -
    // the dropdown only ever offers existing String variables (otherVars,
    // filtered), so there is no <option> to .val() it onto. The only way
    // either bad state reaches the save handler is a value ALREADY stored
    // that way (e.g. the source variable was deleted or retyped after being
    // chosen) - rendered as the flagged fallback <option> and left selected,
    // exactly as a real user who never touched the dropdown would leave it.
    const rerenderVariablesTab = () => {
        $('.se-manager-tab-btn[data-tab="presets"]').trigger('click');
        buildManagerModal();
        $('.se-manager-tab-btn[data-tab="variables"]').trigger('click');
    };

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
        expect(editor().find('[data-field="deltaSource"]').val()).toBe('se__hp'); // flagged fallback (bug fix: was blank before)
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

    it('editing an existing configured datetime variable shows its stored values and can update them', () => {
        addVar('jump', { name: 'se__jump', type: 'string' });
        addVar('clock', { name: 'se__clock', type: 'datetime', fixedIncrement: true, tickUnit: '1d', accumulate: true, deltaSource: 'se__jump' });
        rerenderVariablesTab();

        $('.se-manager-edit-variable[data-var-id="clock"]').trigger('click');
        expect(editor().find('[data-field="tickUnit"]').val()).toBe('1d');
        expect(editor().find('[data-field="deltaSource"]').val()).toBe('se__jump');

        editor().find('[data-field="tickUnit"]').val('2d');
        editor().find('[data-field="accumulate"]').prop('checked', false);
        editor().find('.se-manager-save-variable-inline').trigger('click');

        expect(stored('se__clock')).toMatchObject({ tickUnit: '2d', accumulate: false, fixedIncrement: true, deltaSource: 'se__jump' });
    });
});
