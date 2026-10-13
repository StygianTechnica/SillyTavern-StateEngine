// State Engine — the drawer's "Curator block" section (core/curator-block.js)
//
// Shown only while Curator is installed and running (window.Curator, or its
// 'curator:ready' event once it has loaded): the block is for Curator to
// inject, so without it there is nothing to set up. The user picks the
// preset the default block is made from, edits the block's text, and sees
// it rendered for the open chat.

import { VARIABLES_CHANGED_EVENT } from '../core/variable-change-signal.js';
import { isObjectPreset } from '../core/object-types.js';
import { getSettings } from '../core/settings-core.js';
import { blockSettings, updateBlockSettings, currentTemplate, defaultTemplate, findPresetByName, renderBlock, CURATOR_BLOCK_DEF } from '../core/curator-block.js';

const byId = (id) => document.getElementById(id);

export function isCuratorActive() {
    return !!globalThis.window?.Curator;
}

function fillPresets() {
    const select = byId('se_curator_block_preset');
    if (!select || select === document.activeElement) return;
    const { presetName } = blockSettings();
    const presets = Object.values(getSettings().presets || {})
        .filter((p) => p?.name && Object.keys(p.variables || {}).length && !isObjectPreset(p))
        .sort((a, b) => String(a.namespace).localeCompare(String(b.namespace)) || a.name.localeCompare(b.name));
    select.replaceChildren(...presets.map((p) => new Option(p.namespace && p.namespace !== 'se' ? `${p.name} (${p.namespace})` : p.name, p.name)));
    if (!presets.some((p) => p.name === presetName)) select.add(new Option(`${presetName} (missing)`, presetName));
    select.value = presetName;
}

function renderPreview() {
    const preview = byId('se_curator_block_preview');
    if (!preview) return;
    let chatId = null;
    try {
        chatId = SillyTavern.getContext().chatId ?? null;
    } catch {
        chatId = null;
    }
    const text = chatId ? renderBlock(chatId) : '';
    preview.textContent = text || (chatId ? '(nothing to send in this chat yet - no values)' : '(open a chat to preview)');
}

function fillTemplate() {
    const box = byId('se_curator_block_template');
    if (box && box !== document.activeElement) box.value = currentTemplate();
    const custom = byId('se_curator_block_custom');
    if (custom) custom.hidden = blockSettings().template === null;
}

function refresh() {
    fillPresets();
    fillTemplate();
    renderPreview();
}

function show() {
    const section = byId('se_curator_block');
    if (!section) return;
    section.hidden = false;
    refresh();
}

function bind() {
    byId('se_curator_block_preset')?.addEventListener('change', (e) => {
        const name = e.target.value;
        const { template } = blockSettings();
        if (template !== null && !window.confirm(`Replace your edited block with the default one for "${name}"?`)) {
            updateBlockSettings({ presetName: name });
        } else {
            updateBlockSettings({ presetName: name, template: null });
        }
        refresh();
    });
    byId('se_curator_block_template')?.addEventListener('input', (e) => {
        const value = e.target.value;
        const generated = defaultTemplate(findPresetByName(blockSettings().presetName));
        updateBlockSettings({ template: value === generated ? null : value });
        byId('se_curator_block_custom').hidden = blockSettings().template === null;
        renderPreview();
    });
    byId('se_curator_block_reset')?.addEventListener('click', () => {
        updateBlockSettings({ template: null });
        refresh();
    });
}

export function initCuratorBlockUi() {
    const section = byId('se_curator_block');
    if (!section) return;
    section.querySelector('[data-se="blockName"]').textContent = `{{${CURATOR_BLOCK_DEF.name}}}`;
    bind();
    if (isCuratorActive()) show();
    else document.addEventListener('curator:ready', show, { once: true });
    try {
        const { eventSource, eventTypes } = SillyTavern.getContext();
        const later = () => { if (!section.hidden) refresh(); };
        eventSource.on(eventTypes.CHAT_CHANGED, later);
        eventSource.on(VARIABLES_CHANGED_EVENT, later);
    } catch {
        // No SillyTavern event bus (tests): the preview updates on edits only.
    }
}
