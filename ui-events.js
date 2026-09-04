// State Engine — Manager modal event wiring
// Uses ES6 modules - imported by manager-modal.js

import * as presetManager from './preset-manager.js';
import * as variableSchema from './variable-schema.js';
import * as uiTemplates from './ui-templates.js';
import * as uiRender from './ui-render.js';
import { generateUUID } from './utils.js';

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

        managerApi.persistSettings(settings);
        hideInlineVariableEditor($row);
        managerState.currentPresetId = uiRender.renderVariablesTab(managerApi, managerState.currentPresetId);
        managerApi.setStatus(isNew ? 'Variable created.' : 'Variable updated.');
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

            showInlineVariableEditor(values, $row);
        }, 0);
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

        values.showInTracker = true;
        return values;
    }
}
