// State Engine — UI template strings
// Pure functions that build HTML strings for the manager modal.
// Uses ES6 modules - imported by manager-modal.js

import { escapeHtml } from './utils.js';
import * as variableSchema from './variable-ui-schema.js';
import { listCalendars } from '../../core/calendar-engine.js';
import { BUILTIN_CALENDAR_IDS } from '../../core/settings-core.js';

export function buildPresetRow(presetId, preset, chatPresets, TRIGGER_KEYS, currentChatId) {
    const isActive = chatPresets.includes(presetId);
    const triggers = preset.triggers || [];

    const triggerCheckboxes = TRIGGER_KEYS
        .map(trigger => `
                    <label class="se-manager-trigger-option">
                        <input type="checkbox" class="se-preset-trigger-checkbox"
                               data-preset-id="${presetId}" data-trigger="${trigger.key}"
                               ${triggers.includes(trigger.key) ? 'checked' : ''} />
                        <span class="se-manager-trigger-option-icon"><i class="fa-solid ${trigger.icon}"></i></span>
                        <span class="se-manager-trigger-option-label">${trigger.label}</span>
                    </label>
                `)
        .join('');

    return `
                <div class="se-manager-preset-accordion-item">
                    <div class="se-manager-preset-accordion-header" data-preset-id="${presetId}">
                        <div class="se-manager-preset-accordion-toggle">
                            <i class="fa-solid fa-chevron-right"></i>
                        </div>
                        <div class="se-manager-preset-info">
                            <div class="se-manager-preset-name">
                                ${escapeHtml(preset.name)}
                                ${preset.description ? `<span class="se-manager-preset-description-inline">${escapeHtml(preset.description)}</span>` : ''}
                            </div>
                            <small class="se-manager-preset-meta">
                                ${isActive ? 'Active' : 'Inactive'} • ${triggers.length > 0 ? `${triggers.length} trigger(s)` : 'No triggers'} • ${Object.keys(preset.variables || {}).length} variable${Object.keys(preset.variables || {}).length === 1 ? '' : 's'}
                            </small>
                        </div>
                        <div class="se-row-actions">
                            <button class="se-manager-action-btn se-manager-toggle-active" data-preset-id="${presetId}" data-chat-id="${currentChatId}" title="${isActive ? 'Deactivate for this chat' : 'Activate for this chat'}">
                                <i class="fa-solid ${isActive ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                            </button>
                            <button class="se-manager-action-btn se-manager-clone-preset" data-preset-id="${presetId}" title="Clone">
                                <i class="fa-solid fa-copy"></i>
                            </button>
                            <button class="se-manager-action-btn se-manager-export-preset" data-preset-id="${presetId}" title="Export to a JSON file">
                                <i class="fa-solid fa-file-export"></i>
                            </button>
                            <button class="se-manager-action-btn se-manager-rename-preset" data-preset-id="${presetId}" title="Rename">
                                <i class="fa-solid fa-pen"></i>
                            </button>
                            <button class="se-manager-action-btn se-manager-delete-preset" data-preset-id="${presetId}" title="Delete">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </div>
                    </div>
                    <div class="se-manager-preset-accordion-body" style="display: none;">
                        <div class="se-manager-preset-description-section">
                            <label class="se-manager-label">Description</label>
                            <textarea class="se-manager-preset-description-input" data-preset-id="${presetId}" placeholder="Describe what this preset does...">${escapeHtml(preset.description || '')}</textarea>
                        </div>
                        <div class="se-manager-preset-triggers">
                            <div class="se-manager-trigger-title">Update triggers</div>
                            <div class="se-empty" style="margin-bottom: 10px; padding: 8px 10px;">
                                Check one or more events to control when this preset runs.
                            </div>
                            <div class="se-manager-trigger-list">
                                ${triggerCheckboxes}
                            </div>
                        </div>
                    </div>
                </div>
            `;
}

export function buildVariablesListRow(varId, varDef, index, total, selectedPresetId) {
    // Show label (display name) if available, otherwise just the name
    const displayLabel = varDef.label ? `<span class="se-manager-variable-label">${escapeHtml(varDef.label)}</span>` : '';
    return `
                <div class="se-manager-variable-row" data-var-id="${varId}" data-var-name="${(varDef.name || varId).toLowerCase()}" data-var-label="${(varDef.label || '').toLowerCase()}" data-show-in-tracker="${varDef.showInTracker !== false}">
                    <div class="se-manager-variable-row-header">
                        <span class="se-manager-variable-grip" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
                        <div class="se-manager-variable-info">
                            <div class="se-manager-variable-name">
                                ${escapeHtml(varDef.name || varId)}
                                ${displayLabel}
                            </div>
                            <small class="se-manager-variable-meta">
                                ${escapeHtml(varDef.category || 'manual')} • ${escapeHtml(varDef.type || 'string')}
                            </small>
                        </div>
                        <div class="se-manager-variable-actions">
                            <button class="se-manager-action-btn se-manager-move-variable-up" data-var-id="${varId}" data-preset-id="${selectedPresetId}" title="Move up" ${index === 0 ? 'disabled' : ''}>
                                <i class="fa-solid fa-arrow-up"></i>
                            </button>
                            <button class="se-manager-action-btn se-manager-move-variable-down" data-var-id="${varId}" data-preset-id="${selectedPresetId}" title="Move down" ${index === total - 1 ? 'disabled' : ''}>
                                <i class="fa-solid fa-arrow-down"></i>
                            </button>
                            <button class="se-manager-action-btn se-manager-toggle-visibility" data-var-id="${varId}" data-preset-id="${selectedPresetId}" title="Toggle visibility in tracker">
                                <i class="fa-solid ${varDef.showInTracker !== false ? 'fa-eye' : 'fa-eye-slash'}"></i>
                            </button>
                            <button class="se-manager-action-btn se-manager-edit-variable" data-var-id="${varId}" data-preset-id="${selectedPresetId}" title="Edit">
                                <i class="fa-solid fa-pencil"></i>
                            </button>
                            <button class="se-manager-action-btn se-manager-delete-variable" data-var-id="${varId}" data-preset-id="${selectedPresetId}" title="Delete">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </div>
                    </div>
                    <div class="se-manager-variable-editor-inline" style="display:none;"></div>
                </div>
            `;
}

// One row of the array-default-value editor (Section 3: row-based, not
// textarea-based). itemType 'enum' renders a <select> of itemEnumValues;
// 'object' is a placeholder (no per-item editing yet, add/remove/reorder
// still work); everything else is a plain text input, per spec.
function buildArrayItemRow(val, i, itemType, itemEnumValuesArray) {
    let itemHtml;
    if (itemType === 'enum') {
        const opts = itemEnumValuesArray
            .map((ev) => `<option value="${escapeHtml(ev)}" ${ev === val ? 'selected' : ''}>${escapeHtml(ev)}</option>`)
            .join('');
        itemHtml = `<select class="text_pole se-manager-array-item">${opts}</select>`;
    } else if (itemType === 'object') {
        itemHtml = `<span class="se-manager-array-item-placeholder">Object item editor coming soon</span>`;
    } else {
        const displayVal = (typeof val === 'object' && val !== null) ? JSON.stringify(val) : val;
        itemHtml = `<input class="text_pole se-manager-array-item" value="${escapeHtml(displayVal)}" />`;
    }

    return `
        <div class="se-manager-array-row" data-index="${i}">
            <span class="se-manager-array-grip"><i class="fa-solid fa-grip-vertical"></i></span>
            ${itemHtml}
            <button type="button" class="menu_button se-manager-array-delete" title="Remove item">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    `;
}

export function buildInlineVariableEditor(d, canIncrement, otherVars, calendars = listCalendars()) {
    otherVars = Array.isArray(otherVars) ? otherVars : [];
    // enumValuesMultiline carries the live (possibly-unsaved) list-editor rows
    // across editor re-renders (type toggle, prompted/increment toggles both
    // re-render via collectInlineVariableValues -> showInlineVariableEditor).
    // Only fall back to the stored enumValues array when opening fresh.
    const enumValuesArray = d.enumValuesMultiline !== undefined
        ? variableSchema.splitMultilineList(String(d.enumValuesMultiline))
        : (Array.isArray(d.enumValues) ? d.enumValues : Object.values(d.enumValues || {}));

    // Same live-round-trip-preservation reasoning as enumValuesMultiline above.
    const itemEnumValuesArray = d.itemEnumValuesMultiline !== undefined
        ? variableSchema.splitMultilineList(String(d.itemEnumValuesMultiline)).map((s) => s.trim()).filter(Boolean)
        : (Array.isArray(d.itemEnumValues) ? d.itemEnumValues : []);

    const itemType = d.itemType || 'any';

    // A datetime variable pointing at a calendar that is not in the list
    // (deleted or corrupt settings) is warned about, never silently re-pointed.
    const calendarMissing = d.type === 'datetime' && !!d.calendar && !Object.values(calendars || {}).some((c) => c.id === d.calendar);

    // The array-default-value row editor round-trips through
    // collectInlineVariableValues() the same way enumValuesMultiline does,
    // except here it lands back in defaultValue itself (as a JSON array
    // string) rather than a separate field - getDefaultValue() already
    // accepts a JSON-string array default, so this needed no new field.
    const defaultValueArray = (() => {
        if (Array.isArray(d.defaultValue)) return d.defaultValue;
        if (typeof d.defaultValue === 'string' && d.defaultValue.trim()) {
            try {
                const parsed = JSON.parse(d.defaultValue);
                if (Array.isArray(parsed)) return parsed;
            } catch { /* not JSON - fall through to empty */ }
        }
        return [];
    })();

    return `
        <div class="se-manager-variable-editor-fields">

            <!-- Basic fields -->
            <input class="text_pole se-manager-var-field"
                data-field="name"
                placeholder="Variable name"
                value="${escapeHtml(d.name)}" />

            <input class="text_pole se-manager-var-field"
                data-field="label"
                placeholder="Label"
                value="${escapeHtml(d.label)}" />

            <select class="text_pole se-manager-var-field"
                    data-field="type">
                <option value="string" ${d.type === 'string' ? 'selected' : ''}>String</option>
                <option value="number" ${d.type === 'number' ? 'selected' : ''}>Number</option>
                <option value="boolean" ${d.type === 'boolean' ? 'selected' : ''}>Boolean</option>
                <option value="enum" ${d.type === 'enum' ? 'selected' : ''}>Enum</option>
                <option value="array" ${d.type === 'array' ? 'selected' : ''}>Array</option>
                <option value="calculated" ${d.type === 'calculated' ? 'selected' : ''}>Calculated</option>
                <option value="datetime" ${d.type === 'datetime' ? 'selected' : ''}>Date &amp; time</option>
            </select>

            ${d.type === 'datetime' ? `
                <label class="se-manager-label">Calendar</label>
                <select class="text_pole se-manager-var-field" data-field="calendar">
                    ${Object.values(calendars || {}).map((c) => `
                        <option value="${escapeHtml(c.id)}" ${(d.calendar || 'gregorian') === c.id ? 'selected' : ''}>${escapeHtml(c.label || c.id)}</option>
                    `).join('')}
                    ${calendarMissing ? `<option value="${escapeHtml(d.calendar)}" selected>⚠ ${escapeHtml(d.calendar)} (missing)</option>` : ''}
                </select>
                ${calendarMissing ? `<div class="se-cal-missing-warning" style="color: #e57373;">
                    This variable uses the calendar "${escapeHtml(d.calendar)}", which no longer exists. Pick another calendar before saving.
                </div>` : ''}
            ` : ''}

            ${d.type === 'array' ? `
                <label class="se-manager-label">Default values</label>
                <div class="se-manager-array-list">
                    ${defaultValueArray.map((val, i) => buildArrayItemRow(val, i, itemType, itemEnumValuesArray)).join('')}
                </div>

                <button type="button" class="menu_button se-manager-array-add">
                    <i class="fa-solid fa-plus"></i> Add item
                </button>
            ` : d.type === 'calculated' ? `
                <div class="se-empty">Calculated variables have no manually-set default value - they evaluate automatically.</div>
            ` : `
                <input class="text_pole se-manager-var-field"
                    data-field="defaultValue"
                    placeholder="${d.type === 'datetime' ? 'Default date-time as YYYY-MM-DD HH:mm:ss (numeric month), e.g. 1203-08-17 12:00:00' : 'Default value'}"
                    value="${escapeHtml(d.defaultValue)}" />
                ${d.type === 'datetime' ? `<small class="se-manager-datetime-preview">${escapeHtml(variableSchema.datetimeDefaultPreview(d.calendar, d.defaultValue))}</small>` : ''}
            `}

            <!-- Calculated variable: dependency selector + expression -->
            ${d.type === 'calculated' ? `
                <div class="se-manager-calculated-section">
                    <label class="se-manager-label">Dependencies</label>
                    <div class="se-manager-calc-deps-list">
                        ${otherVars.length === 0
                            ? '<div class="se-empty">No other variables in this preset yet.</div>'
                            : otherVars.map((v) => `
                                <div class="se-manager-calc-dep-item">
                                    <label class="checkbox_label">
                                        <input type="checkbox" class="se-manager-calc-dep-checkbox" value="${escapeHtml(v.name)}"
                                            ${Array.isArray(d.dependencies) && d.dependencies.includes(v.name) ? 'checked' : ''} />
                                        <span>${escapeHtml(v.name)}${v.label ? ` (${escapeHtml(v.label)})` : ''} <small>[${escapeHtml(v.type)}]</small></span>
                                    </label>
                                    <button type="button" class="se-manager-action-btn se-manager-calc-dep-copy" data-copy-name="${escapeHtml(v.name)}" title="Copy &quot;${escapeHtml(v.name)}&quot; to clipboard">
                                        <i class="fa-solid fa-clipboard"></i>
                                    </button>
                                </div>
                            `).join('')
                        }
                    </div>

                    <label class="se-manager-label">Expression</label>
                    <textarea class="text_pole se-manager-var-field"
                        data-field="expression"
                        placeholder="e.g. strength + dexterity * 2">${escapeHtml(d.expression || '')}</textarea>
                    <div class="se-empty">Tiny Expression DSL. Only the checked dependencies above may be referenced by name. Click the clipboard icon next to a dependency to copy its exact name.</div>
                    <div class="se-manager-calc-eval-error" style="display:none;"></div>
                </div>
            ` : ''}

            <!-- Enum values editor -->
            ${d.type === 'enum' ? `
                <label class="se-manager-label">Allowed values</label>
                <div class="se-manager-enum-list">
                    ${enumValuesArray.map((val, i) => `
                        <div class="se-manager-enum-row" data-index="${i}">
                            <span class="se-manager-enum-grip"><i class="fa-solid fa-grip-vertical"></i></span>
                            <input class="text_pole se-manager-enum-item" value="${escapeHtml(val)}" />
                            <button type="button" class="menu_button se-manager-enum-delete" title="Remove value">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </div>
                    `).join('')}
                </div>

                <button type="button" class="menu_button se-manager-enum-add">
                    <i class="fa-solid fa-plus"></i> Add new entry
                </button>
            ` : ''}

            <!-- Typed array editor -->
            ${d.type === 'array' ? `
                <label class="se-manager-label">Item type</label>
                <select class="text_pole se-manager-var-field" data-field="itemType">
                    <option value="string" ${itemType === 'string' ? 'selected' : ''}>String</option>
                    <option value="number" ${itemType === 'number' ? 'selected' : ''}>Number</option>
                    <option value="boolean" ${itemType === 'boolean' ? 'selected' : ''}>Boolean</option>
                    <option value="enum" ${itemType === 'enum' ? 'selected' : ''}>Enum</option>
                    <option value="object" ${itemType === 'object' ? 'selected' : ''}>Object</option>
                    <option value="any" ${itemType === 'any' ? 'selected' : ''}>Any</option>
                </select>

                ${itemType === 'enum' ? `
                    <label class="se-manager-label">Allowed item values</label>
                    <div class="se-manager-itemenum-list">
                        ${itemEnumValuesArray.map((val, i) => `
                            <div class="se-manager-itemenum-row" data-index="${i}">
                                <span class="se-manager-itemenum-grip"><i class="fa-solid fa-grip-vertical"></i></span>
                                <input class="text_pole se-manager-itemenum-item" value="${escapeHtml(val)}" />
                                <button type="button" class="menu_button se-manager-itemenum-delete" title="Remove value">
                                    <i class="fa-solid fa-trash"></i>
                                </button>
                            </div>
                        `).join('')}
                    </div>

                    <button type="button" class="menu_button se-manager-itemenum-add">
                        <i class="fa-solid fa-plus"></i> Add new entry
                    </button>
                ` : ''}

                ${itemType === 'object' ? `
                    <div class="se-empty">Object item editor coming soon. Object items are validated against itemSchema (per-field type checks), configured outside this editor.</div>
                    <div class="se-empty">Object arrays cannot be used in World Info conditions.</div>
                ` : ''}

                <div class="se-manager-array-constraints">
                    <label class="checkbox_label">
                        <input type="checkbox" class="se-manager-var-field" data-field="unique" ${d.unique ? 'checked' : ''} />
                        <span>Unique items only</span>
                    </label>
                    <label class="checkbox_label" ${d.behaviors?.increment ? 'title="Sorted arrays cannot use increment operations."' : ''}>
                        <input type="checkbox" class="se-manager-var-field" data-field="sorted" ${d.sorted ? 'checked' : ''} ${d.behaviors?.increment ? 'disabled' : ''} />
                        <span>Keep sorted</span>
                    </label>
                    <label>
                        Max length:
                        <input class="text_pole se-manager-var-field" data-field="maxLength"
                            value="${d.maxLength === null || d.maxLength === undefined ? '' : escapeHtml(d.maxLength)}"
                            placeholder="no limit" />
                    </label>
                </div>
            ` : ''}

            <!-- Behavior toggles -->
            <div class="se-manager-variable-behaviors">

                ${d.type !== 'calculated' ? `
                <!-- Prompted toggle -->
                <div class="se-manager-toggle-row">
                    <div class="se-row">
                        <label class="checkbox_label">
                            <input id="se-manager-prompted-toggle" type="checkbox" class="se-manager-var-field" data-field="behaviors.prompted" ${d.behaviors?.prompted ? 'checked' : ''} />
                            <span>Prompted Behavior</span>
                        </label>
                    </div>
                </div>

                <!-- Prompted section -->
                <div class="se-manager-prompted-section"
                    style="display: ${d.behaviors.prompted ? 'block' : 'none'};">
                    <textarea class="text_pole se-manager-var-field"
                            data-field="prompted.instructions"
                            placeholder="Prompted variable instructions">${escapeHtml(d.prompted.instructions)}</textarea>
                </div>
                ` : `
                <div class="se-empty">Calculated variables are read-only: prompted and incremented behavior are not available.</div>
                `}

                <!-- Increment toggle -->
                ${canIncrement ? `
                    <div class="se-manager-toggle-row">
                        <div class="se-row">
                            <label class="checkbox_label" ${d.type === 'array' && d.sorted ? 'title="Sorted arrays cannot use increment operations."' : ''}>
                                <input id="se-manager-increment-toggle" type="checkbox" class="se-manager-var-field" data-field="behaviors.increment" ${d.behaviors?.increment ? 'checked' : ''} ${d.type === 'array' && d.sorted ? 'disabled' : ''} />
                                <span>Incremented Behavior</span>
                            </label>
                        </div>
                    </div>
                ` : ''}

                <!-- Increment section -->
                <div class="se-manager-increment-settings"
                    style="display: ${d.behaviors.increment ? 'block' : 'none'};">

                    <!-- Increment trigger (only when not prompted) -->
                    ${!d.behaviors.prompted ? `
                        <label>Increment trigger:</label>
                        <select class="text_pole se-manager-var-field"
                                data-field="increment.triggers">
                            <option value="user" ${d.increment.triggers.includes('user') ? 'selected' : ''}>On user chats</option>
                            <option value="ai" ${d.increment.triggers.includes('ai') ? 'selected' : ''}>On AI chats</option>
                            <option value="both" ${d.increment.triggers.includes('both') ? 'selected' : ''}>Both AI and User Chats</option>
                        </select>
                    ` : `
                        <p>Increment will occur when prompted instructions are satisfied.</p>
                    `}

                    <!-- Type-specific increment controls -->
                    ${d.type === 'number' ? `
                        <label>Increment amount:</label>
                        <input class="text_pole se-manager-var-field"
                            data-field="increment.delta"
                            value="${escapeHtml(d.increment.delta)}" />
                    ` : ''}

                    ${d.type === 'datetime' ? `
                        <label>Advance by (e.g. 1h, 1d, 1mo, 1y):</label>
                        <input class="text_pole se-manager-var-field"
                            data-field="increment.delta"
                            value="${escapeHtml(d.increment.delta)}" />
                    ` : ''}

                    ${d.type === 'boolean' ? `
                        <label>Toggle value on increment</label>
                    ` : ''}

                    ${d.type === 'enum' ? `
                        <label>Cycle through enum values</label>
                    ` : ''}

                    ${d.type === 'array' ? `
                        <label>Operation:</label>
                        <select class="text_pole se-manager-var-field" data-field="increment.operation">
                            <option value="" ${!d.increment.operation ? 'selected' : ''}>-- none (no-op) --</option>
                            <option value="push" ${d.increment.operation === 'push' ? 'selected' : ''}>Push (add to end)</option>
                            <option value="unshift" ${d.increment.operation === 'unshift' ? 'selected' : ''}>Unshift (add to start)</option>
                            <option value="pop" ${d.increment.operation === 'pop' ? 'selected' : ''}>Pop (remove last)</option>
                            <option value="shift" ${d.increment.operation === 'shift' ? 'selected' : ''}>Shift (remove first)</option>
                            <option value="rotate" ${d.increment.operation === 'rotate' ? 'selected' : ''}>Rotate (move last to front)</option>
                            <option value="clear" ${d.increment.operation === 'clear' ? 'selected' : ''}>Clear</option>
                            ${itemType === 'enum' ? `
                                <option value="toggle" ${d.increment.operation === 'toggle' ? 'selected' : ''}>Toggle value</option>
                                <option value="cycle" ${d.increment.operation === 'cycle' ? 'selected' : ''}>Cycle (replace with next item enum value)</option>
                            ` : ''}
                            ${itemType === 'object' ? `
                                <option value="incrementField" ${d.increment.operation === 'incrementField' ? 'selected' : ''}>Increment field (coming soon)</option>
                                <option value="toggleField" ${d.increment.operation === 'toggleField' ? 'selected' : ''}>Toggle field (coming soon)</option>
                            ` : ''}
                        </select>

                        ${['push', 'unshift', 'toggle'].includes(d.increment.operation) ? `
                            <label>Value to ${d.increment.operation === 'toggle' ? 'toggle' : 'add'} on each increment:</label>
                            <input class="text_pole se-manager-var-field" data-field="increment.operand"
                                value="${d.increment.operand === undefined || d.increment.operand === null ? '' : escapeHtml(d.increment.operand)}" />
                        ` : ''}
                    ` : ''}

                </div>
            </div>

            <!-- Explanation box -->
            <div class="se-manager-variable-explanation">
                ${variableSchema.describeVariable(d)}
            </div>

            <!-- Actions -->
            <div class="se-manager-variable-editor-actions">
                <button class="menu_button se-manager-save-variable-inline">${d._isNew ? 'Create' : 'Save'}</button>
                <button class="menu_button se-manager-cancel-variable-inline">Cancel</button>
            </div>
        </div>

    `;
}

export function buildWorldInfoRow(key, condList) {
    const condText = condList
        .map(c => `${escapeHtml(c.variable)} ${escapeHtml(c.operator)} ${escapeHtml(c.value)}`)
        .join(' AND ');
    return `
                <div class="se-manager-worldinfo-row">
                    <div class="se-manager-worldinfo-info">
                        <div class="se-manager-worldinfo-key">${escapeHtml(key)}</div>
                        <small>${condText || 'No conditions'}</small>
                    </div>
                </div>
            `;
}

export function buildDebugActivePresets(debugInfo) {
    if (debugInfo.activePresets && debugInfo.activePresets.length > 0) {
        return debugInfo.activePresets
            .map(p => `
                <div style="margin-bottom: 12px; padding: 8px; background: #2a2a2a; border-radius: 4px;">
                    <div><strong>${escapeHtml(p.name)}</strong></div>
                    <small style="color: #aaa;">ID: ${escapeHtml(p.id)}</small>
                    <small style="color: #aaa;">Variables: ${p.variableCount}, Triggers: ${p.triggers.length}</small>
                </div>
            `)
            .join('');
    }
    return '<div style="color: #999;">No active presets for this chat</div>';
}

export function buildDebugVariablesTable(debugInfo) {
    if (debugInfo.variables && debugInfo.variables.length > 0) {
        return `<table style="width: 100%; border-collapse: collapse;">
            <thead style="border-bottom: 1px solid #444;">
                <tr style="text-align: left;">
                    <th style="padding: 6px; font-weight: bold;">Name</th>
                    <th style="padding: 6px; font-weight: bold;">Type</th>
                    <th style="padding: 6px; font-weight: bold;">Value</th>
                </tr>
            </thead>
            <tbody>
                ${debugInfo.variables
                    .map(v => `
                        <tr style="border-bottom: 1px solid #333;">
                            <td style="padding: 6px;"><code>${escapeHtml(v.name)}</code></td>
                            <td style="padding: 6px;"><small style="color: #aaa;">${v.type}</small></td>
                            <td style="padding: 6px;"><code style="color: #7ec699;">${escapeHtml(JSON.stringify(v.value))}</code></td>
                        </tr>
                    `)
                    .join('')}
            </tbody>
        </table>`;
    }
    return '<div style="color: #999;">No variables in active presets</div>';
}

export function buildPresetsTabContainer(presetRows) {
    return `
        <div class="se-manager-section">
            <div class="se-manager-section-header">
                <h3>Presets</h3>
                <div class="se-manager-section-buttons">
                    <button id="se-manager-import-preset" class="menu_button" title="Import a preset from a JSON file">
                        <i class="fa-solid fa-file-import"></i> Import
                    </button>
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
}

export function buildVariablesTabContainer(presetOptions, variablesList, showActiveOnly) {
    return `
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
}

export function buildWorldInfoTabContainer(conditionRows, conditionCount) {
    return `
        <div class="se-manager-section">
            <h3>World Info Conditions</h3>
            <small>Displays conditions set on World Info entries. Total entries: ${conditionCount}</small>
            <div class="se-manager-worldinfo-list">
                ${conditionRows || '<div class="se-empty">No World Info conditions set yet.</div>'}
            </div>
        </div>
    `;
}

// SillyTavern solo-chat ids are conventionally "${characterName} - ${timestamp}"
// (see script.js: characters[this_chid].chat = `${name2} - ${humanizedDateTime()}`).
// Group chat ids don't follow this shape at all. Best-effort split only -
// falls back to the full chatId when it doesn't match, so a group chat (or
// any legacy/odd id) still renders correctly, just without a split name.
function splitChatDisplayName(chatId) {
    const match = /^(.*)\s-\s\d.*$/.exec(chatId || '');
    return match ? match[1] : (chatId || '');
}

// state.lastUpdated (a real Date.now() timestamp maintained on every write -
// see defaultChatState()/saveChatState() in chat-state.js) is a more
// reliable, format-agnostic timestamp than trying to parse one back out of
// the chatId string, and "last updated" is more useful here anyway - it
// tells you how stale a chat's stored data is, which is the point of this
// tab.
function formatLastUpdated(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildVariableManagementRow(chatId, state, isActiveChat) {
    const variables = state?.variables || {};
    const varCount = Object.keys(variables).length;
    const oneLineRaw = JSON.stringify(variables);
    const oneLine = escapeHtml(oneLineRaw.slice(0, 140)) + (oneLineRaw.length > 140 ? '…' : '');
    const fullJson = escapeHtml(JSON.stringify(variables, null, 2));

    const displayName = escapeHtml(splitChatDisplayName(chatId));
    const timestamp = formatLastUpdated(state?.lastUpdated);
    const metaText = `${timestamp ? escapeHtml(timestamp) + ' • ' : ''}${varCount} var${varCount === 1 ? '' : 's'}`;

    return `
        <div class="se-varmgmt-row" data-chat-id="${escapeHtml(chatId)}">
            <div class="se-varmgmt-row-main">
                <div class="se-varmgmt-row-info">
                    <span class="se-varmgmt-name">${displayName}</span>
                    ${isActiveChat ? '<span class="se-manager-varmgmt-active-badge">Active</span>' : ''}
                    <span class="se-varmgmt-meta">${metaText}</span>
                </div>
                <div class="se-varmgmt-actions">
                    <button type="button" class="se-varmgmt-icon-btn se-varmgmt-toggle-json" title="Show details">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                    <button type="button" class="se-varmgmt-icon-btn se-varmgmt-export" data-chat-id="${escapeHtml(chatId)}" title="Export variable data">
                        <i class="fa-solid fa-file-export"></i>
                    </button>
                    <button type="button" class="se-varmgmt-icon-btn se-varmgmt-import" data-chat-id="${escapeHtml(chatId)}" title="Import variable data for this chat">
                        <i class="fa-solid fa-file-import"></i>
                    </button>
                    <button type="button" class="se-varmgmt-icon-btn se-varmgmt-delete" data-chat-id="${escapeHtml(chatId)}" title="Delete stored data for this chat">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="se-varmgmt-snippet-line">${oneLine}</div>
            <div class="se-varmgmt-json-detail">
                <pre class="se-varmgmt-json">${fullJson}</pre>
            </div>
        </div>
    `;
}

export function buildVariableManagementTab(rowsHtml) {
    return `
        <div class="se-manager-section">
            <h3>Variable Management</h3>
            <small>
                Every chat's stored State Engine variables, independent of which chat is currently open.
                Export copies a chat's stored data as JSON. Import overwrites a chat's stored data from
                pasted JSON. Delete permanently removes a chat's stored data.
            </small>
            <div class="se-varmgmt-list">
                ${rowsHtml || '<div class="se-empty">No stored chat data.</div>'}
            </div>
        </div>
    `;
}

export function buildDebugTabContainer(activePresetsHtml, variablesHtml, isEnabled, debugInfo) {
    return `
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
}

// ---------------------------------------------------------------------------
// Calendars tab (requirements spec 1.22)
// ---------------------------------------------------------------------------

export function buildCalendarsTabContainer(rowsHtml, editorHtml) {
    return `
        <div class="se-manager-section">
            <div class="se-manager-section-header">
                <h3>Calendars</h3>
                <div class="se-manager-section-buttons">
                    <button id="se-cal-import" class="menu_button" title="Import a calendar from pasted JSON">
                        <i class="fa-solid fa-file-import"></i> Import
                    </button>
                    <button id="se-cal-random" class="menu_button" title="Generate a random fantasy calendar to edit">
                        <i class="fa-solid fa-dice"></i> Random
                    </button>
                    <button id="se-cal-new" class="menu_button" title="Create a new calendar">
                        <i class="fa-solid fa-plus"></i> New
                    </button>
                </div>
            </div>
            <small>
                Calendars turn a datetime variable's stored seconds into dates. Pick one per datetime
                variable in the Variables tab. The built-in Gregorian calendar cannot be edited - duplicate it instead.
            </small>
            <div class="se-cal-list">
                ${rowsHtml || '<div class="se-empty">No calendars.</div>'}
            </div>
        </div>
        ${editorHtml || ''}
    `;
}

// One row of the calendar list. `sample` is a formatted example date (or ''),
// `usedBy` the number of variables using this calendar.
export function buildCalendarRow(cal, sample = '', usedBy = 0) {
    const builtin = BUILTIN_CALENDAR_IDS.includes(cal.id);
    const yearDays = (cal.months || []).reduce((n, m) => n + (Number(m.days) || 0), 0);
    const seasons = (cal.seasons || []).length;
    const cycles = (cal.cycles || []).length;
    return `
        <div class="se-cal-row" data-calendar-id="${escapeHtml(cal.id)}">
            <div class="se-cal-row-main">
                <strong>${escapeHtml(cal.label || cal.id)}</strong>
                <small>${escapeHtml(cal.id)} · v${escapeHtml(cal.version || 1)}${builtin ? ' · built in' : ''}</small>
                <small>${(cal.months || []).length} months, ${yearDays}${cal.leapYearRule === 'gregorian' ? '+' : ''} days/year,
                    ${escapeHtml(cal.hoursPerDay)}h × ${escapeHtml(cal.minutesPerHour)}m × ${escapeHtml(cal.secondsPerMinute)}s${seasons ? ` · ${seasons} seasons` : ''}${cycles ? ` · ${cycles} cycles` : ''}
                    · used by ${usedBy} variable(s)</small>
                ${sample ? `<small class="se-cal-sample">Example: ${escapeHtml(sample)}</small>` : ''}
            </div>
            <div class="se-manager-section-buttons">
                ${builtin ? '' : '<button class="menu_button se-cal-edit" title="Edit"><i class="fa-solid fa-pen"></i></button>'}
                <button class="menu_button se-cal-duplicate" title="Duplicate"><i class="fa-solid fa-clone"></i></button>
                <button class="menu_button se-cal-export" title="Copy as JSON"><i class="fa-solid fa-copy"></i></button>
                ${builtin ? '' : '<button class="menu_button se-cal-delete" title="Delete"><i class="fa-solid fa-trash"></i></button>'}
            </div>
        </div>
    `;
}

const calInput = (field, value, placeholder = '', extra = '') => `
    <input class="text_pole se-cal-field" data-cal-field="${field}" placeholder="${escapeHtml(placeholder)}"
        value="${escapeHtml(value ?? '')}" ${extra} />`;

const calTextarea = (field, value, placeholder = '', rows = 3) => `
    <textarea class="text_pole se-cal-field" data-cal-field="${field}" rows="${rows}"
        placeholder="${escapeHtml(placeholder)}">${escapeHtml(value ?? '')}</textarea>`;

export function buildCalendarMonthRow(month = {}) {
    return `
        <div class="se-cal-month-row se-cal-item-row"${month.leap !== undefined ? ` data-leap="${escapeHtml(month.leap)}"` : ''}>
            <input class="text_pole se-cal-month-name" placeholder="Month name" value="${escapeHtml(month.name ?? '')}" />
            <input class="text_pole se-cal-month-days" type="number" min="1" placeholder="Days" value="${escapeHtml(month.days ?? '')}" />
            <button type="button" class="menu_button se-cal-remove-row" title="Remove"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
}

export function buildCalendarSeasonRow(season = {}) {
    return `
        <div class="se-cal-season-row se-cal-item-row">
            <input class="text_pole se-cal-season-name" placeholder="Season name" value="${escapeHtml(season.name ?? '')}" />
            <input class="text_pole se-cal-season-start" type="number" min="1" placeholder="Start day" value="${escapeHtml(season.startDay ?? '')}" />
            <input class="text_pole se-cal-season-end" type="number" min="1" placeholder="End day" value="${escapeHtml(season.endDay ?? '')}" />
            <button type="button" class="menu_button se-cal-remove-row" title="Remove"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
}

export function buildCalendarCycleRow(cycle = {}) {
    return `
        <div class="se-cal-cycle-row se-cal-item-row">
            <input class="text_pole se-cal-cycle-name" placeholder="Cycle name" value="${escapeHtml(cycle.name ?? '')}" />
            <input class="text_pole se-cal-cycle-length" type="number" min="1" placeholder="Length (days)" value="${escapeHtml(cycle.length ?? '')}" />
            <button type="button" class="menu_button se-cal-remove-row" title="Remove"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
}

// The calendar editor. `v` is calendar-ui-schema.js's editor values.
export function buildCalendarEditor(v) {
    const leapRule = v.leapYearRule === 'gregorian' ? 'gregorian' : 'none';
    return `
        <div class="se-manager-section se-cal-editor" data-editing-new="${v.isNew ? 'true' : 'false'}">
            <div class="se-manager-section-header">
                <h3>${v.isNew ? 'New calendar' : `Edit calendar: ${escapeHtml(v.label || v.id)}`}</h3>
                <div class="se-manager-section-buttons">
                    <button id="se-cal-save" class="menu_button"><i class="fa-solid fa-check"></i> Save</button>
                    <button id="se-cal-cancel" class="menu_button"><i class="fa-solid fa-xmark"></i> Cancel</button>
                </div>
            </div>

            <label class="se-manager-label">Id (letters, digits, - and _)</label>
            ${calInput('id', v.id, 'e.g. aldoria', v.isNew ? '' : 'readonly')}
            <label class="se-manager-label">Label</label>
            ${calInput('label', v.label, 'Display name')}

            <label class="se-manager-label">Clock</label>
            <div class="se-cal-clock">
                ${calInput('hoursPerDay', v.hoursPerDay, 'Hours per day', 'type="number" min="1"')}
                ${calInput('minutesPerHour', v.minutesPerHour, 'Minutes per hour', 'type="number" min="1"')}
                ${calInput('secondsPerMinute', v.secondsPerMinute, 'Seconds per minute', 'type="number" min="1"')}
            </div>
            <input type="hidden" class="se-cal-field" data-cal-field="leapYearRule" value="${leapRule}" />

            <label class="se-manager-label">Months</label>
            <div class="se-cal-months">${(v.months || []).map(buildCalendarMonthRow).join('')}</div>
            <button type="button" class="menu_button se-cal-add-month"><i class="fa-solid fa-plus"></i> Add month</button>

            <label class="se-manager-label">Seasons (day of the year, inclusive; a start after the end wraps the year end)</label>
            <div class="se-cal-seasons">${(v.seasons || []).map(buildCalendarSeasonRow).join('')}</div>
            <button type="button" class="menu_button se-cal-add-season"><i class="fa-solid fa-plus"></i> Add season</button>

            <label class="se-manager-label">Cycles (repeating periods, in days - the first is shown and used by "1cycle")</label>
            <div class="se-cal-cycles">${(v.cycles || []).map(buildCalendarCycleRow).join('')}</div>
            <button type="button" class="menu_button se-cal-add-cycle"><i class="fa-solid fa-plus"></i> Add cycle</button>

            <h4>Formatting rules</h4>
            <small>Tokens: YYYY MM DD HH mm ss MMM MMMM, plus D (day), SEASON, CYCLE, CDAY, ERA.</small>
            <label class="se-manager-label">Era text (ERA)</label>
            ${calInput('era', v.era, 'e.g. AR')}
            <label class="se-manager-label">Short month name length (MMM)</label>
            ${calInput('monthAbbreviationLength', v.monthAbbreviationLength, '3', 'type="number" min="1"')}
            <label class="se-manager-label">Patterns (one "style = pattern" per line; styles: full, date, time, month, or your own)</label>
            ${calTextarea('patternsText', v.patternsText, 'full = MMMM D, YYYY ERA HH:mm:ss')}
            <label class="se-manager-label">Month display names (optional, one per line, in month order)</label>
            ${calTextarea('monthNamesText', v.monthNamesText)}
            <label class="se-manager-label">Season display names (optional, one per line)</label>
            ${calTextarea('seasonNamesText', v.seasonNamesText)}

            <h4>Natural-language rules</h4>
            <label class="se-manager-label">Unit words (one "word = unit" per line, e.g. "moon = cycle" or "tenday = day * 10")</label>
            ${calTextarea('unitAliasesText', v.unitAliasesText)}
            <label class="se-manager-label">Extra "advance" phrases (one per line)</label>
            ${calTextarea('advanceVerbsText', v.advanceVerbsText, 'let time pass', 2)}
            <label class="se-manager-label">Extra "rewind" phrases (one per line)</label>
            ${calTextarea('rewindVerbsText', v.rewindVerbsText, '', 2)}
            <label class="se-manager-label">Extra "set to" phrases (one per line)</label>
            ${calTextarea('setVerbsText', v.setVerbsText, '', 2)}

            <h4>Preview</h4>
            <div class="se-cal-preview-inputs">
                <input class="text_pole" id="se-cal-preview-scalar" placeholder="Moment: seconds or a date (blank = day 1, midday)" />
                <input class="text_pole" id="se-cal-preview-delta" placeholder="Increment, e.g. 1mo, 1season, 1cycle" />
                <input class="text_pole" id="se-cal-preview-nl" placeholder="Instruction, e.g. advance 1 season / next cycle / move to Stormfall 17" />
                <button type="button" id="se-cal-preview-run" class="menu_button"><i class="fa-solid fa-eye"></i> Preview</button>
            </div>
            <div id="se-cal-preview-output" class="se-cal-preview-output"></div>
        </div>
    `;
}

// The preview panel's HTML for previewCalendarDefinition()'s result.
export function buildCalendarPreviewOutput(result) {
    if (!result?.valid) {
        return `<div class="se-cal-preview-errors">${(result?.errors || ['No preview available']).map((e) => `<div>${escapeHtml(e)}</div>`).join('')}</div>`;
    }
    const p = result.partial || {};
    const extras = [p.season ? `Season: ${p.season}` : '', p.cycle ? `${p.cycle}: day ${p.cycleDay}` : ''].filter(Boolean);
    return `
        ${result.scalarError ? `<div><em>${escapeHtml(result.scalarError)}</em></div>` : ''}
        <div><strong>${escapeHtml(result.full)}</strong></div>
        ${extras.length ? `<div><small>${escapeHtml(extras.join(' · '))}</small></div>` : ''}
        ${result.incremented ? `<div>+ ${escapeHtml(result.incremented.delta)} → ${result.incremented.error ? `<em>${escapeHtml(result.incremented.error)}</em>` : escapeHtml(result.incremented.text)}</div>` : ''}
        ${result.resolved ? `<div>"${escapeHtml(result.resolved.instruction)}" → ${result.resolved.text === null ? '<em>not understood</em>' : escapeHtml(result.resolved.text)}</div>` : ''}
    `;
}
