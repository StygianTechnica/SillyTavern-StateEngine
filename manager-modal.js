// State Engine Manager Modal
// Complete tabbed interface for preset/variable/trigger/worldinfo management
// Uses ES6 modules - imported by index.js

import * as presetManager from './preset-manager.js';
import * as variableSchema from './variable-schema.js';
import * as uiTemplates from './ui-templates.js';
import * as uiRender from './ui-render.js';
import * as uiEvents from './ui-events.js';
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
    uiRender.renderPresetsTab(managerApi, managerCurrentPresetId);
    managerCurrentPresetId = uiRender.renderVariablesTab(managerApi, managerCurrentPresetId);
    uiRender.renderWorldInfoTab(managerApi);

    // Wire events
    const managerState = { currentPresetId: managerCurrentPresetId, hideManagerModal };
    uiEvents.wireEvents(managerApi, managerState);

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
