// @vitest-environment jsdom
//
// Independent Presets in the manager modal (requirements spec 1.29): the Presets
// tab's two subtabs, the independent-preset editor (enabled toggle, model,
// temperature, max tokens, history limit, prompt, context indicator,
// status), Run Now, and create/rename/delete/clone/export - all driven through
// the manager modal exactly as a user would click through it.
//
// The independentPresetAdapters (manager-api.js) route through the REAL
// src/api/independent-presets.js (stateEngine.*), so this file wires the SAME
// thin translation manager-api.js does - presetId -> (namespace, name), called
// as the built-in 'se' extension - rather than re-testing that pipeline's own
// logic (already covered by tests/api/independent-presets.test.js). What this
// file verifies is that the UI calls the right function with the right
// arguments, and displays what comes back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jQuery from 'jquery';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { addPresetToChat, getPresetsForChat, removePresetFromChat } from '../src/core/preset-manager.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { ensureInstanceId } from '../src/api/identity.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { setManagerApi, buildManagerModal } from '../src/ui/manager-modal/manager-modal.js';
import { callBackgroundLLM } from '../src/core/background-llm.js';

vi.mock('../src/core/chat-state.js', async () => vi.importActual('../src/core/chat-state.js'));
vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/manager-modal-ui.js', () => ({ renderVarTable: vi.fn() }));

const $ = jQuery;
const BUILTIN = 'se';
// Mutable so a test can change what the "model" select offers WITHOUT tearing
// down and rebuilding the modal (managerApi is captured once, in wireEvents(),
// when the modal's DOM is first built - see manager-modal.js; re-calling
// setManagerApi() alone does not reach already-wired click handlers).
let profilesForTest = [];

function findPresetById(presetId) {
    return getSettings().presets[presetId] || null;
}
const asBuiltin = (fn) => fn(BUILTIN, ensureInstanceId());

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
    connectionProfiles: () => profilesForTest,

    createIndependentPreset: (name) => asBuiltin((e, i) => stateEngine.createIndependentPreset(e, i, { namespace: BUILTIN, name })),
    updateIndependentPreset: (presetId, patch) => {
        const preset = findPresetById(presetId);
        if (!preset) return null;
        return asBuiltin((e, i) => stateEngine.updateIndependentPreset(e, i, preset.namespace || BUILTIN, preset.name, patch));
    },
    deleteIndependentPreset: (presetId) => {
        const preset = findPresetById(presetId);
        if (!preset) return false;
        return asBuiltin((e, i) => stateEngine.deleteIndependentPreset(e, i, preset.namespace || BUILTIN, preset.name));
    },
    toggleIndependentPreset: (presetId, enabled) => {
        const preset = findPresetById(presetId);
        if (!preset) return null;
        return asBuiltin((e, i) => stateEngine.toggleIndependentPreset(e, i, preset.namespace || BUILTIN, preset.name, enabled));
    },
    runIndependentPreset: (presetId, chatId) => {
        const preset = findPresetById(presetId);
        if (!preset || !chatId) return Promise.resolve(false);
        return asBuiltin((e, i) => stateEngine.runIndependentPreset(e, i, chatId, { namespace: preset.namespace || BUILTIN, name: preset.name }));
    },
    getIndependentPresetStatus: (presetId) => {
        const preset = findPresetById(presetId);
        return preset ? stateEngine.getIndependentPresetStatus(preset.namespace || BUILTIN, preset.name) : null;
    },
});

// $ helpers, scoped to the Independent Presets pane.
const pane = () => $('.se-manager-presets-subtab-pane[data-presets-subtab="independent"]');
const row = (name) => pane().find('.se-manager-independent-preset-item').filter((_, el) => $(el).find('.se-manager-preset-name').text().includes(name)).first();
const openSubtab = () => { $('.se-manager-presets-subtab-btn[data-presets-subtab="independent"]').trigger('click'); };
const openRow = (name) => { row(name).find('.se-manager-preset-accordion-header').trigger('click'); };

beforeEach(() => {
    settings.reset();
    document.body.innerHTML = '';
    globalThis.$ = globalThis.jQuery = jQuery;
    jQuery.fx.off = true;
    globalThis.alert = vi.fn();
    globalThis.prompt = vi.fn();
    globalThis.confirm = vi.fn(() => true);
    window.alert = globalThis.alert;
    window.prompt = globalThis.prompt;
    window.confirm = globalThis.confirm;

    profilesForTest = [];
    context.chatId = 'chat-1';
    context.chat = [{ is_user: true, mes: 'hello there' }, { is_user: false, name: 'Bot', mes: 'hi' }];
    registerNamespaces(BUILTIN);
    setManagerApi(api());
    buildManagerModal();
    callBackgroundLLM.mockReset();
});

afterEach(() => { document.body.innerHTML = ''; });

describe('the two Presets subtabs', () => {
    it('opens on Regular Presets; Independent Presets is a separate, initially-empty pane', () => {
        expect($('.se-manager-presets-subtab-btn.se-manager-presets-subtab-active').attr('data-presets-subtab')).toBe('regular');
        expect($('.se-manager-presets-subtab-pane[data-presets-subtab="regular"]').css('display')).not.toBe('none');
        expect(pane().css('display')).toBe('none');
        openSubtab();
        expect(pane().css('display')).not.toBe('none');
        expect(pane().text()).toContain('No independent presets yet');
    });

    it('an independent preset never appears in the Regular Presets list, and vice versa', () => {
        asBuiltin((e, i) => stateEngine.createIndependentPreset(e, i, { namespace: BUILTIN, name: 'Indy' }));
        asBuiltin((e, i) => stateEngine.createPreset(e, i, { namespace: BUILTIN, name: 'Regular' }));
        buildManagerModal();
        expect($('.se-manager-presets-subtab-pane[data-presets-subtab="regular"]').text()).toContain('Regular');
        expect($('.se-manager-presets-subtab-pane[data-presets-subtab="regular"]').text()).not.toContain('Indy');
        openSubtab();
        expect(pane().text()).toContain('Indy');
        expect(pane().text()).not.toContain('Regular');
    });
});

describe('create / rename / delete', () => {
    it('New creates one, shown enabled with the chat-history context by default', () => {
        openSubtab();
        globalThis.prompt.mockReturnValue('Watcher');
        $('#se-manager-new-independent-preset').trigger('click');
        expect(row('Watcher').length).toBe(1);
        expect(row('Watcher').text()).toContain('Enabled');
        expect(row('Watcher').text()).toContain('Chat history (default)');
    });

    it('cancelling the name prompt creates nothing', () => {
        openSubtab();
        globalThis.prompt.mockReturnValue(null);
        $('#se-manager-new-independent-preset').trigger('click');
        expect(pane().text()).toContain('No independent presets yet');
    });

    it('rename updates the row', () => {
        const presetId = asBuiltin((e, i) => stateEngine.createIndependentPreset(e, i, { namespace: BUILTIN, name: 'Old' })).id;
        openSubtab();
        globalThis.prompt.mockReturnValue('New');
        row('Old').find('.se-indy-rename').trigger('click');
        expect(findPresetById(presetId).name).toBe('New');
        expect(pane().text()).toContain('New');
    });

    it('delete removes the preset and its variables, after confirmation', () => {
        const created = asBuiltin((e, i) => stateEngine.createIndependentPreset(e, i, { namespace: BUILTIN, name: 'Gone' }));
        stateEngine.createVariable(BUILTIN, ensureInstanceId(), { namespace: BUILTIN, presetName: 'Gone', name: 'x', type: 'string', defaultValue: 'y' });
        openSubtab();
        row('Gone').find('.se-indy-delete').trigger('click');
        expect(findPresetById(created.id)).toBe(null);
        expect(pane().text()).toContain('No independent presets yet');
    });

    it('declining the confirmation keeps it', () => {
        asBuiltin((e, i) => stateEngine.createIndependentPreset(e, i, { namespace: BUILTIN, name: 'Stays' }));
        globalThis.confirm.mockReturnValue(false);
        openSubtab();
        row('Stays').find('.se-indy-delete').trigger('click');
        expect(row('Stays').length).toBe(1);
    });
});

describe('clone and export reuse the regular-preset buttons - no independent-specific code needed', () => {
    it('clone carries independentPreset/independentConfig, but not run history', async () => {
        const created = asBuiltin((e, i) => stateEngine.createIndependentPreset(e, i, { namespace: BUILTIN, name: 'Source', temperature: 0.4 }));
        stateEngine.createVariable(BUILTIN, ensureInstanceId(), {
            namespace: BUILTIN, presetName: 'Source', name: 'mood', type: 'string', defaultValue: 'calm',
            behaviors: { prompted: true, increment: false }, prompted: { instructions: 'infer' },
        });
        addPresetToChat('chat-1', created.id);
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        await asBuiltin((e, i) => stateEngine.runIndependentPreset(e, i, 'chat-1', { namespace: BUILTIN, name: 'Source' }));

        openSubtab();
        globalThis.prompt.mockReturnValue('Cloned');
        row('Source').find('.se-manager-clone-preset').trigger('click');

        const cloned = Object.values(getSettings().presets).find((p) => p.name === 'Cloned');
        expect(cloned.independentPreset).toBe(true);
        expect(cloned.independentConfig).toMatchObject({ temperature: 0.4 });
        expect(cloned.independentStatus).toBeUndefined();
        expect(row('Cloned').length).toBe(1);
    });
});

describe('the editor fields', () => {
    let presetId;
    beforeEach(() => {
        presetId = asBuiltin((e, i) => stateEngine.createIndependentPreset(e, i, { namespace: BUILTIN, name: 'Editable' })).id;
        openSubtab();
        openRow('Editable');
    });

    const field = (name) => row('Editable').find(`.se-indy-field[data-field="${name}"]`);

    it('editing temperature, max tokens and history limit saves through updateIndependentPreset', () => {
        field('temperature').val('0.7').trigger('change');
        field('maxTokens').val('222').trigger('change');
        field('historyLimit').val('3').trigger('change');
        expect(findPresetById(presetId).independentConfig).toMatchObject({ temperature: 0.7, maxTokens: 222, historyLimit: 3 });
    });

    it('there is no "batch" field any more (requirements spec 1.20, rewritten 2026-09-22)', () => {
        expect(field('batch').length).toBe(0);
    });

    it('clearing a number field stores null (clears the override), not left untouched', () => {
        field('temperature').val('0.9').trigger('change');
        expect(findPresetById(presetId).independentConfig.temperature).toBe(0.9);
        field('temperature').val('').trigger('change');
        expect(findPresetById(presetId).independentConfig.temperature).toBe(null);
    });

    // A non-numeric value cannot actually reach the change handler through a real
    // <input type="number"> - the browser (and jsdom, faithfully) refuses to store
    // anything but a valid number or "" in .value, so there is no UI action left to
    // simulate here. The handler's Number.isNaN guard stays in the source as
    // defense in depth (e.g. against a value set some other way), covered directly
    // in tests/api/independent-presets.test.js's own validation coverage instead.

    it('the prompt textarea saves to promptedHeader', () => {
        row('Editable').find('.se-indy-field[data-field="promptedHeader"]').val('Be terse.').trigger('change');
        expect(findPresetById(presetId).independentConfig.promptedHeader).toBe('Be terse.');
    });

    it('model options come from managerApi.connectionProfiles()', () => {
        profilesForTest = [{ id: 'p1', name: 'Profile One' }];
        openSubtab(); // re-render with the new profile list (see profilesForTest's own comment)
        openRow('Editable');
        const options = row('Editable').find('select[data-field="connectionProfileId"] option').map((_, o) => o.textContent).get();
        expect(options).toContain('Profile One');
    });

    it('the context indicator is read-only text, not an input - context is extension-owned', () => {
        const indicator = row('Editable').find('.se-indy-context-indicator');
        expect(indicator.length).toBe(1);
        expect(indicator.is('input, select, textarea')).toBe(false);
        expect(indicator.text()).toContain('Chat history');
    });

    it('the triggers/schedule section is honestly labelled as not yet available', () => {
        expect(row('Editable').text()).toMatch(/[Nn]ot available yet/);
    });
});

describe('enabled / disabled toggle', () => {
    it('toggling updates the row and blocks Run Now at the dispatcher level', async () => {
        const created = asBuiltin((e, i) => stateEngine.createIndependentPreset(e, i, { namespace: BUILTIN, name: 'Togglable' }));
        stateEngine.createVariable(BUILTIN, ensureInstanceId(), {
            namespace: BUILTIN, presetName: 'Togglable', name: 'mood', type: 'string', defaultValue: 'calm',
            behaviors: { prompted: true, increment: false }, prompted: { instructions: 'infer' },
        });
        addPresetToChat('chat-1', created.id);
        openSubtab();

        row('Togglable').find('.se-indy-toggle-enabled').trigger('click');
        expect(row('Togglable').text()).toContain('Disabled');

        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        row('Togglable').find('.se-indy-run-now').trigger('click');
        await vi.waitFor(() => expect(row('Togglable').text()).toMatch(/Skipped \(disabled\)/));
        expect(callBackgroundLLM).not.toHaveBeenCalled();

        row('Togglable').find('.se-indy-toggle-enabled').trigger('click');
        expect(row('Togglable').text()).toContain('Enabled');
    });
});

describe('Run Now', () => {
    let created;
    beforeEach(() => {
        created = asBuiltin((e, i) => stateEngine.createIndependentPreset(e, i, { namespace: BUILTIN, name: 'Runner' }));
        stateEngine.createVariable(BUILTIN, ensureInstanceId(), {
            namespace: BUILTIN, presetName: 'Runner', name: 'mood', type: 'string', defaultValue: 'calm',
            behaviors: { prompted: true, increment: false }, prompted: { instructions: 'infer' },
        });
        addPresetToChat('chat-1', created.id);
        openSubtab();
    });

    it('runs against the currently open chat and shows the resulting status', async () => {
        callBackgroundLLM.mockResolvedValue('{"se__mood":"tense"}');
        row('Runner').find('.se-indy-run-now').trigger('click');
        await vi.waitFor(() => expect(row('Runner').text()).toContain('Updated'));
        expect(row('Runner').text()).toContain('se__mood');
        expect(getVarValue('se__mood')).toBe('tense');
    });

    function getVarValue(name) {
        return getSettings().variableStore.chats['chat-1'].variables[name]?.value;
    }

    it('with no chat open, it refuses and never calls the LLM', async () => {
        context.chatId = null;
        row('Runner').find('.se-indy-run-now').trigger('click');
        await new Promise((r) => setTimeout(r, 10));
        expect(callBackgroundLLM).not.toHaveBeenCalled();
    });

    it('the button is disabled while running and restored afterward', async () => {
        let release;
        callBackgroundLLM.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const $btn = row('Runner').find('.se-indy-run-now');
        $btn.trigger('click');
        await new Promise((r) => setTimeout(r, 0));
        expect($('.se-indy-run-now:disabled').length).toBeGreaterThan(0);
        release('{"se__mood":"tense"}');
        await vi.waitFor(() => expect($('.se-indy-run-now:disabled').length).toBe(0));
    });
});

describe('a regular preset is never reachable through the independent-preset controls', () => {
    it('update/delete/toggle on a plain preset are refused by the underlying API, not silently applied', () => {
        const regularId = asBuiltin((e, i) => stateEngine.createPreset(e, i, { namespace: BUILTIN, name: 'PlainOne' })).id;
        const mgr = api();
        expect(mgr.updateIndependentPreset(regularId, { temperature: 0.9 })).toBe(null);
        expect(mgr.deleteIndependentPreset(regularId)).toBe(false);
        expect(mgr.toggleIndependentPreset(regularId, false)).toBe(null);
        expect(findPresetById(regularId)).not.toBe(null); // untouched
    });
});
