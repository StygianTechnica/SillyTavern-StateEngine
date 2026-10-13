// @vitest-environment jsdom
//
// The State block for Curator (src/core/curator-block.js), served as the
// virtual variable se__state_block (variable-value-api.js), its drawer
// section (src/ui/curator-block-ui.js), and the Scene Context starter preset
// it defaults to (src/core/scene-context-preset.js).

import context from './harness/context.js';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { setVar } from '../src/core/chat-state.js';
import * as O from '../src/core/objects.js';
import {
    CURATOR_BLOCK_NAME, CURATOR_BLOCK_CAPABILITY, REFERENCE_MARKER, defaultTemplate, currentTemplate, renderBlock, updateBlockSettings, blockSettings, findPresetByName, ensureCuratorBlockCapability,
} from '../src/core/curator-block.js';
import { initCuratorBlockUi } from '../src/ui/curator-block-ui.js';
import { SCENE_CONTEXT_BLUEPRINT } from '../src/core/scene-context-preset.js';

let instanceId;
const scene = (name, extra = {}) => stateEngine.createVariable('se', instanceId, { namespace: 'se', presetName: 'Scene Context', name, type: 'string', defaultValue: '', ...extra });

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    stateEngine.createPreset('se', instanceId, { namespace: 'se', name: 'Scene Context' });
    scene('scene_location', { label: 'Location' });
    scene('scene_title', { label: 'Title' });
    scene('scene_is_dry', { type: 'calculated', dependencies: ['se__scene_location'], expression: 'se__scene_location' });
    stateEngine.createPreset('se', instanceId, { namespace: 'se', name: 'Stats' });
    stateEngine.createVariable('se', instanceId, { namespace: 'se', presetName: 'Stats', name: 'hp', label: 'Health', type: 'number', defaultValue: 10 });
    stateEngine.activatePreset('se', instanceId, 'chat-1', 'se', 'Scene Context');
    stateEngine.activatePreset('se', instanceId, 'chat-1', 'se', 'Stats');
});

const def = (name) => Object.values(findPresetByName(name.startsWith('se__hp') ? 'Stats' : 'Scene Context').variables).find((d) => d.name === name);

describe('the State block', () => {
    it('defaults to a line per value of Scene Context (not calculated ones)', () => {
        expect(currentTemplate()).toBe('Scene Context:\n- Location: {{se__scene_location}}\n- Title: {{se__scene_title}}');
        expect(defaultTemplate(null)).toBe('');
    });

    it('is rendered for a chat, leaving out lines with no value, and nothing at all without values', () => {
        expect(renderBlock('chat-1')).toBe('');
        // With values, the block starts with the marker line.
        setVar('chat-1', 'se__scene_location', 'Chronicle Room', def('se__scene_location'));
        expect(renderBlock('chat-1')).toBe(REFERENCE_MARKER + '\n' + 'Scene Context:\n- Location: Chronicle Room');
    });

    it('follows another preset, or the user\'s own text', () => {
        updateBlockSettings({ presetName: 'Stats' });
        expect(currentTemplate()).toBe('Stats:\n- Health: {{se__hp}}');
        updateBlockSettings({ template: 'HP {{se__hp}} at {{se__scene_location}}' });
        setVar('chat-1', 'se__hp', 7, def('se__hp'));
        expect(renderBlock('chat-1')).toBe(REFERENCE_MARKER + '\n' + 'HP 7 at');
        expect(blockSettings()).toMatchObject({ presetName: 'Stats', template: 'HP {{se__hp}} at {{se__scene_location}}' });
    });

    it('drops the old "(State Engine)" label from a block saved with it', () => {
        updateBlockSettings({ template: 'Scene Context (State Engine):\n- Location: {{se__scene_location}}' });
        expect(currentTemplate()).toBe('Scene Context:\n- Location: {{se__scene_location}}');
        setVar('chat-1', 'se__scene_location', 'Chronicle Room', def('se__scene_location'));
        expect(renderBlock('chat-1')).toBe(REFERENCE_MARKER + '\n' + 'Scene Context:\n- Location: Chronicle Room');
    });

    it('shows objects by name, and a field of each with {{name.field}}', () => {
        context.chatId = 'chat-1';
        const syr = O.createObject('default', 'character', { name: 'Syrvanus', role: 'heir', description: 'A dragon heir.' });
        const gremlin = O.createObject('default', 'character', { name: 'the gremlin', description: 'Small and watchful.' });
        stateEngine.createVariable('se', instanceId, { namespace: 'se', presetName: 'Scene Context', name: 'scene_characters', type: 'array', itemType: 'object', itemObjectType: 'character', defaultValue: [] });
        stateEngine.activatePreset('se', instanceId, 'chat-1', 'se', 'Scene Context');
        setVar('chat-1', 'se__scene_characters', [syr.id, gremlin.id], def('se__scene_characters'));
        updateBlockSettings({ template: 'Here: {{se__scene_characters}}\nWho: {{se__scene_characters.description}}\nRoles: {{se__scene_characters.role}}\nMoods: {{se__scene_characters.mood}}' });
        // No mood written yet: that line is left out.
        expect(renderBlock('chat-1')).toBe(REFERENCE_MARKER + '\n' + 'Here: Syrvanus, the gremlin\nWho: Syrvanus: A dragon heir., the gremlin: Small and watchful.\nRoles: Syrvanus: heir');
    });

    it('is read like any variable, rendered at that moment', () => {
        setVar('chat-1', 'se__scene_title', 'The gremlins', def('se__scene_title'));
        const read = stateEngine.getVariableValue('pp', instanceId, 'chat-1', CURATOR_BLOCK_NAME);
        expect(read.value).toBe(REFERENCE_MARKER + '\n' + 'Scene Context:\n- Title: The gremlins');
        expect(read.def).toMatchObject({ name: 'se__state_block', type: 'string' });
    });

    it('is offered to Curator by the built-in namespace', () => {
        ensureCuratorBlockCapability();
        ensureCuratorBlockCapability();
        const se = stateEngine.getCapabilityGraph().se;
        expect(se.capabilities.filter((c) => c === CURATOR_BLOCK_CAPABILITY)).toHaveLength(1);
        expect(se.capabilities).toContain('curator.inject.role:user:se__state_block');
    });
});

describe('the drawer section', () => {
    const markup = `
        <div id="se_curator_block" hidden>
            <select id="se_curator_block_preset"></select>
            <textarea id="se_curator_block_template"></textarea>
            <small id="se_curator_block_custom" hidden></small>
            <button id="se_curator_block_reset"></button>
            <span data-se="blockName"></span>
            <pre id="se_curator_block_preview"></pre>
        </div>`;

    beforeEach(() => {
        document.body.innerHTML = markup;
        delete window.Curator;
        context.chatId = 'chat-1';
    });

    it('stays hidden without Curator, and shows once Curator is ready', () => {
        initCuratorBlockUi();
        expect(document.getElementById('se_curator_block').hidden).toBe(true);
        window.Curator = {};
        document.dispatchEvent(new Event('curator:ready'));
        expect(document.getElementById('se_curator_block').hidden).toBe(false);
        expect(document.getElementById('se_curator_block_template').value).toBe(currentTemplate());
        expect(document.getElementById('se_curator_block_preview').textContent).toMatch(/no values/);
    });

    it('saves an edited block, and goes back to the default on Reset', () => {
        window.Curator = {};
        initCuratorBlockUi();
        const box = document.getElementById('se_curator_block_template');
        box.value = 'Where: {{se__scene_location}}';
        box.dispatchEvent(new Event('input'));
        expect(blockSettings().template).toBe('Where: {{se__scene_location}}');
        expect(document.getElementById('se_curator_block_custom').hidden).toBe(false);
        document.getElementById('se_curator_block_reset').click();
        expect(blockSettings().template).toBeNull();
        expect(box.value).toBe(currentTemplate());
    });
});

describe('the Scene Context starter preset', () => {
    const names = new Set(SCENE_CONTEXT_BLUEPRINT.vars.map((v) => `se__${v.name}`));

    it('has local names, and every variable an expression or delta reads is in it', () => {
        expect(SCENE_CONTEXT_BLUEPRINT.name).toBe('Scene Context');
        for (const v of SCENE_CONTEXT_BLUEPRINT.vars) {
            expect(v.name, v.name).not.toMatch(/__/);
            expect(v.id).toBeUndefined();
            for (const dep of v.dependencies ?? []) expect(names.has(dep), `${v.name} -> ${dep}`).toBe(true);
            if (v.deltaSource) expect(names.has(v.deltaSource), `${v.name} -> ${v.deltaSource}`).toBe(true);
        }
        expect([...names]).toEqual(expect.arrayContaining(['se__scene_location', 'se__scene_characters', 'se__scene_weather', 'se__scene_deltatime']));
    });
});
