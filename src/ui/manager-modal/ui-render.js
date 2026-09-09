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
        // Visible variables first, hidden (showInTracker === false) grouped
        // below them (item 6, 2026-09-09). A stable sort (guaranteed by the
        // spec since ES2019) only reorders across that visible/hidden
        // boundary - ties keep their existing relative order, so this never
        // fights with drag/up-down reordering within either group. This is
        // display order only; the underlying preset.variables order (what
        // drag-and-drop and the up/down arrows actually persist) is
        // untouched here.
        const variableEntries = Object.entries(preset.variables || {})
            .sort(([, a], [, b]) => (a.showInTracker === false ? 1 : 0) - (b.showInTracker === false ? 1 : 0));
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

    // Drag-handle reordering (item 7, 2026-09-09) - the existing up/down
    // arrows (moveVariable, only enabled in "Tracker order" sort mode)
    // remain as a fallback; this is an additional, always-available way to
    // reorder. On drop, the *persisted* preset.variables order is rebuilt
    // from the row order currently in the DOM (which reflects the
    // visible/hidden grouping above, so a drag never fights with it) and
    // saved immediately - matching how moveVariable() already persists on
    // every click rather than requiring a separate save step.
    const $list = $('#se-manager-variable-list');
    if ($list.length && $list.sortable) {
        $list.sortable({
            handle: '.se-manager-variable-grip',
            axis: 'y',
            containment: 'parent',
            update: function () {
                const currentPreset = settings.presets[selectedPresetId];
                if (!currentPreset) return;

                const orderedIds = $list.find('.se-manager-variable-row').map(function () {
                    return $(this).attr('data-var-id');
                }).get();

                const rebuilt = {};
                for (const id of orderedIds) {
                    if (currentPreset.variables[id]) rebuilt[id] = currentPreset.variables[id];
                }
                // Defensive: never drop a variable the DOM pass didn't find
                // (shouldn't happen) - append it, preserving prior order.
                for (const [id, def] of Object.entries(currentPreset.variables)) {
                    if (!(id in rebuilt)) rebuilt[id] = def;
                }
                currentPreset.variables = rebuilt;

                managerApi.persistSettings(settings);
                managerApi.renderTrackerPanel();
            },
        });
    }

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

export function renderVariableManagementTab(managerApi) {
    const settings = managerApi.getSettings();
    const $tab = $('#se-manager-varmgmt-tab');
    if (!$tab.length) return;

    const store = settings.variableStore?.chats || {};
    const currentChatId = managerApi.getCurrentChatId();

    const rowsHtml = Object.entries(store)
        .sort(([, a], [, b]) => (b?.lastUpdated || 0) - (a?.lastUpdated || 0))
        .map(([chatId, state]) => uiTemplates.buildVariableManagementRow(chatId, state, chatId === currentChatId))
        .join('');

    $tab.html(uiTemplates.buildVariableManagementTab(rowsHtml));
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
