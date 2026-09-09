// State Engine — Manager modal event wiring
// Uses ES6 modules - imported by manager-modal.js

import * as presetManager from './preset-manager.js';
import * as variableSchema from './variable-ui-schema.js';
import * as uiTemplates from './ui-templates.js';
import * as uiRender from './ui-render.js';
import { generateUUID, escapeHtml } from './utils.js';
import { resetValueIfTypeChanged, hydrateMacroStoreForChat } from '../../core/chat-state.js';

export function wireEvents(managerApi, managerState) {
    const $overlay = $('#se-manager-overlay');
    if (!$overlay.length) return;

    // Close modal
    $overlay.on('click', '#se-manager-close', function () {
        managerState.hideManagerModal();
    });

    // Close on overlay click (outside window)
    $overlay.on('click', function (e) {
        if (e.target === this) {
            managerState.hideManagerModal();
        }
    });

    // Tab switching
    $overlay.on('click', '.se-manager-tab-btn', function () {
        const tab = $(this).attr('data-tab');
        $('.se-manager-tab-btn').removeClass('se-manager-tab-active');
        $('.se-manager-tab-pane').removeClass('se-manager-tab-active');
        $(this).addClass('se-manager-tab-active');
        $(`.se-manager-tab-pane[data-tab="${tab}"]`).addClass('se-manager-tab-active');

        // Re-render the tab content
        if (tab === 'presets') uiRender.renderPresetsTab(managerApi, managerState.currentPresetId);
        else if (tab === 'variables') managerState.currentPresetId = uiRender.renderVariablesTab(managerApi, managerState.currentPresetId);
        else if (tab === 'worldinfo') uiRender.renderWorldInfoTab(managerApi);
        else if (tab === 'varmgmt') uiRender.renderVariableManagementTab(managerApi);
        else if (tab === 'debug') uiRender.renderDebugTab(managerApi);
    });

    // Accordion: Toggle preset expansion
    $overlay.on('click', '.se-manager-preset-accordion-header', function () {
        const $header = $(this);
        const $body = $header.next('.se-manager-preset-accordion-body');
        const $toggle = $header.find('.se-manager-preset-accordion-toggle i');
        
        // Close all other accordion items
        $overlay.find('.se-manager-preset-accordion-body').not($body).slideUp(200);
        $overlay.find('.se-manager-preset-accordion-toggle i').removeClass('se-rotated');
        
        // Toggle this item
        $body.slideToggle(200);
        $toggle.toggleClass('se-rotated');
    });

    // Preset actions
    $overlay.on('click', '#se-manager-restore-presets', function () {
        if (window.confirm('Restore default presets? This will delete any custom changes to the default presets.')) {
            managerApi.restoreDefaultPresets();
            uiRender.renderPresetsTab(managerApi, managerState.currentPresetId);
            managerApi.renderVarTable();
            managerApi.setStatus('Restored default presets.');
        }
    });

    $overlay.on('click', '#se-manager-new-preset', function () {
        const name = prompt('New preset name:');
        if (name && name.trim()) {
            managerApi.createPreset(name.trim());
            uiRender.renderPresetsTab(managerApi, managerState.currentPresetId);
            managerApi.setStatus(`Created preset "${name}".`);
        }
    });

    $overlay.on('click', '.se-manager-toggle-active', function () {
        const presetId = $(this).attr('data-preset-id');
        const chatId = $(this).attr('data-chat-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        if (managerApi.getPresetsForChat(chatId).includes(presetId)) {
            managerApi.removePresetFromChat(chatId, presetId);
        } else {
            managerApi.addPresetToChat(chatId, presetId);
        }
        uiRender.renderPresetsTab(managerApi, managerState.currentPresetId);
        managerApi.renderVarTable();
        managerApi.renderTrackerPanel();
        managerApi.setStatus(`${managerApi.getPresetsForChat(chatId).includes(presetId) ? 'Activated' : 'Deactivated'} "${preset.name}" for this chat.`);
    });

    $overlay.on('click', '.se-manager-clone-preset', function () {
        const presetId = $(this).attr('data-preset-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        const newName = prompt('Clone name:', preset.name + ' (copy)');
        if (newName && newName.trim()) {
            presetManager.clonePreset(presetId, newName.trim());
            uiRender.renderPresetsTab(managerApi, managerState.currentPresetId);
            managerApi.setStatus(`Cloned preset "${preset.name}".`);
        }
    });

    $overlay.on('click', '.se-manager-rename-preset', function () {
        const presetId = $(this).attr('data-preset-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        const newName = prompt('New name:', preset.name);
        if (newName && newName.trim()) {
            managerApi.renamePreset(presetId, newName.trim());
            uiRender.renderPresetsTab(managerApi, managerState.currentPresetId);
            managerApi.setStatus(`Renamed to "${newName}".`);
        }
    });

    $overlay.on('click', '.se-manager-delete-preset', function () {
        const presetId = $(this).attr('data-preset-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        if (window.confirm(`Delete preset "${preset.name}"? This will also delete all variables in this preset.`)) {
            managerApi.deletePreset(presetId);
            if (managerState.currentPresetId === presetId) managerState.currentPresetId = null;
            uiRender.renderPresetsTab(managerApi, managerState.currentPresetId);
            managerState.currentPresetId = uiRender.renderVariablesTab(managerApi, managerState.currentPresetId);
            managerApi.setStatus(`Deleted "${preset.name}" and all its variables.`);
        }
    });

    // Variables tab
    $overlay.on('change', '#se-manager-preset-selector', function () {
        const presetId = $(this).val();
        managerState.currentPresetId = presetId;
        managerState.currentPresetId = uiRender.renderVariablesTab(managerApi, managerState.currentPresetId);
    });

    $overlay.on('change', '#se-manager-filter-active', function () {
        window.managerShowActiveOnly = $(this).prop('checked');
        managerState.currentPresetId = uiRender.renderVariablesTab(managerApi, managerState.currentPresetId);
    });

    $overlay.on('click', '.se-manager-edit-variable', function () {
        const varId = $(this).attr('data-var-id');
        const presetId = $(this).attr('data-preset-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset || !preset.variables || !preset.variables[varId]) return;
        managerState.currentPresetId = presetId;
        
        const $row = $(this).closest('.se-manager-variable-row');
        showInlineVariableEditor(preset.variables[varId], $row);
    });

    $overlay.on('click', '.se-manager-move-variable-up', function () {
        const sortMode = $('#se-manager-variable-sort').val() || 'order';
        if (sortMode !== 'tracker') {
            managerApi.setStatus('Switch to "Tracker order" sort to reorder variables.');
            return;
        }
        if (presetManager.moveVariable($(this).attr('data-preset-id'), $(this).attr('data-var-id'), -1)) {
            managerState.currentPresetId = uiRender.renderVariablesTab(managerApi, managerState.currentPresetId);
            managerApi.renderTrackerPanel(); // Update tracker with new variable order
        }
    });

    $overlay.on('click', '.se-manager-move-variable-down', function () {
        const sortMode = $('#se-manager-variable-sort').val() || 'order';
        if (sortMode !== 'tracker') {
            managerApi.setStatus('Switch to "Tracker order" sort to reorder variables.');
            return;
        }
        if (presetManager.moveVariable($(this).attr('data-preset-id'), $(this).attr('data-var-id'), 1)) {
            managerState.currentPresetId = uiRender.renderVariablesTab(managerApi, managerState.currentPresetId);
            managerApi.renderTrackerPanel(); // Update tracker with new variable order
        }
    });

    $overlay.on('click', '.se-manager-toggle-visibility', function () {
        const varId = $(this).attr('data-var-id');
        const presetId = $(this).attr('data-preset-id');
        const varDef = presetManager.toggleVariableVisibility(presetId, varId);
        if (!varDef) return;

        managerState.currentPresetId = uiRender.renderVariablesTab(managerApi, managerState.currentPresetId);
        managerApi.setStatus(`Visibility toggled for "${varDef.name}".`);

        // FIX: refresh tracker immediately
        managerApi.renderTrackerPanel();
    });

    $overlay.on('click', '.se-manager-delete-variable', function () {
        const varId = $(this).attr('data-var-id');
        const presetId = $(this).attr('data-preset-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset || !preset.variables[varId]) return;

        if (window.confirm(`Delete variable "${preset.variables[varId].name || varId}"?`)) {
            presetManager.deleteVariable(presetId, varId);
            managerState.currentPresetId = uiRender.renderVariablesTab(managerApi, managerState.currentPresetId);
            managerApi.setStatus(`Variable deleted.`);
        }
        managerApi.renderTrackerPanel(); 
    });

    $overlay.on('click', '.se-manager-cancel-variable-inline', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const $editor = $row.find('.se-manager-variable-editor-inline');

        const isNew = !$editor.data('editing-existing');
        const varId = $editor.data('editing-id');

        if (isNew) {
            presetManager.deleteVariable(managerState.currentPresetId, varId);
            $row.remove();
        } else {
            hideInlineVariableEditor($row);
        }
    });

    $overlay.on('click', '.se-manager-save-variable-inline', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const $editor = $row.find('.se-manager-variable-editor-inline');
        if (!$editor.length) return;

        const settings = managerApi.getSettings();
        const presetId = managerState.currentPresetId;
        const preset = settings.presets[presetId];
        if (!preset) return;

        const values = collectInlineVariableValues($row);
        const isNew = !$editor.data('editing-existing');

        if (!variableSchema.validateVariableName(values.name)) {
            alert('Variable name is required and must start with a letter or underscore.');
            return;
        }

        if (managerApi.isReservedVariable(values.name)) {
            alert(`Cannot create variable: "${values.name}" is a reserved SillyTavern macro name.`);
            return;
        }

        console.log("VALUES BEFORE SAVE:", values);

        const newVariable = {
            ...managerApi.blankDefinition(),
            ...values,
            ...variableSchema.normalizeCollectedValues(values),
        };

        // ⭐ FIX: Save or update the variable in the preset
        preset.variables[newVariable.id] = newVariable;

        const chatId = managerApi.getCurrentChatId();
        resetValueIfTypeChanged(chatId, newVariable);

        managerApi.persistSettings(settings);
        hideInlineVariableEditor($row);
        managerState.currentPresetId = uiRender.renderVariablesTab(managerApi, managerState.currentPresetId);
        managerApi.setStatus(isNew ? 'Variable created.' : 'Variable updated.');
        managerApi.renderTrackerPanel(); 
    });



    // Triggers in accordion
    $overlay.on('change', '.se-preset-trigger-checkbox', function () {
        const presetId = $(this).attr('data-preset-id');
        const trigger = $(this).attr('data-trigger');
        const preset = presetManager.updatePresetTriggers(presetId, trigger, $(this).is(':checked'));
        if (!preset) return;

        const $item = $(this).closest('.se-manager-preset-accordion-item');
        const $headerMeta = $item.find('.se-manager-preset-meta');
        $headerMeta.text(preset.triggers.length > 0 ? `${preset.triggers.length} trigger(s) active` : 'No triggers active');

        managerApi.setStatus(`Triggers updated for "${preset.name}".`);
    });

    // Preset description
    $overlay.on('change', '.se-manager-preset-description-input', function () {
        const presetId = $(this).attr('data-preset-id');
        const newDescription = $(this).val();
        const preset = presetManager.updatePresetDescription(presetId, newDescription);
        if (!preset) return;

        // Re-render the preset tab to update inline description display
        uiRender.renderPresetsTab(managerApi, managerState.currentPresetId);

        managerApi.setStatus(`Description updated for "${preset.name}".`);
    });

    // Variable Management tab: expand/collapse the JSON detail panel for a
    // row. Presentation only - reads no data and writes nothing.
    $overlay.on('click', '.se-varmgmt-toggle-json', function () {
        const $btn = $(this);
        const $row = $btn.closest('.se-varmgmt-row');
        const $detail = $row.find('.se-varmgmt-json-detail');
        const expanded = $detail.toggleClass('se-varmgmt-json-expanded').hasClass('se-varmgmt-json-expanded');

        $btn.attr('title', expanded ? 'Hide details' : 'Show details')
            .find('i')
            .toggleClass('fa-chevron-down', !expanded)
            .toggleClass('fa-chevron-up', expanded);
    });

    // Variable Management tab: delete / export / import a chat's stored
    // data. Each action targets whichever chatId is on the clicked row -
    // never "whichever chat happens to be open" - since a user managing
    // this tab is looking at potentially many chats at once.
    $overlay.on('click', '.se-varmgmt-delete', function () {
        const chatId = $(this).attr('data-chat-id');
        const settings = managerApi.getSettings();
        if (!settings.variableStore?.chats?.[chatId]) return;

        if (!window.confirm(`Delete all stored State Engine variables for chat "${chatId}"? This cannot be undone.`)) return;

        delete settings.variableStore.chats[chatId];
        managerApi.persistSettings(settings);
        uiRender.renderVariableManagementTab(managerApi);
        managerApi.setStatus(`Deleted stored variables for "${chatId}".`);
        managerApi.renderTrackerPanel();
    });

    $overlay.on('click', '.se-varmgmt-export', function () {
        const chatId = $(this).attr('data-chat-id');
        const settings = managerApi.getSettings();
        const state = settings.variableStore?.chats?.[chatId];
        if (!state) return;

        const json = JSON.stringify(state, null, 2);
        navigator.clipboard.writeText(json).then(() => {
            managerApi.setStatus(`Copied stored variables for "${chatId}" to clipboard.`);
        }).catch(err => {
            console.error('Failed to copy:', err);
            managerApi.setStatus('Failed to copy to clipboard.', true);
        });
    });

    $overlay.on('click', '.se-varmgmt-import', function () {
        const chatId = $(this).attr('data-chat-id');
        const settings = managerApi.getSettings();
        const hasExisting = !!settings.variableStore?.chats?.[chatId];

        const raw = window.prompt(`Paste JSON to import for chat "${chatId}". This will overwrite this chat's stored variables.`, '');
        if (raw === null || raw.trim() === '') return;

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            alert('Invalid JSON - import cancelled.');
            return;
        }

        if (!parsed || typeof parsed !== 'object' || typeof parsed.variables !== 'object' || parsed.variables === null) {
            alert('That JSON does not look like stored chat data (expected an object with a "variables" field) - import cancelled.');
            return;
        }

        if (hasExisting && !window.confirm(`Chat "${chatId}" already has stored variables. Overwrite them with the pasted data?`)) return;

        if (!settings.variableStore) settings.variableStore = { chats: {} };
        if (!settings.variableStore.chats) settings.variableStore.chats = {};
        settings.variableStore.chats[chatId] = parsed;
        managerApi.persistSettings(settings);

        // Only re-mirror into macro store if this is the chat currently open -
        // context.variables.local only ever reflects whichever chat is active
        // (spec 1.2), so hydrating any other chatId here would be a no-op at
        // best and a misdirected write at worst.
        if (SillyTavern.getContext().chatId === chatId) {
            hydrateMacroStoreForChat(chatId);
        }

        uiRender.renderVariableManagementTab(managerApi);
        managerApi.setStatus(`Imported stored variables for "${chatId}".`);
        managerApi.renderTrackerPanel();
    });

    // Debug mode controls
    $overlay.on('click', '#se-manager-debug-toggle', function () {
        const enabled = managerApi.toggleDebugMode();
        uiRender.renderDebugTab(managerApi);
        managerApi.setStatus(`Debug mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
    });

    $overlay.on('click', '#se-manager-debug-copy-json', function () {
        const debugInfo = managerApi.getDebugInfo();
        const json = JSON.stringify(debugInfo, null, 2);
        navigator.clipboard.writeText(json).then(() => {
           managerApi.setStatus('Debug info copied to clipboard!');
        }).catch(err => {
           console.error('Failed to copy:', err);
           managerApi.setStatus('Failed to copy to clipboard');
        });
    });

    $overlay.on('click', '#se-manager-debug-log-console', function () {
        const debugInfo = managerApi.getDebugInfo();
        console.log('%c=== STATE ENGINE DEBUG INFO ===', 'background: #222; color: #bada55; font-weight: bold');
        console.table(debugInfo);
        console.log('Full settings:', debugInfo.fullSettings);
        managerApi.setStatus('Debug info logged to console');
    });

    $overlay.on('change', '#se-manager-prompted-toggle', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const isOn = $(this).is(':checked');

        // UI-only toggles
        $overlay.find('.se-manager-prompted-section').toggle(isOn);
        $overlay.find('.se-manager-increment-heartbeat').toggle(!isOn);

        setTimeout(() => {
            const values = collectInlineVariableValues($row);

            // Ensure behaviors exists
            values.behaviors = values.behaviors || {};

            // Inject BOTH behaviors
            values.behaviors.prompted = isOn;
            values.behaviors.increment = $('#se-manager-increment-toggle').is(':checked');

            showInlineVariableEditor(values, $row);
        }, 0);
    });

    $overlay.on('change', '#se-manager-increment-toggle', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const isOn = $(this).is(':checked');

        // UI-only toggles
        $overlay.find('.se-manager-increment-settings').toggle(isOn);

        setTimeout(() => {
            const values = collectInlineVariableValues($row);

            values.behaviors = values.behaviors || {};

            // Inject BOTH behaviors
            values.behaviors.increment = isOn;
            values.behaviors.prompted = $('#se-manager-prompted-toggle').is(':checked');

            // Sorted and increment are mutually exclusive for arrays -
            // turning increment on forces sorted off (the reverse direction
            // is enforced by the [data-field="sorted"] handler below).
            if (isOn) values.sorted = false;

            showInlineVariableEditor(values, $row);
        }, 0);
    });

    // Sorted and increment are mutually exclusive for arrays (sorted +
    // rotate/push/unshift/pop/shift all produce ambiguous or contradictory
    // results) - checking "Keep sorted" forces increment off. Unchecking it
    // must ALSO re-render even though nothing needs forcing on that side -
    // the increment toggle's disabled attribute was computed from the old
    // (sorted=true) render and won't lift itself without a fresh one. An
    // earlier version of this handler returned early on uncheck, leaving
    // increment stuck disabled until the editor was closed and reopened.
    $overlay.on('change', '[data-field="sorted"]', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const isOn = $(this).is(':checked');

        const values = collectInlineVariableValues($row);
        values.sorted = isOn;
        values.behaviors = values.behaviors || {};
        if (isOn) values.behaviors.increment = false;

        showInlineVariableEditor(values, $row);
    });

    $overlay.on('change', '[data-field="type"]', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const $editor = $row.find('.se-manager-variable-editor-inline');

        // Pull current working values from the editor
        const values = collectInlineVariableValues($row);

        // Update only the type in the working copy
        values.type = $(this).val();

        // Re-render the editor with updated working copy
        showInlineVariableEditor(values, $row);
    });

    $overlay.on('change', '[data-field="type"]', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const $editor = $row.find('.se-manager-variable-editor-inline');

        const values = collectInlineVariableValues($row);
        values.type = $(this).val();

        // Disable increment for strings
        if (values.type === 'string') {
            values.behaviors.increment = false;
        }

        showInlineVariableEditor(values, $row);
    });

    // Typed array editor: re-render on itemType change (show/hide the item
    // enum editor) and on increment.operation change (show/hide the operand
    // field) - same pattern as the top-level type-select handler above.
    $overlay.on('change', '[data-field="itemType"]', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const values = collectInlineVariableValues($row);
        values.itemType = $(this).val();
        showInlineVariableEditor(values, $row);
    });

    $overlay.on('change', '[data-field="increment.operation"]', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const values = collectInlineVariableValues($row);
        values.increment = values.increment || {};
        values.increment.operation = $(this).val();
        showInlineVariableEditor(values, $row);
    });

    // Enum values editor: row add/delete edit the DOM directly (no re-render
    // needed - collectInlineVariableValues() reads current row order/values
    // at save time). Never touches presets, the variable store, or the
    // macro store directly.
    $overlay.on('click', '.se-manager-enum-add', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const $editor = $row.find('.se-manager-variable-editor-inline');
        const $list = $editor.find('.se-manager-enum-list');

        const $item = $(`
            <div class="se-manager-enum-row">
                <span class="se-manager-enum-grip"><i class="fa-solid fa-grip-vertical"></i></span>
                <input class="text_pole se-manager-enum-item" value="New Entry" />
                <button class="menu_button se-manager-enum-delete" title="Remove value">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `);

        $list.append($item);
    });

    $overlay.on('click', '.se-manager-enum-delete', function () {
        $(this).closest('.se-manager-enum-row').remove();
    });

    // Array default-value row editor: same "edit the DOM directly, collect
    // at save time" approach as the enum list above. A freshly-added row's
    // shape depends on the array's current itemType, read live from the DOM
    // rather than a possibly-stale working copy.
    $overlay.on('click', '.se-manager-array-add', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const $editor = $row.find('.se-manager-variable-editor-inline');
        const $list = $editor.find('.se-manager-array-list');

        const itemType = $editor.find('[data-field="itemType"]').val() || 'any';

        let itemHtml;
        if (itemType === 'enum') {
            const raw = $editor.find('[data-field="itemEnumValuesMultiline"]').val() || '';
            const allowed = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            const opts = allowed.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
            itemHtml = `<select class="text_pole se-manager-array-item">${opts}</select>`;
        } else if (itemType === 'object') {
            itemHtml = `<span class="se-manager-array-item-placeholder">Object item editor coming soon</span>`;
        } else {
            itemHtml = `<input class="text_pole se-manager-array-item" value="" />`;
        }

        const $item = $(`
            <div class="se-manager-array-row">
                <span class="se-manager-array-grip"><i class="fa-solid fa-grip-vertical"></i></span>
                ${itemHtml}
                <button type="button" class="menu_button se-manager-array-delete" title="Remove item">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `);

        $list.append($item);
    });

    $overlay.on('click', '.se-manager-array-delete', function () {
        $(this).closest('.se-manager-array-row').remove();
    });

    $overlay.on('click', '#se-manager-new-variable', function () {
        const presetId = managerState.currentPresetId;
        if (!presetId) {
            alert('Select a preset first.');
            return;
        }

        // Create a blank variable using the modern schema
        const newVar = managerApi.blankDefinition();
        newVar.id = generateUUID();

        // Insert into preset BEFORE opening editor
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        preset.variables[newVar.id] = newVar;

        managerApi.persistSettings(settings);

        // Re-render the variables tab
        managerState.currentPresetId = presetId;
        uiRender.renderVariablesTab(managerApi, managerState.currentPresetId);

        // Find the new row
        const $row = $(`#se-manager-variable-list .se-manager-variable-row[data-var-id="${newVar.id}"]`);

        // Open the inline editor for the new variable
        showInlineVariableEditor({ ...newVar, _isNew: true }, $row);
    });

    // ---------------------------------------------------------------------
    // Helpers used exclusively by the event handlers above
    // ---------------------------------------------------------------------

    function showInlineVariableEditor(varDef, $row) {
        // Default structure for new variables
        const defaults = managerApi.blankDefinition();
            defaults.id = generateUUID();

        // Merge defaults into existing varDef
        const d = variableSchema.mergeDefinition(defaults, varDef);
        const canIncrement = variableSchema.canIncrement(d.type);

        const $editor = $row.find('.se-manager-variable-editor-inline');

        $editor.html(uiTemplates.buildInlineVariableEditor(d, canIncrement)).data('editing-id', d.id).data('editing-existing', !d._isNew).show();

        // Enable drag-and-drop reordering for the enum and array-default
        // list editors, if present.
        setTimeout(() => {
            const $enumList = $editor.find('.se-manager-enum-list');
            if ($enumList.length && $enumList.sortable) {
                $enumList.sortable({
                    handle: '.se-manager-enum-grip',
                    axis: 'y',
                    containment: 'parent'
                });
            }

            const $arrayList = $editor.find('.se-manager-array-list');
            if ($arrayList.length && $arrayList.sortable) {
                $arrayList.sortable({
                    handle: '.se-manager-array-grip',
                    axis: 'y',
                    containment: 'parent'
                });
            }
        }, 0);

        // Disable other controls
        $('#se-manager-new-variable, #se-manager-variable-search, #se-manager-variable-sort').prop('disabled', true).css('opacity', '0.5');
        $row.siblings('.se-manager-variable-row').css('opacity', '0.5').find('button:not(.se-manager-edit-variable)').prop('disabled', true);
        $row.find('.se-manager-variable-row-header').css('opacity', '0.5').find('button').prop('disabled', true);
    }

    function hideInlineVariableEditor($row) {
        $row.find('.se-manager-variable-editor-inline').hide().empty().removeData('editing-id').removeData('editing-existing');
        
        // Re-enable other controls
        $('#se-manager-new-variable, #se-manager-variable-search, #se-manager-variable-sort').prop('disabled', false).css('opacity', '1');
        $row.siblings('.se-manager-variable-row').css('opacity', '1').find('button').prop('disabled', false);
        $row.find('.se-manager-variable-row-header').css('opacity', '1').find('button').prop('disabled', false);
    }

    function collectInlineVariableValues($row) {
        const $editor = $row.find('.se-manager-variable-editor-inline');
        const values = { id: $editor.data('editing-id') };

        // Helper: assign nested fields from dotted paths
        function assignNested(obj, path, value) {
            const parts = path.split('.');
            let current = obj;

            for (let i = 0; i < parts.length - 1; i++) {
                const key = parts[i];
                if (!current[key]) current[key] = {};
                current = current[key];
            }

            current[parts[parts.length - 1]] = value;
        }

        // Collect all fields
        $editor.find('.se-manager-var-field').each(function () {
            const $field = $(this);
            const field = $field.attr('data-field');
            const value = $field.is(':checkbox') ? $field.is(':checked') : $field.val();
            assignNested(values, field, value);
        });

        // Enum list editor rows serialize into enumValuesMultiline, which the
        // existing normalization pipeline (normalizeCollectedValues) already
        // splits on newline, trims, and dedupes.
        const enumLines = [];
        $editor.find('.se-manager-enum-item').each(function () {
            enumLines.push($(this).val());
        });
        values.enumValuesMultiline = enumLines.join('\n');

        // Array default-value row editor: rows serialize into defaultValue
        // itself, as a JSON array string - getDefaultValue() (variable-schema.js)
        // already accepts a JSON-string array default, so no new field was
        // needed. Only runs when the array row editor is actually present,
        // so non-array types keep using whatever the generic
        // .se-manager-var-field loop above already collected for
        // defaultValue from the plain text input.
        const $arrayList = $editor.find('.se-manager-array-list');
        if ($arrayList.length) {
            const items = [];
            $arrayList.find('.se-manager-array-row').each(function () {
                const $input = $(this).find('.se-manager-array-item');
                if ($input.length) {
                    items.push($input.val());
                } else {
                    // Object-array placeholder rows have no editable content yet.
                    items.push({});
                }
            });
            values.defaultValue = JSON.stringify(items);
        }

        values.showInTracker = true;
        return values;
    }
}
