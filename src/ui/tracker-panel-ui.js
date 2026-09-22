// State Engine — floating tracker panel

import { getSettings, persistSettings, debugLog, DEFAULT_CALENDAR_ID } from '../core/settings-core.js';
import { getPresetLoadOrder, getAllVariablesFromPresets, getTrackerPresets, addPresetToTracker, removePresetFromTracker } from '../core/preset-manager.js';
import { getMacroValue } from '../core/macro-store.js';
import { setVar, getVar } from '../core/chat-state.js';
import { getDefaultValue } from '../core/variable-schema.js';
import { coerceValue, validateValueStrict } from '../core/variable-validation.js';
import { format } from '../core/calendar-engine.js';
import { formatPartial } from '../core/calendar-engine.js';
import { recalculateDependents, getCalculatedVariableError } from '../core/calculated-engine.js';
import { formatValueForDisplay } from './formatting-utils.js';
import { isImageType, activeImageRef } from '../core/image-variables.js';
import { thumbHtml } from './image-preview.js';
import { setStatus } from './settings-panel-ui.js';

// A variable is runtime-editable from the tracker when nothing else already
// owns writing its value: not calculated (derived, read-only - 1.17.3),
// not prompted (the LLM owns it), not incremented (the reset button and the
// increment engine own it). There is no separate "static" schema type -
// number/string/boolean/enum/array are all eligible here whenever neither
// behavior flag is set; type itself doesn't matter.
//
// A flag-mode boolean (1.28) is the one deliberate exception: it is ALWAYS
// editable here, even when prompted or incremented, because the tracker's edit
// pencil (and its reset button, below) is the only manual write surface this
// extension actually has - without this override a flag that is also prompted
// (the normal case: "set true by prompted updates") could never be reset at all.
function isStaticVariable(def) {
    if (def?.type === 'boolean' && def.flagMode === true) return true;
    return !!def
        && def.type !== 'calculated'
        && !isImageType(def) // shown as a picture only - no editing from the tracker
        && def.behaviors?.prompted !== true
        && def.behaviors?.increment !== true;
}

// What a tracker edit of `def` means for the text the user committed:
// { ok: true, value } with the value to store, or { ok: false, error }.
// Every type but datetime keeps the long-standing behavior - coerceValue()
// always yields something, falling back to the default for input it cannot
// use. A datetime variable is the exception: falling back to the default
// would silently reset the clock to 1970 on a typo, so there the text must be
// an ISO date/datetime ("2026-09-18 22:55:00") or a number of seconds, and
// anything else is refused and nothing is written.
export function resolveTrackerEdit(def, rawValue) {
    if (def?.type === 'datetime') {
        const result = validateValueStrict(def, typeof rawValue === 'string' ? rawValue.trim() : rawValue);
        // An empty box is not a value (validateValueStrict treats only
        // null/undefined that way).
        if (!result.valid || rawValue === '' || rawValue === null || rawValue === undefined) {
            return { ok: false, error: result.error || 'Enter a date such as "2026-09-18 22:55:00" or a number of seconds.' };
        }
        return { ok: true, value: result.value };
    }
    return { ok: true, value: coerceValue(def, rawValue) };
}

// The value an image variable shows, read from the isolated store (the source of
// truth) - the macro mirror is SillyTavern's variable store, which turns a
// numeric-looking string ("12345", a resource id) into a number.
function imageVariableValue(chatId, def, context) {
    const stored = chatId ? getVar(chatId, def.name) : undefined;
    return stored ? stored.value : getMacroValue(context, def);
}

// The current value of the variable an image map names in def.currentKeyVariable
// (found by name among this chat's active variables), or undefined when it names
// none / that variable is not active. Any type is fine - the key is the value read
// as text (image-variables.js resolveKeyString).
function imageMapKeyValue(def, variables, context) {
    if (!def.currentKeyVariable) return undefined;
    const keyDef = Object.values(variables).find((d) => d?.name === def.currentKeyVariable);
    return keyDef ? getMacroValue(context, keyDef) : undefined;
}

// A datetime's stored scalar as the tracker shows it, via calendar-engine's
// format() - the one official formatter (spec 1.21.5). A Gregorian calendar
// gives "2026-09-18 22:55:00"; a fantasy calendar shows its own month name and
// pattern ("Stormfall 17, 1203 12:00:00", spec 1.22.2). A value or calendar
// format() refuses is shown as stored rather than breaking the panel.
function datetimeText(def, scalar) {
    try {
        return format(def.calendar || DEFAULT_CALENDAR_ID, Number(scalar), { style: 'full' });
    } catch {
        return scalar ?? '';
    }
}

// What the tracker edit box starts with. Always the numeric ISO form, which
// every calendar can read back (a fantasy calendar's own pattern - an era, a
// month name - need not be parseable), so committing an untouched box never
// fails.
function datetimeEditText(def, scalar) {
    try {
        return format(def.calendar || DEFAULT_CALENDAR_ID, Number(scalar), { style: 'custom', pattern: 'YYYY-MM-DD HH:mm:ss' });
    } catch {
        return scalar ?? '';
    }
}

// The extra line a fantasy calendar adds under its date: the season and the
// cycle position ("Deepfrost · Silver Moon day 5"). '' for a calendar with
// neither (Gregorian), or when the value cannot be formatted.
function datetimeDetail(def, scalar) {
    try {
        const p = formatPartial(def.calendar || DEFAULT_CALENDAR_ID, Number(scalar), ['season', 'cycle', 'cycleDay']);
        return [p.season, p.cycle ? `${p.cycle} day ${p.cycleDay}` : ''].filter(Boolean).join(' · ');
    } catch {
        return '';
    }
}

// Builds the type-appropriate edit control for one static variable's
// current value. `onCommit(rawValue)` is called once with whatever the user
// entered/selected/toggled; the caller is responsible for coercing and
// writing it. `onCancel()` discards the edit. Both are guarded by the
// caller against double-invocation (blur firing after Enter/Escape).
function buildStaticValueEditor(def, currentValue, onCommit, onCancel) {
    if (def.type === 'boolean') {
        // Deliberately NOT .se-tracker-edit-input - that class's flex-grow
        // and padding (meant for the text input/select below) fought with
        // SillyTavern's own themed checkbox rule (style.css's global
        // input[type='checkbox'] - appearance:none, fixed
        // width/height:var(--mainFontSize), its own checkmark), stretching
        // it away from the square shape every other checkbox in the
        // extension (e.g. the manager-modal editor's behaviors.prompted
        // checkbox, which carries no sizing class at all) already gets for
        // free. No custom class/CSS needed here either - inheriting that
        // same global rule untouched *is* "matching the extension drawer's
        // checkbox style" (2026-09-09).
        const $input = $('<input type="checkbox" class="se-tracker-edit-checkbox" />').prop('checked', !!currentValue);
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

    // number, string, array, datetime - a single text field. Arrays
    // round-trip as their JSON form; coerceValue() (variable-validation.js)
    // already accepts a JSON-array string, the same as every other
    // array-editing surface in this codebase. A datetime is edited as its
    // ISO form ("2026-09-18 22:55:00"); a plain number of seconds is accepted
    // back too (resolveTrackerEdit above).
    const displayVal = def.type === 'datetime'
        ? datetimeEditText(def, currentValue)
        : Array.isArray(currentValue) ? JSON.stringify(currentValue) : (currentValue ?? '');
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
        const value = isImageType(def) ? imageVariableValue(chatId, def, context) : getMacroValue(context, def);
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

        // An image variable shows the ONE image currently active - a thumbnail (hover to
        // enlarge), or a neutral placeholder when there is none: an image's value, an
        // image list's first element, an image map's entry for the current key (no key,
        // or a key that is not in the map: placeholder - never a default). The full
        // list or map is never shown, and nothing here edits it.
        let $value;
        if (isImageType(def)) {
            const ref = activeImageRef(def, value, def.type === 'imageMap' ? imageMapKeyValue(def, variables, context) : undefined);
            $value = $('<span></span>')
                .addClass('se-tracker-value se-tracker-image')
                .html(thumbHtml(ref, { enlarge: true, label: def.type === 'imageMap' ? 'No image for the current key' : 'No image' }));
        } else {
            $value = $('<span></span>')
                .addClass('se-tracker-value')
                .text(def.type === 'datetime' ? String(datetimeText(def, value)) : formatValueForDisplay(value, def));
        }

        // A fantasy calendar's season/cycle rides under its date, in the
        // value's tooltip and as a small second line (spec 1.22).
        if (def.type === 'datetime') {
            const detail = datetimeDetail(def, value);
            if (detail) {
                $value.attr('title', detail);
                $value.append($('<small></small>').addClass('se-tracker-datetime-detail').css('display', 'block').text(detail));
            }
        }

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
                                const edit = resolveTrackerEdit(def, rawValue);
                                if (edit.ok) {
                                    // manual: true - the pencil IS "manually in the
                                    // tracker" (1.28's authorized flag-reset path).
                                    setVar(cid, def.name, edit.value, def, { manual: true });
                                    recalculateDependents(cid, def.name);
                                } else {
                                    setStatus(`"${def.label || def.name}" not changed: ${edit.error}`, true);
                                }
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
                        // manual: true - clicking Reset is a deliberate user action
                        // too, and for a flag-mode boolean it is the other authorized
                        // way to reset one to false (getDefaultValue forces false).
                        setVar(chatId, def.name, next, def, { manual: true });
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

// Persists the panel's current on-screen size (from the native CSS
// resize:both handle - style.css) into settings.trackerPanelSize, so it's
// restored on the next buildTrackerPanel() rather than snapping back to
// the CSS default every reload. ResizeObserver is the correct mechanism
// here - CSS resize:both drags don't dispatch any element-level DOM event
// (window.onresize doesn't cover it); ResizeObserver is the only thing
// that reliably fires when it happens, in any browser. Debounced so a drag
// in progress doesn't write on every intermediate frame.
function watchTrackerPanelResize($panel) {
    if (typeof ResizeObserver !== 'function') return; // very old browser - resizing itself still works, just isn't remembered
    let saveTimer = null;
    const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            const settings = getSettings();
            // While collapsed the panel's rendered height is just the
            // header (the body is hidden and its own inline height was
            // cleared - see the collapse-toggle handler) - never let that
            // overwrite the real expanded height the user actually set.
            const nextHeight = settings.trackerPanelCollapsed
                ? settings.trackerPanelSize?.height ?? null
                : Math.round(entry.contentRect.height);
            settings.trackerPanelSize = {
                width: Math.round(entry.contentRect.width),
                height: nextHeight,
            };
            persistSettings();
        }, 400);
    });
    observer.observe($panel[0]);
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
    if (settings.trackerPanelSize?.width) $panel.css('width', `${settings.trackerPanelSize.width}px`);
    if (settings.trackerPanelSize?.height) $panel.css('height', `${settings.trackerPanelSize.height}px`);
    $panel.toggleClass('se-tracker-collapsed', !!settings.trackerPanelCollapsed);
    $('#se_tracker_debug_toggle').toggleClass('se-tracker-btn-active', !!settings.trackerShowHidden);
    watchTrackerPanelResize($panel);

    $('#se_tracker_collapse').on('click', () => {
        const s = getSettings();
        s.trackerPanelCollapsed = !s.trackerPanelCollapsed;
        persistSettings();
        $panel.toggleClass('se-tracker-collapsed', s.trackerPanelCollapsed);

        // A manual resize sets an explicit inline height via the browser's
        // native resize:both drag; that height doesn't clear itself when
        // the body is hidden (display:none) for collapse, which would
        // otherwise leave dead space below the header. Clear it on
        // collapse, restore the remembered size on expand.
        if (s.trackerPanelCollapsed) {
            $panel.css('height', '');
        } else if (s.trackerPanelSize?.height) {
            $panel.css('height', `${s.trackerPanelSize.height}px`);
        }
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
