// State Engine — Manager modal tab rendering
// Uses ES6 modules - imported by manager-modal.js

import * as uiTemplates from './ui-templates.js';
import { escapeHtml } from './utils.js';
import { format, fromStructured, variablesUsingCalendar } from '../../core/calendar-engine.js';

// `presetsSubtab` ('regular' | 'independent', default 'regular') - which of
// the Presets tab's two subtabs (1.29) is showing. Both panes are always
// built (so switching subtabs is instant, no re-fetch), only one is visible.
export function renderPresetsTab(managerApi, managerCurrentPresetId, presetsSubtab = 'regular') {
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

    // 1.29: an independent preset never appears in the Regular Presets list -
    // the two subtabs are mutually exclusive views of the same settings.presets.
    const regularEntries = Object.entries(allPresets).filter(([, preset]) => preset?.independentPreset !== true);
    const presetRows = regularEntries
        .sort(([aId], [bId]) => {
            const aActive = chatPresets.includes(aId) ? 1 : 0;
            const bActive = chatPresets.includes(bId) ? 1 : 0;
            return bActive - aActive;
        })
        .map(([presetId, preset]) => uiTemplates.buildPresetRow(presetId, preset, chatPresets, TRIGGER_KEYS, currentChatId))
        .join('');
    const regularHtml = uiTemplates.buildPresetsTabContainer(presetRows);

    const connectionProfiles = managerApi.connectionProfiles ? managerApi.connectionProfiles() : [];
    const independentRows = Object.entries(allPresets)
        .filter(([, preset]) => preset?.independentPreset === true)
        .sort(([, a], [, b]) => (a.name || '').localeCompare(b.name || ''))
        .map(([presetId, preset]) => {
            const status = managerApi.getIndependentPresetStatus(presetId) || {
                enabled: true, contextMode: 'chat-history', lastRunAt: null, lastOutcome: 'never-run', lastError: null, changedVariables: [],
            };
            return uiTemplates.buildIndependentPresetRow(presetId, preset, currentChatId, status, connectionProfiles, managerApi.listCalendars());
        })
        .join('');
    const independentHtml = uiTemplates.buildIndependentPresetsTabContainer(independentRows);

    $tab.html(uiTemplates.buildPresetsTabShell(presetsSubtab, regularHtml, independentHtml));
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

    // Alphabetic by name (case-insensitive), not creation order - the
    // dropdown previously had no ordering at all, which made a preset hard
    // to find once there were more than a few.
    presetsToShow.sort((a, b) => (settings.presets[a]?.name || '').localeCompare(settings.presets[b]?.name || '', undefined, { sensitivity: 'base' }));

    const presetRows = presetsToShow
        .map(id => {
            const preset = settings.presets[id];
            const isActive = activePresetIds.includes(id);
            const indicator = isActive ? ' ✓' : '';
            // data-preset-name is the lowercased match target for the live
            // filter below; the visible label (with the active indicator)
            // stays in the row's text content, escaped separately.
            return `<div class="se-manager-preset-combobox-row" data-preset-id="${id}" data-preset-name="${escapeHtml((preset.name || '').toLowerCase())}">${escapeHtml(preset.name)}${indicator}</div>`;
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

    const selectedPresetName = selectedPresetId ? settings.presets[selectedPresetId]?.name : '';
    const html = uiTemplates.buildVariablesTabContainer(presetRows, variablesList, showActiveOnly, selectedPresetName, selectedPresetId);

    $tab.html(html);

    // Wire up search and sort handlers
    $('#se-manager-variable-search').on('input', filterAndSortVariables);
    $('#se-manager-variable-sort').on('change', function () {
        filterAndSortVariables();
        updateMoveButtonStates();
    });

    // Preset picker: a searchable dropdown (a combobox), not a plain
    // <select> - typing into it filters the row list live, in place (no
    // re-render, same technique as filterAndSortVariables above), rather
    // than only being able to jump to an option by its first letter.
    // Picking a row is wired in ui-events.js (it needs managerState to
    // switch the active preset); everything here is self-contained open/
    // filter/keyboard-nav/close behavior over the DOM this render just built.
    const $comboInput = $('#se-manager-preset-combobox-input');
    const $comboList = $('#se-manager-preset-combobox-list');

    const comboRows = () => $comboList.find('.se-manager-preset-combobox-row');
    // Not jQuery's :visible (layout-dependent - offsetWidth/offsetHeight,
    // which jsdom never computes, making it unusable in tests, and not what
    // is actually meant here anyway): rows are only ever toggled via inline
    // display none/block (filterPresetCombobox above), so checking that
    // directly is both precise and layout-independent.
    const comboVisibleRows = () => comboRows().filter(function () { return this.style.display !== 'none'; });
    const clearComboHighlight = () => comboRows().removeClass('se-manager-preset-combobox-row-active');
    const highlightCombo = ($row) => { clearComboHighlight(); if ($row && $row.length) $row.addClass('se-manager-preset-combobox-row-active'); };

    function filterPresetCombobox() {
        const term = $comboInput.val().trim().toLowerCase();
        comboRows().each(function () {
            const $row = $(this);
            $row.toggle(term === '' || ($row.attr('data-preset-name') || '').includes(term));
        });
        clearComboHighlight();
    }

    // Opening on focus/click must show every row, not re-filter by whatever
    // text already happens to be displayed (the selected preset's name) -
    // .select() only highlights that text for an easy overwrite, it does
    // NOT clear $comboInput.val(), so filterPresetCombobox() would otherwise
    // treat the CURRENT selection's own name as an active search term and
    // hide everything else the moment the box is opened.
    function openPresetComboboxShowingAll() {
        comboRows().show();
        clearComboHighlight();
        $comboList.show();
    }

    function openPresetCombobox() {
        filterPresetCombobox();
        $comboList.show();
    }

    // Closing without a pick always reverts the input to the ACTUALLY
    // selected preset's name - a half-typed search left in the box would
    // otherwise no longer match what the variable list below is showing.
    function closePresetCombobox() {
        $comboList.hide();
        clearComboHighlight();
        $comboInput.val(selectedPresetName || '');
    }

    $comboInput.on('focus click', function () {
        this.select(); // browser-address-bar style: typing immediately replaces it
        openPresetComboboxShowingAll();
    });
    $comboInput.on('input', openPresetCombobox);
    $comboInput.on('keydown', function (e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closePresetCombobox();
            this.blur();
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const $visible = comboVisibleRows();
            if (!$visible.length) return;
            const $current = $comboList.find('.se-manager-preset-combobox-row-active');
            let idx = $current.length ? $visible.index($current) : -1;
            idx = e.key === 'ArrowDown' ? Math.min(idx + 1, $visible.length - 1) : Math.max(idx - 1, 0);
            const $next = $visible.eq(idx);
            highlightCombo($next);
            // Not implemented at all in jsdom (and conceivably absent in
            // other embedding contexts) - guarded rather than assumed.
            $next.get(0)?.scrollIntoView?.({ block: 'nearest' });
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            // Not ':visible' (same layout-dependent, jsdom-incompatible
            // check already replaced in comboVisibleRows above) - the
            // highlight is only ever placed on a row that was already
            // confirmed visible when it was highlighted, so no extra
            // filter is needed here at all.
            const $active = $comboList.find('.se-manager-preset-combobox-row-active');
            const $target = $active.length ? $active : comboVisibleRows().first();
            if ($target.length) $target.trigger('click');
        }
    });

    // Click-outside closes without changing the selection. Namespaced and
    // rebound (off then on) on every call - this function runs again on
    // every preset switch/filter toggle, so without the off() first this
    // would stack a fresh document-level handler on each one.
    $(document).off('mousedown.sePresetCombobox').on('mousedown.sePresetCombobox', (e) => {
        if (!$(e.target).closest('#se-manager-preset-combobox').length) {
            closePresetCombobox();
        }
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

// The list shows every calendar in settings.calendars - the built-in ones
// (gregorian and the fantasy seeds) first, as getSettings() inserts them.
// An example date for a calendar's list row: the first day of its first year
// (2026 for Gregorian), at midday, through the calendar's own format().
function calendarSample(cal) {
    try {
        const midday = Math.floor(cal.hoursPerDay / 2);
        const scalar = fromStructured(cal.id, { year: cal.leapYearRule === 'gregorian' ? 2026 : 1, month: 1, day: 1, hour: midday });
        return format(cal.id, scalar, { style: 'full' });
    } catch {
        return '';
    }
}

// `editing` is calendar-ui-schema.js's editor values for the open editor, or
// null when no calendar is being created/edited.
export function renderCalendarsTab(managerApi, editing = null) {
    const $tab = $('#se-manager-calendars-tab');
    if (!$tab.length) return;

    const rows = Object.values(managerApi.listCalendars())
        .map((cal) => uiTemplates.buildCalendarRow(cal, calendarSample(cal), variablesUsingCalendar(cal.id).length))
        .join('');

    $tab.html(uiTemplates.buildCalendarsTabContainer(rows, editing ? uiTemplates.buildCalendarEditor(editing) : ''));
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
