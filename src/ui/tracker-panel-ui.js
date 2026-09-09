// State Engine — floating tracker panel

import { getSettings, persistSettings, debugLog } from '../core/settings-core.js';
import { getPresetLoadOrder, getAllVariablesFromPresets, getTrackerPresets, addPresetToTracker, removePresetFromTracker } from '../core/preset-manager.js';
import { getMacroValue } from '../core/macro-store.js';
import { setVar } from '../core/chat-state.js';
import { getDefaultValue } from '../core/variable-schema.js';
import { coerceValue } from '../core/variable-validation.js';
import { recalculateDependents, getCalculatedVariableError } from '../core/calculated-engine.js';
import { formatValueForDisplay } from './formatting-utils.js';
import { setStatus } from './settings-panel-ui.js';

// A variable is runtime-editable from the tracker when nothing else already
// owns writing its value: not calculated (derived, read-only - 1.17.3),
// not prompted (the LLM owns it), not incremented (the reset button and the
// increment engine own it). There is no separate "static" schema type -
// number/string/boolean/enum/array are all eligible here whenever neither
// behavior flag is set; type itself doesn't matter.
function isStaticVariable(def) {
    return !!def
        && def.type !== 'calculated'
        && def.behaviors?.prompted !== true
        && def.behaviors?.increment !== true;
}

// Builds the type-appropriate edit control for one static variable's
// current value. `onCommit(rawValue)` is called once with whatever the user
// entered/selected/toggled; the caller is responsible for coercing and
// writing it. `onCancel()` discards the edit. Both are guarded by the
// caller against double-invocation (blur firing after Enter/Escape).
function buildStaticValueEditor(def, currentValue, onCommit, onCancel) {
    if (def.type === 'boolean') {
        const $input = $('<input type="checkbox" class="se-tracker-edit-input" />').prop('checked', !!currentValue);
        $input.on('change', () => onCommit($input.is(':checked')));
        $input.on('keydown', (e) => { if (e.key === 'Escape') onCancel(); });
        return $input;
    }

    if (def.type === 'enum') {
        const list = Array.isArray(def.enumValues) ? def.enumValues : [];
        const $input = $('<select class="text_pole se-tracker-edit-input"></select>');
        for (const v of list) {
            $('<option></option>').val(v).text(v).prop('selected', v === currentValue).appendTo($input);
        }
        $input.on('change', () => onCommit($input.val()));
        $input.on('keydown', (e) => { if (e.key === 'Escape') onCancel(); });
        return $input;
    }

    // number, string, array - a single text field. Arrays round-trip as
    // their JSON form; coerceValue() (variable-validation.js) already
    // accepts a JSON-array string, the same as every other array-editing
    // surface in this codebase.
    const displayVal = Array.isArray(currentValue) ? JSON.stringify(currentValue) : (currentValue ?? '');
    const $input = $('<input type="text" class="text_pole se-tracker-edit-input" />').val(displayVal);
    $input.on('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); onCommit($input.val()); }
        else if (e.key === 'Escape') { onCancel(); }
    });
    $input.on('blur', () => onCommit($input.val()));
    return $input;
}

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
        const value = getMacroValue(context, def);
        const $row = $('<div></div>').addClass('se-tracker-row');
        if (def.showInTracker === false) $row.addClass('se-tracker-row-hidden');

        const $label = $('<span></span>')
            .addClass('se-tracker-label')
            .text(def.label || def.name);

        let evalError = null;
        if (def.type === 'calculated') {
            evalError = getCalculatedVariableError(chatId, def.name);

            $label.prepend(
                $('<i></i>')
                    .addClass('fa-solid fa-calculator se-tracker-calculated-badge')
                    .attr('title', 'Calculated variable (read-only, derived from other variables)'),
            );

            // Inline failure indicator (item 3, 2026-09-09): a type
            // mismatch, an unresolved dependency, or a dependency cycle
            // must be visible here, not only in the console - covers the
            // case where the failing expression was saved from somewhere
            // other than the manager-modal editor (e.g. a dependency was
            // later deleted or renamed).
            if (evalError) {
                $label.append(
                    $('<i></i>')
                        .addClass('fa-solid fa-triangle-exclamation se-tracker-error-badge')
                        .attr('title', `Evaluation failed: ${evalError}`),
                );
            }
        }

        const $value = $('<span></span>')
            .addClass('se-tracker-value')
            .text(formatValueForDisplay(value));

        //$row.append($('<span></span>').addClass(`se-badge se-badge-${def.category} se-tracker-badge`).text(categoryLabel(def.category)));//111111111111
        $row.append($label, $value);

        // Static variables (no prompted/increment behavior, not calculated)
        // have no write-path after seeding otherwise - this is the runtime
        // state edit surface. The inline manager-modal editor stays
        // schema-only (name/type/dependencies/etc); this only ever changes
        // the *stored value* for the current chat, never defaultValue, and
        // never re-seeds anything.
        if (isStaticVariable(def)) {
            const $editBtn = $('<button></button>')
                .addClass('se-tracker-btn se-tracker-edit-btn')
                .attr('title', 'Edit value')
                .html('<i class="fa-solid fa-pencil"></i>')
                .on('click', () => {
                    const ctx = SillyTavern.getContext();
                    const cid = ctx.chatId;
                    if (!cid) return;

                    const current = getMacroValue(ctx, def);
                    let committed = false;

                    const $input = buildStaticValueEditor(
                        def,
                        current,
                        (rawValue) => {
                            if (committed) return;
                            committed = true;
                            try {
                                const nextValue = coerceValue(def, rawValue);
                                setVar(cid, def.name, nextValue, def);
                                recalculateDependents(cid, def.name);
                            } catch (err) {
                                console.warn('[State Engine] tracker value edit failed (gracefully handled)', err);
                            }
                            renderTrackerPanel();
                        },
                        () => {
                            if (committed) return;
                            committed = true;
                            renderTrackerPanel();
                        },
                    );

                    $value.replaceWith($input);
                    $input.trigger('focus');
                    if ($input.is('input[type="text"]')) $input[0].select();
                });

            $row.append($editBtn);
        }

        // Only show reset button for increment variables
        if (def.behaviors && def.behaviors.increment) {
            const $reset = $('<button></button>')
                .addClass('se-tracker-btn se-tracker-reset-btn')
                .attr('title', 'Reset to default')
                .html('<i class="fa-solid fa-rotate-left"></i>')
                .on('click', () => {
                    try {
                        const ctx = SillyTavern.getContext();
                        const chatId = ctx.chatId;
                        if (!chatId) return;
                        // getDefaultValue(), not raw def.defaultValue - same
                        // string-vs-number gap fixed in chat-state.js's
                        // seedVariablesForChat()/resetValueIfTypeChanged()
                        // (2026-09-09): def.defaultValue can be a string
                        // (e.g. "5") even for a number-type variable, since
                        // the manager-modal defaultValue input is a plain
                        // text field.
                        const next = getDefaultValue(def);
                        setVar(chatId, def.name, next, def);
                        recalculateDependents(chatId, def.name);
                        renderTrackerPanel();
                    } catch (err) {
                        console.warn('[State Engine] reset button failed (gracefully handled)', err);
                    }
                });

            $row.append($reset);
        }

        $body.append($row);

        // Full-width banner under the row, not just an icon+tooltip - the
        // failure must be visible at a glance, not only on hover.
        if (evalError) {
            $body.append(
                $('<div></div>')
                    .addClass('se-tracker-error-banner')
                    .text(`"${def.label || def.name}" failed to evaluate: ${evalError}`),
            );
        }
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
