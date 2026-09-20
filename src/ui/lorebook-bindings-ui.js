// State Engine — "Lorebook Preset Bindings" section of the settings panel
// (settings.html). Pick a lorebook, tick presets, Bind / Unbind them; export a
// lorebook bundle or import one.

import { getSettings } from '../core/settings-core.js';
import {
    listLorebookNames, getPresetsForLorebook, bindPresetToLorebook, unbindPresetFromLorebook, clearLorebookPresetDeclines,
} from '../core/lorebook-bindings.js';
import { exportLorebookBundle, importLorebookBundle } from '../core/lorebook-bundle.js';
import { escapeHtml } from './manager-modal/utils.js';
import { setStatus } from './settings-panel-ui.js';
import { downloadJson, pickJsonFile } from './file-io.js';

const selectedLorebook = () => String($('#se_lorebook_select').val() || '');
const ticked = () => $('#se_lorebook_presets .se-lorebook-preset-checkbox:checked').map((_, el) => $(el).val()).get();

// Fills the lorebook dropdown from SillyTavern's lorebook list (plus any
// lorebook State Engine already has bindings or conditions for), keeping the
// current selection when it still exists.
export function populateLorebookSelect() {
    const $select = $('#se_lorebook_select');
    if (!$select.length) return;
    const previous = String($select.val() || '');
    const names = listLorebookNames();

    $select.html(names.length
        ? names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')
        : '<option value="">No lorebooks found</option>');
    if (previous && names.includes(previous)) $select.val(previous);
    renderLorebookPresetBindings();
}

// One row per preset: a checkbox to pick it, and a badge on those already
// bound to the selected lorebook.
export function renderLorebookPresetBindings() {
    const $list = $('#se_lorebook_presets');
    if (!$list.length) return;
    const book = selectedLorebook();
    if (!book) {
        $list.html('<div class="se-empty">Select a lorebook to manage its presets.</div>');
        return;
    }

    const bound = new Set(getPresetsForLorebook(book, book));
    const presets = Object.entries(getSettings().presets || {});
    $list.html(presets.length
        ? presets.map(([id, preset]) => `
            <label class="checkbox_label se-lorebook-preset-row">
                <input type="checkbox" class="se-lorebook-preset-checkbox" value="${escapeHtml(id)}" />
                <span>${escapeHtml(preset.name)}</span>
                ${bound.has(id) ? '<small class="se-lorebook-bound-badge"> (bound)</small>' : ''}
            </label>`).join('')
        : '<div class="se-empty">No presets yet.</div>');
}

// Bind the ticked presets to the selected lorebook.
export function bindPresetToLorebookFromUI() {
    const book = selectedLorebook();
    const ids = ticked();
    if (!book || ids.length === 0) { setStatus('Select a lorebook and tick at least one preset to bind.', true); return; }
    const done = ids.filter((id) => bindPresetToLorebook(book, book, id));
    renderLorebookPresetBindings();
    setStatus(`Bound ${done.length} preset(s) to "${book}".`);
}

// Unbind the ticked presets from the selected lorebook.
export function unbindPresetFromLorebookFromUI() {
    const book = selectedLorebook();
    const ids = ticked();
    if (!book || ids.length === 0) { setStatus('Select a lorebook and tick at least one preset to unbind.', true); return; }
    const done = ids.filter((id) => unbindPresetFromLorebook(book, book, id));
    renderLorebookPresetBindings();
    setStatus(`Unbound ${done.length} preset(s) from "${book}".`);
}

// Forget every "No" given to an activation prompt, in every chat, so those
// presets are offered again the next time such a chat loads.
export function clearDeclinesFromUI() {
    const cleared = clearLorebookPresetDeclines();
    setStatus(cleared > 0 ? `Cleared ${cleared} declined preset prompt(s).` : 'There were no declined prompts to clear.');
}

async function exportBundleFromUI() {
    const book = selectedLorebook();
    if (!book) { setStatus('Select a lorebook to export.', true); return; }
    try {
        const bundle = await exportLorebookBundle(book, book);
        if (!bundle) { setStatus(`Could not load lorebook "${book}".`, true); return; }
        downloadJson(`${book}.stateengine-bundle`, bundle);
        setStatus(`Exported "${book}" with ${Object.keys(bundle.stateEngine.presets || {}).length} preset(s).`);
    } catch (err) {
        console.error('[State Engine]', err);
        setStatus(err?.message || 'Export failed.', true);
    }
}

async function importBundleFromUI() {
    try {
        const file = await pickJsonFile();
        if (!file) return;
        const result = await importLorebookBundle(file.data);
        if (!result) { setStatus('Nothing imported (not a lorebook bundle, or cancelled).', true); return; }
        populateLorebookSelect();
        setStatus(`Imported "${result.lorebook}": ${result.presetIds.length} preset(s), ${result.conditions} condition(s).`);
    } catch (err) {
        console.error('[State Engine]', err);
        setStatus(err?.message || 'Import failed.', true);
    }
}

// Wires the section's controls (delegated, so it works whenever the settings
// template is inserted) and fills it.
export function initLorebookBindingsUi() {
    $(document).on('change', '#se_lorebook_select', renderLorebookPresetBindings);
    $(document).on('click', '#se_lorebook_bind', bindPresetToLorebookFromUI);
    $(document).on('click', '#se_lorebook_unbind', unbindPresetFromLorebookFromUI);
    $(document).on('click', '#se_lorebook_refresh', populateLorebookSelect);
    $(document).on('click', '#se_lorebook_clear_declines', clearDeclinesFromUI);
    $(document).on('click', '#se_lorebook_export_bundle', exportBundleFromUI);
    $(document).on('click', '#se_lorebook_import_bundle', importBundleFromUI);
    populateLorebookSelect();
}
