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
    const currentChatId = managerApi.getCurrentChatId();

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
    const activePresetIds = managerApi.getPresetsForChat(managerApi.getCurrentChatId());
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
            .map(([varId, varDef], index) => {
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
                    <div class="se-manager-variable-editor-inline" style="display:none;"></div>
                </div>
            `;
            })
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

    $tab.html(html);

    // Set selected preset
    if (selectedPresetId) {
        $('#se-manager-preset-selector').val(selectedPresetId);
    }

    // Wire up search and sort handlers
    $('#se-manager-variable-search').on('input', filterAndSortVariables);
    $('#se-manager-variable-sort').on('change', function () {
        filterAndSortVariables();
        updateMoveButtonStates();
    });

    // Set initial button states
    updateMoveButtonStates();
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

function showInlineVariableEditor(varDef, $row) {
    // Default structure for new variables
    const defaults = {
        id: generateUUID(),
        name: '',
        label: '',
        category: 'manual', // legacy
        scope: 'chat',
        type: 'string',
        default: '',
        enumValues: [],
        min: '',
        max: '',
        description: '',
        resetOnNewChat: false,
        showInTracker: true,
        skipPromptedRefresh: false,

        behaviors: {
            increment: false,
            prompted: false
        },

        increment: {
            triggers: [],
            delta: 1,
            toggle: true,
            cycle: [],
            timeInterval: '',
            specificTime: '',
            randomInterval: ''
        },

        prompted: {
            triggers: [],
            instructions: ''
        }
    };

    // Merge defaults into existing varDef
    const d = Object.assign({}, defaults, varDef);

    // Deep merge nested objects so old presets don't crash
    d.behaviors = Object.assign({}, defaults.behaviors, varDef?.behaviors);
    d.increment = Object.assign({}, defaults.increment, varDef?.increment);
    d.prompted = Object.assign({}, defaults.prompted, varDef?.prompted);
    const canIncrement = (d.type === 'number' || d.type === 'boolean' || d.type === 'enum');

    const $editor = $row.find('.se-manager-variable-editor-inline');
    
    $editor.html(`
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
                            <input id="se-manager-prompted-toggle"
                                type="checkbox"
                                class="se-manager-var-field"
                                data-field="behaviors.prompted"
                                ${d.behaviors?.prompted ? 'checked' : ''} />
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
                                <input id="se-manager-increment-toggle"
                                    type="checkbox"
                                    class="se-manager-var-field"
                                    data-field="behaviors.increment"
                                    ${d.behaviors?.increment ? 'checked' : ''} />
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
                ${generateExplanation(d)}
            </div>

            <!-- Actions -->
            <div class="se-manager-variable-editor-actions">
                <button class="menu_button se-manager-save-variable-inline">${d._isNew ? 'Create' : 'Save'}</button>
                <button class="menu_button se-manager-cancel-variable-inline">Cancel</button>
            </div>
        </div>

    `).data('editing-id', d.id).data('editing-existing', !d._isNew).show();


    // Disable other controls
    $('#se-manager-new-variable, #se-manager-variable-search, #se-manager-variable-sort').prop('disabled', true).css('opacity', '0.5');
    $row.siblings('.se-manager-variable-row').css('opacity', '0.5').find('button:not(.se-manager-edit-variable)').prop('disabled', true);
    $row.find('.se-manager-variable-row-header').css('opacity', '0.5').find('button').prop('disabled', true);
}

function generateExplanation(d) {
    let out = [];

    // Type + default
    const base = `${d.name || 'This variable'} is a ${d.type} variable`;
    if (d.default !== '' && d.default !== undefined && d.default !== null) {
        out.push(`${base} with a default value of "${d.default}".`);
    } else {
        out.push(`${base} with no default value.`);
    }

    // Prompted behavior
    if (d.behaviors?.prompted) {
        out.push(`It updates when the prompted instructions are satisfied.`);
    }

    // Increment behavior
    if (d.behaviors?.increment) {

        // Trigger logic depends on prompted
        if (d.behaviors.prompted) {
            out.push(`Its value increments when the prompted condition is met.`);
        } else {
            const trigger = incrementTriggerText(d.increment?.triggers || []);
            out.push(`Its value increments ${trigger}.`);
        }

        // Type-specific increment behavior
        if (d.type === 'number') {
            out.push(`Each increment changes the value by ${d.increment?.delta ?? 1}.`);
        } else if (d.type === 'boolean') {
            out.push(`Each increment toggles the boolean value.`);
        } else if (d.type === 'enum') {
            out.push(`Each increment cycles through the enum values.`);
        }
    }

    return out.join(' ');
}

function incrementTriggerText(triggers) {
    if (triggers.includes('user')) return 'when a user chat is received';
    if (triggers.includes('ai')) return 'when an AI chat is received';
    if (triggers.includes('both')) return 'when either user or AI chat is received';
    return 'when the increment condition is met';
}

function hideInlineVariableEditor($row) {
    $row.find('.se-manager-variable-editor-inline').hide().empty().removeData('editing-id').removeData('editing-existing');
    
    // Re-enable other controls
    $('#se-manager-new-variable, #se-manager-variable-search, #se-manager-variable-sort').prop('disabled', false).css('opacity', '1');
    $row.siblings('.se-manager-variable-row').css('opacity', '1').find('button').prop('disabled', false);
    $row.find('.se-manager-variable-row-header').css('opacity', '1').find('button').prop('disabled', false);
}

function collectInlineVariableValues($row) {
    const $editor = $row.find('.se-manager-variable-editor-inline');
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

// function showVariableEditor(def) {
//     const d = def || {
//         id: generateUUID(),
//         name: '',
//         label: '',
//         category: 'manual',
//         scope: 'chat',
//         type: 'string',
//         default: '',
//         enumValues: [],
//         min: '',
//         max: '',
//         description: '',
//         resetOnNewChat: false,
//         showInTracker: true,
//         counter: { trigger: 'ai', direction: 'increment', step: 1, promptedInstructions: '' },
//         cycling: { trigger: 'ai', values: [], promptedInstructions: '' },
//         prompted: { triggers: [], instructions: '' }
//     };

//     const $editor = $('#se-manager-variable-editor');
//     if (!$editor.length) return;

//     $editor.html(`
//         <div class="se-manager-section">
//             <div class="se-manager-section-header">
//                 <h3>${def ? 'Edit variable' : 'New variable'}</h3>
//                 <div class="se-manager-variable-editor-actions">
//                     <button class="menu_button se-manager-save-variable">${def ? 'Save' : 'Create'}</button>
//                     <button class="menu_button se-manager-cancel-variable">Cancel</button>
//                 </div>
//             </div>
//             <div class="se-manager-variable-editor-grid">
//                 <input class="text_pole se-manager-var-field" data-field="name" placeholder="Variable name" value="${escapeHtml(d.name || '')}" />
//                 <input class="text_pole se-manager-var-field" data-field="label" placeholder="Label" value="${escapeHtml(d.label || '')}" />
//                 <select class="text_pole se-manager-var-field" data-field="category">
//                     <option value="manual" ${d.category === 'manual' ? 'selected' : ''}>Manual</option>
//                     <option value="cycling" ${d.category === 'cycling' ? 'selected' : ''}>Cycling</option>
//                     <option value="prompted" ${d.category === 'prompted' ? 'selected' : ''}>Prompted</option>
//                 </select>
//                 <select class="text_pole se-manager-var-field" data-field="type">
//                     <option value="string" ${d.type === 'string' ? 'selected' : ''}>String</option>
//                     <option value="number" ${d.type === 'number' ? 'selected' : ''}>Number</option>
//                     <option value="boolean" ${d.type === 'boolean' ? 'selected' : ''}>Boolean</option>
//                     <option value="enum" ${d.type === 'enum' ? 'selected' : ''}>Enum</option>
//                 </select>
//                 <input class="text_pole se-manager-var-field" data-field="default" placeholder="Default value" value="${escapeHtml(d.default || '')}" />
//                 <label class="se-manager-inline-checkbox">
//                     <input type="checkbox" class="se-manager-var-field" data-field="skipPromptedRefresh" ${d.skipPromptedRefresh ? 'checked' : ''} />
//                     <span>Skip prompted refresh</span>
//                 </label>
//                 <textarea class="text_pole se-manager-var-field se-manager-prompted-instructions" data-field="prompted?.instructions" placeholder="Prompted variable instructions">${escapeHtml(d.prompted?.instructions || '')}</textarea>
//             </div>
//         </div>
//     `).show().data('editing-id', d.id).data('editing-existing', !!def);
// }

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
    managerApi.renderTrackerPanel(); // Update tracker with new variable order
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

function filterAndSortVariables() {
    const $list = $('#se-manager-variable-list');
    if (!$list.length) return;

    const searchTerm = $('#se-manager-variable-search').val().toLowerCase();
    const sortMode = $('#se-manager-variable-sort').val() || 'tracker';
    let $rows = $list.find('.se-manager-variable-row');

    // Filter based on search (partial match on both name and label)
    $rows.each(function () {
        const $row = $(this);
        const varName = $row.data('var-name') || '';
        const varLabel = $row.data('var-label') || '';
        
        // Show if: no search term, OR name contains term, OR label contains term
        if (searchTerm === '' || varName.includes(searchTerm) || varLabel.includes(searchTerm)) {
            $row.show();
        } else {
            $row.hide();
        }
    });

    // Get visible rows for sorting
    $rows = $list.find('.se-manager-variable-row:visible');
    const visibleRows = Array.from($rows);

    // Sort based on selected mode
    if (sortMode === 'tracker') {
        // Tracker order: show only variables that appear in tracker (showInTracker !== false), keep original order
        visibleRows.forEach(row => {
            const $row = $(row);
            const showInTracker = $row.data('show-in-tracker') === 'true' || $row.data('show-in-tracker') === true;
            if (showInTracker) {
                $row.show();
            } else {
                $row.hide();
            }
        });
    } else if (sortMode === 'name-asc' || sortMode === 'name-desc') {
        visibleRows.sort((a, b) => {
            const $aRow = $(a);
            const $bRow = $(b);
            const aName = $aRow.data('var-name');
            const bName = $bRow.data('var-name');
            const aLabel = $aRow.data('var-label');
            const bLabel = $bRow.data('var-label');

            if (sortMode === 'name-asc') {
                return (aLabel || aName).localeCompare(bLabel || bName);
            } else {
                return (bLabel || bName).localeCompare(aLabel || aName);
            }
        });

        // Re-append sorted rows
        visibleRows.forEach(row => {
            $list.append(row);
        });
    }

    // Show "no results" message if all hidden
    if ($list.find('.se-manager-variable-row:visible').length === 0) {
        if ($list.find('.se-empty').length === 0) {
            $list.append('<div class="se-empty">No variables match your search or filter.</div>');
        }
    } else {
        $list.find('.se-empty').remove();
    }
}

function updateMoveButtonStates() {
    const sortMode = $('#se-manager-variable-sort').val() || 'order';
    const isTrackerOrder = sortMode === 'tracker';
    
    // Enable/disable all move buttons based on sort mode
    const $moveButtons = $('.se-manager-move-variable-up, .se-manager-move-variable-down');
    $moveButtons.prop('disabled', !isTrackerOrder);
    
    // Add/remove class for visual feedback
    if (isTrackerOrder) {
        $moveButtons.removeClass('se-button-disabled');
    } else {
        $moveButtons.addClass('se-button-disabled');
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

        const newVar = {
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
            skipPromptedRefresh: false,

            behaviors: {
                increment: false,
                prompted: false
            },

            increment: {
                triggers: [],
                delta: 1,
                toggle: true,
                cycle: [],
                timeInterval: '',
                specificTime: '',
                randomInterval: ''
            },

            prompted: {
                triggers: [],
                instructions: ''
            }
        };

        
        const settings = managerApi.getSettings();
        const activePresetIds = managerApi.getPresetsForChat(managerApi.getCurrentChatId());
        const allPresets = Object.keys(settings.presets || {});
        const selectedPresetId = allPresets.includes(managerCurrentPresetId)
            ? managerCurrentPresetId
            : activePresetIds[0] || allPresets[0] || null;
        const preset = settings.presets[selectedPresetId];
        preset.variables[newVar.id] = newVar;//XXXXXXXX
        renderManagerVariablesTab();

        const varId = newVar.id;
        managerCurrentPresetId = selectedPresetId;
        
        const $row = $(`#se-manager-variable-list .se-manager-variable-row[data-var-id="${newVar.id}"]`);
        showInlineVariableEditor({... newVar, _isNew: true }, $row);

    });

    $overlay.on('click', '.se-manager-edit-variable', function () {
        const varId = $(this).attr('data-var-id');
        const presetId = $(this).attr('data-preset-id');
        const settings = managerApi.getSettings();
        const preset = settings.presets[presetId];
        if (!preset || !preset.variables || !preset.variables[varId]) return;
        managerCurrentPresetId = presetId;
        
        const $row = $(this).closest('.se-manager-variable-row');
        showInlineVariableEditor(preset.variables[varId], $row);
    });

    $overlay.on('click', '.se-manager-move-variable-up', function () {
        const sortMode = $('#se-manager-variable-sort').val() || 'order';
        if (sortMode !== 'tracker') {
            managerApi.setStatus('Switch to "Tracker order" sort to reorder variables.');
            return;
        }
        moveVariable($(this).attr('data-preset-id'), $(this).attr('data-var-id'), -1);
    });

    $overlay.on('click', '.se-manager-move-variable-down', function () {
        const sortMode = $('#se-manager-variable-sort').val() || 'order';
        if (sortMode !== 'tracker') {
            managerApi.setStatus('Switch to "Tracker order" sort to reorder variables.');
            return;
        }
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

    // $overlay.on('click', '.se-manager-cancel-variable', function () {
    //     $('#se-manager-variable-editor').hide().empty();
    // });

    // $overlay.on('click', '.se-manager-cancel-variable-inline', function () {
    //     const $row = $(this).closest('.se-manager-variable-row');
    //     const $editor = $row.find('.se-manager-variable-editor-inline');
    //     const varId = $editor.data('editing-id');
    //     const presetId = $(this).attr('data-preset-id');
    //     const settings = managerApi.getSettings();
    //     const preset = settings.presets[presetId];
    //     if (!preset || !preset.variables[varId]) return;
    //     delete preset.variables[varId];
    //     managerApi.persistSettings(settings);
    //     hideInlineVariableEditor($row);
    // });
    $overlay.on('click', '.se-manager-cancel-variable-inline', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const $editor = $row.find('.se-manager-variable-editor-inline');

        const isNew = !$editor.data('editing-existing');
        const varId = $editor.data('editing-id');

        if (isNew) {
            const settings = managerApi.getSettings();
            const preset = settings.presets[managerCurrentPresetId];

            delete preset.variables[varId];
            managerApi.persistSettings(settings);
            $row.remove();
        } else {
            hideInlineVariableEditor($row);
        }
    });

    $overlay.on('click', '.se-manager-save-variable-inline', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const $editor = $row.find('.se-manager-variable-editor-inline');
        if (!$editor.length) return;

        const settings = managerApi.getSettings();
        const presetId = managerCurrentPresetId;
        const preset = settings.presets[presetId];
        if (!preset) return;

        const values = collectInlineVariableValues($row);
        const isNew = !$editor.data('editing-existing');

        if (!values.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values.name)) {
            alert('Variable name is required and must start with a letter or underscore.');
            return;
        }

        // Check for reserved SillyTavern variable names
        if (managerApi.isReservedVariable(values.name)) {
            alert(`Cannot create variable: "${values.name}" is a reserved SillyTavern macro name.`);
            return;
        }

        // Build new variable definition using the updated schema
        preset.variables[values.id] = {
            id: values.id,
            name: values.name.trim(),collectInlineVariableValues,
            label: String(values.label || '').trim(),
            description: values.description || '',
            scope: values.scope || 'chat',

            type: values.type || 'string',
            enumValues: values.enumValues || [],

            defaultValue: values.defaultValue ?? '',

            min: values.min ?? null,
            max: values.max ?? null,

            resetOnNewChat: values.resetOnNewChat || false,
            showInTracker: values.showInTracker !== false,

            behaviors: {
                increment: !!values.behaviors?.increment,
                prompted: !!values.behaviors?.prompted,
            },

            increment: {
                delta: Number(values.increment?.delta || 1),
                triggers: values.increment?.triggers || ['ai'],
                tick_mode: values.increment?.tick_mode || null,
                tick_on: values.increment?.tick_on || 'both',
                tick_every: Number(values.increment?.tick_every || 1),
            },

            prompted: {
                instructions: values.prompted?.instructions || '',
            },
        };

        managerApi.persistSettings(settings);
        hideInlineVariableEditor($row);
        renderManagerVariablesTab();
        managerApi.setStatus(isNew ? 'Variable created.' : 'Variable updated.');
    });


    // $overlay.on('click', '.se-manager-save-variable', function () {
    //     const editor = $('#se-manager-variable-editor');
    //     if (!editor.length) return;

    //     const settings = managerApi.getSettings();
    //     const presetId = managerCurrentPresetId;
    //     const preset = settings.presets[presetId];
    //     if (!preset) return;

    //     const values = collectVariableEditorValues();
    //     const isNew = !editor.data('editing-existing');

    //     if (!values.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values.name)) {
    //         alert('Variable name is required and must start with a letter or underscore.');
    //         return;
    //     }

    //     // Check for reserved SillyTavern variable names
    //     if (managerApi.isReservedVariable(values.name)) {
    //         alert(`Cannot create variable: "${values.name}" is a reserved SillyTavern macro name.\n\nReserved names include: charname, user, bot, time, date, random, counter, and others.\n\nPlease choose a different name.`);
    //         return;
    //     }

    //     if (!preset.variables) preset.variables = {};
    //     if (isNew && preset.variables[values.id]) {
    //         values.id = generateUUID();
    //     }

    //     preset.variables[values.id] = {
    //         id: values.id,
    //         name: values.name.trim(),
    //         label: String(values.label || '').trim(),
    //         category: values.category || 'manual',
    //         scope: 'chat',
    //         type: values.type || 'string',
    //         default: values.default || '',
    //         showInTracker: true,
    //         description: '',
    //         counter: { trigger: 'ai', direction: 'increment', step: 1, promptedInstructions: '' },
    //         cycling: { trigger: 'ai', values: [], promptedInstructions: '' },
    //         prompted: { triggers: [], instructions: '' }
    //     };

    //     managerApi.persistSettings(settings);
    //     editor.hide().empty();
    //     renderManagerVariablesTab();
    //     managerApi.setStatus(isNew ? 'Variable created.' : 'Variable updated.');
    // });

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

    $overlay.on('change', '#se-manager-prompted-toggle', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const isOn = $(this).is(':checked');

        // UI-only toggles
        $overlay.find('.se-manager-prompted-section').toggle(isOn);
        $overlay.find('.se-manager-increment-heartbeat').toggle(!isOn);

        setTimeout(() => {
            const values = collectInlineVariableValues($row);

            // Ensure behaviors exists
            values.behaviors = values.behaviors || {};

            // Inject BOTH behaviors
            values.behaviors.prompted = isOn;
            values.behaviors.increment = $('#se-manager-increment-toggle').is(':checked');

            showInlineVariableEditor(values, $row);
        }, 0);
    });

    $overlay.on('change', '#se-manager-increment-toggle', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const isOn = $(this).is(':checked');

        // UI-only toggles
        $overlay.find('.se-manager-increment-settings').toggle(isOn);

        setTimeout(() => {
            const values = collectInlineVariableValues($row);

            values.behaviors = values.behaviors || {};

            // Inject BOTH behaviors
            values.behaviors.increment = isOn;
            values.behaviors.prompted = $('#se-manager-prompted-toggle').is(':checked');

            showInlineVariableEditor(values, $row);
        }, 0);
    });

    $overlay.on('change', '[data-field="type"]', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const $editor = $row.find('.se-manager-variable-editor-inline');

        // Pull current working values from the editor
        const values = collectInlineVariableValues($row);

        // Update only the type in the working copy
        values.type = $(this).val();

        // Re-render the editor with updated working copy
        showInlineVariableEditor(values, $row);
    });

    $overlay.on('change', '[data-field="type"]', function () {
        const $row = $(this).closest('.se-manager-variable-row');
        const $editor = $row.find('.se-manager-variable-editor-inline');

        const values = collectInlineVariableValues($row);
        values.type = $(this).val();

        // Disable increment for strings
        if (values.type === 'string') {
            values.behaviors.increment = false;
        }

        showInlineVariableEditor(values, $row);
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

