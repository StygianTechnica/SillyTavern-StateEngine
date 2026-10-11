// @vitest-environment jsdom
//
// Presets owned by another extension, in the manager modal:
// - isNamespaceActive(): an extension that claimed its namespace during
//   this page load is installed and running;
// - the manager warns before deactivating, deleting, or deleting a variable
//   of a preset whose extension is running - and only then, so a removed
//   extension's leftovers can be cleaned up without nagging;
// - the manager can now delete another extension's preset at all
//   (stateEngine.deletePreset() is owner-only, so the manager's `se` call
//   used to be refused).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jQuery from 'jquery';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { addPresetToChat, getPresetsForChat, createPreset as createPresetCore } from '../src/core/preset-manager.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { ensureInstanceId } from '../src/api/identity.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { getExtensionsStore, isNamespaceActive } from '../src/api/namespace-manager.js';
import { getVar } from '../src/core/chat-state.js';
import * as adapters from '../src/ui/manager-modal/manager-api.js';
import { setManagerApi, buildManagerModal } from '../src/ui/manager-modal/manager-modal.js';

vi.mock('../src/core/chat-state.js', async () => vi.importActual('../src/core/chat-state.js'));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/manager-modal-ui.js', () => ({ renderVarTable: vi.fn() }));
vi.mock('../src/ui/tracker-panel-ui.js', () => ({ renderTrackerPanel: vi.fn() }));
vi.mock('../src/ui/wand-ui.js', () => ({ getCurrentChatId: vi.fn(() => 'chat-1') }));
vi.mock('../src/core/debug-engine.js', () => ({ getDebugInfo: vi.fn(() => ({})) }));

const $ = jQuery;

// A preset left behind by an extension that is NOT running this session:
// its namespace record persisted from an earlier load, but nothing claimed it now.
function leftoverPreset(namespace, name) {
    getExtensionsStore()[namespace] = { id: `${namespace}-extension`, namespace, name: `${namespace}-extension`, registeredAt: 1 };
    const presetId = createPresetCore(name);
    getSettings().presets[presetId].namespace = namespace;
    return presetId;
}

// A preset of the running extension "arch" (namespace claimed this session).
function runningPreset(name, withVariable = false) {
    const created = stateEngine.createPreset('arch', ensureInstanceId(), { namespace: 'arch', name });
    if (withVariable) {
        stateEngine.createVariable('arch', ensureInstanceId(), { namespace: 'arch', presetName: name, name: 'memo', type: 'string', defaultValue: 'kept' });
    }
    return created.id;
}

const api = () => ({
    getSettings,
    persistSettings: vi.fn(),
    getCurrentChatId: () => context.chatId,
    getPresetsForChat,
    addPresetToChat: adapters.addPresetToChatAdapter,
    removePresetFromChat: adapters.removePresetFromChatAdapter,
    deletePreset: adapters.deletePresetAdapter,
    getPresetOwner: adapters.getPresetOwnerAdapter,
    deleteIndependentPreset: adapters.deleteIndependentPresetAdapter,
    createPreset: vi.fn(), renamePreset: vi.fn(),
    setStatus: vi.fn(), renderVarTable: vi.fn(), renderTrackerPanel: vi.fn(),
    restoreDefaultPresets: vi.fn(), toggleDebugMode: vi.fn(), getDebugInfo: () => ({}),
    isReservedVariable: () => false, blankDefinition,
    isVariableNameTaken: () => false, generateUniqueVariableName: (n) => n,
    listCalendars: () => getSettings().calendars,
    connectionProfiles: () => [],
    getIndependentPresetStatus: () => null,
});

const click = (presetId, selector) => $(`${selector}[data-preset-id="${presetId}"]`).first().trigger('click');

beforeEach(() => {
    settings.reset();
    document.body.innerHTML = '';
    globalThis.$ = globalThis.jQuery = jQuery;
    jQuery.fx.off = true;
    globalThis.confirm = window.confirm = vi.fn(() => true);
    globalThis.prompt = window.prompt = vi.fn();
    globalThis.alert = window.alert = vi.fn();
    context.chatId = 'chat-1';
    registerNamespaces('se', 'arch');
    setManagerApi(api());
});

afterEach(() => { document.body.innerHTML = ''; });

describe('isNamespaceActive', () => {
    it('is true once an extension claims its namespace this session, including an idempotent re-claim', () => {
        expect(isNamespaceActive('arch')).toBe(true);
        stateEngine.createNamespace('arch', ensureInstanceId(), 'arch');
        expect(isNamespaceActive('arch')).toBe(true);
        expect(stateEngine.isNamespaceActive('arch')).toBe(true);
    });

    it('is false for a namespace only remembered from an earlier session, or unknown', () => {
        leftoverPreset('gone', 'Leftover');
        expect(isNamespaceActive('gone')).toBe(false);
        expect(isNamespaceActive('nobody')).toBe(false);
    });
});

describe('getPresetOwnerAdapter', () => {
    it('names the owning extension and whether it is running', () => {
        expect(adapters.getPresetOwnerAdapter(runningPreset('Live'))).toEqual({ namespace: 'arch', extensionId: 'arch', active: true });
        expect(adapters.getPresetOwnerAdapter(leftoverPreset('gone', 'Old'))).toEqual({ namespace: 'gone', extensionId: 'gone-extension', active: false });
    });

    it('is null for State Engine\'s own presets', () => {
        const own = stateEngine.createPreset('se', ensureInstanceId(), { namespace: 'se', name: 'Mine' });
        expect(adapters.getPresetOwnerAdapter(own.id)).toBeNull();
        expect(adapters.getPresetOwnerAdapter('missing')).toBeNull();
    });
});

describe('deleting another extension\'s preset from the manager', () => {
    it('works - preset, chat bindings and stored values everywhere', () => {
        const presetId = runningPreset('Live', true);
        stateEngine.activatePreset('arch', ensureInstanceId(), 'chat-1', 'arch', 'Live');
        expect(getVar('chat-1', 'arch__memo')?.value).toBe('kept');

        adapters.deletePresetAdapter(presetId);

        expect(getSettings().presets[presetId]).toBeUndefined();
        expect(getPresetsForChat('chat-1')).not.toContain(presetId);
        expect(getVar('chat-1', 'arch__memo')).toBeUndefined();
    });

    it('works for a leftover preset of a removed extension', () => {
        const presetId = leftoverPreset('gone', 'Leftover');
        adapters.deletePresetAdapter(presetId);
        expect(getSettings().presets[presetId]).toBeUndefined();
    });

    it('works for another extension\'s independent preset', () => {
        const created = stateEngine.createIndependentPreset('arch', ensureInstanceId(), { namespace: 'arch', name: 'CatchUp' });
        expect(adapters.deleteIndependentPresetAdapter(created.id)).toBe(true);
        expect(getSettings().presets[created.id]).toBeUndefined();
    });
});

describe('manager warnings', () => {
    it('asks before deactivating a running extension\'s preset, and keeps it active on Cancel', () => {
        const presetId = runningPreset('Live');
        addPresetToChat('chat-1', presetId);
        buildManagerModal();

        window.confirm.mockReturnValue(false);
        click(presetId, '.se-manager-toggle-active');
        expect(window.confirm).toHaveBeenCalledTimes(1);
        expect(window.confirm.mock.calls[0][0]).toContain('managed by the extension "arch", which is installed and running');
        expect(getPresetsForChat('chat-1')).toContain(presetId);

        window.confirm.mockReturnValue(true);
        click(presetId, '.se-manager-toggle-active');
        expect(getPresetsForChat('chat-1')).not.toContain(presetId);
    });

    it('does not ask when deactivating State Engine\'s own or a removed extension\'s preset', () => {
        const own = stateEngine.createPreset('se', ensureInstanceId(), { namespace: 'se', name: 'Mine' }).id;
        const leftover = leftoverPreset('gone', 'Leftover');
        addPresetToChat('chat-1', own);
        addPresetToChat('chat-1', leftover);
        buildManagerModal();

        click(own, '.se-manager-toggle-active');
        click(leftover, '.se-manager-toggle-active');
        expect(window.confirm).not.toHaveBeenCalled();
        expect(getPresetsForChat('chat-1')).toEqual([]);
    });

    it('never asks when activating', () => {
        const presetId = runningPreset('Live');
        buildManagerModal();
        click(presetId, '.se-manager-toggle-active');
        expect(window.confirm).not.toHaveBeenCalled();
        expect(getPresetsForChat('chat-1')).toContain(presetId);
    });

    it('adds the warning to the delete confirmation for a running extension\'s preset', () => {
        const presetId = runningPreset('Live');
        buildManagerModal();
        window.confirm.mockReturnValue(false);
        click(presetId, '.se-manager-delete-preset');
        expect(window.confirm.mock.calls[0][0]).toMatch(/^Delete preset "Live"\?[\s\S]*installed and running\. Deleting it can stop that extension from working/);
        expect(getSettings().presets[presetId]).toBeDefined();
    });

    it('keeps the plain delete confirmation for a removed extension\'s preset, and deletes it', () => {
        const presetId = leftoverPreset('gone', 'Leftover');
        buildManagerModal();
        click(presetId, '.se-manager-delete-preset');
        expect(window.confirm.mock.calls[0][0]).toBe('Delete preset "Leftover"? This will also delete all variables in this preset.');
        expect(getSettings().presets[presetId]).toBeUndefined();
    });

    it('works without the owner lookup (managers that do not provide it)', () => {
        const presetId = runningPreset('Live');
        addPresetToChat('chat-1', presetId);
        setManagerApi({ ...api(), getPresetOwner: undefined });
        buildManagerModal();
        click(presetId, '.se-manager-toggle-active');
        expect(window.confirm).not.toHaveBeenCalled();
        expect(getPresetsForChat('chat-1')).not.toContain(presetId);
    });
});
