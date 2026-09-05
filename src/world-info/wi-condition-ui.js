// State Engine — condition UI injected directly into the World Info entry editor

import { LOG_PREFIX } from '../core/settings-core.js';
import { makeWIEntryKey, getWIConditions, setWICondition, deleteWICondition, getAvailableVariablesForConditions } from './wi-conditions.js';

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

export function observeWIEditorChanges() {
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
