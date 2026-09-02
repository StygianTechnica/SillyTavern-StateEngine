// State Engine Manager Modal
// Complete tabbed interface for preset/variable/trigger/worldinfo management
// Uses ES6 modules - imported by index.js

let managerCurrentPresetId = null;
let managerApi = null;

export function setManagerApi(api) {
    managerApi = api;
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
    const settings = managerApi.getSettings();
    const $tab = $('#se-manager-presets-tab');
    if (!$tab.length) return;

    $tab.empty();

    // Get current chat ID
    const currentChatId = getCurrentChatId();

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
                            <div class="se-manager-preset-name">
                                ${escapeHtml(preset.name)}
                                ${preset.description ? `<span class="se-manager-preset-description-inline">${escapeHtml(preset.description)}</span>` : ''}
                            </div>
                            <small class="se-manager-preset-meta">
                                ${isActive ? 'Active' : 'Inactive'} • ${triggers.length > 0 ? `${triggers.length} trigger(s)` : 'No triggers'}
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
        })
        .join('');

    const html = `
        <div class="se-manager-section">
            <div class="se-manager-section-header">
                <h3>Presets</h3>
                <div class="se-manager-section-buttons">
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

    $tab.html(html);
}

export function renderManagerVariablesTab() {
    const settings = managerApi.getSettings();
    const $tab = $('#se-manager-variables-tab');
    if (!$tab.length) return;

    $tab.empty();

    // Preset selector
    const activePresetIds = managerApi.getPresetsForChat(getCurrentChatId());
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
    const settings = managerApi.getSettings();
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
    managerApi.persistSettings(settings);
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

export function renderManagerDebugTab() {
    const $tab = $('#se-manager-debug-tab');
    if (!$tab.length) return;

    const debugInfo = managerApi.getDebugInfo();
    const isEnabled = debugInfo.debugEnabled;

    let activePresetsHtml = '';
    if (debugInfo.activePresets && debugInfo.activePresets.length > 0) {
        activePresetsHtml = debugInfo.activePresets
            .map(p => `
                <div style="margin-bottom: 12px; padding: 8px; background: #2a2a2a; border-radius: 4px;">
                    <div><strong>${escapeHtml(p.name)}</strong></div>
                    <small style="color: #aaa;">ID: ${escapeHtml(p.id)}</small>
                    <small style="color: #aaa;">Variables: ${p.variableCount}, Triggers: ${p.triggers.length}</small>
                </div>
            `)
            .join('');
    } else {
        activePresetsHtml = '<div style="color: #999;">No active presets for this chat</div>';
    }

    let variablesHtml = '';
    if (debugInfo.variables && debugInfo.variables.length > 0) {
        variablesHtml = `<table style="width: 100%; border-collapse: collapse;">
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
    } else {
        variablesHtml = '<div style="color: #999;">No variables in active presets</div>';
    }

    const html = `
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

    $tab.html(html);
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
        else if (tab === 'debug') renderManagerDebugTab();
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
    $overlay.on('click', '#se-manager-restore-presets', function () {
        if (window.confirm('Restore default presets? This will delete any custom changes to the default presets.')) {
            managerApi.restoreDefaultPresets();
            renderManagerPresetsTab();
            managerApi.renderVarTable();
            managerApi.setStatus('Restored default presets.');
        }
    });

    $overlay.on('click', '#se-manager-new-preset', function () {
        const name = prompt('New preset name:');
        if (name && name.trim()) {
            managerApi.createPreset(name.trim());
            renderManagerPresetsTab();
            managerApi.setStatus(`Created preset "${name}".`);
        }
    });

    $overlay.on('click', '.se-manager-toggle-active', function () {
        const presetId = $(this).attr('data-preset-id');
        const chatId = $(this).attr('data-chat-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        if (managerApi.getPresetsForChat(chatId).includes(presetId)) {
            managerApi.removePresetFromChat(chatId, presetId);
        } else {
            managerApi.addPresetToChat(chatId, presetId);
        }
        renderManagerPresetsTab();
        managerApi.renderVarTable();
        managerApi.renderTrackerPanel();
        managerApi.setStatus(`${managerApi.getPresetsForChat(chatId).includes(presetId) ? 'Activated' : 'Deactivated'} "${preset.name}" for this chat.`);
    });

    $overlay.on('click', '.se-manager-clone-preset', function () {
        const presetId = $(this).attr('data-preset-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        const newName = prompt('Clone name:', preset.name + ' (copy)');
        if (newName && newName.trim()) {
            const newPresetId = generateUUID();
            const newPreset = JSON.parse(JSON.stringify(preset));
            newPreset.name = newName.trim();
            settings.presets[newPresetId] = newPreset;
            managerApi.persistSettings(settings);
            renderManagerPresetsTab();
            managerApi.setStatus(`Cloned preset "${preset.name}".`);
        }
    });

    $overlay.on('click', '.se-manager-rename-preset', function () {
        const presetId = $(this).attr('data-preset-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        const newName = prompt('New name:', preset.name);
        if (newName && newName.trim()) {
            managerApi.renamePreset(presetId, newName.trim());
            renderManagerPresetsTab();
            managerApi.setStatus(`Renamed to "${newName}".`);
        }
    });

    $overlay.on('click', '.se-manager-delete-preset', function () {
        const presetId = $(this).attr('data-preset-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        if (window.confirm(`Delete preset "${preset.name}"? This will also delete all variables in this preset.`)) {
            managerApi.deletePreset(presetId);
            if (managerCurrentPresetId === presetId) managerCurrentPresetId = null;
            renderManagerPresetsTab();
            renderManagerVariablesTab();
            managerApi.setStatus(`Deleted "${preset.name}" and all its variables.`);
        }
    });

    // Variables tab
    $overlay.on('change', '#se-manager-preset-selector', function () {
        const presetId = $(this).val();
        managerCurrentPresetId = presetId;
        renderManagerVariablesTab();
    });

    $overlay.on('change', '#se-manager-filter-active', function () {
        window.managerShowActiveOnly = $(this).prop('checked');
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
        const settings = managerApi.getSettings();
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
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset || !preset.variables[varId]) return;
        
        const varDef = preset.variables[varId];
        varDef.showInTracker = varDef.showInTracker === false;
        managerApi.persistSettings(settings);
        renderManagerVariablesTab();
        managerApi.setStatus(`Visibility toggled for "${varDef.name}".`);
    });

    $overlay.on('click', '.se-manager-delete-variable', function () {
        const varId = $(this).attr('data-var-id');
        const presetId = $(this).attr('data-preset-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset || !preset.variables[varId]) return;

        if (window.confirm(`Delete variable "${preset.variables[varId].name || varId}"?`)) {
            delete preset.variables[varId];
            managerApi.persistSettings(settings);
            renderManagerVariablesTab();
            managerApi.setStatus(`Variable deleted.`);
        }
    });

    $overlay.on('click', '.se-manager-cancel-variable', function () {
        $('#se-manager-variable-editor').hide().empty();
    });

    $overlay.on('click', '.se-manager-save-variable', function () {
        const editor = $('#se-manager-variable-editor');
        if (!editor.length) return;

        const settings = managerApi.getSettings();
        const presetId = managerCurrentPresetId;
        const preset = settings.presets[presetId];
        if (!preset) return;

        const values = collectVariableEditorValues();
        const isNew = !editor.data('editing-existing');

        if (!values.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values.name)) {
            alert('Variable name is required and must start with a letter or underscore.');
            return;
        }

        // Check for reserved SillyTavern variable names
        if (managerApi.isReservedVariable(values.name)) {
            alert(`Cannot create variable: "${values.name}" is a reserved SillyTavern macro name.\n\nReserved names include: charname, user, bot, time, date, random, counter, and others.\n\nPlease choose a different name.`);
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

        managerApi.persistSettings(settings);
        editor.hide().empty();
        renderManagerVariablesTab();
        managerApi.setStatus(isNew ? 'Variable created.' : 'Variable updated.');
    });

    // Triggers in accordion
    $overlay.on('change', '.se-preset-trigger-checkbox', function () {
        const presetId = $(this).attr('data-preset-id');
        const trigger = $(this).attr('data-trigger');
        const settings = managerApi.getSettings();
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

        managerApi.persistSettings(settings);
        const $item = $(this).closest('.se-manager-preset-accordion-item');
        const $headerMeta = $item.find('.se-manager-preset-meta');
        $headerMeta.text(preset.triggers.length > 0 ? `${preset.triggers.length} trigger(s) active` : 'No triggers active');

        managerApi.setStatus(`Triggers updated for "${preset.name}".`);
    });

    // Preset description
    $overlay.on('change', '.se-manager-preset-description-input', function () {
        const presetId = $(this).attr('data-preset-id');
        const newDescription = $(this).val();
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        preset.description = newDescription;
        managerApi.persistSettings(settings);
        
        // Re-render the preset tab to update inline description display
        renderManagerPresetsTab();
        
        managerApi.setStatus(`Description updated for "${preset.name}".`);
    });

    // Debug mode controls
    $overlay.on('click', '#se-manager-debug-toggle', function () {
        const enabled = managerApi.toggleDebugMode();
        renderManagerDebugTab();
        managerApi.setStatus(`Debug mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
    });

    $overlay.on('click', '#se-manager-debug-copy-json', function () {
        const debugInfo = managerApi.getDebugInfo();
        const json = JSON.stringify(debugInfo, null, 2);
        navigator.clipboard.writeText(json).then(() => {
           managerApi.setStatus('Debug info copied to clipboard!');
        }).catch(err => {
           console.error('Failed to copy:', err);
           managerApi.setStatus('Failed to copy to clipboard');
        });
    });

    $overlay.on('click', '#se-manager-debug-log-console', function () {
        const debugInfo = managerApi.getDebugInfo();
        console.log('%c=== STATE ENGINE DEBUG INFO ===', 'background: #222; color: #bada55; font-weight: bold');
        console.table(debugInfo);
        console.log('Full settings:', debugInfo.fullSettings);
        managerApi.setStatus('Debug info logged to console');
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
