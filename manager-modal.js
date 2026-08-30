// State Engine Manager Modal
// Complete tabbed interface for preset/variable/trigger/worldinfo management
// Assumes: jQuery ($), currentPresetId, getSettings(), persistSettings(), and helper functions available in global scope

function buildManagerModal() {
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
            <button class="se-manager-tab-btn" data-tab="triggers">
                <i class="fa-solid fa-bolt"></i> Triggers
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
            <div class="se-manager-tab-pane" data-tab="triggers" id="se-manager-triggers-tab"></div>
            <div class="se-manager-tab-pane" data-tab="worldinfo" id="se-manager-worldinfo-tab"></div>
        `);

    $window.append($header, $tabButtons, $content);
    $overlay.append($window);
    $('body').append($overlay);

    // Initial tab rendering
    renderManagerPresetsTab();
    renderManagerVariablesTab();
    renderManagerTriggersTab();
    renderManagerWorldInfoTab();

    // Wire events
    wireManagerModalEvents();

    return showManagerModal();
}

function showManagerModal() {
    const $overlay = $('#se-manager-overlay');
    if ($overlay.length) {
        $overlay.fadeIn(200);
    }
}

function hideManagerModal() {
    const $overlay = $('#se-manager-overlay');
    if ($overlay.length) {
        $overlay.fadeOut(200);
    }
}

function renderManagerPresetsTab() {
    const settings = getSettings();
    const $tab = $('#se-manager-presets-tab');
    if (!$tab.length) return;

    $tab.empty();

    const presetList = Object.entries(settings.presets || {})
        .map(([presetId, preset]) => {
            const triggers = preset.triggers || [];
            return `
                <div class="se-manager-preset-row">
                    <div class="se-manager-preset-info">
                        <div class="se-manager-preset-name">${escapeHtml(preset.name)}</div>
                        <small class="se-manager-preset-triggers">
                            Triggers: ${triggers.length > 0 ? triggers.join(', ') : 'none'}
                        </small>
                    </div>
                    <div class="se-manager-preset-actions">
                        <button class="se-manager-action-btn se-manager-clone-preset" data-preset-id="${presetId}" title="Clone">
                            <i class="fa-solid fa-copy"></i>
                        </button>
                        <button class="se-manager-action-btn se-manager-rename-preset" data-preset-id="${presetId}" title="Rename">
                            <i class="fa-solid fa-pencil"></i>
                        </button>
                        <button class="se-manager-action-btn se-manager-delete-preset" data-preset-id="${presetId}" title="Delete">
                            <i class="fa-solid fa-trash"></i>
                        </button>
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
                ${presetList || '<div class="se-empty">No presets yet. Click "New" to create one.</div>'}
            </div>
        </div>
    `;

    $tab.html(html);
}

function renderManagerVariablesTab() {
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
                            ${escapeHtml(varDef.category || 'manual')} • ${escapeHtml(varDef.type || 'string')} • 
                            ${varDef.showInTracker ? '👁️ visible' : '👁️ hidden'}
                        </small>
                    </div>
                    <div class="se-manager-variable-actions">
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

function renderManagerTriggersTab() {
    const settings = getSettings();
    const $tab = $('#se-manager-triggers-tab');
    if (!$tab.length) return;

    $tab.empty();

    const triggerRows = Object.entries(settings.presets || {})
        .map(([presetId, preset]) => {
            const triggers = preset.triggers || [];
            const triggerHtml = ['startup', 'new_chat', 'chat_change', 'user', 'pre_generation', 'ai', 'group_draft']
                .map(t => `
                    <label class="checkbox_label se-manager-trigger-checkbox">
                        <input type="checkbox" class="se-manager-trigger-checkbox-input" 
                               data-preset-id="${presetId}" data-trigger="${t}"
                               ${triggers.includes(t) ? 'checked' : ''} />
                        <span>${t}</span>
                    </label>
                `)
                .join('');

            return `
                <div class="se-manager-trigger-preset">
                    <h4>${escapeHtml(preset.name)}</h4>
                    <div class="se-manager-trigger-grid">
                        ${triggerHtml}
                    </div>
                </div>
            `;
        })
        .join('');

    const html = `
        <div class="se-manager-section">
            <h3>When to Update Variables</h3>
            <small>Select which events should trigger variable updates for each preset. Variables in a preset all update together.</small>
            <div class="se-manager-triggers-container">
                ${triggerRows || '<div class="se-empty">Create a preset first to configure triggers.</div>'}
            </div>
        </div>
    `;

    $tab.html(html);
}

function renderManagerWorldInfoTab() {
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

function wireManagerModalEvents() {
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
        else if (tab === 'triggers') renderManagerTriggersTab();
        else if (tab === 'worldinfo') renderManagerWorldInfoTab();
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
        // Open variable editor for new variable
        openEditor(null);
    });

    $overlay.on('click', '.se-manager-edit-variable', function () {
        const varId = $(this).attr('data-var-id');
        const presetId = $(this).attr('data-preset-id');
        currentPresetId = presetId;
        // Open editor for this variable
        const settings = getSettings();
        const preset = settings.presets[presetId];
        if (preset && preset.variables && preset.variables[varId]) {
            openEditor(preset.variables[varId]);
        }
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

    // Triggers tab
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
