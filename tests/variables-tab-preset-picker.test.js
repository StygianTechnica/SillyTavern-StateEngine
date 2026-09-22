// @vitest-environment jsdom
//
// The Variables tab's preset dropdown (manager modal) had no ordering at all
// (raw Object.keys() = creation order) and no way to find a preset once there
// were more than a handful. Two additions: an alphabetic (case-insensitive)
// sort by name, and a search box that filters the dropdown's own <option>
// list in place.

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
const selector = () => document.getElementById('se-manager-preset-selector');
const optionNames = () => [...selector().options].filter((o) => o.value !== '').map((o) => o.textContent);
const visibleOptionNames = () => [...selector().options].filter((o) => o.value !== '' && o.style.display !== 'none').map((o) => o.textContent);
const search = (text) => {
    const $input = $('#se-manager-preset-search');
    $input.val(text).trigger('input');
};

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

describe('preset dropdown ordering', () => {
    it('lists presets alphabetically by name, case-insensitively, regardless of creation order', () => {
        makePreset('p1', 'zebra');
        makePreset('p2', 'Apple');
        makePreset('p3', 'banana');
        buildManagerModal();
        $('.se-manager-tab-btn[data-tab="variables"]').trigger('click');

        expect(optionNames()).toEqual(['Apple', 'banana', 'zebra']);
    });

    it('re-sorts correctly when "Show active only" narrows the list', () => {
        makePreset('p1', 'zebra');
        const active = makePreset('p2', 'Apple');
        makePreset('p3', 'banana');
        addPresetToChat('chat-1', active);
        buildManagerModal();
        $('.se-manager-tab-btn[data-tab="variables"]').trigger('click');
        $('#se-manager-filter-active').prop('checked', true).trigger('change');

        expect(optionNames()).toEqual(['Apple ✓']); // active indicator, existing behavior
    });

    it('the placeholder option always leads, unaffected by sorting', () => {
        makePreset('p1', 'zebra');
        buildManagerModal();
        $('.se-manager-tab-btn[data-tab="variables"]').trigger('click');

        expect(selector().options[0].value).toBe('');
        expect(selector().options[0].textContent).toContain('Select preset');
    });
});

describe('preset dropdown search box', () => {
    beforeEach(() => {
        makePreset('p1', 'Alpha Team');
        makePreset('p2', 'Beta Squad');
        makePreset('p3', 'Gamma Ray');
        buildManagerModal();
        $('.se-manager-tab-btn[data-tab="variables"]').trigger('click');
    });

    it('shows every preset when the search box is empty', () => {
        expect(visibleOptionNames()).toEqual(['Alpha Team', 'Beta Squad', 'Gamma Ray']);
    });

    it('filters to presets whose name contains the (case-insensitive) search text', () => {
        search('beta');
        expect(visibleOptionNames()).toEqual(['Beta Squad']);
    });

    it('matches a substring anywhere in the name, not just the start', () => {
        search('team');
        expect(visibleOptionNames()).toEqual(['Alpha Team']);
    });

    it('matching nothing hides every real option but keeps the placeholder selectable', () => {
        search('nonexistent-preset-xyz');
        expect(visibleOptionNames()).toEqual([]);
        expect(selector().options[0].style.display).not.toBe('none');
    });

    it('clearing the search box restores every option', () => {
        search('beta');
        search('');
        expect(visibleOptionNames()).toEqual(['Alpha Team', 'Beta Squad', 'Gamma Ray']);
    });

    it('never touches the underlying <select> value - filtering is display-only', () => {
        selector().value = 'p2';
        search('alpha');
        expect(selector().value).toBe('p2');
    });
});
