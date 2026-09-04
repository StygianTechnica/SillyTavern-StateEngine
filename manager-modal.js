// State Engine Manager Modal
// Complete tabbed interface for preset/variable/trigger/worldinfo management
// Uses ES6 modules - imported by index.js

import * as presetManager from './preset-manager.js';
import * as variableSchema from './variable-schema.js';
import * as uiTemplates from './ui-templates.js';
import { escapeHtml, generateUUID } from './utils.js';

let managerCurrentPresetId = null;
let managerApi = null;

export function setManagerApi(api) {
    managerApi = api;
    presetManager.setManagerApi(api);
}

export function buildManagerModal() {
    // Check if modal already exists
    if ($('#se-manager-overlay').length) {
        return showManagerModal();
    }

    const settings = managerApi.getSettings();

    // Build main overlay and window
    const $overlay = $('<div></div>')
        .attr('id', 'se-manager-overlay')
        .addClass('se-manager-overlay');

    const $window = $('<div></div>')
        .attr('id', 'se-manager-window')
        .addClass('se-manager-window');

    const $header = $('<div></div>')
        .addClass('se-manager-header')
        .html(`
            <h2>State Engine Manager</h2>
            <button id="se-manager-close" class="se-manager-close-btn" title="Close">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `);

    // Build tab buttons
    const $tabButtons = $('<div></div>')
        .addClass('se-manager-tabs')
        .html(`
            <button class="se-manager-tab-btn se-manager-tab-active" data-tab="presets">
                <i class="fa-solid fa-boxes-stacked"></i> Presets
            </button>
            <button class="se-manager-tab-btn" data-tab="variables">
                <i class="fa-solid fa-list"></i> Variables
            </button>
            <button class="se-manager-tab-btn" data-tab="worldinfo">
                <i class="fa-solid fa-book"></i> World Info
            </button>
            <button class="se-manager-tab-btn" data-tab="debug">
                <i class="fa-solid fa-bug"></i> Debug
            </button>
        `);

    // Build tab content container
    const $content = $('<div></div>')
        .addClass('se-manager-content')
        .html(`
            <div class="se-manager-tab-pane se-manager-tab-active" data-tab="presets" id="se-manager-presets-tab"></div>
            <div class="se-manager-tab-pane" data-tab="variables" id="se-manager-variables-tab"></div>
            <div class="se-manager-tab-pane" data-tab="worldinfo" id="se-manager-worldinfo-tab"></div>
            <div class="se-manager-tab-pane" data-tab="debug" id="se-manager-debug-tab"></div>
        `);

    $window.append($header, $tabButtons, $content);
    $overlay.append($window);
    $('body').append($overlay);

    // Initial tab rendering
    renderManagerPresetsTab();
    renderManagerVariablesTab();
    renderManagerWorldInfoTab();

    // Wire events
    wireManagerModalEvents();

    return showManagerModal();
}

export function showManagerModal() {
    const $overlay = $('#se-manager-overlay');
    if ($overlay.length) {
        $overlay.fadeIn(200);
    }
}

export function hideManagerModal() {
    const $overlay = $('#se-manager-overlay');
    if ($overlay.length) {
        $overlay.fadeOut(200);
    }
}

export function renderManagerPresetsTab() {
    const settings = managerApi.getSettings();
    const $tab = $('#se-manager-presets-tab');
    if (!$tab.length) return;

    $tab.empty();

    // Get current chat ID
    const currentChatId = managerApi.getCurrentChatId();

    const chatPresets = managerApi.getPresetsForChat(currentChatId);
    const allPresets = settings.presets || {};
    
    const TRIGGER_KEYS = [
        { key: 'startup', label: 'Execute on startup', icon: 'fa-rocket' },
        { key: 'user', label: 'Execute on user message', icon: 'fa-user' },
        { key: 'ai', label: 'Execute on AI message', icon: 'fa-robot' },
        { key: 'chat_change', label: 'Execute on chat change', icon: 'fa-comment' },
        { key: 'new_chat', label: 'Execute on new chat', icon: 'fa-comments' },
        { key: 'group_draft', label: 'Execute on group member draft', icon: 'fa-users' },
        { key: 'pre_generation', label: 'Execute before message generation', icon: 'fa-paper-plane' }
    ];

    const presetRows = Object.entries(allPresets)
        .sort(([aId], [bId]) => {
            const aActive = chatPresets.includes(aId) ? 1 : 0;
            const bActive = chatPresets.includes(bId) ? 1 : 0;
            return bActive - aActive;
        })
        .map(([presetId, preset]) => uiTemplates.buildPresetRow(presetId, preset, chatPresets, TRIGGER_KEYS, currentChatId))
        .join('');

    const html = `
        <div class="se-manager-section">
            <div class="se-manager-section-header">
                <h3>Presets</h3>
                <div class="se-manager-section-buttons">
                    <button id="se-manager-restore-presets" class="menu_button" title="Restore default presets">
                        <i class="fa-solid fa-redo"></i> Restore Defaults
                    </button>
                    <button id="se-manager-new-preset" class="menu_button" title="Create a new preset">
                        <i class="fa-solid fa-plus"></i> New
                    </button>
                </div>
            </div>
            <div class="se-manager-preset-list">
                ${presetRows || '<div class="se-empty">No presets yet. Click New to create one.</div>'}
            </div>
        </div>
    `;

    $tab.html(html);
}

export function renderManagerVariablesTab() {
    const settings = managerApi.getSettings();
    const $tab = $('#se-manager-variables-tab');
    if (!$tab.length) return;

    $tab.empty();

    // Preset selector
    const activePresetIds = managerApi.getPresetsForChat(managerApi.getCurrentChatId());
    const allPresets = Object.keys(settings.presets || {});
    const selectedPresetId = allPresets.includes(managerCurrentPresetId)
        ? managerCurrentPresetId
        : activePresetIds[0] || allPresets[0] || null;

    managerCurrentPresetId = selectedPresetId;

    const showActiveOnly = window.managerShowActiveOnly || false;
    const presetsToShow = showActiveOnly
        ? allPresets.filter(id => activePresetIds.includes(id))
        : allPresets;

    const presetOptions = presetsToShow
        .map(id => {
            const preset = settings.presets[id];
            const isActive = activePresetIds.includes(id);
            const indicator = isActive ? ' ✓' : '';
            return `<option value="${id}">${escapeHtml(preset.name)}${indicator}</option>`;
        })
        .join('');

    let variablesList = '';
    if (selectedPresetId && settings.presets[selectedPresetId]) {
        const preset = settings.presets[selectedPresetId];
        const variableEntries = Object.entries(preset.variables || {});
        variablesList = variableEntries
            .map(([varId, varDef], index) => uiTemplates.buildVariablesListRow(varId, varDef, index, variableEntries.length, selectedPresetId))
            .join('');
    }

    const html = `
        <div class="se-manager-section">
            <div class="se-manager-section-header">
                <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
                    <h3 style="margin: 0;">Variables for Preset:</h3>
                    <select id="se-manager-preset-selector" class="text_pole">
                        <option value="">-- Select preset --</option>
                        ${presetOptions}
                    </select>
                    <label style="margin: 0; white-space: nowrap; display: flex; align-items: center; gap: 4px;">
                        <input type="checkbox" id="se-manager-filter-active" ${showActiveOnly ? 'checked' : ''} />
                        <span style="font-size: 0.9em;">Show active only</span>
                    </label>
                </div>
            </div>
             
            <div class="se-manager-section-header">
                <button id="se-manager-new-variable" class="menu_button" title="Create a new variable">
                    <i class="fa-solid fa-plus"></i> New Variable
                </button>
                <div style="flex: 1;"></div>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <input 
                        type="text" 
                        id="se-manager-variable-search" 
                        class="text_pole" 
                        placeholder="Search variables..." 
                        style="width: 200px; padding: 4px 8px; font-size: 0.9em;" 
                    />
                    <select id="se-manager-variable-sort" class="text_pole" style="width: 120px; padding: 4px 8px; font-size: 0.9em;">
                        <option value="tracker">Tracker order</option>
                        <option value="name-asc">Name (A-Z)</option>
                        <option value="name-desc">Name (Z-A)</option>
                    </select>
                </div>
            </div>

            <div class="se-manager-variable-list" id="se-manager-variable-list">
                ${variablesList || '<div class="se-empty">No variables in this preset yet.</div>'}
            </div>
        </div>
    `;

    $tab.html(html);

    // Set selected preset
    if (selectedPresetId) {
        $('#se-manager-preset-selector').val(selectedPresetId);
    }

    // Wire up search and sort handlers
    $('#se-manager-variable-search').on('input', filterAndSortVariables);
    $('#se-manager-variable-sort').on('change', function () {
        filterAndSortVariables();
        updateMoveButtonStates();
    });

    // Set initial button states
    updateMoveButtonStates();
}

export function renderManagerWorldInfoTab() {
    const settings = managerApi.getSettings();
    const $tab = $('#se-manager-worldinfo-tab');
    if (!$tab.length) return;

    $tab.empty();

    const conditions = settings.wiConditions || {};
    const conditionCount = Object.keys(conditions).length;
    const conditionRows = Object.entries(conditions)
        .slice(0, 50) // Limit to 50 for display
        .map(([key, conds]) => {
            const condList = Array.isArray(conds) ? conds : [];
            return uiTemplates.buildWorldInfoRow(key, condList);
        })
        .join('');

    const html = `
        <div class="se-manager-section">
            <h3>World Info Conditions</h3>
            <small>Displays conditions set on World Info entries. Total entries: ${conditionCount}</small>
            <div class="se-manager-worldinfo-list">
                ${conditionRows || '<div class="se-empty">No World Info conditions set yet.</div>'}
            </div>
        </div>
    `;

    $tab.html(html);
}

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


function collectVariableEditorValues() {
    const $editor = $('#se-manager-variable-editor');
    const values = { id: $editor.data('editing-id') };
    $editor.find('.se-manager-var-field').each(function () {
        const $field = $(this);
        const field = $field.attr('data-field');
        values[field] = $field.is(':checkbox') ? $field.is(':checked') : $field.val();
    });
    values.showInTracker = true;
    values.prompted = { instructions: String($editor.find('.se-manager-prompted-instructions').val() || '') };
    return values;
}

export function renderManagerDebugTab() {
    const $tab = $('#se-manager-debug-tab');
    if (!$tab.length) return;

    const debugInfo = managerApi.getDebugInfo();
    const isEnabled = debugInfo.debugEnabled;

    const activePresetsHtml = uiTemplates.buildDebugActivePresets(debugInfo);

    const variablesHtml = uiTemplates.buildDebugVariablesTable(debugInfo);

    const html = `
        <div class="se-manager-section">
            <div class="se-manager-section-header">
                <h3 style="margin: 0;">Debug Mode</h3>
                <div class="se-manager-section-buttons">
                    <button id="se-manager-debug-toggle" class="menu_button" title="Toggle debug logging">
                        <i class="fa-solid ${isEnabled ? 'fa-check-circle' : 'fa-circle'}"></i> 
                        ${isEnabled ? 'Disable' : 'Enable'}
                    </button>
                </div>
            </div>
            <div style="margin-bottom: 12px; padding: 8px; background: #1a1a1a; border-left: 2px solid ${isEnabled ? '#7ec699' : '#666'}; border-radius: 2px;">
                <div><strong>Status:</strong> <span style="color: ${isEnabled ? '#7ec699' : '#999'};">${isEnabled ? 'ENABLED' : 'DISABLED'}</span></div>
                <small style="color: #aaa;">Debug mode logs additional info to console and displays diagnostic data below.</small>
            </div>
        </div>

        <div class="se-manager-section">
            <h3 style="margin-top: 0;">Chat Information</h3>
            <div style="font-family: monospace; font-size: 0.9em; background: #1a1a1a; padding: 8px; border-radius: 4px;">
                <div><strong>Chat ID:</strong> <code>${debugInfo.chatId ? escapeHtml(debugInfo.chatId) : '(no chat selected)'}</code></div>
                <div><strong>Timestamp:</strong> <code>${debugInfo.currentTimestamp}</code></div>
                <div><strong>Total Presets:</strong> ${debugInfo.totalPresets}</div>
            </div>
        </div>

        <div class="se-manager-section">
            <h3>Active Presets</h3>
            ${activePresetsHtml}
        </div>

        <div class="se-manager-section">
            <h3>Variables in Active Presets</h3>
            ${variablesHtml}
        </div>

        <div class="se-manager-section">
            <h3>Export & Inspect</h3>
            <div class="se-manager-section-buttons">
                <button id="se-manager-debug-copy-json" class="menu_button" title="Copy debug info as JSON">
                    <i class="fa-solid fa-copy"></i> Copy JSON
                </button>
                <button id="se-manager-debug-log-console" class="menu_button" title="Log debug info to console">
                    <i class="fa-solid fa-terminal"></i> Log to Console
                </button>
            </div>
            <small style="color: #999; display: block; margin-top: 8px;">
                Click "Copy JSON" to copy all debug data to clipboard, or "Log to Console" to inspect in the browser developer tools.
            </small>
        </div>
    `;

    $tab.html(html);
}

function filterAndSortVariables() {
    const $list = $('#se-manager-variable-list');
    if (!$list.length) return;

    const searchTerm = $('#se-manager-variable-search').val().toLowerCase();
    const sortMode = $('#se-manager-variable-sort').val() || 'tracker';
    let $rows = $list.find('.se-manager-variable-row');

    // Filter based on search (partial match on both name and label)
    $rows.each(function () {
        const $row = $(this);
        const varName = $row.data('var-name') || '';
        const varLabel = $row.data('var-label') || '';
        
        // Show if: no search term, OR name contains term, OR label contains term
        if (searchTerm === '' || varName.includes(searchTerm) || varLabel.includes(searchTerm)) {
            $row.show();
        } else {
            $row.hide();
        }
    });

    // Get visible rows for sorting
    $rows = $list.find('.se-manager-variable-row:visible');
    const visibleRows = Array.from($rows);

    // Sort based on selected mode
    if (sortMode === 'tracker') {
        // Tracker order: show only variables that appear in tracker (showInTracker !== false), keep original order
        visibleRows.forEach(row => {
            const $row = $(row);
            const showInTracker = $row.data('show-in-tracker') === 'true' || $row.data('show-in-tracker') === true;
            if (showInTracker) {
                $row.show();
            } else {
                $row.hide();
            }
        });
    } else if (sortMode === 'name-asc' || sortMode === 'name-desc') {
        visibleRows.sort((a, b) => {
            const $aRow = $(a);
            const $bRow = $(b);
            const aName = $aRow.data('var-name');
            const bName = $bRow.data('var-name');
            const aLabel = $aRow.data('var-label');
            const bLabel = $bRow.data('var-label');

            if (sortMode === 'name-asc') {
                return (aLabel || aName).localeCompare(bLabel || bName);
            } else {
                return (bLabel || bName).localeCompare(aLabel || aName);
            }
        });

        // Re-append sorted rows
        visibleRows.forEach(row => {
            $list.append(row);
        });
    }

    // Show "no results" message if all hidden
    if ($list.find('.se-manager-variable-row:visible').length === 0) {
        if ($list.find('.se-empty').length === 0) {
            $list.append('<div class="se-empty">No variables match your search or filter.</div>');
        }
    } else {
        $list.find('.se-empty').remove();
    }
}

function updateMoveButtonStates() {
    const sortMode = $('#se-manager-variable-sort').val() || 'order';
    const isTrackerOrder = sortMode === 'tracker';
    
    // Enable/disable all move buttons based on sort mode
    const $moveButtons = $('.se-manager-move-variable-up, .se-manager-move-variable-down');
    $moveButtons.prop('disabled', !isTrackerOrder);
    
    // Add/remove class for visual feedback
    if (isTrackerOrder) {
        $moveButtons.removeClass('se-button-disabled');
    } else {
        $moveButtons.addClass('se-button-disabled');
    }
}

export function wireManagerModalEvents() {
    const $overlay = $('#se-manager-overlay');
    if (!$overlay.length) return;

    // Close modal
    $overlay.on('click', '#se-manager-close', function () {
        hideManagerModal();
    });

    // Close on overlay click (outside window)
    $overlay.on('click', function (e) {
        if (e.target === this) {
            hideManagerModal();
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
        if (tab === 'presets') renderManagerPresetsTab();
        else if (tab === 'variables') renderManagerVariablesTab();
        else if (tab === 'worldinfo') renderManagerWorldInfoTab();
        else if (tab === 'debug') renderManagerDebugTab();
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
            renderManagerPresetsTab();
            managerApi.renderVarTable();
            managerApi.setStatus('Restored default presets.');
        }
    });

    $overlay.on('click', '#se-manager-new-preset', function () {
        const name = prompt('New preset name:');
        if (name && name.trim()) {
            managerApi.createPreset(name.trim());
            renderManagerPresetsTab();
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
        renderManagerPresetsTab();
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
            renderManagerPresetsTab();
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
            renderManagerPresetsTab();
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
            if (managerCurrentPresetId === presetId) managerCurrentPresetId = null;
            renderManagerPresetsTab();
            renderManagerVariablesTab();
            managerApi.setStatus(`Deleted "${preset.name}" and all its variables.`);
        }
    });

    // Variables tab
    $overlay.on('change', '#se-manager-preset-selector', function () {
        const presetId = $(this).val();
        managerCurrentPresetId = presetId;
        renderManagerVariablesTab();
    });

    $overlay.on('change', '#se-manager-filter-active', function () {
        window.managerShowActiveOnly = $(this).prop('checked');
        renderManagerVariablesTab();
    });

    $overlay.on('click', '.se-manager-edit-variable', function () {
        const varId = $(this).attr('data-var-id');
        const presetId = $(this).attr('data-preset-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset || !preset.variables || !preset.variables[varId]) return;
        managerCurrentPresetId = presetId;
        
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
            renderManagerVariablesTab();
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
            renderManagerVariablesTab();
            managerApi.renderTrackerPanel(); // Update tracker with new variable order
        }
    });

    $overlay.on('click', '.se-manager-toggle-visibility', function () {
        const varId = $(this).attr('data-var-id');
        const presetId = $(this).attr('data-preset-id');
        const varDef = presetManager.toggleVariableVisibility(presetId, varId);
        if (!varDef) return;

        renderManagerVariablesTab();
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
            renderManagerVariablesTab();
            managerApi.setStatus(`Variable deleted.`);
        }
    });

    $overlay.on('click', '.se-manager-cancel-variable-inline', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const $editor = $row.find('.se-manager-variable-editor-inline');

        const isNew = !$editor.data('editing-existing');
        const varId = $editor.data('editing-id');

        if (isNew) {
            presetManager.deleteVariable(managerCurrentPresetId, varId);
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
        const presetId = managerCurrentPresetId;
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
        renderManagerVariablesTab();
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
        renderManagerPresetsTab();

        managerApi.setStatus(`Description updated for "${preset.name}".`);
    });

    // Debug mode controls
    $overlay.on('click', '#se-manager-debug-toggle', function () {
        const enabled = managerApi.toggleDebugMode();
        renderManagerDebugTab();
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
}

