// State Engine — floating tracker panel

import { getSettings, persistSettings, debugLog } from '../core/settings-core.js';
import { getPresetLoadOrder, getAllVariablesFromPresets, getTrackerPresets, addPresetToTracker, removePresetFromTracker } from '../core/preset-manager.js';
import { getVarValue } from '../core/variable-storage.js';
import { formatValueForDisplay } from './formatting-utils.js';
import { setStatus } from './settings-panel-ui.js';

export function renderTrackerPanel() {
    const $body = $('#se_tracker_body');
    if (!$body.length) return;

    const context = SillyTavern.getContext();
    const settings = getSettings();
    const showHidden = !!settings.trackerShowHidden;
    const chatId = context.chatId;

    debugLog('renderTrackerPanel called for chat:', chatId);

    if (!chatId) {
        $body.empty().append($('<div></div>').addClass('se-tracker-empty').text('Select a chat to view state variables.'));
        return;
    }

    // Use load order to display presets in activation order
    const presetLoadOrder = getPresetLoadOrder(chatId);
    debugLog('  presetLoadOrder:', presetLoadOrder);

    const variables = getAllVariablesFromPresets(presetLoadOrder);
    debugLog('  variables from presets:', variables);

    // Filter without sorting to preserve insertion order (which is determined by preset load order)
    const defs = Object.values(variables)
        .filter((def) => def.name && (def.showInTracker !== false || showHidden));

    debugLog('  filtered defs (after showInTracker check):', defs);

    $body.empty();
    if (defs.length === 0) {
        $body.append($('<div></div>').addClass('se-tracker-empty').text('No tracked variables to show.'));
        return;
    }

    for (const def of defs) {
        const value = getVarValue(context, def);
        const $row = $('<div></div>').addClass('se-tracker-row');
        if (def.showInTracker === false) $row.addClass('se-tracker-row-hidden');
        $row.append($('<span></span>').addClass('se-tracker-label').text(def.label || def.name));
        //$row.append($('<span></span>').addClass(`se-badge se-badge-${def.category} se-tracker-badge`).text(categoryLabel(def.category)));//111111111111
        $row.append($('<span></span>').addClass('se-tracker-value').text(formatValueForDisplay(value)));
        $body.append($row);
    }
}

export function makeTrackerPanelDraggable($panel, $header) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startTop = 0;
    let startLeft = 0;

    $header.on('mousedown', (e) => {
        if ($(e.target).is('button, .se-tracker-btn')) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const offset = $panel.offset();
        startTop = offset.top;
        startLeft = offset.left;
        e.preventDefault();
    });

    $(document).on('mousemove.seTracker', (e) => {
        if (!dragging) return;
        const newLeft = Math.max(0, startLeft + (e.clientX - startX));
        const newTop = Math.max(0, startTop + (e.clientY - startY));
        $panel.css({ left: `${newLeft}px`, top: `${newTop}px`, right: 'auto', bottom: 'auto' });
    });

    $(document).on('mouseup.seTracker', () => {
        if (!dragging) return;
        dragging = false;
        const settings = getSettings();
        settings.trackerPanelPos = {
            top: parseInt($panel.css('top'), 10) || 0,
            left: parseInt($panel.css('left'), 10) || 0,
        };
        persistSettings();
    });
}

export function buildTrackerPanel() {
    if ($('#se_tracker_panel').length) return;

    const settings = getSettings();
    const $panel = $(
        '<div id="se_tracker_panel">' +
        '<div id="se_tracker_header">' +
        '<span id="se_tracker_title">State Tracker</span>' +
        '<span class="se-tracker-header-actions">' +
        '<button id="se_tracker_debug_toggle" class="se-tracker-btn" title="Show hidden/debug variables"><i class="fa-solid fa-bug"></i></button>' +
        '<button id="se_tracker_collapse" class="se-tracker-btn" title="Collapse">–</button>' +
        '<button id="se_tracker_close" class="se-tracker-btn" title="Hide panel">×</button>' +
        '</span>' +
        '</div>' +
        '<div id="se_tracker_body"></div>' +
        '</div>',
    );
    $('body').append($panel);

    $panel.css({ top: `${settings.trackerPanelPos.top}px`, left: `${settings.trackerPanelPos.left}px` });
    $panel.toggleClass('se-tracker-collapsed', !!settings.trackerPanelCollapsed);
    $('#se_tracker_debug_toggle').toggleClass('se-tracker-btn-active', !!settings.trackerShowHidden);

    $('#se_tracker_collapse').on('click', () => {
        const s = getSettings();
        s.trackerPanelCollapsed = !s.trackerPanelCollapsed;
        persistSettings();
        $panel.toggleClass('se-tracker-collapsed', s.trackerPanelCollapsed);
    });

    $('#se_tracker_close').on('click', () => {
        getSettings().showTrackerPanel = false;
        persistSettings();
        $panel.hide();
        $('#se_show_tracker_panel').prop('checked', false);
    });

    $('#se_tracker_debug_toggle').on('click', function () {
        const s = getSettings();
        s.trackerShowHidden = !s.trackerShowHidden;
        persistSettings();
        $(this).toggleClass('se-tracker-btn-active', s.trackerShowHidden);
        renderTrackerPanel();
    });

    makeTrackerPanelDraggable($panel, $('#se_tracker_header'));
    renderTrackerPanel();
}

export function setTrackerPanelVisible(visible) {
    if (visible) {
        buildTrackerPanel();
        $('#se_tracker_panel').show();
        renderTrackerPanel();
    } else {
        $('#se_tracker_panel').hide();
    }
}

export function renderTrackerPresetList() {
    const settings = getSettings();
    const $list = $('#se_tracker_preset_list');
    if (!$list.length) return;

    $list.empty();

    const trackerPresets = getTrackerPresets();

    if (Object.keys(settings.presets).length === 0) {
       $list.html('<div class="se-empty">Create a preset first.</div>');
       return;
    }

    for (const [presetId, preset] of Object.entries(settings.presets)) {
       const isChecked = trackerPresets.includes(presetId);
       const $item = $('<label></label>').addClass('se-tracker-preset-item checkbox_label');
       const $checkbox = $('<input></input>')
           .attr('type', 'checkbox')
           .prop('checked', isChecked)
           .on('change', function () {
               if ($(this).is(':checked')) {
                   addPresetToTracker(presetId);
               } else {
                   removePresetFromTracker(presetId);
               }
               renderTrackerPanel();
               setStatus(`Tracker display updated.`);
           });
       const $label = $('<span></span>').text(preset.name);
       $item.append($checkbox, $label);
       $list.append($item);
    }
}
