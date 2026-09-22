// @vitest-environment jsdom
//
// The Variables tab's preset picker is a searchable dropdown (a combobox),
// not a plain <select> - a native select can only jump to an option by its
// first letter, not be typed into to narrow the list. Alphabetic ordering
// (was raw Object.keys() = creation order) is unchanged from the plain-select
// version; this file replaces the select-specific tests with combobox ones.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jQuery from 'jquery';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { addPresetToChat, getPresetsForChat, removePresetFromChat } from '../src/core/preset-manager.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { setManagerApi, buildManagerModal } from '../src/ui/manager-modal/manager-modal.js';

vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/manager-modal-ui.js', () => ({ renderVarTable: vi.fn() }));

const $ = jQuery;

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

const makePreset = (id, name) => {
    getSettings().presets[id] = { id, name, namespace: 'se', description: '', triggers: ['ai'], showInTracker: false, variables: {} };
    return id;
};
const input = () => document.getElementById('se-manager-preset-combobox-input');
const list = () => document.getElementById('se-manager-preset-combobox-list');
const rows = () => [...list().querySelectorAll('.se-manager-preset-combobox-row')];
const rowNames = () => rows().map((r) => r.textContent);
const visibleRowNames = () => rows().filter((r) => r.style.display !== 'none').map((r) => r.textContent);
const rowFor = (presetId) => list().querySelector(`.se-manager-preset-combobox-row[data-preset-id="${presetId}"]`);
const type = (text) => { $(input()).val(text).trigger('input'); };
const pick = (presetId) => { $(rowFor(presetId)).trigger('click'); };

beforeEach(() => {
    settings.reset();
    document.body.innerHTML = '';
    globalThis.$ = globalThis.jQuery = jQuery;
    jQuery.fx.off = true;
    context.chatId = 'chat-1';
    setManagerApi(api());
    // window.managerShowActiveOnly (ui-render.js/ui-events.js) is a plain
    // global with no reset of its own anywhere in the codebase - it leaks
    // across tests within the same process otherwise (caught by this file's
    // own tests toggling it, not assumed).
    window.managerShowActiveOnly = false;
});

afterEach(() => { document.body.innerHTML = ''; });

describe('preset combobox: ordering and rendering', () => {
    it('lists presets alphabetically by name, case-insensitively, regardless of creation order', () => {
        makePreset('p1', 'zebra');
        makePreset('p2', 'Apple');
        makePreset('p3', 'banana');
        buildManagerModal();

        expect(rowNames()).toEqual(['Apple', 'banana', 'zebra']);
    });

    it('re-sorts correctly when "Show active only" narrows the list', () => {
        makePreset('p1', 'zebra');
        const active = makePreset('p2', 'Apple');
        makePreset('p3', 'banana');
        addPresetToChat('chat-1', active);
        buildManagerModal();
        $('#se-manager-filter-active').prop('checked', true).trigger('change');

        expect(rowNames()).toEqual(['Apple ✓']);
    });

    it('the input starts showing the selected preset\'s name, not its id', () => {
        const active = makePreset('p1', 'zebra');
        addPresetToChat('chat-1', active);
        buildManagerModal();

        expect(input().value).toBe('zebra');
    });

    it('the row list starts hidden until the input is opened', () => {
        makePreset('p1', 'zebra');
        buildManagerModal();

        expect(list().style.display).toBe('none');
    });
});

describe('preset combobox: opening and live filtering', () => {
    beforeEach(() => {
        makePreset('p1', 'Alpha Team');
        makePreset('p2', 'Beta Squad');
        makePreset('p3', 'Gamma Ray');
        buildManagerModal();
    });

    it('focusing the input opens the list, showing every preset', () => {
        $(input()).trigger('focus');
        expect(list().style.display).not.toBe('none');
        expect(visibleRowNames()).toEqual(['Alpha Team', 'Beta Squad', 'Gamma Ray']);
    });

    it('typing filters to presets whose name contains the (case-insensitive) text, and keeps the list open', () => {
        type('beta');
        expect(list().style.display).not.toBe('none');
        expect(visibleRowNames()).toEqual(['Beta Squad']);
    });

    it('matches a substring anywhere in the name, not just the start', () => {
        type('team');
        expect(visibleRowNames()).toEqual(['Alpha Team']);
    });

    it('clearing the text restores every row', () => {
        type('beta');
        type('');
        expect(visibleRowNames()).toEqual(['Alpha Team', 'Beta Squad', 'Gamma Ray']);
    });

    it('matching nothing leaves every row hidden without erroring', () => {
        type('nonexistent-preset-xyz');
        expect(visibleRowNames()).toEqual([]);
    });
});

describe('preset combobox: picking a row', () => {
    let a; let b;
    beforeEach(() => {
        a = makePreset('p1', 'Alpha');
        b = makePreset('p2', 'Beta');
        addPresetToChat('chat-1', a);
        buildManagerModal();
    });

    it('clicking a row switches the selected preset and updates the input text', () => {
        pick(b);
        expect(input().value).toBe('Beta');
    });

    it('the underlying preset actually changes (drives the variable list, not just cosmetic text)', () => {
        getSettings().presets[b].variables.v1 = { ...blankDefinition(), id: 'v1', name: 'se__thing', label: 'Thing' };
        pick(b);
        expect(document.querySelector('#se-manager-variable-list').textContent).toContain('Thing');
    });

    it('Enter with no row highlighted picks the first VISIBLE match', () => {
        type('Beta');
        $(input()).trigger($.Event('keydown', { key: 'Enter' }));
        expect(input().value).toBe('Beta');
    });

    it('ArrowDown then Enter picks the highlighted row', () => {
        $(input()).trigger('focus'); // Alpha, Beta both visible, alphabetical
        $(input()).trigger($.Event('keydown', { key: 'ArrowDown' })); // highlight Alpha
        $(input()).trigger($.Event('keydown', { key: 'ArrowDown' })); // highlight Beta
        $(input()).trigger($.Event('keydown', { key: 'Enter' }));
        expect(input().value).toBe('Beta');
    });
});

describe('preset combobox: closing without picking reverts the text', () => {
    let a; let b;
    beforeEach(() => {
        a = makePreset('p1', 'Alpha');
        b = makePreset('p2', 'Beta');
        addPresetToChat('chat-1', a);
        buildManagerModal();
        void b;
    });

    it('Escape closes the list and restores the actually-selected preset\'s name', () => {
        type('something typed but never picked');
        $(input()).trigger($.Event('keydown', { key: 'Escape' }));
        expect(list().style.display).toBe('none');
        expect(input().value).toBe('Alpha');
    });

    it('clicking outside the combobox does the same', () => {
        type('gibberish');
        $(document).trigger($.Event('mousedown', { target: document.body }));
        expect(list().style.display).toBe('none');
        expect(input().value).toBe('Alpha');
    });

    it('clicking INSIDE the combobox (e.g. a row) does not trigger the outside-close path', () => {
        type('Beta');
        // The mousedown that precedes a real row click - must not itself
        // close the list before the click handler gets to read the row.
        $(document).trigger($.Event('mousedown', { target: rowFor(b) }));
        expect(list().style.display).not.toBe('none');
    });
});
