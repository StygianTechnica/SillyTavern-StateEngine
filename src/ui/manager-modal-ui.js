// State Engine — legacy variable table renderer for the settings panel
//
// The variable/preset editing UI that used to live alongside this has been
// superseded by manager-modal.js; only the active table renderer remains
// here.

import { getSettings } from '../core/settings-core.js';
import { getPresetsForChat } from '../core/preset-manager.js';
import { getVarValue } from '../core/variable-storage.js';
import { typeLabel, formatValueForDisplay } from './formatting-utils.js';

// Session state (not persisted)
export let currentPresetId = null;

export function renderVarTable() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const chatId = context.chatId;
    if (!chatId) {
        const $tabContainer = $('#se_preset_tabs');
        const $tbody = $('#se_var_tbody');
        const $empty = $('#se_var_empty');
        if ($tabContainer.length) $tabContainer.empty();
        if ($tbody.length) $tbody.empty();
        if ($empty.length) $empty.show().text('Select a chat to view state variables.');
        currentPresetId = null;
        return;
    }
    const activePresetIds = getPresetsForChat(chatId);

    // Don't auto-add default presets here — that should only happen on first chat load
    // If user explicitly deactivated all presets, respect that choice

    // Render tabs
    const $tabContainer = $('#se_preset_tabs');
    if (!$tabContainer.length) return;

    $tabContainer.empty();

    // If no presets at all, show a message
    if (Object.keys(settings.presets).length === 0) {
        $tabContainer.html('<div class="se-empty">No presets created. Click "New Preset" to get started.</div>');
        return;
    }

    // Create tab buttons
    for (const presetId of activePresetIds) {
        const preset = settings.presets[presetId];
        if (!preset) continue;

        const $tab = $('<button></button>')
            .addClass('se-tab-btn')
            .toggleClass('se-tab-active', presetId === currentPresetId)
            .text(preset.name)
            .on('click', () => {
                currentPresetId = presetId;
                renderVarTable();
            });
        $tabContainer.append($tab);
    }

    // Render variables for current preset
    const $tbody = $('#se_var_tbody');
    const $empty = $('#se_var_empty');
    if (!$tbody.length) return;

    $tbody.empty();

    // If no current preset, select the first active one
    if (!currentPresetId && activePresetIds.length > 0) {
        currentPresetId = activePresetIds[0];
    }

    const currentPreset = settings.presets[currentPresetId];
    if (!currentPreset) {
        $empty.show();
        return;
    }

    const defs = Object.values(currentPreset.variables).sort((a, b) => a.name.localeCompare(b.name));
    $empty.toggle(defs.length === 0);

    for (const def of defs) {
        const value = def.name ? getVarValue(context, def) : '';
        const $row = $('<tr></tr>').attr('data-id', def.id);
        $row.append($('<td></td>').append($('<code></code>').text(def.name || '(unnamed)')));
        // $row.append($('<td></td>').append(
        //     $('<span></span>').addClass(`se-badge se-badge-${def.category}`).text(categoryLabel(def.category)),
        // ));
        $row.append($('<td></td>').text(typeLabel(def.type)));
        $row.append($('<td></td>').text(def.scope === 'global' ? 'Global' : 'Chat'));
        $row.append($('<td></td>').addClass('se-col-value').text(formatValueForDisplay(value)));

        const $actions = $('<div></div>').addClass('se-row-actions');
        const $editBtn = $('<button></button>').addClass('menu_button se-edit-btn').text('Edit');
        const $delBtn = $('<button></button>').addClass('menu_button se-delete-btn').text('Delete');
        $actions.append($editBtn, $delBtn);
        $row.append($('<td></td>').append($actions));

        $tbody.append($row);
    }
}
