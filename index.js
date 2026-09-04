// State Engine — local, prompt-free state tracking for SillyTavern
//
// Keeps user-defined "state variables" locally (per chat or global), exposes
// them to World Info / prompts / character cards via the built-in {{getvar::name}}
// macro family, and can update them automatically:
//   - "manual"   variables: you (or a slash command) set them directly.
//   - "counter"  variables: increment/decrement by a fixed step on a trigger.
//   - "prompted" variables: a quiet, invisible background generation asks the
//                 AI to derive/update the value from recent chat context.
//
// Nothing this extension does is added to the visible chat log or the
// permanent context — prompted updates run as an isolated background
// generation, and the results are written straight into SillyTavern's
// native chat/global variable store.

import { 
    buildManagerModal, 
    showManagerModal, 
    hideManagerModal,
    renderManagerPresetsTab,
    renderManagerVariablesTab,
    renderManagerWorldInfoTab,
    setManagerApi,
    wireManagerModalEvents
} from './manager-modal.js';

const CURRENT_SCHEMA_VERSION = 1;

const MODULE_NAME = 'state_engine';
const EXT_TEMPLATE_PATH = 'third-party/SillyTavern-StateEngine';
const LOG_PREFIX = '[State Engine]';
const DEFAULT_PROMPTED_HEADER = [
            'You are a silent background state‑tracking process for a roleplay chat application.',
            'You are not a character in the roleplay and must not narrate, comment, or add anything besides the requested output.',
            'You will be given a recent conversation excerpt and a list of state variables with conditions.',
            'Evaluate each variable according to its conditions and return the required JSON output.',
            ''
        ].join('\n');

const DEFAULT_UNIFIED_VARIABLE_RULES = [
            '',
            'Output rules:',
            '- Reply with ONLY a single raw JSON object. No markdown code fences, no explanation, no extra text.',
            '- The object must contain exactly one key per listed variable.',
            '- For update variables: return the new value. If no change is needed, repeat the current value unchanged.',
            '- For boolean-condition variables: return true if the condition is met, otherwise false.',
        ].join('\n');

// Debug mode - session-only, not persisted
window.seDebugMode = false;

function migrateAllSettings(settings) {
    if (!settings) return;
    for (const preset of Object.values(settings.presets || {})) {
        const vars = preset.variables || {};
        for (const def of Object.values(vars)) {
            migrateVariableDefinition(def);
        }
    }

    // Sanitize chatPresetBindings
    if (!settings.chatPresetBindings || typeof settings.chatPresetBindings !== 'object') {
        settings.chatPresetBindings = {};
    } else {
        for (const chatId of Object.keys(settings.chatPresetBindings)) {
            const binding = settings.chatPresetBindings[chatId];

            // If binding is null or not an object, reset it
            if (!binding || typeof binding !== 'object') {
                settings.chatPresetBindings[chatId] = {};
            }

            // Otherwise leave it EXACTLY as-is
        }
    }

}


function migrateVariableDefinition(def) {
    const v = def.version || 0;

    if (v < CURRENT_SCHEMA_VERSION) {
        // Future migrations go here
        def.version = CURRENT_SCHEMA_VERSION;
    }

    return def;
}

export function toggleDebugMode() {
    window.seDebugMode = !window.seDebugMode;
    console.log(`${LOG_PREFIX} Debug mode ${window.seDebugMode ? 'ENABLED' : 'DISABLED'}`);
    return window.seDebugMode;
}

export function debugLog(...args) {
    if (window.seDebugMode) {
        console.log(LOG_PREFIX, ...args);
    }
}

// Session state (not persisted)
let currentPresetId = null;

setManagerApi({
    getSettings,
    persistSettings,
    getCurrentChatId,
    createPreset,
    renamePreset,
    deletePreset,
    getPresetsForChat,
    addPresetToChat,
    removePresetFromChat,
    setStatus,
    renderVarTable,
    renderTrackerPanel,
    restoreDefaultPresets,
    toggleDebugMode,
    debugLog,
    getDebugInfo,
    isReservedVariable,
    blankDefinition
});

function getCurrentChatId() {
    try {
        const context = window.SillyTavern?.getContext?.();
        return context?.chatId || context?.chat?.id || context?.groupId || context?.group?.id || window.chat_id || null;
    } catch (e) {
        return null;
    }
}

function updateManagerButtonState() {
    const hasChat = !!getCurrentChatId();
    const $button = $('#se_open_manager');
    const $hint = $('#se_open_manager_hint');
    $button.prop('disabled', !hasChat);
    $hint.toggle(!hasChat);
}

function refreshManagerButtonLater() {
    setTimeout(updateManagerButtonState, 0);
    setTimeout(updateManagerButtonState, 250);
}

function watchChatSelection() {
    const target = document.body;
    if (!target) return;

    const observer = new MutationObserver(() => {
        updateManagerButtonState();
    });

    observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-id', 'data-chat-id'] });
    updateManagerButtonState();
}

function openManagerIfReady() {
    if (!getCurrentChatId()) {
        updateManagerButtonState();
        return;
    }
    if ($('#se-manager-overlay').length && $('#se-manager-overlay').is(':visible')) {
        hideManagerModal();
        return;
    }
    buildManagerModal();
}

function openTrackerPanelIfReady() {
    if (!getCurrentChatId()) {
        updateManagerButtonState();
        return;
    }
    const $panel = $('#se_tracker_panel');
    if ($panel.length && $panel.is(':visible')) {
        setTrackerPanelVisible(false);
        return;
    }
    setTrackerPanelVisible(true);
}

async function addStateEngineWandUi() {
    if (!getSettings().wandVisible) return;
    const menu = $('#extensionsMenu');
    if (!menu.length || document.getElementById('state-engine-wand-button')) return;

    menu.append(`
        <div id="state-engine-wand-button" class="list-group-item flex-container flexGap5">
            <div class="extensionsMenuExtensionButton fa-solid fa-wand-magic-sparkles"></div>
            <span>State Engine</span>
            <i class="fa-solid fa-chevron-right se-wand-caret"></i>
        </div>
        <div id="state-engine-wand-submenu" class="se-wand-submenu" style="display:none;">
            <div id="state-engine-wand-tracker" class="list-group-item flex-container flexGap5 se-wand-subitem">
                <div class="extensionsMenuExtensionButton fa-solid fa-list"></div>
                <span>Tracker</span>
            </div>
            <div id="state-engine-wand-manager" class="list-group-item flex-container flexGap5 se-wand-subitem">
                <div class="extensionsMenuExtensionButton fa-solid fa-sliders"></div>
                <span>Manager</span>
            </div>
        </div>
    `);

    $('#state-engine-wand-button').on('click', (e) => {
        e.stopPropagation();
        $('#state-engine-wand-submenu').toggle();
        $('#state-engine-wand-button .se-wand-caret').toggleClass('fa-chevron-right fa-chevron-down');
    });

    $('#state-engine-wand-tracker').on('click', (e) => {
        e.stopPropagation();
        openTrackerPanelIfReady();
    });

    $('#state-engine-wand-manager').on('click', (e) => {
        e.stopPropagation();
        openManagerIfReady();
    });
}

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    wandVisible: true,
    contextMessageCount: 10,
    responseLength: 300,
    connectionProfileId: '',
    showTrackerPanel: false,
    trackerPanelPos: { top: 100, left: 100 },
    trackerPanelCollapsed: false,
    trackerShowHidden: false,
    presets: {},
    chatPresetBindings: {},
    defaultPresetForNewChats: '',
    trackerPresets: [],
    wiConditions: {}, // Maps "worldbook.uid" -> array of {variable, operator, value}
    promptedHeader: DEFAULT_PROMPTED_HEADER,
});

// All the moments a "prompted" variable can be told to re-evaluate at —
// deliberately mirrors SillyTavern's Quick Reply automation trigger points.
const PROMPTED_TRIGGER_KEYS = ['startup', 'new_chat', 'chat_change', 'user', 'pre_generation', 'ai', 'group_draft'];

// World Info conditional display operators
const CONDITION_OPERATORS = {
    'equals': (varValue, condValue) => {
        const v = String(varValue).toLowerCase().trim();
        const c = String(condValue).toLowerCase().trim();
        return v === c;
    },
    'not_equals': (varValue, condValue) => {
        const v = String(varValue).toLowerCase().trim();
        const c = String(condValue).toLowerCase().trim();
        return v !== c;
    },
    'greater_than': (varValue, condValue) => {
        const v = Number(varValue);
        const c = Number(condValue);
        return !isNaN(v) && !isNaN(c) && v > c;
    },
    'less_than': (varValue, condValue) => {
        const v = Number(varValue);
        const c = Number(condValue);
        return !isNaN(v) && !isNaN(c) && v < c;
    },
    'greater_or_equal': (varValue, condValue) => {
        const v = Number(varValue);
        const c = Number(condValue);
        return !isNaN(v) && !isNaN(c) && v >= c;
    },
    'less_or_equal': (varValue, condValue) => {
        const v = Number(varValue);
        const c = Number(condValue);
        return !isNaN(v) && !isNaN(c) && v <= c;
    },
    'contains': (varValue, condValue) => {
        return String(varValue).toLowerCase().includes(String(condValue).toLowerCase());
    },
    'not_contains': (varValue, condValue) => {
        return !String(varValue).toLowerCase().includes(String(condValue).toLowerCase());
    },
    'regex': (varValue, condValue) => {
        try {
            return new RegExp(condValue, 'i').test(String(varValue));
        } catch (e) {
            console.error(`${LOG_PREFIX} Invalid regex in condition:`, condValue, e);
            return true; // Fail open on regex error
        }
    },
    'in_list': (varValue, condValue) => {
        const list = String(condValue).split(',').map(v => v.trim().toLowerCase());
        return list.includes(String(varValue).toLowerCase());
    },
    'is_true': (varValue) => varValue == true || String(varValue).toLowerCase() === 'true' || varValue == 1,
    'is_false': (varValue) => varValue == false || String(varValue).toLowerCase() === 'false' || varValue == 0,
};

// ---------------------------------------------------------------------------
// World Info Conditional Display
// ---------------------------------------------------------------------------

function makeWIEntryKey(world, uid) {
    return `${world}.${uid}`;
}

function getWIConditions(entryKey) {
    const settings = getSettings();
    return settings.wiConditions[entryKey] || [];
}

function setWICondition(entryKey, condition) {
    const settings = getSettings();
    if (!settings.wiConditions[entryKey]) {
        settings.wiConditions[entryKey] = [];
    }
    settings.wiConditions[entryKey].push(condition);
    //saveSettings(settings);
    console.log(`${LOG_PREFIX} Added condition to ${entryKey}:`, condition);
}

function updateWICondition(entryKey, index, condition) {
    const settings = getSettings();
    if (settings.wiConditions[entryKey] && settings.wiConditions[entryKey][index]) {
        settings.wiConditions[entryKey][index] = condition;
        //saveSettings(settings);
        console.log(`${LOG_PREFIX} Updated condition ${index} for ${entryKey}:`, condition);
    }
}

function deleteWICondition(entryKey, index) {
    const settings = getSettings();
    if (settings.wiConditions[entryKey]) {
        settings.wiConditions[entryKey].splice(index, 1);
        if (settings.wiConditions[entryKey].length === 0) {
            delete settings.wiConditions[entryKey];
        }
        //saveSettings(settings);
        console.log(`${LOG_PREFIX} Deleted condition ${index} for ${entryKey}`);
    }
}

function clearWIConditionsForEntry(entryKey) {
    const settings = getSettings();
    if (settings.wiConditions[entryKey]) {
        delete settings.wiConditions[entryKey];
        //saveSettings(settings);
        console.log(`${LOG_PREFIX} Cleared all conditions for ${entryKey}`);
    }
}

function evaluateCondition(varName, operator, condValue) {
    try {
        const varValue = getVarValue(varName);
        const operatorFunc = CONDITION_OPERATORS[operator];
        
        if (!operatorFunc) {
            console.warn(`${LOG_PREFIX} Unknown operator: ${operator}`);
            return true; // Fail open
        }
        
        return operatorFunc(varValue, condValue);
    } catch (e) {
        console.error(`${LOG_PREFIX} Error evaluating condition for ${varName}:`, e);
        return true; // Fail open
    }
}

function shouldDisplayWIEntry(entryKey) {
    const conditions = getWIConditions(entryKey);
    if (conditions.length === 0) return true; // No conditions = always show
    
    // All conditions must evaluate to true (AND logic)
    return conditions.every(cond => {
        const result = evaluateCondition(cond.variable, cond.operator, cond.value);
        if (!result) {
            console.debug(`${LOG_PREFIX} ${entryKey} filtered out: ${cond.variable} ${cond.operator} ${cond.value}`);
        }
        return result;
    });
}

function filterWorldInfoEntries(entries) {
    if (!Array.isArray(entries)) return entries;
    return entries.filter(entry => {
        const entryKey = makeWIEntryKey(entry.world, entry.uid);
        return shouldDisplayWIEntry(entryKey);
    });
}

function getAvailableVariablesForConditions() {
    // Get all variables from all active presets in current chat
    const context = SillyTavern.getContext();
    const currentChatId = context.chat.id || 'unknown';
    const settings = getSettings();
    
    const variables = [];
    const activePresetIds = getPresetsForChat(currentChatId);
    const seenNames = new Set();
    
    for (const presetId of activePresetIds) {
        const preset = settings.presets[presetId];
        if (!preset || !preset.variables) continue;
        
        for (const [varName, def] of Object.entries(preset.variables)) {
            if (seenNames.has(varName)) continue;
            seenNames.add(varName);
            
            variables.push({
                name: varName,
                type: def.type || 'manual',
                category: def.category || 'manual',
                presetId: presetId,
                presetName: preset.name || presetId,
            });
        }
    }
    
    return variables;
}

function applyWorldInfoConditionalFiltering() {
    // Hook into world info activation to filter entries based on variable conditions
    // This runs when world info is being prepared for the LLM context
    
    try {
        const context = SillyTavern.getContext();
        
        // getWorldInfoPrompt is exported on the context API
        if (!context.getWorldInfoPrompt) {
            console.debug(`${LOG_PREFIX} getWorldInfoPrompt not available, skipping conditional filtering`);
            return;
        }
        
        // Call getWorldInfoPrompt to get the current world info state
        const wiPrompt = context.getWorldInfoPrompt();
        if (!wiPrompt || !wiPrompt.outletEntries) {
            console.debug(`${LOG_PREFIX} No world info outlets to filter`);
            return;
        }
        
        // Before filtering, get the original count for logging
        const originalCount = wiPrompt.outletEntries.length;
        
        // Filter entries based on our conditions
        const filteredEntries = [];
        const filteredOutEntries = [];
        
        for (const entry of wiPrompt.outletEntries) {
            const entryKey = makeWIEntryKey(entry.world || entry.book || 'unknown', entry.uid);
            if (shouldDisplayWIEntry(entryKey)) {
                filteredEntries.push(entry);
            } else {
                filteredOutEntries.push(entry);
            }
        }
        
        // Log filtering results for debugging
        if (filteredOutEntries.length > 0) {
            console.log(`${LOG_PREFIX} Filtered out ${filteredOutEntries.length}/${originalCount} world info entries based on conditions`);
            for (const entry of filteredOutEntries) {
                const entryKey = makeWIEntryKey(entry.world || entry.book || 'unknown', entry.uid);
                const conditions = getWIConditions(entryKey);
                console.log(`  - "${entry.comment || entry.name || 'unnamed'}" (${entryKey}): ${conditions.map(c => `${c.variable}${c.operator}${c.value}`).join(', ')}`);
            }
        }
        
        // Replace the outlet entries with the filtered version
        wiPrompt.outletEntries = filteredEntries;
        
    } catch (e) {
        console.error(`${LOG_PREFIX} Error applying world info conditional filtering:`, e);
        // Fail open - don't break world info if filtering fails
    }
}

function getWorldInfoEntries() {
    // Get all available world info entries from the current context
    const context = SillyTavern.getContext();
    
    try {
        if (!context.getWorldInfoPrompt) return [];
        
        const wiPrompt = context.getWorldInfoPrompt();
        if (!wiPrompt || !wiPrompt.outletEntries) return [];
        
        return wiPrompt.outletEntries || [];
    } catch (e) {
        console.error(`${LOG_PREFIX} Error getting world info entries:`, e);
        return [];
    }
}

function injectWIConditionUI() {
    // Inject condition UI into the WI entry editor dialog
    // Look for the entry-specific fields (those are only visible when editing an entry)
    const entryFields = document.querySelector('.world-info-entry-fields, .ui-world-info-edit-form, .form-inline');
    if (!entryFields) return; // No WI editor visible
    
    // Check if we already injected
    if (entryFields.querySelector('.se-wi-injected-conditions')) return;
    
    // Build the condition UI HTML
    const conditionsHTML = `
        <div class="se-wi-injected-conditions" style="margin-top: 12px; padding: 8px; background: rgba(128,128,128,0.05); border-radius: 3px; border-left: 3px solid #4a9eff;">
            <div style="margin-bottom: 8px;">
                <label style="font-weight: bold; display: block; margin-bottom: 4px;">
                    <i class="fa-solid fa-filter"></i> State Engine Conditions
                </label>
                <small style="opacity: 0.8; display: block; margin-bottom: 8px;">Control if this entry displays based on variable state (all must be true)</small>
            </div>
            <div id="se_wi_injected_conditions_list" class="se-conditions-list" style="margin-bottom: 8px;"></div>
            <button type="button" class="se-wi-add-condition-btn menu_button" style="font-size: 0.9em;">
                <i class="fa-solid fa-plus"></i> Add condition
            </button>
            <div id="se_wi_injected_condition_editor" style="display: none; margin-top: 8px; padding: 8px; background: rgba(255,255,255,0.3); border-radius: 3px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 8px;">
                    <div>
                        <label for="se_wi_injected_cond_variable" style="font-size: 0.9em;">Variable</label>
                        <select id="se_wi_injected_cond_variable" class="text_pole" style="font-size: 0.9em;">
                            <option value="">-- Select variable --</option>
                        </select>
                    </div>
                    <div>
                        <label for="se_wi_injected_cond_operator" style="font-size: 0.9em;">Operator</label>
                        <select id="se_wi_injected_cond_operator" class="text_pole" style="font-size: 0.9em;">
                            <option value="equals">equals</option>
                            <option value="not_equals">not equals</option>
                            <option value="greater_than">greater than</option>
                            <option value="less_than">less than</option>
                            <option value="greater_or_equal">≥ greater or equal</option>
                            <option value="less_or_equal">≤ less or equal</option>
                            <option value="contains">contains</option>
                            <option value="not_contains">not contains</option>
                            <option value="in_list">in list</option>
                            <option value="regex">regex pattern</option>
                            <option value="is_true">is true</option>
                            <option value="is_false">is false</option>
                        </select>
                    </div>
                    <div id="se_wi_injected_cond_value_container">
                        <label for="se_wi_injected_cond_value" style="font-size: 0.9em;">Value</label>
                        <input id="se_wi_injected_cond_value" type="text" class="text_pole" style="font-size: 0.9em;" placeholder="comma-separated for 'in list'" />
                    </div>
                </div>
                <div style="display: flex; gap: 6px;">
                    <button type="button" class="se-wi-save-condition-btn menu_button" style="font-size: 0.9em;">Add condition</button>
                    <button type="button" class="se-wi-cancel-condition-btn menu_button" style="font-size: 0.9em;">Cancel</button>
                </div>
            </div>
        </div>
    `;
    
    // Find the right place to insert (after the entry name/comment field or similar)
    // Usually at the end of the form or before the action buttons
    const insertPoint = entryFields.querySelector('.world-info-entry-form-bottom, .form-inline:last-child') || entryFields;
    const temp = document.createElement('div');
    temp.innerHTML = conditionsHTML;
    insertPoint.appendChild(temp.firstElementChild);
    
    console.log(`${LOG_PREFIX} Injected World Info condition UI`);
}

function getWIEditorEntryKey() {
    // Try to extract the current entry key being edited from the WI editor
    // Look for uid in data attributes or the form
    const uidInput = document.querySelector('[name="uid"], [data-uid], .world-info-entry-uid');
    if (uidInput) {
        const uid = uidInput.value || uidInput.getAttribute('data-uid') || uidInput.textContent;
        // Try to get the world/book name
        const worldInput = document.querySelector('[name="world"], [data-world], .world-info-entry-world');
        const world = worldInput ? (worldInput.value || worldInput.getAttribute('data-world') || 'unknown') : 'unknown';
        if (uid) return makeWIEntryKey(world, uid);
    }
    return null;
}

function wireInjectedWIConditionUI() {
    // Wire up click handlers for the injected condition UI
    const addBtn = document.querySelector('.se-wi-add-condition-btn');
    const saveBtn = document.querySelector('.se-wi-save-condition-btn');
    const cancelBtn = document.querySelector('.se-wi-cancel-condition-btn');
    const operatorSelect = document.getElementById('se_wi_injected_cond_operator');
    
    if (!addBtn) return;
    
    addBtn.removeEventListener('click', handleWIAddCondition);
    addBtn.addEventListener('click', handleWIAddCondition);
    
    if (saveBtn) {
        saveBtn.removeEventListener('click', handleWISaveCondition);
        saveBtn.addEventListener('click', handleWISaveCondition);
    }
    
    if (cancelBtn) {
        cancelBtn.removeEventListener('click', handleWICancelCondition);
        cancelBtn.addEventListener('click', handleWICancelCondition);
    }
    
    if (operatorSelect) {
        operatorSelect.removeEventListener('change', handleWIOperatorChange);
        operatorSelect.addEventListener('change', handleWIOperatorChange);
    }
}

function handleWIAddCondition() {
    const editor = document.getElementById('se_wi_injected_condition_editor');
    if (!editor) return;
    
    const variables = getAvailableVariablesForConditions();
    const varSelect = document.getElementById('se_wi_injected_cond_variable');
    varSelect.innerHTML = '<option value="">-- Select variable --</option>' + 
        variables.map(v => `<option value="${v.name}">${v.presetName} / ${v.name}</option>`).join('');
    
    editor.style.display = 'block';
}

function handleWICancelCondition() {
    const editor = document.getElementById('se_wi_injected_condition_editor');
    if (editor) editor.style.display = 'none';
}

function handleWISaveCondition() {
    const entryKey = getWIEditorEntryKey();
    if (!entryKey) {
        alert('Could not identify the entry being edited. Make sure you have an entry open.');
        return;
    }
    
    const varName = document.getElementById('se_wi_injected_cond_variable').value;
    const operator = document.getElementById('se_wi_injected_cond_operator').value;
    const value = document.getElementById('se_wi_injected_cond_value').value;
    
    if (!varName || !operator) {
        alert('Please select a variable and operator');
        return;
    }
    
    if ((operator !== 'is_true' && operator !== 'is_false') && !value) {
        alert('Please enter a value');
        return;
    }
    
    const condition = {
        variable: varName,
        operator: operator,
        value: operator.startsWith('is_') ? '' : value
    };
    
    setWICondition(entryKey, condition);
    
    // Refresh condition list and close editor
    renderInjectedWIConditions(entryKey);
    handleWICancelCondition();
}

function handleWIOperatorChange() {
    const operator = document.getElementById('se_wi_injected_cond_operator').value;
    const isBoolean = operator === 'is_true' || operator === 'is_false';
    const valueContainer = document.getElementById('se_wi_injected_cond_value_container');
    if (valueContainer) {
        valueContainer.style.display = isBoolean ? 'none' : 'block';
    }
}

function renderInjectedWIConditions(entryKey) {
    const list = document.getElementById('se_wi_injected_conditions_list');
    if (!list) return;
    
    const conditions = getWIConditions(entryKey);
    
    if (conditions.length === 0) {
        list.innerHTML = '<div style="opacity:0.7; padding:4px; font-size:0.9em;">No conditions — entry will always display.</div>';
        return;
    }
    
    const html = conditions.map((cond, index) => `
        <div class="se-condition-item" style="display: flex; align-items: center; justify-content: space-between; padding: 4px 6px; margin: 4px 0; background: rgba(255,255,255,0.2); border-radius: 3px; font-size: 0.9em;">
            <span class="se-condition-text"><code>${cond.variable}</code> ${cond.operator} <code>${cond.value}</code></span>
            <button type="button" class="se-delete-injected-condition menu_button" data-entry-key="${entryKey}" data-index="${index}" title="Delete" style="padding: 2px 6px; font-size: 0.85em;">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    `).join('');
    
    list.innerHTML = html;
    
    // Wire delete buttons
    list.querySelectorAll('.se-delete-injected-condition').forEach(btn => {
        btn.removeEventListener('click', handleWIDeleteCondition);
        btn.addEventListener('click', handleWIDeleteCondition);
    });
}

function handleWIDeleteCondition(e) {
    const btn = e.target.closest('button');
    const entryKey = btn.getAttribute('data-entry-key');
    const index = parseInt(btn.getAttribute('data-index'), 10);
    
    if (!confirm('Delete this condition?')) return;
    
    deleteWICondition(entryKey, index);
    renderInjectedWIConditions(entryKey);
}

function observeWIEditorChanges() {
    // Monitor the DOM for when a WI entry editor opens/closes
    // and inject/update the condition UI accordingly
    const observer = new MutationObserver(() => {
        injectWIConditionUI();
        
        // If we have an entry open, render its conditions
        const entryKey = getWIEditorEntryKey();
        if (entryKey) {
            renderInjectedWIConditions(entryKey);
            wireInjectedWIConditionUI();
        }
    });
    
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: false,
    });
    
    console.log(`${LOG_PREFIX} Monitoring WI editor for changes`);
}

function populateWIEntrySelect() {
    // Populate the world info entry dropdown
    const select = document.getElementById('se_wi_entry_select');
    if (!select) return;
    
    const entries = getWorldInfoEntries();
    
    if (entries.length === 0) {
        select.innerHTML = '<option value="">No world info entries loaded</option>';
        const detailsSection = document.getElementById('se_wi_entry_details');
        const noEntriesMsg = document.getElementById('se_wi_no_entries');
        if (detailsSection) detailsSection.style.display = 'none';
        if (noEntriesMsg) noEntriesMsg.style.display = 'block';
        return;
    }
    
    const options = ['<option value="">-- Select an entry --</option>'];
    for (const entry of entries) {
        const entryKey = makeWIEntryKey(entry.world || entry.book || 'unknown', entry.uid);
        const entryName = entry.comment || entry.name || `[${entry.uid}]`;
        options.push(`<option value="${entryKey}">${entryName}</option>`);
    }
    
    select.innerHTML = options.join('');
    const noEntriesMsg = document.getElementById('se_wi_no_entries');
    if (noEntriesMsg) noEntriesMsg.style.display = 'none';
}

function renderWIConditions(entryKey) {
    // Render the list of conditions for a world info entry
    const list = document.getElementById('se_wi_conditions_list');
    if (!list) return;
    
    const conditions = getWIConditions(entryKey);
    
    if (conditions.length === 0) {
        list.innerHTML = '<div style="opacity:0.7; padding:4px;">No conditions. Entry will always display.</div>';
        return;
    }
    
    const html = conditions.map((cond, index) => `
        <div class="se-condition-item">
            <div class="se-condition-text">${cond.variable} ${cond.operator} ${cond.value}</div>
            <div class="se-condition-actions">
                <button class="se-condition-btn" onclick="deleteWIConditionFromUI('${entryKey}', ${index})" title="Delete"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
    `).join('');
    
    list.innerHTML = html;
}

function openWIConditionEditor(entryKey) {
    // Open the condition editor for adding a new condition
    const editor = document.getElementById('se_wi_condition_editor');
    if (!editor) return;
    
    // Populate variable dropdown
    const varSelect = document.getElementById('se_wi_cond_variable');
    if (varSelect) {
        const variables = getAvailableVariablesForConditions();
        varSelect.innerHTML = '<option value="">-- Select variable --</option>' + 
            variables.map(v => `<option value="${v.name}">${v.presetName} / ${v.name}</option>`).join('');
    }
    
    // Reset form
    const valueInput = document.getElementById('se_wi_cond_value');
    if (valueInput) valueInput.value = '';
    
    // Show editor
    editor.style.display = 'block';
    
    // Store the entry key for saving
    editor._editingEntryKey = entryKey;
}

function closeWIConditionEditor() {
    const editor = document.getElementById('se_wi_condition_editor');
    if (editor) {
        editor.style.display = 'none';
        editor._editingEntryKey = null;
    }
}

function saveWIConditionFromUI() {
    // Save a condition from the UI
    const editor = document.getElementById('se_wi_condition_editor');
    if (!editor || !editor._editingEntryKey) return;
    
    const entryKey = editor._editingEntryKey;
    const varName = document.getElementById('se_wi_cond_variable').value;
    const operator = document.getElementById('se_wi_cond_operator').value;
    const value = document.getElementById('se_wi_cond_value').value;
    
    if (!varName || !operator) {
        alert('Please select a variable and operator');
        return;
    }
    
    if ((operator !== 'is_true' && operator !== 'is_false') && !value) {
        alert('Please enter a value');
        return;
    }
    
    const condition = {
        variable: varName,
        operator: operator,
        value: operator.startsWith('is_') ? '' : value
    };
    
    setWICondition(entryKey, condition);
    
    // Refresh UI
    renderWIConditions(entryKey);
    closeWIConditionEditor();
    updateWIEntryStatus(entryKey);
}

function deleteWIConditionFromUI(entryKey, index) {
    deleteWICondition(entryKey, index);
    renderWIConditions(entryKey);
    updateWIEntryStatus(entryKey);
}

function updateWIEntryStatus(entryKey) {
    // Update the status badge showing if entry is currently active
    const statusDiv = document.getElementById('se_wi_entry_status');
    if (!statusDiv) return;
    
    const isActive = shouldDisplayWIEntry(entryKey);
    statusDiv.className = 'se-wi-status ' + (isActive ? 'active' : 'inactive');
    statusDiv.innerHTML = isActive ? '✓ Currently displayed' : '✗ Filtered out';
}

function openWorldInfoConditionManager() {
    // Toggle world info condition manager panel
    const editorSection = document.getElementById('se_wi_editor_section');
    if (!editorSection) return;
    
    if (editorSection.style.display === 'none') {
        editorSection.style.display = 'block';
        populateWIEntrySelect();
    } else {
        editorSection.style.display = 'none';
    }
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

export function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredCloneSafe(DEFAULT_SETTINGS);
    }
    const settings = context.extensionSettings[MODULE_NAME];
    if (settings.enabled === undefined) settings.enabled = true;
    if (settings.contextMessageCount === undefined) settings.contextMessageCount = 10;
    if (settings.responseLength === undefined) settings.responseLength = 300;
    if (settings.connectionProfileId === undefined) settings.connectionProfileId = '';
    if (settings.showTrackerPanel === undefined) settings.showTrackerPanel = false;
    if (!settings.trackerPanelPos || typeof settings.trackerPanelPos !== 'object') settings.trackerPanelPos = { top: 100, left: 100 };
    if (settings.trackerPanelCollapsed === undefined) settings.trackerPanelCollapsed = false;
    if (settings.trackerShowHidden === undefined) settings.trackerShowHidden = false;

    
    if (!settings.presets || typeof settings.presets !== 'object') settings.presets = {};
    if (!settings.chatPresetBindings || typeof settings.chatPresetBindings !== 'object') settings.chatPresetBindings = {};
    
    // Clean up any "undefined", "null", or other invalid chat ID keys
    const validKeys = Object.keys(settings.chatPresetBindings).filter(key => key && key !== 'undefined' && key !== 'null');
    if (validKeys.length !== Object.keys(settings.chatPresetBindings).length) {
        const cleaned = {};
        for (const key of validKeys) {
            cleaned[key] = settings.chatPresetBindings[key];
        }
        settings.chatPresetBindings = cleaned;
        debugLog('Cleaned up invalid chat ID keys from bindings');
    }
    
    if (!settings.defaultPresetForNewChats) settings.defaultPresetForNewChats = '';
    if (!settings.wiConditions || typeof settings.wiConditions !== 'object') settings.wiConditions = {};

    
    return settings;
}



function getStarterPresetBlueprints() {
    const makeVar = (overrides) => {
        const base = managerApi.blankDefinition();
        return {
            ...base,
            ...overrides,
        };
    };

    return [
        {
            name: 'Story Progression',
            description: 'Track narrative progression: chapters, story arcs, quests, and major plot points.',
            triggers: ['ai'],
            vars: [
                makeVar({
                    name: 'chapter',
                    label: 'Chapter',
                    type: 'number',
                    defaultValue: 1,
                    min: 1,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Increment when the story clearly moves to the next chapter.' },
                    description: 'Main narrative chapter progression.',
                }),

                makeVar({
                    name: 'arc_phase',
                    label: 'Arc Phase',
                    type: 'enum',
                    enumValues: ['setup', 'rising_action', 'climax', 'aftermath'],
                    defaultValue: 'setup',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Advance when the current arc phase has clearly resolved.' },
                    description: 'Current high-level story arc phase.',
                }),

                makeVar({
                    name: 'quest_active',
                    label: 'Quest Active',
                    type: 'boolean',
                    defaultValue: false,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Set true when a quest begins; set false when it ends.' },
                    description: 'Whether a main quest is currently active.',
                }),

                makeVar({
                    name: 'quest_name',
                    label: 'Quest Name',
                    type: 'string',
                    defaultValue: '',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Update when a new quest begins or the quest name changes.' },
                    description: 'Current quest title.',
                }),
            ],
        },

        {
            name: 'Location and Time',
            description: 'Manage scene settings: current location, time of day, weather, and environment state.',
            triggers: ['user', 'ai'],
            vars: [
                makeVar({
                    name: 'current_location',
                    label: 'Current Location',
                    type: 'enum',
                    enumValues: ['tavern', 'market', 'arena', 'road', 'wilderness'],
                    defaultValue: 'tavern',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Infer location from narrative context.' },
                    description: 'Current scene location.',
                }),

                makeVar({
                    name: 'time_of_day',
                    label: 'Time of Day',
                    type: 'enum',
                    enumValues: ['dawn', 'morning', 'noon', 'evening', 'night'],
                    defaultValue: 'morning',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Advance when narration implies time has progressed.' },
                    description: 'Narrative time period.',
                }),

                makeVar({
                    name: 'weather',
                    label: 'Weather',
                    type: 'string',
                    defaultValue: 'clear',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Infer weather from narrative context. Keep concise (1–3 words).' },
                    description: 'Current weather condition.',
                }),

                makeVar({
                    name: 'is_indoor',
                    label: 'Indoor Scene',
                    type: 'boolean',
                    defaultValue: true,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Set true when the scene moves indoors; false when outdoors.' },
                    description: 'Whether current scene is indoors.',
                }),
            ],
        },

        {
            name: 'Relationships',
            description: 'Track character dynamics: trust levels, affection, relationship status, and betrayals.',
            triggers: ['ai'],
            vars: [
                makeVar({
                    name: 'npc_trust',
                    label: 'NPC Trust',
                    type: 'number',
                    defaultValue: 25,
                    min: 0,
                    max: 100,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Estimate trust from recent interactions on a 0–100 scale.' },
                    description: 'General trust level with a focal NPC.',
                }),

                makeVar({
                    name: 'npc_affection',
                    label: 'NPC Affection',
                    type: 'number',
                    defaultValue: 20,
                    min: 0,
                    max: 100,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Estimate affection from recent interactions on a 0–100 scale.' },
                    description: 'General affection level with a focal NPC.',
                }),

                makeVar({
                    name: 'relationship_status',
                    label: 'Relationship Status',
                    type: 'enum',
                    enumValues: ['strangers', 'acquaintances', 'friends', 'allies', 'intimate'],
                    defaultValue: 'strangers',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Advance only when interactions justify relationship progression.' },
                    description: 'Current relationship state.',
                }),

                makeVar({
                    name: 'betrayal_flag',
                    label: 'Betrayal Flag',
                    type: 'boolean',
                    defaultValue: false,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Set true when betrayal occurs; false when resolved.' },
                    description: 'Set true if betrayal has occurred.',
                }),
            ],
        },

        {
            name: 'Combat and Encounter',
            description: 'Manage combat state: active/inactive status, round count, threat level, and encounter tags.',
            triggers: ['user', 'ai'],
            vars: [
                makeVar({
                    name: 'combat_active',
                    label: 'Combat Active',
                    type: 'boolean',
                    defaultValue: false,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Set true when combat begins; false when combat ends.' },
                    description: 'Whether combat is currently active.',
                }),

                makeVar({
                    name: 'rounds_elapsed',
                    label: 'Rounds Elapsed',
                    type: 'number',
                    defaultValue: 0,
                    behaviors: { increment: true, prompted: false },
                    increment: {
                        delta: 1,
                        triggers: ['both'],
                        tick_mode: 'per_message',
                        tick_on: 'both',
                        tick_every: 1,
                    },
                    description: 'Combat rounds elapsed.',
                }),

                makeVar({
                    name: 'threat_level',
                    label: 'Threat Level',
                    type: 'enum',
                    enumValues: ['low', 'medium', 'high', 'critical'],
                    defaultValue: 'low',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Infer threat level from narrative context.' },
                    description: 'Current encounter danger level.',
                }),

                makeVar({
                    name: 'encounter_tags',
                    label: 'Encounter Tags',
                    type: 'array',
                    defaultValue: [],
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Update tags when encounter descriptors change.' },
                    description: 'Array of current encounter tags.',
                }),
            ],
        },

        {
            name: 'Mixed Showcase',
            description: 'Example preset demonstrating all variable types.',
            triggers: ['ai'],
            vars: [
                makeVar({
                    name: 'mood',
                    label: 'Mood',
                    type: 'string',
                    defaultValue: 'neutral',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Infer room mood in one word: calm, tense, hopeful, ominous, etc.' },
                    description: 'Prompted text example.',
                }),

                makeVar({
                    name: 'danger_score',
                    label: 'Danger Score',
                    type: 'number',
                    defaultValue: 10,
                    min: 0,
                    max: 100,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Estimate danger from recent context from 0–100.' },
                    description: 'Prompted number with min/max.',
                }),

                makeVar({
                    name: 'story_flags',
                    label: 'Story Flags',
                    type: 'array',
                    defaultValue: [],
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Update flags when story conditions change.' },
                    description: 'Manual array.',
                }),

                makeVar({
                    name: 'event_stage',
                    label: 'Event Stage',
                    type: 'enum',
                    enumValues: ['seed', 'signal', 'portent', 'manifest'],
                    defaultValue: 'seed',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Advance when narrative omens intensify.' },
                    description: 'Enum showcase.',
                }),

                makeVar({
                    name: 'heartbeat',
                    label: 'Heartbeat Counter',
                    type: 'number',
                    defaultValue: 0,
                    behaviors: { increment: true, prompted: false },
                    increment: {
                        delta: 1,
                        triggers: ['both'],
                        tick_mode: 'per_message',
                        tick_on: 'both',
                        tick_every: 1,
                    },
                    description: 'Simple per-message counter.',
                }),

                makeVar({
                    name: 'omens_unlocked',
                    label: 'Omens Unlocked',
                    type: 'boolean',
                    defaultValue: false,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Set true when omens are discovered; false when reset.' },
                    description: 'Manual boolean toggle showcase.',
                }),
            ],
        },
    ];
}


function seedExamplePresets(settings, restoreMissing) {
    const blueprints = getStarterPresetBlueprints();
    const existingNames = new Map();
    for (const preset of Object.values(settings.presets || {})) {
        existingNames.set(String(preset.name || '').toLowerCase(), preset);
    }

    const createdPresetIds = [];
    for (const seed of blueprints) {
        const existing = existingNames.get(seed.name.toLowerCase());
        if (existing && !restoreMissing) {
            continue;
        }
        if (existing && restoreMissing) {
            continue;
        }
        const presetId = genId();
        const variables = {};
        for (const def of seed.vars) variables[def.id] = def;
        settings.presets[presetId] = {
            id: presetId,
            name: seed.name,
            description: seed.description || '',
            variables,
            triggers: seed.triggers,
            showInTracker: true,
        };
        createdPresetIds.push(presetId);
    }

    if (!settings.defaultPresetForNewChats) {
        settings.defaultPresetForNewChats = createdPresetIds[0] || '';
    }
    if (createdPresetIds.length > 0 && !settings.trackerPresets?.length) {
        settings.trackerPresets = createdPresetIds.slice(0, 3);
    }
    if (createdPresetIds.length > 0) {
        console.log(`${LOG_PREFIX} seeded ${createdPresetIds.length} starter preset(s)`);
    }
}

export function restoreDefaultPresets() {
    const settings = getSettings();
    const blueprints = getStarterPresetBlueprints();
    // Ensure all chat bindings are arrays
    for (const chatId of Object.keys(settings.chatPresetBindings)) {
        const list = settings.chatPresetBindings[chatId];
        if (!Array.isArray(list)) {
            settings.chatPresetBindings[chatId] = [];
        }
    }
    // Delete existing default presets by name so we can restore them
    for (const seed of blueprints) {
        for (const [presetId, preset] of Object.entries(settings.presets)) {
            if (preset.name === seed.name) {
                deletePreset(presetId);
                break;
            }
        }
    }
    
    // Re-seed the defaults
    seedExamplePresets(settings, false);
    persistSettings();
    console.log(`${LOG_PREFIX} restored default presets`);
}

export function persistSettings() {
    try {
        SillyTavern.getContext().saveSettingsDebounced();
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to save settings', err);
    }
}

// ---------------------------------------------------------------------------
// Preset management
// ---------------------------------------------------------------------------

export function createPreset(name) {
    const presetId = genId();
    const preset = {
        id: presetId,
        name: name || 'New Preset',
        description: '',  // User-provided explanation of what this preset does
        variables: {},
        triggers: ['ai'],  // Preset-level: when to update prompted variables in this preset
        showInTracker: false,  // Whether this preset's variables appear in the floating tracker
    };
    const settings = getSettings();
    settings.presets[presetId] = preset;
    persistSettings();
    return presetId;
}

export function renamePreset(presetId, newName) {
    const settings = getSettings();
    if (settings.presets[presetId]) {
        settings.presets[presetId].name = newName;
        persistSettings();
    }
}

export function deletePreset(presetId) {
    const settings = getSettings();
    delete settings.presets[presetId];
    
    // Remove from all chat bindings
    for (const bindingList of Object.values(settings.chatPresetBindings)) {
        if (!Array.isArray(bindingList)) continue;
        const idx = bindingList.indexOf(presetId);
        if (idx !== -1) bindingList.splice(idx, 1);
    }
    
    // Clear as default if it was
    if (settings.defaultPresetForNewChats === presetId) {
        settings.defaultPresetForNewChats = '';
    }
    
    persistSettings();
}

export function getPresetsForChat(chatId) {
    const settings = getSettings();
    
    // Guard against invalid chatId
    if (!chatId || chatId === 'undefined' || chatId === 'null') {
        return [];
    }
    
    // Support both old format (array) and new format (object with presetIds array)
    const binding = settings.chatPresetBindings[chatId];
    
    if (!binding) {
        settings.chatPresetBindings[chatId] = { presetIds: [], presetLoadOrder: [] };
        return [];
    }
    
    // Legacy format: plain array
    if (Array.isArray(binding)) {
        settings.chatPresetBindings[chatId] = { presetIds: binding, presetLoadOrder: binding };
        persistSettings();
        return binding;
    }
    
    // New format: object with presetIds and presetLoadOrder
    return binding.presetIds || [];
}

function shouldSkipPromptedRefresh(def) {
    return !!(def && def.skipPromptedRefresh);
}

export function getPresetLoadOrder(chatId) {
    // Guard against invalid chatId
    if (!chatId || chatId === 'undefined' || chatId === 'null') {
        return [];
    }
    
    const settings = getSettings();
    const binding = settings.chatPresetBindings[chatId];
    
    if (!binding) return [];
    if (Array.isArray(binding)) return binding; // Legacy format
    return binding.presetLoadOrder || binding.presetIds || [];
}

export function setPresetsForChat(chatId, presetIds) {
    const settings = getSettings();
    settings.chatPresetBindings[chatId] = { presetIds, presetLoadOrder: presetIds };
    persistSettings();
}

export function addPresetToChat(chatId, presetId) {
    // Validate chatId to prevent storing under "undefined" or "null"
    if (!chatId || chatId === 'undefined' || chatId === 'null') {
        debugLog(`WARNING: addPresetToChat called with invalid chatId: "${chatId}"`);
        return;
    }
    
    const settings = getSettings();
    
    // Ensure binding structure exists
    if (!settings.chatPresetBindings[chatId]) {
        settings.chatPresetBindings[chatId] = { presetIds: [], presetLoadOrder: [] };
    }
    
    let binding = settings.chatPresetBindings[chatId];
    
    // Handle legacy array format
    if (Array.isArray(binding)) {
        binding = { presetIds: binding, presetLoadOrder: binding };
        settings.chatPresetBindings[chatId] = binding;
    }
    
    // Add to presetIds if not already there
    if (!binding.presetIds.includes(presetId)) {
        binding.presetIds.push(presetId);
    }
    
    // Add to load order if not already there (at the end)
    if (!binding.presetLoadOrder.includes(presetId)) {
        binding.presetLoadOrder.push(presetId);
    }
    
    persistSettings();
    debugLog(`Added preset ${presetId} to chat ${chatId}. Load order:`, binding.presetLoadOrder);
}

export function removePresetFromChat(chatId, presetId) {
    // Validate chatId to prevent issues with "undefined" or "null"
    if (!chatId || chatId === 'undefined' || chatId === 'null') {
        debugLog(`WARNING: removePresetFromChat called with invalid chatId: "${chatId}"`);
        return;
    }
    
    const settings = getSettings();
    
    if (!settings.chatPresetBindings[chatId]) return;
    
    let binding = settings.chatPresetBindings[chatId];
    
    // Handle legacy array format
    if (Array.isArray(binding)) {
        const idx = binding.indexOf(presetId);
        if (idx !== -1) {
            binding.splice(idx, 1);
            persistSettings();
            debugLog(`Removed preset ${presetId} from chat ${chatId}`);
        }
        return;
    }
    
    // Remove from both arrays
    binding.presetIds = binding.presetIds.filter(id => id !== presetId);
    binding.presetLoadOrder = binding.presetLoadOrder.filter(id => id !== presetId);
    
    persistSettings();
    debugLog(`Removed preset ${presetId} from chat ${chatId}. Load order:`, binding.presetLoadOrder);
}

function getTrackerPresets() {
    const settings = getSettings();
    if (!settings.trackerPresets || !Array.isArray(settings.trackerPresets)) {
        settings.trackerPresets = [];
    }
    return settings.trackerPresets;
}

function setTrackerPresets(presetIds) {
    getSettings().trackerPresets = presetIds;
    persistSettings();
}

function addPresetToTracker(presetId) {
    const trackerPresets = getTrackerPresets();
    if (!trackerPresets.includes(presetId)) {
        trackerPresets.push(presetId);
        setTrackerPresets(trackerPresets);
    }
}

function removePresetFromTracker(presetId) {
    const trackerPresets = getTrackerPresets();
    const idx = trackerPresets.indexOf(presetId);
    if (idx !== -1) {
        trackerPresets.splice(idx, 1);
        setTrackerPresets(trackerPresets);
    }
}

function getAllVariablesFromPresets(presetIds, preserveOrder = true) {
    const settings = getSettings();
    const allVars = {};
    // If preserveOrder is true, iterate in given order to maintain preset load order
    // Variables are collected in order, so first preset's vars come first
    for (const presetId of presetIds) {
        const preset = settings.presets[presetId];
        if (preset && preset.variables) {
            // Only assign if not already present (earlier preset takes precedence)
            for (const [varId, varDef] of Object.entries(preset.variables)) {
                if (!allVars[varId]) {
                    allVars[varId] = varDef;
                }
            }
        }
    }
    return allVars;
}

function structuredCloneSafe(obj) {
    if (typeof structuredClone === 'function') return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
}

function genId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `se-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Variable definition helpers
// ---------------------------------------------------------------------------

function blankDefinition() {
    return {
        id: genId(),

        // Identity
        name: '',
        label: '',
        description: '',

        // Scope
        scope: 'chat', // chat | global

        // Type system
        type: 'number', // number | string | boolean | enum | array
        enumValues: [],

        // Default value
        defaultValue: 0,

        // Numeric constraints
        min: null,
        max: null,

        // Behavior flags
        resetOnNewChat: false,
        showInTracker: true,

        // New behavior model
        behaviors: {
            increment: false,   // deterministic increment
            prompted: false,    // LLM-driven increment
        },

        // Deterministic increment configuration
        increment: {
            delta: 1,           // arithmetic increment for numbers
            triggers: ['ai'],   // user | ai | both
            tick_mode: null,    // null or "per_message"
            tick_on: 'both',    // user | ai | both
            tick_every: 1,      // threshold for deterministic increments
        },

        // Prompted increment configuration
        prompted: {
            instructions: '',   // LLM instructions
        },
        version: 1
    };
}


function getDefaultValue(def) {
    switch (def.type) {
        case 'number': {
            const n = Number(def.default);
            return Number.isFinite(n) ? n : 0;
        }
        case 'boolean':
            return String(def.default).trim().toLowerCase() === 'true';
        case 'enum':
            return def.enumValues.includes(def.default) ? def.default : (def.enumValues[0] ?? '');
        case 'array':
            if (Array.isArray(def.default)) return [...def.default];
            if (typeof def.default === 'string' && def.default.trim()) {
                try { return JSON.parse(def.default); }
                catch { return []; }
            }
            return [];
        default:
            return def.default ?? '';
    }
}

function clampNumber(def, n) {
    let result = n;
    if (def.min !== '' && def.min !== null && def.min !== undefined && !Number.isNaN(Number(def.min))) {
        result = Math.max(result, Number(def.min));
    }
    if (def.max !== '' && def.max !== null && def.max !== undefined && !Number.isNaN(Number(def.max))) {
        result = Math.min(result, Number(def.max));
    }
    return result;
}

// Validate a value against type constraints; return {valid: boolean, value: coerced, error?: string}
function validateValueStrict(def, raw) {
    if (raw === undefined || raw === null) {
        return { valid: true, value: getDefaultValue(def) };
    }

    const errors = [];
    let coerced = raw;

    try {
        switch (def.type) {
            case 'number': {
                if (typeof raw === 'number') {
                    coerced = raw;
                } else if (typeof raw === 'string' && raw.trim() !== '') {
                    coerced = Number(raw.trim());
                    if (Number.isNaN(coerced)) {
                        errors.push(`Cannot convert "${raw}" to number`);
                        coerced = getDefaultValue(def);
                        break;
                    }
                } else {
                    errors.push(`Expected number, got ${typeof raw}`);
                    coerced = getDefaultValue(def);
                    break;
                }
                
                if (!Number.isFinite(coerced)) {
                    errors.push(`Not a valid number (got ${raw})`);
                    coerced = getDefaultValue(def);
                } else {
                    coerced = clampNumber(def, coerced);
                }
                break;
            }

            case 'boolean': {
                if (typeof raw === 'boolean') {
                    coerced = raw;
                } else if (typeof raw === 'number') {
                    coerced = raw !== 0;
                } else if (typeof raw === 'string') {
                    const s = raw.trim().toLowerCase();
                    if (['true', 'yes', '1', 'on'].includes(s)) {
                        coerced = true;
                    } else if (['false', 'no', '0', 'off'].includes(s)) {
                        coerced = false;
                    } else {
                        errors.push(`"${raw}" is not a valid boolean`);
                        coerced = getDefaultValue(def);
                    }
                } else {
                    errors.push(`Expected boolean, got ${typeof raw}`);
                    coerced = getDefaultValue(def);
                }
                break;
            }

            case 'enum': {
                const s = String(raw);
                if (!def.enumValues.includes(s)) {
                    errors.push(`"${s}" not in allowed values: [${def.enumValues.join(', ')}]`);
                    coerced = getDefaultValue(def);
                } else {
                    coerced = s;
                }
                break;
            }

            case 'array': {
                if (Array.isArray(raw)) {
                    coerced = raw;
                } else if (typeof raw === 'string') {
                    try {
                        const parsed = JSON.parse(raw);
                        if (Array.isArray(parsed)) {
                            coerced = parsed;
                        } else {
                            errors.push(`Parsed JSON is not an array`);
                            coerced = getDefaultValue(def);
                        }
                    } catch (e) {
                        errors.push(`Invalid JSON for array: ${e.message}`);
                        coerced = getDefaultValue(def);
                    }
                } else {
                    errors.push(`Expected array, got ${typeof raw}`);
                    coerced = getDefaultValue(def);
                }
                break;
            }

            default: {
                // String type: accept anything, stringify it
                coerced = String(raw);
            }
        }
    } catch (err) {
        errors.push(`Validation error: ${err.message}`);
        coerced = getDefaultValue(def);
    }

    return {
        valid: errors.length === 0,
        value: coerced,
        error: errors.length > 0 ? errors.join('; ') : undefined,
    };
}

function coerceValue(def, raw) {
    if (raw === undefined || raw === null) return getDefaultValue(def);
    switch (def.type) {
        case 'number': {
            let n = typeof raw === 'number' ? raw : Number(raw);
            if (!Number.isFinite(n)) n = getDefaultValue(def);
            return clampNumber(def, n);
        }
        case 'boolean': {
            if (typeof raw === 'boolean') return raw;
            const s = String(raw).trim().toLowerCase();
            return ['true', 'yes', '1', 'on'].includes(s);
        }
        case 'enum': {
            const s = String(raw);
            return def.enumValues.includes(s) ? s : getDefaultValue(def);
        }
        case 'array': {
            if (Array.isArray(raw)) return raw;
            if (typeof raw === 'string') {
                try { return JSON.parse(raw); }
                catch { return getDefaultValue(def); }
            }
            return getDefaultValue(def);
        }
        default:
            return String(raw);
    }
}

function varStore(context, def) {
    return def.scope === 'global' ? context.variables.global : context.variables.local;
}

function getVarValue(context, def) {
    const store = varStore(context, def);
    try {
        if (store.has(def.name)) {
            return store.get(def.name);
        }
    } catch (err) {
        console.warn(LOG_PREFIX, `could not read variable "${def.name}"`, err);
    }
    return getDefaultValue(def);
}

function setVarValue(context, def, rawValue) {
    const store = varStore(context, def);
    const validation = validateValueStrict(def, rawValue);
    
    if (!validation.valid && validation.error) {
        console.warn(LOG_PREFIX, `Type validation for "${def.name}": ${validation.error}`);
    }
    
    try {
        store.set(def.name, validation.value);
    } catch (err) {
        console.error(LOG_PREFIX, `could not write variable "${def.name}"`, err);
    }
    return validation.value;
}

// ---------------------------------------------------------------------------
// Debug info collection
// ---------------------------------------------------------------------------

export function getDebugInfo() {
    try {
        const context = SillyTavern.getContext();
        const chatId = getCurrentChatId();
        const settings = getSettings();
        const activePresetIds = getPresetsForChat(chatId);

        // Collect active preset details
        const activePresetsInfo = activePresetIds.map(id => {
            const preset = settings.presets[id];
            return {
                id,
                name: preset?.name || 'unknown',
                description: preset?.description || '',
                variableCount: Object.keys(preset?.variables || {}).length,
                triggers: preset?.triggers || []
            };
        });

        // Collect all variables and their current values
        const variables = getAllVariablesFromPresets(activePresetIds);
        const variablesWithValues = Object.entries(variables).map(([varId, varDef]) => {
            const value = getVarValue(context, varDef);
            return {
                id: varId,
                name: varDef.name,
                label: varDef.label,
                type: varDef.type,
                scope: varDef.scope,
                value: value,
                defaultValue: varDef.defaultValue,
                enumValues: varDef.enumValues,
                min: varDef.min,
                max: varDef.max,
                showInTracker: varDef.showInTracker !== false,

                // New behavior model
                behaviors: varDef.behaviors || {},

                // Deterministic increment config
                increment: varDef.increment || {},

                // Prompted increment config
                prompted: varDef.prompted || {},
            };
        });

        return {
            chatId,
            currentTimestamp: new Date().toISOString(),
            activePresets: activePresetsInfo,
            variables: variablesWithValues,
            totalPresets: Object.keys(settings.presets || {}).length,
            debugEnabled: window.seDebugMode,
            settingsKeys: Object.keys(settings),
            fullSettings: settings
        };
    } catch (err) {
        console.error(`${LOG_PREFIX} Error collecting debug info:`, err);
        return { error: err.message };
    }
}


// ---------------------------------------------------------------------------
// Initialization / reset
// ---------------------------------------------------------------------------

function applyDefaultsForMissing() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    
    // If no presets bound to this chat, use default
    if (activePresetIds.length === 0 && getSettings().defaultPresetForNewChats) {
        activePresetIds.push(getSettings().defaultPresetForNewChats);
    }
    
    const variables = getAllVariablesFromPresets(activePresetIds);
    for (const def of Object.values(variables)) {
        if (!def.name || shouldSkipPromptedRefresh(def)) continue;
        const store = varStore(context, def);
        let exists = false;
        try {
            exists = store.has(def.name);
        } catch {
            exists = false;
        }
        if (!exists) {
            setVarValue(context, def, getDefaultValue(def));
        }
    }
}

function applyResetOnNewChat() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    const variables = getAllVariablesFromPresets(activePresetIds);
    
    for (const def of Object.values(variables)) {
        if (!def.name || !def.resetOnNewChat || shouldSkipPromptedRefresh(def)) continue;
        setVarValue(context, def, getDefaultValue(def));
    }
}


function applyIncrement(context, def, delta) {
    const current = getVarValue(context, def);
    let next;
    console.log(LOG_PREFIX, "Incrementing Variable: ", def.name, " by ", delta);
    switch (def.type) {
        case 'number':
            next = current + delta;
            break;

        case 'boolean':
            next = !current;
            break;

        case 'enum':
            next = cycleEnum(def, current);
            break;

    }

    //enforceConstraints is the future place where you’ll clamp values, validate enums, enforce min/max, and guarantee type correctness.
    //next = enforceConstraints(def, next);

    setVarValue(context, def, next);

    //triggerHooks would be It’s the future place where you fire side‑effects when a variable changes.
    //triggerHooks(def, current, next);

    refreshPanelIfOpen();
}

function cycleEnum(def, current) {
    const values = def.enumValues || [];
    if (!values.length) return current;

    const idx = values.indexOf(current);
    return values[(idx + 1) % values.length];
}

// ---------------------------------------------------------------------------

function stripHtml(str) {
    return String(str ?? '').replace(/<[^>]*>/g, '').trim();
}

function extractJsonObject(text) {
    if (!text) return null;
    let s = String(text).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) return null;
    const candidate = s.slice(first, last + 1);
    try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        return null;
    } catch {
        return null;
    }
}

function describeConstraint(def) {
    if (def.type === 'number') {
        const parts = [];
        if (def.min !== '' && def.min !== null && def.min !== undefined) parts.push(`min ${def.min}`);
        if (def.max !== '' && def.max !== null && def.max !== undefined) parts.push(`max ${def.max}`);
        return `number${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    if (def.type === 'boolean') return 'true or false';
    if (def.type === 'enum') return `one of: ${def.enumValues.join(', ')}`;
    return 'text';
}

async function callBackgroundLLM(context, settings, messages, maxTokens) {
    const profileId = settings.connectionProfileId;
    if (profileId) {
        const svc = context.ConnectionManagerRequestService;
        if (svc && typeof svc.sendRequest === 'function') {
            try {
                const result = await svc.sendRequest(profileId, messages, maxTokens, { extractData: true, stream: false });
                const text = extractTextFromServiceResult(result);
                if (text) return text;
                console.warn(LOG_PREFIX, 'connection profile request returned no usable text, falling back to the active connection', result);
            } catch (err) {
                console.warn(LOG_PREFIX, 'connection profile request failed, falling back to the active connection', err);
            }
        } else {
            console.warn(LOG_PREFIX, 'ConnectionManagerRequestService.sendRequest unavailable, falling back to the active connection');
        }
    }
    return await context.generateRaw({ prompt: messages, responseLength: maxTokens });
}

function extractTextFromServiceResult(result) {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object') {
        if (typeof result.content === 'string') return result.content;
        if (typeof result.text === 'string') return result.text;
        if (Array.isArray(result.choices) && result.choices[0]) {
            const choice = result.choices[0];
            if (typeof choice.message?.content === 'string') return choice.message.content;
            if (typeof choice.text === 'string') return choice.text;
        }
    }
    return '';
}

async function runPromptedStateUpdate(triggerType) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;

    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);

    // Filter presets that have this trigger enabled
    let presetsToUpdate = [];
    if (triggerType === 'manual-all') {
        presetsToUpdate = activePresetIds;
    } else {
        presetsToUpdate = activePresetIds.filter(presetId => {
            const preset = settings.presets[presetId];
            return preset && Array.isArray(preset.triggers) && preset.triggers.includes(triggerType);
        });
    }

    // Collect variables from presets that should update, and classify them
    const variables = getAllVariablesFromPresets(presetsToUpdate);
    const updateVars = [];
    const incrementVars = [];
    for (const def of Object.values(variables)) {
        if (!def.name) continue;
        if (def.category === 'prompted' && !shouldSkipPromptedRefresh(def)) {
            updateVars.push(def);
        } else if (def.behaviors?.prompted === true && def.behaviors?.increment === true) {
            incrementVars.push(def);
        }
    }

    if (updateVars.length === 0 && incrementVars.length === 0) return;
    if (!Array.isArray(context.chat)) return;

    setStatus('Updating state…');

    try {
        const count = Math.max(1, Number(settings.contextMessageCount) || 10);
        const recent = context.chat.slice(-count);
        const transcript = recent
            .map((m) => {
                const speaker = m.is_user ? (context.name1 || 'User') : (m.name || context.name2 || 'Character');
                return `${speaker}: ${stripHtml(m.mes)}`;
            })
            .filter((line) => line.trim().length > 0)
            .join('\n');

        const updateVarLines = updateVars
            .map((def) => {
                const current = getVarValue(context, def);
                const instructions = (def.prompted?.instructions || def.description || '').trim();
                return `- "${def.name}" [${describeConstraint(def)}] currently ${JSON.stringify(current)}.${instructions ? ` ${instructions}` : ''}`;
            })
            .join('\n');

        const incrementVarLines = incrementVars
            .map((def) => {
                const current = getVarValue(context, def);
                const instructions = (def.prompted?.instructions || def.description || '').trim();
                return `- "${def.name}" (${def.type}, current: ${current}): ${instructions}`;
            })
            .join('\n');

        const varLines = [updateVarLines, incrementVarLines].filter(Boolean).join('\n');
        if (!varLines.trim()) return;

        const promptSections = [
            settings.promptedHeader || DEFAULT_PROMPTED_HEADER,
            settings.promptedRules || DEFAULT_UNIFIED_VARIABLE_RULES,
            '',
            transcript ? `Recent conversation:\n${transcript}` : 'No conversation yet.',
        ];

        if (updateVarLines) {
            promptSections.push('', 'Update variables:', updateVarLines);
        }
        if (incrementVarLines) {
            promptSections.push('', 'Boolean-condition variables:', incrementVarLines);
        }

        const systemPrompt = promptSections.join('\n');

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Output the JSON object now. JSON only, no other text.' },
        ];

        const raw = await callBackgroundLLM(context, settings, messages, Number(settings.responseLength) || 300);

        const parsed = extractJsonObject(raw);
        if (!parsed) {
            console.warn(LOG_PREFIX, 'could not parse a JSON object from the model response:', raw);
            setStatus('Update failed — response was not valid JSON. See console.', true);
            return;
        }

        let updatedCount = 0;
        for (const def of updateVars) {
            if (Object.prototype.hasOwnProperty.call(parsed, def.name)) {
                setVarValue(context, def, parsed[def.name]);
                updatedCount++;
            }
        }

        let incrementedCount = 0;
        for (const def of incrementVars) {
            if (parsed[def.name] === true) {
                applyIncrement(context, def, def.increment.delta);
                incrementedCount++;
            }
        }

        setStatus(`State updated (${updatedCount}/${updateVars.length} variables, ${incrementedCount}/${incrementVars.length} incremented).`);
    } catch (err) {
        console.error(LOG_PREFIX, 'prompted state update failed', err);
        setStatus('Update failed — see browser console for details.', true);
    } finally {
        refreshPanelIfOpen();
    }
}

function runDeterministicIncrements(triggerType) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;

    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    const variables = getAllVariablesFromPresets(activePresetIds);

    for (const def of Object.values(variables)) {
        if (!def.name) continue;

        // Only deterministic increment variables
        if(def.behaviors?.prompted) continue;
        if (!def.behaviors?.increment) continue;
        console.log(LOG_PREFIX, "Checking to increment variable", def);
        if(!def.increment) continue;
        if(def.increment?.triggers != triggerType || 
            (def.increment?.triggers == "both" && (triggerType != "ai" && triggerType != "user" )))continue;

        // Increment internal counter
        const counter = Number(def._counter || 0) + 1;
        def._counter = counter;

        if (counter < (def.tick_every || 1)) continue;

        // Reset counter
        def._counter = 0;

        applyIncrement(context, def, def.increment.delta);

    }

    refreshPanelIfOpen();
}



// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

let startupRan = false;

function runStartupOnce() {
    if (startupRan) return;
    startupRan = true;
    const settings = getSettings();
    migrateAllSettings(settings);
    runPromptedStateUpdate('startup');
}

function registerEvents() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    // Covers the case where this extension finishes loading only after
    // APP_READY has already fired; runStartupOnce() guards against firing twice.
    eventSource.on(eventTypes.APP_READY, runStartupOnce);

    eventSource.on(eventTypes.CHAT_CREATED, () => {
        applyResetOnNewChat();
        applyDefaultsForMissing();
        runPromptedStateUpdate('new_chat');
        refreshPanelIfOpen();
        refreshManagerButtonLater();
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        applyDefaultsForMissing();
        runPromptedStateUpdate('chat_change');
        refreshPanelIfOpen();
        refreshManagerButtonLater();
    });

    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, () => {
        //runCounters('user');
        runDeterministicIncrements('user');
        runPromptedStateUpdate('user');
    });

    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => {
        //runCounters('ai');
        runDeterministicIncrements('ai');
        runPromptedStateUpdate('ai');
    });

    eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, () => {
        runPromptedStateUpdate('pre_generation');
    });

    if (eventTypes.GROUP_MEMBER_DRAFTED) {
        eventSource.on(eventTypes.GROUP_MEMBER_DRAFTED, () => {
            runPromptedStateUpdate('group_draft');
        });
    }

    // Hook into world info to apply conditional filtering
    if (eventTypes.WORLD_INFO_ACTIVATED) {
        eventSource.on(eventTypes.WORLD_INFO_ACTIVATED, () => {
            applyWorldInfoConditionalFiltering();
        });
    }

    // Keep the connection-profile dropdown in sync if profiles are
    // created/renamed/deleted elsewhere while the panel is open.
    for (const key of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED', 'CONNECTION_PROFILE_LOADED']) {
        const evt = eventTypes[key];
        if (evt) {
            eventSource.on(evt, () => populateConnectionProfileDropdown());
        }
    }
    
    // Start monitoring WI editor for condition UI injection
    observeWIEditorChanges();
}

function registerSlashCommand() {
    // Best-effort: slash command registration APIs vary a little between
    // SillyTavern versions, so this is wrapped defensively and never blocks
    // the rest of the extension from loading if it fails.
    try {
        const context = SillyTavern.getContext();
        if (!context.SlashCommandParser || !context.SlashCommand?.fromProps) return;
        context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
            name: 'state-run',
            callback: async () => {
                await runPromptedStateUpdate('manual-all');
                return '';
            },
            helpString: 'Force State Engine to run all prompted variable updates right now.',
        }));
        context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
            name: 'state-manager',
            callback: async () => {
                buildManagerModal();
                return '';
            },
            helpString: 'Open the State Engine Manager (tabbed interface for presets, variables, triggers, and world info).',
        }));
    } catch (err) {
        console.warn(LOG_PREFIX, 'slash command registration skipped', err);
    }
}

// ---------------------------------------------------------------------------
// Connection profile selection
// ---------------------------------------------------------------------------

function populateConnectionProfileDropdown() {
    const $select = $('#se_connection_profile');
    if (!$select.length) return;

    const context = SillyTavern.getContext();
    const settings = getSettings();
    const current = settings.connectionProfileId || '';

    let profiles = [];
    try {
        const svc = context.ConnectionManagerRequestService;
        if (svc && typeof svc.getSupportedProfiles === 'function') {
            profiles = svc.getSupportedProfiles() || [];
        } else if (context.extensionSettings?.connectionManager?.profiles) {
            profiles = context.extensionSettings.connectionManager.profiles;
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not read connection profiles', err);
    }

    $select.empty();
    $select.append($('<option></option>').val('').text('Use currently active connection'));
    for (const profile of profiles) {
        if (!profile || !profile.id) continue;
        $select.append($('<option></option>').val(profile.id).text(profile.name || profile.id));
    }
    if (current && !profiles.some((p) => p.id === current)) {
        $select.append($('<option></option>').val(current).text(`(not found) ${current}`));
    }
    $select.val(current);
}

// ---------------------------------------------------------------------------
// Floating tracker panel
// ---------------------------------------------------------------------------

function renderTrackerPanel() {
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
        const value = getVarValue(context, def);
        const $row = $('<div></div>').addClass('se-tracker-row');
        if (def.showInTracker === false) $row.addClass('se-tracker-row-hidden');
        $row.append($('<span></span>').addClass('se-tracker-label').text(def.label || def.name));
        //$row.append($('<span></span>').addClass(`se-badge se-badge-${def.category} se-tracker-badge`).text(categoryLabel(def.category)));//111111111111
        $row.append($('<span></span>').addClass('se-tracker-value').text(formatValueForDisplay(value)));
        $body.append($row);
    }
}

function makeTrackerPanelDraggable($panel, $header) {
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

function buildTrackerPanel() {
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

function setTrackerPanelVisible(visible) {
    if (visible) {
        buildTrackerPanel();
        $('#se_tracker_panel').show();
        renderTrackerPanel();
    } else {
        $('#se_tracker_panel').hide();
    }
}

// ---------------------------------------------------------------------------
// UI — settings panel
// ---------------------------------------------------------------------------

let statusTimer = null;

function setStatus(text, isError = false) {
    const $status = $('#se_status');
    if (!$status.length) return;
    $status.text(text).toggleClass('se-status-error', !!isError);
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => $status.text(''), 5000);
}

// function categoryLabel(cat) {
//     if (cat === 'counter') return 'Counter';
//     if (cat === 'cycling') return 'Cycling';
//     if (cat === 'prompted') return 'Prompted';
//     return 'Manual';
// }

function typeLabel(type) {
    if (type === 'number') return 'Number';
    if (type === 'boolean') return 'True/False';
    if (type === 'enum') return 'Choice';
    if (type === 'array') return 'Array';
    return 'Text';
}

function formatValueForDisplay(value) {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return `[${value.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(', ')}]`;
    }
    if (value === '' || value === undefined || value === null) return '—';
    return String(value);
}

function renderVarTable() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const chatId = context.chatId;
    if (!chatId) {
        const $tabContainer = $('#se_preset_tabs');
        const $tbody = $('#se_var_tbody');
        const $empty = $('#se_var_empty');
        if ($tabContainer.length) $tabContainer.empty();
        if ($tbody.length) $tbody.empty();
        if ($empty.length) $empty.show().text('Select a chat to view state variables.');
        currentPresetId = null;
        return;
    }
    const activePresetIds = getPresetsForChat(chatId);
    
    // Don't auto-add default presets here — that should only happen on first chat load
    // If user explicitly deactivated all presets, respect that choice
    
    // Render tabs
    const $tabContainer = $('#se_preset_tabs');
    if (!$tabContainer.length) return;
    
    $tabContainer.empty();
    
    // If no presets at all, show a message
    if (Object.keys(settings.presets).length === 0) {
        $tabContainer.html('<div class="se-empty">No presets created. Click "New Preset" to get started.</div>');
        return;
    }
    
    // Create tab buttons
    for (const presetId of activePresetIds) {
        const preset = settings.presets[presetId];
        if (!preset) continue;
        
        const $tab = $('<button></button>')
            .addClass('se-tab-btn')
            .toggleClass('se-tab-active', presetId === currentPresetId)
            .text(preset.name)
            .on('click', () => {
                currentPresetId = presetId;
                renderVarTable();
            });
        $tabContainer.append($tab);
    }
    
    // Render variables for current preset
    const $tbody = $('#se_var_tbody');
    const $empty = $('#se_var_empty');
    if (!$tbody.length) return;
    
    $tbody.empty();
    
    // If no current preset, select the first active one
    if (!currentPresetId && activePresetIds.length > 0) {
        currentPresetId = activePresetIds[0];
    }
    
    const currentPreset = settings.presets[currentPresetId];
    if (!currentPreset) {
        $empty.show();
        return;
    }
    
    const defs = Object.values(currentPreset.variables).sort((a, b) => a.name.localeCompare(b.name));
    $empty.toggle(defs.length === 0);
    
    for (const def of defs) {
        const value = def.name ? getVarValue(context, def) : '';
        const $row = $('<tr></tr>').attr('data-id', def.id);
        $row.append($('<td></td>').append($('<code></code>').text(def.name || '(unnamed)')));
        // $row.append($('<td></td>').append(
        //     $('<span></span>').addClass(`se-badge se-badge-${def.category}`).text(categoryLabel(def.category)),
        // ));
        $row.append($('<td></td>').text(typeLabel(def.type)));
        $row.append($('<td></td>').text(def.scope === 'global' ? 'Global' : 'Chat'));
        $row.append($('<td></td>').addClass('se-col-value').text(formatValueForDisplay(value)));

        const $actions = $('<div></div>').addClass('se-row-actions');
        const $editBtn = $('<button></button>').addClass('menu_button se-edit-btn').text('Edit');
        const $delBtn = $('<button></button>').addClass('menu_button se-delete-btn').text('Delete');
        $actions.append($editBtn, $delBtn);
        $row.append($('<td></td>').append($actions));

        $tbody.append($row);
    }
}

// function toggleEditorSections() {
//     const type = $('#se_f_type').val();
//     const category = $('#se_f_category').val();
//     const counterTrigger = $('#se_f_counter_trigger').val();
//     const cyclingTrigger = $('#se_f_cycling_trigger').val();
    
//     $('#se_f_enum_row').toggle(type === 'enum');
//     $('#se_f_minmax_row').toggle(type === 'number');
//     $('#se_f_array_row').toggle(type === 'array');
//     $('.se-cat-counter').toggle(category === 'counter');
//     $('.se-cat-cycling').toggle(category === 'cycling');
//     $('.se-cat-prompted').toggle(category === 'prompted');
    
//     // Show prompted instruction sections for AI-triggered increments
//     $('#se_f_counter_prompted_section').toggle(category === 'counter' && counterTrigger === 'prompted');
//     $('#se_f_cycling_prompted_section').toggle(category === 'cycling' && cyclingTrigger === 'prompted');
// }

// function openEditor(def) {
//     const isNew = !def;
//     const d = def || blankDefinition();

//     $('#se_edit_id').val(d.id);
//     $('#se_f_name').val(d.name).prop('disabled', !isNew);
//     $('#se_f_label').val(d.label);
//     $('#se_f_category').val(d.category);
//     $('#se_f_scope').val(d.scope);
//     $('#se_f_type').val(d.type);
//     $('#se_f_default').val(d.default);
//     $('#se_f_enum_values').val((d.enumValues || []).join(', '));
//     $('#se_f_min').val(d.min);
//     $('#se_f_max').val(d.max);
//     $('#se_f_description').val(d.description);
//     $('#se_f_reset_on_new_chat').prop('checked', !!d.resetOnNewChat);
//     $('#se_f_show_in_tracker').prop('checked', d.showInTracker !== false);
    
//     // Counter fields
//     $('#se_f_counter_trigger').val(d.counter?.trigger || 'ai');
//     $('#se_f_counter_direction').val(d.counter?.direction || 'increment');se_prompted_variable_rules
//     $('#se_f_counter_step').val(d.counter?.step ?? 1);
//     $('#se_f_counter_prompted_instructions').val(d.counter?.promptedInstructions || '');
    
//     // Cycling fields
//     $('#se_f_cycling_values').val((d.cycling?.values || []).join('\n'));
//     $('#se_f_cycling_trigger').val(d.cycling?.trigger || 'ai');
//     $('#se_f_cycling_prompted_instructions').val(d.cycling?.promptedInstructions || '');
    
//     // Prompted fields
//     const activeTriggers = Array.isArray(d.prompted?.triggers) ? d.prompted.triggers : [];
//     $('.se-f-prompted-trigger').each(function () {
//         $(this).prop('checked', activeTriggers.includes($(this).val()));
//     });
//     $('#se_f_prompted_instructions').val(d.promptedInstructions || '');

//     toggleEditorSections();
//     $('#se_editor').data('is-new', isNew).show();
//     $('html, body').stop();
//     document.getElementById('se_editor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
// }

// function closeEditor() {
//     $('#se_editor').hide();
//     $('#se_f_name').prop('disabled', false);
// }

// function readEditorForm() {
//     const enumValues = String($('#se_f_enum_values').val() || '')
//         .split(',')
//         .map((s) => s.trim())
//         .filter((s) => s.length > 0);

//     const cyclingValues = String($('#se_f_cycling_values').val() || '')
//         .split('\n')
//         .map((s) => s.trim())
//         .filter((s) => s.length > 0);

//     return {
//         id: $('#se_edit_id').val(),
//         name: String($('#se_f_name').val() || '').trim(),
//         label: String($('#se_f_label').val() || '').trim(),
//         category: $('#se_f_category').val(),
//         scope: $('#se_f_scope').val(),
//         type: $('#se_f_type').val(),
//         enumValues,
//         default: $('#se_f_default').val(),
//         min: $('#se_f_min').val(),
//         max: $('#se_f_max').val(),
//         description: String($('#se_f_description').val() || ''),
//         resetOnNewChat: $('#se_f_reset_on_new_chat').is(':checked'),
//         showInTracker: $('#se_f_show_in_tracker').is(':checked'),
//         counter: {
//             trigger: $('#se_f_counter_trigger').val(),
//             direction: $('#se_f_counter_direction').val(),
//             step: Number($('#se_f_counter_step').val()) || 1,
//             promptedInstructions: String($('#se_f_counter_prompted_instructions').val() || ''),
//         },
//         cycling: {
//             trigger: $('#se_f_cycling_trigger').val(),
//             values: cyclingValues,
//             promptedInstructions: String($('#se_f_cycling_prompted_instructions').val() || ''),
//         },
//         prompted: {
//             triggers: $('.se-f-prompted-trigger:checked').map(function () { return $(this).val(); }).get(),
//             instructions: String($('#se_f_prompted_instructions').val() || ''),
//         },
//     };
// }

// Known SillyTavern built-in variables and reserved names
const SILLYTAVERN_RESERVED_VARS = new Set([
    // Built-in SillyTavern character/chat variables
    'charname', 'char_name', 'user', 'user_name', 'bot_name', 'bot',
    'time', 'date', 'timestamp', 'year', 'month', 'day', 'hour', 'minute', 'second',
    'idle_duration', 'gmtime', 'lastmessage', 'lastsender', 'lastchar',
    'version', 'model', 'current_date', 'current_time',
    'random', 'randomfrom', 'dice',
    'counter', 'pos', 'iscreator', 'isgroup',
    'avatar', 'char', 'me', 'you', 'them',
    // Common extensions might use these
    'groupdesc', 'groupchat', 'group_name', 'group', 'members',
]);

function isReservedVariable(name) {
    try {
        // Check against known built-in SillyTavern variables (case-insensitive)
        if (SILLYTAVERN_RESERVED_VARS.has(name.toLowerCase())) {
            return true;
        }
        
        // Also check if SillyTavern has this as a stored variable already
        const context = SillyTavern.getContext();
        if (context?.chat) {
            // Check chat variables
            const chatVars = context.chat.mes || [];
            if (chatVars.some && typeof chatVars === 'object') {
                // If it looks like there's a variable storage, check it
                if (context.chat.mesVariables && context.chat.mesVariables[name]) {
                    return true;
                }
            }
        }
        
        // Check if getvar macro exists with this name already (from SillyTavern's system)
        // This is harder to detect without direct API access, so we rely on the list above
        return false;
    } catch (e) {
        // If we can't check, assume it's not reserved (fail open)
        return false;
    }
}

// function saveVariableFromEditor() {
//     const settings = getSettings();
//     const def = readEditorForm();
//     const presetId = currentPresetId;

//     if (!presetId) {
//         setStatus('No preset selected.', true);
//         return;
//     }
    
//     const preset = settings.presets[presetId];
//     if (!preset) {
//         setStatus('Preset not found.', true);
//         return;
//     }

//     if (!def.name) {
//         setStatus('Variable name is required.', true);
//         return;
//     }
//     if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(def.name)) {
//         setStatus('Variable name should only contain letters, numbers, and underscores, and not start with a number.', true);
//         return;
//     }
//     const isNew = $('#se_editor').data('is-new');
//     const nameTaken = Object.values(preset.variables).some((other) => other.id !== def.id && other.name === def.name);
//     if (nameTaken) {
//         setStatus(`A variable named "${def.name}" already exists in this preset.`, true);
//         return;
//     }
//     // Check against SillyTavern's reserved variable names
//     if (isReservedVariable(def.name)) {
//         setStatus(`"${def.name}" is a reserved SillyTavern variable name and cannot be overridden. Choose a different name.`, true);
//         return;
//     }
//     if (def.type === 'enum' && def.enumValues.length === 0) {
//         setStatus('Add at least one allowed value for a choice-list variable.', true);
//         return;
//     }
//     if (def.category === 'cycling' && def.cycling.values.length === 0) {
//         setStatus('Add at least one value for a cycling variable.', true);
//         return;
//     }

//     preset.variables[def.id] = def;
//     persistSettings();

//     if (isNew) {
//         const context = SillyTavern.getContext();
//         setVarValue(context, def, getDefaultValue(def));
//     }

//     closeEditor();
//     renderVarTable();
//     setStatus(`Saved "${def.name}".`);
// }

// function deleteVariable(id) {
//     const settings = getSettings();
//     const presetId = currentPresetId;
    
//     if (!presetId) return;
    
//     const preset = settings.presets[presetId];
//     if (!preset) return;
    
//     const def = preset.variables[id];
//     if (!def) return;
    
//     if (!window.confirm(`Delete variable "${def.name}"? This only removes the definition; any value already stored for it is left in place.`)) {
//         return;
//     }
//     delete preset.variables[id];
//     persistSettings();
//     renderVarTable();
//     setStatus(`Deleted "${def.name}".`);
// }

function loadGeneralSettingsIntoForm() {
    const settings = getSettings();
    $('#se_enabled').prop('checked', !!settings.enabled);
    $('#se_wand_visible').prop('checked', settings.wandVisible !== false);
    $('#se_show_tracker_panel').prop('checked', !!settings.showTrackerPanel);
    $('#se_context_count').val(settings.contextMessageCount);
    $('#se_response_length').val(settings.responseLength);
    $('#se_prompted_header').val(settings.promptedHeader || DEFAULT_PROMPTED_HEADER);
    $('#se_prompted_variable_rules').val(settings.promptedRules || DEFAULT_UNIFIED_VARIABLE_RULES);
    populateConnectionProfileDropdown();
}

function refreshPanelIfOpen() {
    if ($('#state_engine_settings').length) {
        renderVarTable();
    }
    if ($('#se_tracker_panel').length) {
        renderTrackerPanel();
    }
    updateManagerButtonState();
}

function bindPanelEvents() {
    $('#se_enabled').on('change', function () {
        getSettings().enabled = $(this).is(':checked');
        persistSettings();
    });
    $('#se_wand_visible').on('change', function () {
        getSettings().wandVisible = $(this).is(':checked');
        persistSettings();
    });
    $('#se_show_tracker_panel').on('change', function () {
        const checked = $(this).is(':checked');
        getSettings().showTrackerPanel = checked;
        persistSettings();
        setTrackerPanelVisible(checked);
    });
    $('#se_connection_profile').on('change', function () {
        getSettings().connectionProfileId = $(this).val() || '';
        persistSettings();
    });
    $('#se_context_count').on('change', function () {
        const n = Math.max(1, Math.min(50, Number($(this).val()) || 10));
        getSettings().contextMessageCount = n;
        $(this).val(n);
        persistSettings();
    });
    $('#se_response_length').on('change', function () {
        const n = Math.max(50, Math.min(2000, Number($(this).val()) || 300));
        getSettings().responseLength = n;
        $(this).val(n);
        persistSettings();
    });

    $('#se_run_now').on('click', () => runPromptedStateUpdate('manual-all'));

    $('#se_open_manager').on('click', () => openManagerIfReady());
    updateManagerButtonState();

    // $('#se_new_preset').on('click', () => {
    //    const name = prompt('Preset name:');
    //    if (name && name.trim()) {
    //        const presetId = createPreset(name.trim());
    //        currentPresetId = presetId;
    //        renderPresetList();
    //        renderVarTable();
    //        setStatus(`Created preset "${name}".`);
    //    }
    // });

    // $('#se_restore_defaults').on('click', () => {
    //     const settings = getSettings();
    //     const before = Object.keys(settings.presets).length;
    //     seedExamplePresets(settings, true);
    //     persistSettings();
    //     renderPresetList();
    //     renderTrackerPresetList();
    //     renderVarTable();
    //     const after = Object.keys(settings.presets).length;
    //     setStatus(after > before ? 'Starter presets restored.' : 'Starter presets are already present.');
    // });

    //$('#se_add_var').on('click', () => openEditor(null));
    //$('#se_cancel_edit').on('click', closeEditor);
    //$('#se_save_var').on('click', saveVariableFromEditor);

    //$('#se_cancel_preset_edit').on('click', () => $('#se_preset_editor').hide());
    //$('#se_save_preset').on('click', savePresetSettings);

    //$('#se_f_type').on('change', toggleEditorSections);
    //$('#se_f_category').on('change', toggleEditorSections);
    //$('#se_f_counter_trigger').on('change', toggleEditorSections);
    //$('#se_f_cycling_trigger').on('change', toggleEditorSections);

    $('#se_prompted_header').on('change', (e) => {
        const settings = getSettings();
        settings.promptedHeader = e.target.value;
        persistSettings();
    });

    $('#se_prompted_header_reset').on('click', () => {
        const settings = getSettings();
        settings.promptedHeader = DEFAULT_PROMPTED_HEADER;
        persistSettings();
        $('#se_prompted_header').val(DEFAULT_PROMPTED_HEADER);
    });

    $('#se_prompted_variable_rules').on('change', (e) => {
        const settings = getSettings();
        settings.promptedRules = e.target.value;
        persistSettings();
    });

    $('#se_prompted_variable_rules_reset').on('click', () => {
        const settings = getSettings();
        settings.promptedRules = DEFAULT_UNIFIED_VARIABLE_RULES;
        persistSettings();
        $('#se_prompted_variable_rules').val(DEFAULT_UNIFIED_VARIABLE_RULES);
    });

    $('#se_prompted_increment_rules').on('change', (e) => {
        const settings = getSettings();
        settings.incrementedRules = e.target.value;
        persistSettings();
    });

    // $('#se_prompted_increment_rules_reset').on('click', () => {
    //     const settings = getSettings();
    //     settings.incrementedRules = DEFAULT_INCREMENTED_VARIABLE_RULES;
    //     persistSettings();
    //     $('#se_prompted_increment_rules').val(DEFAULT_INCREMENTED_VARIABLE_RULES);
    // });
}

// function renderPresetList() {
//     const settings = getSettings();
//     const $list = $('#se_preset_list');
//     if (!$list.length) return;

//     $list.empty();

//     if (Object.keys(settings.presets).length === 0) {
//        $list.html('<div class="se-empty">No presets yet. Click the + button to create one.</div>');
//        return;
//     }

//     for (const [presetId, preset] of Object.entries(settings.presets)) {
//        const $item = $('<div></div>').addClass('se-preset-item');
//        const $name = $('<span></span>').addClass('se-preset-name').text(preset.name);
//        const $actions = $('<div></div>').addClass('se-preset-actions');

//        // Edit/Settings button
//        const $settingsBtn = $('<button></button>')
//            .addClass('se-preset-btn')
//            .html('<i class="fa-solid fa-cog"></i>')
//            .attr('title', 'Edit triggers for this preset')
//            .on('click', () => editPresetSettings(presetId));

//        // Rename button
//        const $renameBtn = $('<button></button>')
//            .addClass('se-preset-btn')
//            .html('<i class="fa-solid fa-pencil"></i>')
//            .attr('title', 'Rename preset')
//            .on('click', () => {
//                const newName = prompt('New name:', preset.name);
//                if (newName && newName.trim()) {
//                    renamePreset(presetId, newName.trim());
//                    renderPresetList();
//                    renderVarTable();
//                    setStatus(`Renamed to "${newName}".`);
//                }
//            });

//        // Delete button
//        const $deleteBtn = $('<button></button>')
//            .addClass('se-preset-btn')
//            .html('<i class="fa-solid fa-trash"></i>')
//            .attr('title', 'Delete preset (variables stay)')
//            .on('click', () => {
//                if (window.confirm(`Delete preset "${preset.name}"? Variables in this preset won't be deleted.`)) {
//                    deletePreset(presetId);
//                    if (currentPresetId === presetId) currentPresetId = null;
//                    renderPresetList();
//                    renderVarTable();
//                    setStatus(`Deleted "${preset.name}".`);
//                }
//            });

//        $actions.append($settingsBtn, $renameBtn, $deleteBtn);
//        $item.append($name, $actions);
//        $list.append($item);
//     }
// }

function renderTrackerPresetList() {
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

// function editPresetSettings(presetId) {
//     const settings = getSettings();
//     const preset = settings.presets[presetId];
//     if (!preset) return;

//     const $editor = $('#se_preset_editor');
//     const $title = $('#se_preset_edit_title');
//     $title.text(`Edit "${preset.name}" - Update Triggers`);
//     $('#se_preset_edit_id').val(presetId);

//     // Clear checkboxes
//     $('.se-preset-trigger').prop('checked', false);

//     // Set which triggers are active
//     if (preset.triggers && Array.isArray(preset.triggers)) {
//         preset.triggers.forEach(trigger => {
//             $(`.se-preset-trigger[value="${trigger}"]`).prop('checked', true);
//         });
//     }

//     $editor.show();
//     $('html, body').scrollTop($editor.offset().top - 100);
// }

// function savePresetSettings() {
//     const presetId = $('#se_preset_edit_id').val();
//     const settings = getSettings();
//     const preset = settings.presets[presetId];
//     if (!preset) return;

//     const triggers = [];
//     $('.se-preset-trigger:checked').each(function () {
//         triggers.push($(this).val());
//     });

//     preset.triggers = triggers;
//     persistSettings();
    
//     $('#se_preset_editor').hide();
//     setStatus(`Triggers updated for "${preset.name}".`);
//     renderVarTable(); // Refresh in case prompt variables are shown
// }

async function initPanel() {
    const context = SillyTavern.getContext();
    let html;
    try {
        html = await context.renderExtensionTemplateAsync(EXT_TEMPLATE_PATH, 'settings');
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to load settings.html template', err);
        return;
    }
    const $html = $(html);
    $html.find('#se_macro_example, #se_macro_example2').text('{{getvar::name}}');
    $('#extensions_settings2').append($html);

    bindPanelEvents();
    loadGeneralSettingsIntoForm();
     
    const chatId = getCurrentChatId();
    if (chatId) {
        const activePresetIds = getPresetsForChat(chatId);
        if (activePresetIds.length > 0) {
            currentPresetId = activePresetIds[0];
        }
        renderVarTable();
    } else {
        const $tabContainer = $('#se_preset_tabs');
        const $tbody = $('#se_var_tbody');
        const $empty = $('#se_var_empty');
        if ($tabContainer.length) $tabContainer.empty();
        if ($tbody.length) $tbody.empty();
        if ($empty.length) $empty.show().text('Select a chat to view state variables.');
    }

    if (getSettings().showTrackerPanel) {
        setTrackerPanelVisible(true);
    }
}

// ---------------------------------------------------------------------------
// Stylesheet loader
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dynamic script/stylesheet loader
// ---------------------------------------------------------------------------

function loadManagerModalScript() {
    const scriptId = 'se-manager-modal-script';
    if (document.getElementById(scriptId)) return Promise.resolve(); // Already loaded

    const scriptPath = `scripts/extensions/${EXT_TEMPLATE_PATH}/manager-modal.js?v=${Date.now()}`;
    
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.id = scriptId;
        script.src = scriptPath;
        script.onload = () => {
            console.log(LOG_PREFIX, 'manager modal script loaded');
            resolve();
        };
        script.onerror = () => {
            console.error(LOG_PREFIX, 'failed to load manager modal script');
            reject(new Error('Failed to load manager-modal.js'));
        };
        document.head.appendChild(script);
    });
}

function loadManagerModalStyles() {
    const styleId = 'se-manager-modal-styles';
    if (document.getElementById(styleId)) return; // Already loaded

    const cssPath = `scripts/extensions/${EXT_TEMPLATE_PATH}/manager-modal.css`;
    const link = document.createElement('link');
    link.id = styleId;
    link.rel = 'stylesheet';
    link.href = cssPath;
    document.head.appendChild(link);
    console.log(LOG_PREFIX, 'manager modal styles loaded');
}

// ---------------------------------------------------------------------------
// Template registration
// ---------------------------------------------------------------------------

async function registerTemplates() {
    const context = SillyTavern.getContext();
    try {
        if (context.registerExtensionTemplates) {
            await context.registerExtensionTemplates(EXT_TEMPLATE_PATH, 'settings.html');
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'template registration skipped or failed', err);
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

jQuery(async () => {
    try {
        getSettings(); // ensure defaults exist / migrate
        await registerTemplates();
        await initPanel();
        addStateEngineWandUi();
        registerEvents();
        registerSlashCommand();
        applyDefaultsForMissing();
        updateManagerButtonState();
        watchChatSelection();
        // Covers the case where APP_READY already fired before we got here.
        runStartupOnce();
        
        // Load manager modal styles
        loadManagerModalStyles();
        
        console.log(LOG_PREFIX, 'loaded');
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to initialize', err);
    }
});
