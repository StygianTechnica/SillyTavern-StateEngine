// State Engine — Manager modal tab rendering
// Uses ES6 modules - imported by manager-modal.js

import * as uiTemplates from './ui-templates.js';
import { escapeHtml } from './utils.js';

export function renderPresetsTab(managerApi, managerCurrentPresetId) {
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

    const html = uiTemplates.buildPresetsTabContainer(presetRows);

    $tab.html(html);
}

export function renderVariablesTab(managerApi, managerCurrentPresetId) {
    const settings = managerApi.getSettings();
    const $tab = $('#se-manager-variables-tab');
    if (!$tab.length) return managerCurrentPresetId;

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

    const html = uiTemplates.buildVariablesTabContainer(presetOptions, variablesList, showActiveOnly);

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

    return selectedPresetId;
}

export function renderWorldInfoTab(managerApi) {
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

    const html = uiTemplates.buildWorldInfoTabContainer(conditionRows, conditionCount);

    $tab.html(html);
}

export function renderDebugTab(managerApi) {
    const $tab = $('#se-manager-debug-tab');
    if (!$tab.length) return;

    const debugInfo = managerApi.getDebugInfo();
    const isEnabled = debugInfo.debugEnabled;

    const activePresetsHtml = uiTemplates.buildDebugActivePresets(debugInfo);

    const variablesHtml = uiTemplates.buildDebugVariablesTable(debugInfo);

    const html = uiTemplates.buildDebugTabContainer(activePresetsHtml, variablesHtml, isEnabled, debugInfo);

    $tab.html(html);
}

// ---------------------------------------------------------------------------
// Private helpers used only by renderVariablesTab's search/sort wiring
// ---------------------------------------------------------------------------

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
