// State Engine Manager Modal
// Complete tabbed interface for preset/variable/trigger/worldinfo management
// Uses ES6 modules - imported by index.js

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
    let currentChatId = null;
    try {
        const context = window.SillyTavern?.getContext?.();
        currentChatId = context?.chat?.id;
    } catch (e) {
        // Chat context not available
    }

    if (!currentChatId) {
        const html = `
            <div class="se-manager-section">
                <div class="se-empty" style="padding: 20px; text-align: center;">
                    <p><i class="fa-solid fa-circle-info"></i> No chat selected</p>
                    <small>Select or create a chat to manage presets for this conversation.</small>
                </div>
            </div>
        `;
        $tab.html(html);
        return;
    }

    // Get presets bound to current chat
    const chatPresets = settings.chatPresetBindings[currentChatId] || [];
    const allPresets = settings.presets || {};
    
    const TRIGGER_KEYS = ['startup', 'new_chat', 'chat_change', 'user', 'pre_generation', 'ai', 'group_draft'];
    
    // Render bound presets as accordion items
    const boundPresetsHtml = chatPresets
        .filter(presetId => allPresets[presetId])
        .map(presetId => {
            const preset = allPresets[presetId];
            const triggers = preset.triggers || [];
            
            // Build trigger checkboxes for this preset
            const triggerCheckboxes = TRIGGER_KEYS
                .map(trigger => `
                    <label class="checkbox_label se-manager-trigger-checkbox" style="display: block; margin: 8px 0;">
                        <input type="checkbox" class="se-preset-trigger-checkbox" 
                               data-preset-id="${presetId}" data-trigger="${trigger}"
                               ${triggers.includes(trigger) ? 'checked' : ''} />
                        <span>${trigger}</span>
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
                                Active triggers: ${triggers.length > 0 ? triggers.join(', ') : 'none'}
                            </small>
                        </div>
                        <div class="se-manager-preset-header-actions">
                            <button class="se-manager-action-btn se-manager-unbind-preset" data-preset-id="${presetId}" data-chat-id="${currentChatId}" title="Unbind from this chat">
                                <i class="fa-solid fa-link-slash"></i>
                            </button>
                            <button class="se-manager-action-btn se-manager-clone-preset" data-preset-id="${presetId}" title="Clone">
                                <i class="fa-solid fa-copy"></i>
                            </button>
                        </div>
                    </div>
                    <div class="se-manager-preset-accordion-body" style="display: none;">
                        <div class="se-manager-preset-triggers">
                            <h4>When to update variables in this preset:</h4>
                            <div style="padding: 0 20px;">
                                ${triggerCheckboxes}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        })
        .join('');

    // Render unbound presets as simple list items
    const unboundPresetsHtml = Object.entries(allPresets)
        .filter(([presetId]) => !chatPresets.includes(presetId))
        .map(([presetId, preset]) => `
            <div class="se-manager-preset-row">
                <div class="se-manager-preset-info">
                    <div class="se-manager-preset-name">${escapeHtml(preset.name)}</div>
                    <small class="se-manager-preset-meta">Not active in this chat</small>
                </div>
                <div class="se-manager-preset-actions">
                    <button class="se-manager-action-btn se-manager-bind-preset" data-preset-id="${presetId}" data-chat-id="${currentChatId}" title="Bind to this chat">
                        <i class="fa-solid fa-link"></i>
                    </button>
                    <button class="se-manager-action-btn se-manager-clone-preset" data-preset-id="${presetId}" title="Clone">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
            </div>
        `)
        .join('');

    const html = `
        <div class="se-manager-section">
            <div class="se-manager-section-header">
                <h3>Active for this chat</h3>
                <button id="se-manager-new-preset" class="menu_button" title="Create a new preset">
                    <i class="fa-solid fa-plus"></i> New
                </button>
            </div>
            <div class="se-manager-preset-list">
                ${boundPresetsHtml || '<div class="se-empty">No presets bound to this chat. Click a link icon below to add one.</div>'}
            </div>
        </div>

        <div class="se-manager-section">
            <div class="se-manager-section-header">
                <h3>Available presets</h3>
            </div>
            <div class="se-manager-preset-list">
                ${unboundPresetsHtml || '<div class="se-empty">All presets are already bound to this chat.</div>'}
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

    const selectedPresetId = currentPresetId || Object.keys(settings.presets || {})[0];

    let variablesList = '';
    if (selectedPresetId && settings.presets[selectedPresetId]) {
        const preset = settings.presets[selectedPresetId];
        variablesList = Object.entries(preset.variables || {})
            .map(([varId, varDef]) => `
                <div class="se-manager-variable-row">
                    <div class="se-manager-variable-info">
                        <div class="se-manager-variable-name">${escapeHtml(varDef.name || varId)}</div>
                        <small class="se-manager-variable-meta">
                            ${escapeHtml(varDef.category || 'manual')} • ${escapeHtml(varDef.type || 'string')}
                        </small>
                    </div>
                    <div class="se-manager-variable-actions">
                        <button class="se-manager-action-btn se-manager-toggle-visibility" data-var-id="${varId}" data-preset-id="${selectedPresetId}" title="Toggle visibility in tracker">
                            <i class="fa-solid ${varDef.showInTracker !== false ? 'fa-eye' : 'fa-eye-slash'}"></i>
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

export function wireManagerModalEvents() {
    const $overlay = $('#se-manager-overlay');
    if (!$overlay.length) return;

    // Close modal
    $overlay.on('click', '#se-manager-close', function () {
        hideManagerModal();
    });

    // Close on overlay click (outside window)
    $overlay.on('click', '.se-manager-overlay', function (e) {
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

    $overlay.on('click', '.se-manager-bind-preset', function () {
        const presetId = $(this).attr('data-preset-id');
        const chatId = $(this).attr('data-chat-id');
        const settings = getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        addPresetToChat(chatId, presetId);
        renderManagerPresetsTab();
        setStatus(`Bound "${preset.name}" to this chat.`);
    });

    $overlay.on('click', '.se-manager-unbind-preset', function () {
        const presetId = $(this).attr('data-preset-id');
        const chatId = $(this).attr('data-chat-id');
        const settings = getSettings();
        const preset = settings.presets[presetId];
        if (!preset) return;

        removePresetFromChat(chatId, presetId);
        renderManagerPresetsTab();
        setStatus(`Unbound "${preset.name}" from this chat.`);
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
            if (currentPresetId === presetId) currentPresetId = null;
            renderManagerPresetsTab();
            renderManagerVariablesTab();
            setStatus(`Deleted "${preset.name}".`);
        }
    });

    // Variables tab
    $overlay.on('change', '#se-manager-preset-selector', function () {
        const presetId = $(this).val();
        currentPresetId = presetId;
        renderManagerVariablesTab();
    });

    $overlay.on('click', '#se-manager-new-variable', function () {
        if (!currentPresetId) {
            alert('Select a preset first.');
            return;
        }
        // Create new variable with defaults
        const settings = getSettings();
        const preset = settings.presets[currentPresetId];
        if (!preset) return;
        
        const varId = generateUUID();
        if (!preset.variables) preset.variables = {};
        
        // Create a new variable with defaults
        preset.variables[varId] = {
            id: varId,
            name: 'New Variable',
            label: '',
            category: 'manual',
            scope: 'chat',
            type: 'string',
            default: '',
            showInTracker: true,
            description: ''
        };
        
        persistSettings(settings);
        renderManagerVariablesTab();
        setStatus('New variable created. Edit name and settings as needed.');
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

    // Triggers in accordion (updated class name)
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
        
        // Update the trigger summary in the header
        const $header = $(this).closest('.se-manager-preset-accordion-item').find('.se-manager-preset-meta');
        const newTriggers = preset.triggers.length > 0 ? preset.triggers.join(', ') : 'none';
        $header.text(`Active triggers: ${newTriggers}`);
        
        setStatus(`Triggers updated for "${preset.name}".`);
    });

    // Old trigger handler for backward compatibility (removed from new UI but kept for safety)
    $overlay.on('change', '.se-manager-trigger-checkbox-input', function () {
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
