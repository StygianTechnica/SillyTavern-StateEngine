// State Engine — UI settings panel

import { LOG_PREFIX, EXT_TEMPLATE_PATH, DEFAULT_PROMPTED_HEADER, DEFAULT_UNIFIED_VARIABLE_RULES, getSettings, persistSettings } from '../core/settings-core.js';
import { getPresetsForChat } from '../core/preset-manager.js';
import { runPromptedStateUpdate } from '../core/prompted-engine.js';
import { populateConnectionProfileDropdown } from './connection-profile-ui.js';
import { renderVarTable, currentPresetId } from './manager-modal-ui.js';
import { setTrackerPanelVisible } from './tracker-panel-ui.js';
import { openManagerIfReady, updateManagerButtonState, getCurrentChatId } from './wand-ui.js';

// ---------------------------------------------------------------------------
// UI — settings panel
// ---------------------------------------------------------------------------

let statusTimer = null;

export function setStatus(text, isError = false) {
    const $status = $('#se_status');
    if (!$status.length) return;
    $status.text(text).toggleClass('se-status-error', !!isError);
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => $status.text(''), 5000);
}

export function loadGeneralSettingsIntoForm() {
    const settings = getSettings();
    $('#se_enabled').prop('checked', !!settings.enabled);
    $('#se_wand_visible').prop('checked', settings.wandVisible !== false);
    $('#se_show_tracker_panel').prop('checked', !!settings.showTrackerPanel);
    $('#se_context_count').val(settings.contextMessageCount);
    $('#se_response_length').val(settings.responseLength);
    $('#se_prompted_header').val(settings.promptedHeader || DEFAULT_PROMPTED_HEADER);
    $('#se_prompted_variable_rules').val(settings.promptedRules || DEFAULT_UNIFIED_VARIABLE_RULES);
    populateConnectionProfileDropdown();
}

export function bindPanelEvents() {
    $('#se_enabled').on('change', function () {
        getSettings().enabled = $(this).is(':checked');
        persistSettings();
    });
    $('#se_wand_visible').on('change', function () {
        getSettings().wandVisible = $(this).is(':checked');
        persistSettings();
    });
    $('#se_show_tracker_panel').on('change', function () {
        const checked = $(this).is(':checked');
        getSettings().showTrackerPanel = checked;
        persistSettings();
        setTrackerPanelVisible(checked);
    });
    $('#se_connection_profile').on('change', function () {
        getSettings().connectionProfileId = $(this).val() || '';
        persistSettings();
    });
    $('#se_context_count').on('change', function () {
        const n = Math.max(1, Math.min(50, Number($(this).val()) || 10));
        getSettings().contextMessageCount = n;
        $(this).val(n);
        persistSettings();
    });
    $('#se_response_length').on('change', function () {
        const n = Math.max(50, Math.min(2000, Number($(this).val()) || 300));
        getSettings().responseLength = n;
        $(this).val(n);
        persistSettings();
    });

    $('#se_run_now').on('click', () => runPromptedStateUpdate('manual-all'));

    $('#se_open_manager').on('click', () => openManagerIfReady());
    updateManagerButtonState();

    $('#se_prompted_header').on('change', (e) => {
        const settings = getSettings();
        settings.promptedHeader = e.target.value;
        persistSettings();
    });

    $('#se_prompted_header_reset').on('click', () => {
        const settings = getSettings();
        settings.promptedHeader = DEFAULT_PROMPTED_HEADER;
        persistSettings();
        $('#se_prompted_header').val(DEFAULT_PROMPTED_HEADER);
    });

    $('#se_prompted_variable_rules').on('change', (e) => {
        const settings = getSettings();
        settings.promptedRules = e.target.value;
        persistSettings();
    });

    $('#se_prompted_variable_rules_reset').on('click', () => {
        const settings = getSettings();
        settings.promptedRules = DEFAULT_UNIFIED_VARIABLE_RULES;
        persistSettings();
        $('#se_prompted_variable_rules').val(DEFAULT_UNIFIED_VARIABLE_RULES);
    });

    $('#se_prompted_increment_rules').on('change', (e) => {
        const settings = getSettings();
        settings.incrementedRules = e.target.value;
        persistSettings();
    });

    // $('#se_prompted_increment_rules_reset').on('click', () => {
    //     const settings = getSettings();
    //     settings.incrementedRules = DEFAULT_INCREMENTED_VARIABLE_RULES;
    //     persistSettings();
    //     $('#se_prompted_increment_rules').val(DEFAULT_INCREMENTED_VARIABLE_RULES);
    // });
}

export async function initPanel() {
    const context = SillyTavern.getContext();
    let html;
    try {
        html = await context.renderExtensionTemplateAsync(EXT_TEMPLATE_PATH, 'settings');
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to load settings.html template', err);
        return;
    }
    const $html = $(html);
    $html.find('#se_macro_example, #se_macro_example2').text('{{getvar::name}}');
    $('#extensions_settings2').append($html);

    bindPanelEvents();
    loadGeneralSettingsIntoForm();

    const chatId = getCurrentChatId();
    if (chatId) {
        renderVarTable();
    } else {
        const $tabContainer = $('#se_preset_tabs');
        const $tbody = $('#se_var_tbody');
        const $empty = $('#se_var_empty');
        if ($tabContainer.length) $tabContainer.empty();
        if ($tbody.length) $tbody.empty();
        if ($empty.length) $empty.show().text('Select a chat to view state variables.');
    }

    if (getSettings().showTrackerPanel) {
        setTrackerPanelVisible(true);
    }
}
