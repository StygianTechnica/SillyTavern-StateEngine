// @vitest-environment jsdom
//
// The manager modal must always describe the chat that is open NOW. It used to
// redraw only the Variable Management tab when re-opened, so after creating or
// switching to another chat the Presets tab still showed the previous chat's
// active presets - and its Activate/Deactivate buttons acted on that old chat.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jQuery from 'jquery';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { addPresetToChat, getPresetsForChat, removePresetFromChat } from '../src/core/preset-manager.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { setManagerApi, buildManagerModal, showManagerModal, hideManagerModal, refreshVariableManagementTabIfOpen } from '../src/ui/manager-modal/manager-modal.js';

vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/tracker-panel-ui.js', () => ({ renderTrackerPanel: vi.fn() }));
vi.mock('../src/ui/manager-modal-ui.js', () => ({ renderVarTable: vi.fn() }));

let presetA; let presetB;

const api = () => ({
    getSettings,
    persistSettings: vi.fn(),
    getCurrentChatId: () => context.chatId,
    getPresetsForChat,
    addPresetToChat,
    removePresetFromChat,
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
const activeNames = () => [...document.querySelectorAll('#se-manager-presets-tab .se-manager-toggle-active')]
    .filter((b) => b.querySelector('.fa-toggle-on')).map((b) => b.closest('.se-manager-preset-accordion-item').querySelector('.se-manager-preset-name').textContent.trim().split(/\s+/)[0]);
const toggleFor = (name) => [...document.querySelectorAll('#se-manager-presets-tab .se-manager-toggle-active')]
    .find((b) => b.closest('.se-manager-preset-accordion-item').querySelector('.se-manager-preset-name').textContent.includes(name));

beforeEach(() => {
    settings.reset();
    document.body.innerHTML = '';
    globalThis.$ = globalThis.jQuery = jQuery;
    jQuery.fx.off = true; // fades finish immediately
    presetA = makePreset('pa', 'Alpha');
    presetB = makePreset('pb', 'Beta');
    // Chat A has Alpha active; chat B is a brand-new chat with nothing.
    context.chatId = 'chat-A';
    addPresetToChat('chat-A', presetA);
    setManagerApi(api());
});
afterEach(() => { document.body.innerHTML = ''; });

describe('the manager shows the chat that is open now', () => {
    it('setup: opens on chat A with Alpha active', () => {
        buildManagerModal();
        expect(activeNames()).toEqual(['Alpha']);
    });

    it('a NEW chat, manager re-opened: no presets appear active (they are not carried over)', () => {
        buildManagerModal();
        hideManagerModal();
        context.chatId = 'chat-NEW';            // the user creates a new chat
        showManagerModal();                      // ...and opens the manager again
        expect(getPresetsForChat('chat-NEW')).toEqual([]);
        expect(activeNames()).toEqual([]);       // used to still say ['Alpha']
    });

    it('switching back shows the first chat\'s presets again', () => {
        buildManagerModal();
        context.chatId = 'chat-NEW';
        showManagerModal();
        context.chatId = 'chat-A';
        showManagerModal();
        expect(activeNames()).toEqual(['Alpha']);
    });

    it('the toggle buttons carry the chat they were drawn for', () => {
        buildManagerModal();
        context.chatId = 'chat-NEW';
        showManagerModal();
        expect(toggleFor('Alpha').getAttribute('data-chat-id')).toBe('chat-NEW');
    });

    it('a toggle acts on the chat open NOW even if the button was drawn under another chat', () => {
        buildManagerModal();                     // drawn under chat A
        context.chatId = 'chat-NEW';             // chat changes with no redraw in between
        jQuery(toggleFor('Beta')).trigger('click');
        expect(getPresetsForChat('chat-NEW')).toEqual([presetB]);
        expect(getPresetsForChat('chat-A')).toEqual([presetA]);   // chat A untouched
    });

    it('deactivating in the new chat leaves the other chat alone', () => {
        buildManagerModal();
        context.chatId = 'chat-NEW';
        addPresetToChat('chat-NEW', presetA);
        showManagerModal();
        expect(activeNames()).toEqual(['Alpha']);
        jQuery(toggleFor('Alpha')).trigger('click');
        expect(getPresetsForChat('chat-NEW')).toEqual([]);
        expect(getPresetsForChat('chat-A')).toEqual([presetA]);
    });
});

describe('an open manager follows chat changes', () => {
    it('redraws when the chat changes while it is open', () => {
        buildManagerModal();
        expect(activeNames()).toEqual(['Alpha']);
        context.chatId = 'chat-NEW';
        refreshVariableManagementTabIfOpen();     // what every chat change / update calls
        expect(activeNames()).toEqual([]);
    });

    it('does NOT redraw the Variables tab for an update in the same chat (an open editor survives)', () => {
        buildManagerModal();
        const marker = document.createElement('div');
        marker.id = 'editor-in-progress';
        document.querySelector('#se-manager-variables-tab').appendChild(marker);
        refreshVariableManagementTabIfOpen();
        refreshVariableManagementTabIfOpen();
        expect(document.getElementById('editor-in-progress')).not.toBeNull();
    });

    it('does nothing while the manager is closed', () => {
        buildManagerModal();
        hideManagerModal();
        context.chatId = 'chat-NEW';
        refreshVariableManagementTabIfOpen();
        expect(activeNames()).toEqual(['Alpha']);   // redrawn on the next open, not before
        showManagerModal();
        expect(activeNames()).toEqual([]);
    });

    it('keeps the preset selected in the Variables tab across a redraw', () => {
        buildManagerModal();
        const select = document.querySelector('#se-manager-preset-selector');
        select.value = presetB;
        context.chatId = 'chat-NEW';
        showManagerModal();
        expect(document.querySelector('#se-manager-preset-selector').value).toBe(presetB);
    });
});
