// @vitest-environment jsdom
//
// Boolean "flag mode" (requirements spec 1.28) in the manager modal editor and the
// tracker: the "Flag mode (write-once)" checkbox, and the tracker's edit pencil /
// reset button as the one manual way to reset a flag to false.
//
// The tracker assertions need the REAL chat-state.js (its write-path gate is what a
// manual edit is actually bypassing) - re-mocked to its own real implementation, the
// same pattern tests/tracker-refresh.test.js and tests/api/boolean-flags-api.test.js
// already use for this reason.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jQuery from 'jquery';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { addPresetToChat, getPresetsForChat, removePresetFromChat } from '../src/core/preset-manager.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { setManagerApi, buildManagerModal } from '../src/ui/manager-modal/manager-modal.js';
import { buildInlineVariableEditor } from '../src/ui/manager-modal/ui-templates.js';
import { canIncrement, normalizeCollectedValues, describeVariable } from '../src/ui/manager-modal/variable-ui-schema.js';
import { describeConstraint } from '../src/ui/formatting-utils.js';
import { setVar, getVar } from '../src/core/chat-state.js';
import { renderTrackerPanel } from '../src/ui/tracker-panel-ui.js';

vi.mock('../src/core/chat-state.js', async () => vi.importActual('../src/core/chat-state.js'));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/manager-modal-ui.js', () => ({ renderVarTable: vi.fn() }));

const $ = jQuery;

beforeEach(() => {
    settings.reset();
    document.body.innerHTML = '';
    globalThis.$ = globalThis.jQuery = jQuery;
    jQuery.fx.off = true;
});

afterEach(() => { document.body.innerHTML = ''; });

// ---------------------------------------------------------------------------
describe('the editor template', () => {
    const editor = (over = {}) => {
        const d = { ...blankDefinition(), name: 'se__flag', type: 'boolean', ...over };
        return buildInlineVariableEditor(d, canIncrement(d.type), []);
    };
    const dom = (html) => { const el = document.createElement('div'); el.innerHTML = html; return el; };

    it('a boolean editor offers "Flag mode (write-once)", unchecked by default', () => {
        const el = dom(editor());
        const checkbox = el.querySelector('[data-field="flagMode"]');
        expect(checkbox).not.toBe(null);
        expect(checkbox.type).toBe('checkbox');
        expect(checkbox.checked).toBe(false);
        expect(el.textContent).toContain('Flag mode (write-once)');
        expect(el.textContent).toMatch(/cannot be set back to false except manually/);
    });

    it('reflects an existing flagMode:true definition as checked', () => {
        const el = dom(editor({ flagMode: true }));
        expect(el.querySelector('[data-field="flagMode"]').checked).toBe(true);
    });

    it('no other type offers it', () => {
        for (const type of ['number', 'string', 'enum', 'array', 'datetime', 'calculated', 'image', 'imageList', 'imageMap']) {
            const el = dom(editor({ type }));
            expect(el.querySelector('[data-field="flagMode"]'), type).toBe(null);
        }
    });

    it('describeVariable explains a flag; canIncrement still allows increment on a boolean', () => {
        expect(describeVariable({ ...blankDefinition(), name: 'flag', type: 'boolean', flagMode: true })).toMatch(/write-once flag/);
        expect(describeVariable({ ...blankDefinition(), name: 'flag', type: 'boolean', flagMode: false })).not.toMatch(/write-once/);
        expect(canIncrement('boolean')).toBe(true);
    });

    it('describeConstraint (the prompt-facing wording) marks a flag one-way', () => {
        expect(describeConstraint({ type: 'boolean', flagMode: true })).toMatch(/one-way flag/);
        expect(describeConstraint({ type: 'boolean', flagMode: false })).toBe('true or false');
    });
});

describe('normalizeCollectedValues', () => {
    it('coerces flagMode to a real boolean, and leaves it out when not present', () => {
        expect(normalizeCollectedValues({ type: 'boolean', flagMode: true }).flagMode).toBe(true);
        expect(normalizeCollectedValues({ type: 'boolean', flagMode: '' }).flagMode).toBe(false);
        expect('flagMode' in normalizeCollectedValues({ type: 'boolean' })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe('the manager modal: saving the checkbox', () => {
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

    beforeEach(() => {
        context.chatId = 'chat-1';
        presetId = 'p1';
        getSettings().presets[presetId] = { id: presetId, name: 'Alpha', namespace: 'se', description: '', triggers: ['ai'], showInTracker: false, variables: {} };
        addPresetToChat('chat-1', presetId);
        setManagerApi(api());
        buildManagerModal();
        $('.se-manager-tab-btn[data-tab="variables"]').trigger('click');
    });

    it('checking Flag mode and saving stores flagMode: true, forced to start false', () => {
        $('#se-manager-new-variable').trigger('click');
        editor().find('[data-field="name"]').val('ready');
        editor().find('[data-field="type"]').val('boolean').trigger('change');
        editor().find('[data-field="flagMode"]').prop('checked', true).trigger('change');
        editor().find('.se-manager-save-variable-inline').trigger('click');

        expect(stored('se__ready')).toMatchObject({ type: 'boolean', flagMode: true });
    });

    it('leaving it unchecked stores an ordinary boolean (flagMode: false)', () => {
        $('#se-manager-new-variable').trigger('click');
        editor().find('[data-field="name"]').val('flag');
        editor().find('[data-field="type"]').val('boolean').trigger('change');
        editor().find('.se-manager-save-variable-inline').trigger('click');

        expect(stored('se__flag')).toMatchObject({ type: 'boolean', flagMode: false });
    });
});

// ---------------------------------------------------------------------------
describe('the tracker: the manual reset path', () => {
    let presetId;

    const add = (name, extra = {}) => {
        const def = { ...blankDefinition(), id: name, name: `se__${name}`, label: name, type: 'boolean', flagMode: true, showInTracker: true, ...extra };
        getSettings().presets[presetId].variables[name] = def;
        return def;
    };
    const body = () => document.getElementById('se_tracker_body');
    const rowFor = (label) => [...body().querySelectorAll('.se-tracker-row')].find((r) => r.querySelector('.se-tracker-label').textContent.includes(label));

    beforeEach(() => {
        context.chatId = 'chat-1';
        presetId = 'p1';
        getSettings().presets[presetId] = { id: presetId, name: 'Alpha', namespace: 'se', description: '', triggers: ['ai'], showInTracker: true, variables: {} };
        addPresetToChat('chat-1', presetId);
        document.body.innerHTML = '<div id="se_tracker_body"></div>';
    });

    it('the edit pencil is offered even when the flag is prompted AND incremented (its own manual-write exception)', () => {
        add('ready', { behaviors: { prompted: true, increment: true }, increment: { ...blankDefinition().increment, triggers: 'ai' } });
        renderTrackerPanel();
        expect(rowFor('ready').querySelector('.se-tracker-edit-btn')).not.toBe(null);
    });

    it('an ordinary prompted boolean still has NO edit pencil (the exception is flag-mode only)', () => {
        add('mood', { flagMode: false, behaviors: { prompted: true, increment: false } });
        renderTrackerPanel();
        expect(rowFor('mood').querySelector('.se-tracker-edit-btn')).toBe(null);
    });

    it('clicking the pencil, unchecking the box and committing resets a true flag to false', () => {
        const d = add('ready');
        setVar('chat-1', d.name, true, d);
        renderTrackerPanel();

        rowFor('ready').querySelector('.se-tracker-edit-btn').click();
        const checkbox = rowFor('ready').querySelector('input[type="checkbox"].se-tracker-edit-checkbox');
        expect(checkbox).not.toBe(null);
        expect(checkbox.checked).toBe(true);
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));

        expect(getVar('chat-1', d.name).value).toBe(false);
        renderTrackerPanel();
        expect(rowFor('ready').querySelector('.se-tracker-value').textContent).toBe('false');
    });

    it('the Reset button (shown because increment is on) also resets a true flag to false', () => {
        const d = add('ready', { behaviors: { increment: true, prompted: false }, increment: { ...blankDefinition().increment, triggers: 'ai' } });
        setVar('chat-1', d.name, true, d);
        renderTrackerPanel();

        rowFor('ready').querySelector('.se-tracker-reset-btn').click();
        expect(getVar('chat-1', d.name).value).toBe(false);
    });

    it('an automatic write elsewhere (not through the tracker) still cannot reset it - the manual bypass is truly only in these two UI actions', () => {
        const d = add('ready');
        setVar('chat-1', d.name, true, d);
        setVar('chat-1', d.name, false, d); // no { manual: true } - e.g. what a prompted/engine write looks like
        expect(getVar('chat-1', d.name).value).toBe(true);
        renderTrackerPanel();
        expect(rowFor('ready').querySelector('.se-tracker-value').textContent).toBe('true');
    });

    it('the tracker displays a flag exactly like any boolean (true/false text, no special badge)', () => {
        const d = add('ready');
        setVar('chat-1', d.name, false, d);
        renderTrackerPanel();
        const row = rowFor('ready');
        expect(row.querySelector('.se-tracker-value').textContent).toBe('false');
        expect(row.querySelector('.se-tracker-calculated-badge')).toBe(null);
        setVar('chat-1', d.name, true, d);
        renderTrackerPanel();
        expect(rowFor('ready').querySelector('.se-tracker-value').textContent).toBe('true');
    });
});
