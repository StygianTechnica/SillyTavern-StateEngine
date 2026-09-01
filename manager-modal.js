// State Engine Manager Modal
// Complete tabbed interface for preset/variable/trigger/worldinfo management
// Uses ES6 modules - imported by index.js

import {
    getSettings,
    persistSettings,
    createPreset,
    renamePreset,
    deletePreset,
    getPresetsForChat,
    addPresetToChat,
    removePresetFromChat
} from './index.js';

let managerCurrentPresetId = null;

export function buildManagerModal() {
    // Check if modal already exists
    if ($('#se-manager-overlay').length) {
        return showManagerModal();
    }

    const settings = getSettings();

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
        `);

    // Build tab content container
    const $content = $('<div></div>')
        .addClass('se-manager-content')
        .html(`
            <div class="se-manager-tab-pane se-manager-tab-active" data-tab="presets" id="se-manager-presets-tab"></div>
            <div class="se-manager-tab-pane" data-tab="variables" id="se-manager-variables-tab"></div>
            <div class="se-manager-tab-pane" data-tab="worldinfo" id="se-manager-worldinfo-tab"></div>
        `);

    $window.append($header, $tabButtons, $content);
    $overlay.append($window);
    $('body').append($overlay);

    // Initial tab rendering
    renderManagerPresetsTab();
    renderManagerVariablesTab();
    renderManagerWorldInfoTab();

    // Wire events
    wireManagerModalEvents();

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

export function renderManagerPresetsTab() {
    const settings = getSettings();
    const $tab = $('#se-manager-presets-tab');
    if (!$tab.length) return;

    $tab.empty();

    // Get current chat ID
    const currentChatId = getCurrentChatId();

    const chatPresets = getPresetsForChat(currentChatId);
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
        .map(([presetId, preset]) => {
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
                            <div class="se-manager-preset-name">${escapeHtml(preset.name)}</div>
                            <small class="se-manager-preset-meta">
                                ${isActive ? 'Active' : 'Inactive'} • ${triggers.length > 0 ? `${triggers.length} trigger(s)` : 'No triggers'}
                            </small>
                        </div>
                        <div class="se-manager-preset-header-actions">
                            <button class="se-manager-action-btn se-manager-toggle-active" data-preset-id="${presetId}" data-chat-id="${currentChatId}" title="${isActive ? 'Deactivate for this chat' : 'Activate for this chat'}">
                                <i class="fa-solid ${isActive ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                            </button>
                            <button class="se-manager-action-btn se-manager-clone-preset" data-preset-id="${presetId}" title="Clone">
                                <i class="fa-solid fa-copy"></i>
                            </button>
                        </div>
                    </div>
                    <div class="se-manager-preset-accordion-body" style="display: none;">
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
        })
        .join('');

    const html = `
        <div class="se-manager-section">
            <div class="se-manager-section-header">
                <h3>Presets</h3>
                <button id="se-manager-new-preset" class="menu_button" title="Create a new preset">
                    <i class="fa-solid fa-plus"></i> New
                </button>
            </div>
            <div class="se-manager-preset-list">
                ${presetRows || '<div class="se-empty">No presets yet. Click New to create one.</div>'}
            </div>
        </div>
    `;

    $tab.html(html);
}

export function renderManagerVariablesTab() {
    const settings = getSettings();
    const $tab = $('#se-manager-variables-tab');
    if (!$tab.length) return;

    $tab.empty();

    // Preset selector
    const presetOptions = Object.entries(settings.presets || {})
        .map(([id, preset]) => `<option value="${id}">${escapeHtml(preset.name)}</option>`)
        .join('');

    const selectedPresetId = managerCurrentPresetId || Object.keys(settings.presets || {})[0];

    let variablesList = '';
    if (selectedPresetId && settings.presets[selectedPresetId]) {
        const preset = settings.presets[selectedPresetId];
        const variableEntries = Object.entries(preset.variables || {});
        variablesList = variableEntries
            .map(([varId, varDef], index) => `
                <div class="se-manager-variable-row">
                    <div class="se-manager-variable-info">
                        <div class="se-manager-variable-name">${escapeHtml(varDef.name || varId)}</div>
                        <small class="se-manager-variable-meta">
                            ${escapeHtml(varDef.category || 'manual')} • ${escapeHtml(varDef.type || 'string')}
                        </small>
                    </div>
                    <div class="se-manager-variable-actions">
                        <button class="se-manager-action-btn se-manager-move-variable-up" data-var-id="${varId}" data-preset-id="${selectedPresetId}" title="Move up" ${index === 0 ? 'disabled' : ''}>
                            <i class="fa-solid fa-arrow-up"></i>
                        </button>
                        <button class="se-manager-action-btn se-manager-move-variable-down" data-var-id="${varId}" data-preset-id="${selectedPresetId}" title="Move down" ${index === variableEntries.length - 1 ? 'disabled' : ''}>
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
            `)
            .join('');
    }

    const html = `
        <div class="se-manager-section">
            <div class="se-manager-section-header">
                <h3>Variables for Preset:</h3>
                <select id="se-manager-preset-selector" class="text_pole">
                    <option value="">-- Select preset --</option>
                    ${presetOptions}
                </select>
            </div>
            
            <div class="se-manager-section-header">
                <button id="se-manager-new-variable" class="menu_button" title="Create a new variable">
                    <i class="fa-solid fa-plus"></i> New Variable
                </button>
            </div>
            <div id="se-manager-variable-editor" class="se-manager-variable-editor" style="display:none;"></div>

            <div class="se-manager-variable-list">
                ${variablesList || '<div class="se-empty">No variables in this preset yet.</div>'}
            </div>
        </div>
    `;

    $tab.html(html);

    // Set selected preset
    if (selectedPresetId) {
        $('#se-manager-preset-selector').val(selectedPresetId);
    }
}

export function renderManagerWorldInfoTab() {
    const settings = getSettings();
    const $tab = $('#se-manager-worldinfo-tab');
    if (!$tab.length) return;

    $tab.empty();

    const conditions = settings.wiConditions || {};
    const conditionCount = Object.keys(conditions).length;
    const conditionRows = Object.entries(conditions)
        .slice(0, 50) // Limit to 50 for display
        .map(([key, conds]) => {
            const condList = Array.isArray(conds) ? conds : [];
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
        })
        .join('');

    const html = `
        <div class="se-manager-section">
            <h3>World Info Conditions</h3>
            <small>Displays conditions set on World Info entries. Total entries: ${conditionCount}</small>
            <div class="se-manager-worldinfo-list">
                ${conditionRows || '<div class="se-empty">No World Info conditions set yet.</div>'}
            </div>
        </div>
    `;

    $tab.html(html);
}

function showVariableEditor(def) {
    const d = def || {
        id: generateUUID(),
        name: '',
        label: '',
        category: 'manual',
        scope: 'chat',
        type: 'string',
        default: '',
        enumValues: [],
        min: '',
        max: '',
        description: '',
        resetOnNewChat: false,
        showInTracker: true,
        counter: { trigger: 'ai', direction: 'increment', step: 1, promptedInstructions: '' },
        cycling: { trigger: 'ai', values: [], promptedInstructions: '' },
        prompted: { triggers: [], instructions: '' }
    };

    const $editor = $('#se-manager-variable-editor');
    if (!$editor.length) return;

    $editor.html(`
        <div class="se-manager-section">
            <div class="se-manager-section-header">
                <h3>${def ? 'Edit variable' : 'New variable'}</h3>
                <div class="se-manager-variable-editor-actions">
                    <button class="menu_button se-manager-save-variable">${def ? 'Save' : 'Create'}</button>
                    <button class="menu_button se-manager-cancel-variable">Cancel</button>
                </div>
            </div>
            <div class="se-manager-variable-editor-grid">
                <input class="text_pole se-manager-var-field" data-field="name" placeholder="Variable name" value="${escapeHtml(d.name || '')}" />
                <input class="text_pole se-manager-var-field" data-field="label" placeholder="Label" value="${escapeHtml(d.label || '')}" />
                <select class="text_pole se-manager-var-field" data-field="category">
                    <option value="manual" ${d.category === 'manual' ? 'selected' : ''}>Manual</option>
                    <option value="cycling" ${d.category === 'cycling' ? 'selected' : ''}>Cycling</option>
                    <option value="prompted" ${d.category === 'prompted' ? 'selected' : ''}>Prompted</option>
                </select>
                <select class="text_pole se-manager-var-field" data-field="type">
                    <option value="string" ${d.type === 'string' ? 'selected' : ''}>String</option>
                    <option value="number" ${d.type === 'number' ? 'selected' : ''}>Number</option>
                    <option value="boolean" ${d.type === 'boolean' ? 'selected' : ''}>Boolean</option>
                    <option value="enum" ${d.type === 'enum' ? 'selected' : ''}>Enum</option>
                </select>
                <input class="text_pole se-manager-var-field" data-field="default" placeholder="Default value" value="${escapeHtml(d.default || '')}" />
            </div>
        </div>
    `).show().data('editing-id', d.id).data('editing-existing', !!def);
}

function collectVariableEditorValues() {
    const $editor = $('#se-manager-variable-editor');
    const values = { id: $editor.data('editing-id') };
    $editor.find('.se-manager-var-field').each(function () {
        values[$(this).attr('data-field')] = $(this).val();
    });
    values.showInTracker = true;
    return values;
}

function moveVariable(presetId, varId, direction) {
    const settings = getSettings();
    const preset = settings.presets[presetId];
    if (!preset || !preset.variables) return;

    const entries = Object.entries(preset.variables);
    const idx = entries.findIndex(([id]) => id === varId);
    if (idx === -1) return;

    const nextIdx = idx + direction;
    if (nextIdx < 0 || nextIdx >= entries.length) return;

    const swapped = entries.slice();
    const tmp = swapped[idx];
    swapped[idx] = swapped[nextIdx];
    swapped[nextIdx] = tmp;
    preset.variables = Object.fromEntries(swapped);
    persistSettings(settings);
    renderManagerVariablesTab();
}

function getCurrentChatId() {
    try {
        const context = window.SillyTavern?.getContext?.();
        return context?.chat?.id || null;
    } catch (e) {
        return null;
    }
}

export function wireManagerModalEvents() {
    const $overlay = $('#se-manager-overlay');
    if (!$overlay.length) return;

    // Close modal
    $overlay.on('click', '#se-manager-close', function () {
        hideManagerModal();
    });

    // Close on overlay click (outside window)
    $overlay.on('click', function (e) {
        if (e.target === this) {
            hideManagerModal();
        }
    });

    // Tab switching
    $overlay.on('click', '.se-manager-tab-btn', function () {
        const tab = $(this).attr('data-tab');
        $('.se-manager-tab-btn').removeClass('se-manager-tab-active');
        $('.se-manager-tab-pane').removeClass('se-manager-tab-active');
        $(this).addClass('se-manager-tab-active');
        $(`.se-manager-tab-pane[data-tab="${tab}"]`).addClass('se-manager-tab-active');

        // Re-render the tab content
        if (tab === 'presets') renderManagerPresetsTab();
        else if (tab === 'variables') renderManagerVariablesTab();
        else if (tab === 'worldinfo') renderManagerWorldInfoTab();
    });

    // Accordion: Toggle preset expansion
    $overlay.on('click', '.se-manager-preset-accordion-header', function () {
        const $header = $(this);
        const $body = $header.next('.se-manager-preset-accordion-body');
        const $toggle = $header.find('.se-manager-preset-accordion-toggle i');
        
        // Close all other accordion items
        $overlay.find('.se-manager-preset-accordion-body').not($body).slideUp(200);
        $overlay.find('.se-manager-preset-accordion-toggle i').removeClass('se-rotated');
        
        // Toggle this item
        $body.slideToggle(200);
        $toggle.toggleClass('se-rotated');
    });

    // Preset actions
    $overlay.on('click', '#se-manager-new-preset', function () {
        const name = prompt('New preset name:');
        if (name && name.trim()) {
            createPreset(name.trim());
            renderManagerPresetsTab();
            setStatus(`Created preset "${name}".`);
        }
    });

    $overlay.on('click', '.se-manager-toggle-active', function () {
        const presetId = $(this).attr('data-preset-id');
        const chatId = $(this).attr('data-chat-id');
        const settings = getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        if (getPresetsForChat(chatId).includes(presetId)) {
            removePresetFromChat(chatId, presetId);
        } else {
            addPresetToChat(chatId, presetId);
        }
        renderManagerPresetsTab();
        setStatus(`${getPresetsForChat(chatId).includes(presetId) ? 'Activated' : 'Deactivated'} "${preset.name}" for this chat.`);
    });

    $overlay.on('click', '.se-manager-clone-preset', function () {
        const presetId = $(this).attr('data-preset-id');
        const settings = getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        const newName = prompt('Clone name:', preset.name + ' (copy)');
        if (newName && newName.trim()) {
            const newPresetId = generateUUID();
            const newPreset = JSON.parse(JSON.stringify(preset));
            newPreset.name = newName.trim();
            settings.presets[newPresetId] = newPreset;
            persistSettings(settings);
            renderManagerPresetsTab();
            setStatus(`Cloned preset "${preset.name}".`);
        }
    });

    $overlay.on('click', '.se-manager-rename-preset', function () {
        const presetId = $(this).attr('data-preset-id');
        const settings = getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        const newName = prompt('New name:', preset.name);
        if (newName && newName.trim()) {
            renamePreset(presetId, newName.trim());
            renderManagerPresetsTab();
            setStatus(`Renamed to "${newName}".`);
        }
    });

    $overlay.on('click', '.se-manager-delete-preset', function () {
        const presetId = $(this).attr('data-preset-id');
        const settings = getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        if (window.confirm(`Delete preset "${preset.name}"? Variables in this preset won't be deleted.`)) {
            deletePreset(presetId);
            if (managerCurrentPresetId === presetId) managerCurrentPresetId = null;
            renderManagerPresetsTab();
            renderManagerVariablesTab();
            setStatus(`Deleted "${preset.name}".`);
        }
    });

    // Variables tab
    $overlay.on('change', '#se-manager-preset-selector', function () {
        const presetId = $(this).val();
        managerCurrentPresetId = presetId;
        renderManagerVariablesTab();
    });

    $overlay.on('click', '#se-manager-new-variable', function () {
        if (!managerCurrentPresetId) {
            alert('Select a preset first.');
            return;
        }
        showVariableEditor(null);
    });

    $overlay.on('click', '.se-manager-edit-variable', function () {
        const varId = $(this).attr('data-var-id');
        const presetId = $(this).attr('data-preset-id');
        const settings = getSettings();
        const preset = settings.presets[presetId];
        if (!preset || !preset.variables || !preset.variables[varId]) return;
        managerCurrentPresetId = presetId;
        showVariableEditor(preset.variables[varId]);
    });

    $overlay.on('click', '.se-manager-move-variable-up', function () {
        moveVariable($(this).attr('data-preset-id'), $(this).attr('data-var-id'), -1);
    });

    $overlay.on('click', '.se-manager-move-variable-down', function () {
        moveVariable($(this).attr('data-preset-id'), $(this).attr('data-var-id'), 1);
    });

    $overlay.on('click', '.se-manager-toggle-visibility', function () {
        const varId = $(this).attr('data-var-id');
        const presetId = $(this).attr('data-preset-id');
        const settings = getSettings();
        const preset = settings.presets[presetId];
        if (!preset || !preset.variables[varId]) return;
        
        const varDef = preset.variables[varId];
        varDef.showInTracker = varDef.showInTracker === false;
        persistSettings(settings);
        renderManagerVariablesTab();
        setStatus(`Visibility toggled for "${varDef.name}".`);
    });

    $overlay.on('click', '.se-manager-delete-variable', function () {
        const varId = $(this).attr('data-var-id');
        const presetId = $(this).attr('data-preset-id');
        const settings = getSettings();
        const preset = settings.presets[presetId];
        if (!preset || !preset.variables[varId]) return;

        if (window.confirm(`Delete variable "${preset.variables[varId].name || varId}"?`)) {
            delete preset.variables[varId];
            persistSettings(settings);
            renderManagerVariablesTab();
            setStatus(`Variable deleted.`);
        }
    });

    $overlay.on('click', '.se-manager-cancel-variable', function () {
        $('#se-manager-variable-editor').hide().empty();
    });

    $overlay.on('click', '.se-manager-save-variable', function () {
        const editor = $('#se-manager-variable-editor');
        if (!editor.length) return;

        const settings = getSettings();
        const presetId = managerCurrentPresetId;
        const preset = settings.presets[presetId];
        if (!preset) return;

        const values = collectVariableEditorValues();
        const isNew = !editor.data('editing-existing');

        if (!values.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values.name)) {
            alert('Variable name is required and must start with a letter or underscore.');
            return;
        }

        if (!preset.variables) preset.variables = {};
        if (isNew && preset.variables[values.id]) {
            values.id = generateUUID();
        }

        preset.variables[values.id] = {
            id: values.id,
            name: values.name.trim(),
            label: String(values.label || '').trim(),
            category: values.category || 'manual',
            scope: 'chat',
            type: values.type || 'string',
            default: values.default || '',
            showInTracker: true,
            description: '',
            counter: { trigger: 'ai', direction: 'increment', step: 1, promptedInstructions: '' },
            cycling: { trigger: 'ai', values: [], promptedInstructions: '' },
            prompted: { triggers: [], instructions: '' }
        };

        persistSettings(settings);
        editor.hide().empty();
        renderManagerVariablesTab();
        setStatus(isNew ? 'Variable created.' : 'Variable updated.');
    });

    // Triggers in accordion
    $overlay.on('change', '.se-preset-trigger-checkbox', function () {
        const presetId = $(this).attr('data-preset-id');
        const trigger = $(this).attr('data-trigger');
        const settings = getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        if (!preset.triggers) preset.triggers = [];

        if ($(this).is(':checked')) {
            if (!preset.triggers.includes(trigger)) {
                preset.triggers.push(trigger);
            }
        } else {
            preset.triggers = preset.triggers.filter(t => t !== trigger);
        }

        persistSettings(settings);
        const $item = $(this).closest('.se-manager-preset-accordion-item');
        const $headerMeta = $item.find('.se-manager-preset-meta');
        $headerMeta.text(preset.triggers.length > 0 ? `${preset.triggers.length} trigger(s) active` : 'No triggers active');

        setStatus(`Triggers updated for "${preset.name}".`);
    });
}

function escapeHtml(text) {
    if (!text) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
