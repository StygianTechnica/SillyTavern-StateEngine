// State Engine — UI template strings
// Pure functions that build HTML strings for the manager modal.
// Uses ES6 modules - imported by manager-modal.js

import { escapeHtml } from './utils.js';
import * as variableSchema from './variable-schema.js';

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

export function buildInlineVariableEditor(d, canIncrement) {
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
            </select>

            <input class="text_pole se-manager-var-field"
                data-field="defaultValue"
                placeholder="Default value"
                value="${escapeHtml(d.defaultValue)}" />

            <!-- Behavior toggles -->
            <div class="se-manager-variable-behaviors">

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

                <!-- Increment toggle -->
                ${canIncrement ? `
                    <div class="se-manager-toggle-row">
                        <div class="se-row">
                            <label class="checkbox_label">
                                <input id="se-manager-increment-toggle" type="checkbox" class="se-manager-var-field" data-field="behaviors.increment" ${d.behaviors?.increment ? 'checked' : ''} />
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

                    ${d.type === 'boolean' ? `
                        <label>Toggle value on increment</label>
                    ` : ''}

                    ${d.type === 'enum' ? `
                        <label>Cycle through enum values</label>
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
