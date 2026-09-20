// State Engine — condition UI injected directly into the World Info entry editor

import { LOG_PREFIX } from '../core/settings-core.js';
import { makeWIEntryKey, normalizeWorldName, getWIConditions, setWICondition, updateWICondition, deleteWICondition, getAvailableVariablesForConditions } from './wi-conditions.js';

function injectWIConditionUI() {
    // Inject condition UI into the WI entry editor dialog
    // Look for the entry-specific fields (those are only visible when editing an entry)
    const entryFields = document.querySelector('.world-info-entry-fields, .ui-world-info-edit-form, .form-inline');
    if (!entryFields) return; // No WI editor visible

    // Check if we already injected
    if (entryFields.querySelector('.se-wi-injected-conditions')) return;

    // Build the condition UI HTML
    const conditionsHTML = `
        <div class="se-wi-injected-conditions se-wi-box">
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
            <div id="se_wi_injected_condition_editor" class="se-wi-editor" style="display: none;">
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
                <div id="se_wi_injected_cond_index_container" style="display: none; margin-bottom: 8px;">
                    <label for="se_wi_injected_cond_index" style="font-size: 0.9em;">Index</label>
                    <input id="se_wi_injected_cond_index" type="number" min="0" step="1" class="text_pole" style="font-size: 0.9em;" placeholder="0" />
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
        // ST's own editor has no [name="world"] element - the book being edited
        // is the selected option of #world_editor_select - so fall back to that,
        // and to normalizeWorldName()'s default, so this key matches the one the
        // filter builds from the entry's own `world`.
        const editorBook = document.querySelector('#world_editor_select option:checked');
        const world = (worldInput && (worldInput.value || worldInput.getAttribute('data-world')))
            || (editorBook && editorBook.textContent);
        if (uid) return makeWIEntryKey(normalizeWorldName({ world }), uid);
    }
    return null;
}

// Cached by handleWIAddCondition each time the editor opens, so the
// variable-select change handler doesn't need to re-fetch it.
let cachedConditionVariables = [];

// The condition being edited ({ entryKey, index }), or null when the editor is
// adding a new one. Module state, so it survives the list re-rendering.
let editingCondition = null;

const BASE_OPERATORS = [
    { value: 'equals', label: 'equals' },
    { value: 'not_equals', label: 'not equals' },
    { value: 'greater_than', label: 'greater than' },
    { value: 'less_than', label: 'less than' },
    { value: 'greater_or_equal', label: '≥ greater or equal' },
    { value: 'less_or_equal', label: '≤ less or equal' },
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'not contains' },
    { value: 'in_list', label: 'in list' },
    { value: 'regex', label: 'regex pattern' },
    { value: 'is_true', label: 'is true' },
    { value: 'is_false', label: 'is false' },
];

// Array-aware operators, per spec: contains/not_contains/length_gt/length_eq
// for every itemType; index_eq added only when itemType isn't "any" (an
// index lookup into an untyped "any" array is still meaningful, but the
// spec explicitly restricts itemType "any" to just these four).
function arrayOperators(itemType) {
    const ops = [
        { value: 'contains', label: 'contains' },
        { value: 'not_contains', label: 'not contains' },
        { value: 'length_gt', label: 'length >' },
        { value: 'length_eq', label: 'length ==' },
    ];
    if (itemType !== 'any') {
        ops.push({ value: 'index_eq', label: 'item at index ==' });
    }
    return ops;
}

// ---------------------------------------------------------------------------
// Pure helpers (no DOM) - exported so they can be tested
// ---------------------------------------------------------------------------

// Escapes text for safe use in HTML content AND in attribute values.
// Everything the editor renders from stored or user-typed data goes through
// this: variable names, preset names, operator names, values, entry keys.
export function escapeText(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// An array whose items are objects. Conditions on these are not supported yet:
// there is no field selector, so nothing a condition could compare against.
export function isObjectArray(varMeta) {
    return varMeta?.type === 'array' && varMeta.itemType === 'object';
}

// The operators the editor offers for a variable (null meta = none chosen yet).
// Object arrays get none.
export function operatorsFor(varMeta) {
    if (isObjectArray(varMeta)) return [];
    return varMeta?.type === 'array' ? arrayOperators(varMeta.itemType) : BASE_OPERATORS;
}

// <option>s for the variable dropdown: value = what a condition stores (the
// variable's id), text = "<preset name> / <variable name>".
export function variableOptionsHtml(variables) {
    return '<option value="">-- Select variable --</option>' + (variables || []).map((v) =>
        `<option value="${escapeText(v.name)}">${escapeText(v.presetName)} / ${escapeText(v.variableName || v.name)}</option>`).join('');
}

// "0:sword" -> { index: '0', value: 'sword' } for index_eq (only the first
// colon separates); anything else -> { index: '', value: <as is> }.
export function splitConditionValue(operator, stored) {
    const raw = String(stored ?? '');
    if (operator !== 'index_eq') return { index: '', value: raw };
    const at = raw.indexOf(':');
    return at === -1 ? { index: '', value: raw } : { index: raw.slice(0, at), value: raw.slice(at + 1) };
}

// One row of the condition list. `labelFor(variableKey)` gives the variable's
// display name; unknown variables show as stored. Everything is escaped.
export function conditionItemHtml(cond, index, entryKey, labelFor = (v) => v) {
    const variable = escapeText(labelFor(cond?.variable) ?? cond?.variable);
    const operator = escapeText(cond?.operator);
    const value = escapeText(cond?.value);
    const key = escapeText(entryKey);
    return `
        <div class="se-condition-item se-wi-condition-item">
            <span class="se-condition-text"><code>${variable}</code> ${operator} <code>${value}</code></span>
            <span class="se-wi-condition-actions">
                <button type="button" class="se-edit-injected-condition menu_button" data-entry-key="${key}" data-index="${index}" title="Edit">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button type="button" class="se-delete-injected-condition menu_button" data-entry-key="${key}" data-index="${index}" title="Delete">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </span>
        </div>
    `;
}

// Rebuilds the operator dropdown for the currently-selected variable's type,
// then re-derives the value input for whichever operator ends up selected.
function updateOperatorAndValueUI(varName) {
    const operatorSelect = document.getElementById('se_wi_injected_cond_operator');
    if (!operatorSelect) return;

    const varMeta = cachedConditionVariables.find(v => v.name === varName) || null;
    const options = operatorsFor(varMeta);

    operatorSelect.innerHTML = isObjectArray(varMeta)
        ? '<option value="">Not available for object arrays</option>'
        : options.map(o => `<option value="${escapeText(o.value)}">${escapeText(o.label)}</option>`).join('');
    operatorSelect.disabled = isObjectArray(varMeta);
    updateValueUI(varMeta, operatorSelect.value);
}

// Swaps the value input between a plain text field, a dropdown of
// itemEnumValues (array of enum), or a disabled field with an explanation
// (array of object), and shows/hides the separate index field for index_eq.
// The value element keeps the id se_wi_injected_cond_value regardless of shape
// (input or select both expose .value), so save/read code doesn't need to care
// which - it exists in EVERY branch except the hidden boolean one, where it is
// simply left as it was.
function updateValueUI(varMeta, operator) {
    const valueContainer = document.getElementById('se_wi_injected_cond_value_container');
    const indexContainer = document.getElementById('se_wi_injected_cond_index_container');
    if (!valueContainer) return;

    const isBoolean = operator === 'is_true' || operator === 'is_false';
    valueContainer.style.display = isBoolean ? 'none' : 'block';
    if (indexContainer) indexContainer.style.display = operator === 'index_eq' ? 'block' : 'none';
    if (isBoolean) return;

    if (isObjectArray(varMeta)) {
        valueContainer.innerHTML = `
            <label for="se_wi_injected_cond_value" style="font-size: 0.9em;">Value</label>
            <input id="se_wi_injected_cond_value" type="text" class="text_pole" style="font-size: 0.9em;" disabled placeholder="Not available" />
            <div class="se-wi-object-array-note" style="font-size: 0.85em; opacity: 0.8;">
                Conditions on arrays of objects are not supported yet (there is no way to pick a field to compare).
                Choose a different variable.
            </div>
        `;
    } else if (varMeta?.type === 'array' && varMeta.itemType === 'enum') {
        const opts = (varMeta.itemEnumValues || []).map(v => `<option value="${escapeText(v)}">${escapeText(v)}</option>`).join('');
        valueContainer.innerHTML = `
            <label for="se_wi_injected_cond_value" style="font-size: 0.9em;">Value</label>
            <select id="se_wi_injected_cond_value" class="text_pole" style="font-size: 0.9em;">${opts}</select>
        `;
    } else {
        valueContainer.innerHTML = `
            <label for="se_wi_injected_cond_value" style="font-size: 0.9em;">Value</label>
            <input id="se_wi_injected_cond_value" type="text" class="text_pole" style="font-size: 0.9em;" placeholder="comma-separated for 'in list'" />
        `;
    }
}

function handleWIVariableChange() {
    const varSelect = document.getElementById('se_wi_injected_cond_variable');
    updateOperatorAndValueUI(varSelect ? varSelect.value : null);
}

function wireInjectedWIConditionUI() {
    // Wire up click handlers for the injected condition UI
    const addBtn = document.querySelector('.se-wi-add-condition-btn');
    const saveBtn = document.querySelector('.se-wi-save-condition-btn');
    const cancelBtn = document.querySelector('.se-wi-cancel-condition-btn');
    const operatorSelect = document.getElementById('se_wi_injected_cond_operator');
    const varSelect = document.getElementById('se_wi_injected_cond_variable');

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

    if (varSelect) {
        varSelect.removeEventListener('change', handleWIVariableChange);
        varSelect.addEventListener('change', handleWIVariableChange);
    }
}

function setSaveButtonLabel() {
    const saveBtn = document.querySelector('.se-wi-save-condition-btn');
    if (saveBtn) saveBtn.textContent = editingCondition ? 'Save changes' : 'Add condition';
}

// Opens the editor for a NEW condition.
function handleWIAddCondition() {
    const editor = document.getElementById('se_wi_injected_condition_editor');
    if (!editor) return;

    editingCondition = null;
    setSaveButtonLabel();

    cachedConditionVariables = getAvailableVariablesForConditions();
    const varSelect = document.getElementById('se_wi_injected_cond_variable');
    varSelect.innerHTML = variableOptionsHtml(cachedConditionVariables);

    updateOperatorAndValueUI(null);

    editor.style.display = 'block';
}

// Opens the editor filled in with an existing condition; saving replaces it.
function handleWIEditCondition(e) {
    const btn = e.target.closest('button');
    const entryKey = btn.getAttribute('data-entry-key');
    const index = parseInt(btn.getAttribute('data-index'), 10);
    const list = getWIConditions(entryKey);
    const cond = Array.isArray(list) ? list[index] : undefined;
    const editor = document.getElementById('se_wi_injected_condition_editor');
    if (!cond || !editor) return;

    cachedConditionVariables = getAvailableVariablesForConditions();
    const varSelect = document.getElementById('se_wi_injected_cond_variable');
    let options = variableOptionsHtml(cachedConditionVariables);
    // The condition's variable may not be available right now (its preset is not
    // active): keep it selectable so saving does not silently change it.
    if (!cachedConditionVariables.some((v) => v.name === cond.variable)) {
        options += `<option value="${escapeText(cond.variable)}">(not available) ${escapeText(cond.variable)}</option>`;
    }
    varSelect.innerHTML = options;
    varSelect.value = cond.variable;

    updateOperatorAndValueUI(cond.variable);
    const operatorSelect = document.getElementById('se_wi_injected_cond_operator');
    operatorSelect.value = cond.operator;
    const varMeta = cachedConditionVariables.find((v) => v.name === cond.variable) || null;
    updateValueUI(varMeta, cond.operator);

    const { index: itemIndex, value } = splitConditionValue(cond.operator, cond.value);
    const valueEl = document.getElementById('se_wi_injected_cond_value');
    if (valueEl && !valueEl.disabled) valueEl.value = value;
    const indexInput = document.getElementById('se_wi_injected_cond_index');
    if (indexInput) indexInput.value = itemIndex;

    editingCondition = { entryKey, index };
    setSaveButtonLabel();
    editor.style.display = 'block';
}

function handleWICancelCondition() {
    const editor = document.getElementById('se_wi_injected_condition_editor');
    if (editor) editor.style.display = 'none';
    editingCondition = null;
    setSaveButtonLabel();
}

function handleWISaveCondition() {
    const entryKey = getWIEditorEntryKey();
    if (!entryKey) {
        alert('Could not identify the entry being edited. Make sure you have an entry open.');
        return;
    }

    const varName = document.getElementById('se_wi_injected_cond_variable').value;
    const operator = document.getElementById('se_wi_injected_cond_operator').value;

    const varMeta = cachedConditionVariables.find((v) => v.name === varName) || null;
    if (isObjectArray(varMeta)) {
        alert('Conditions on arrays of objects are not supported yet. Please choose a different variable.');
        return;
    }

    // The value element can be absent or disabled; never read through null.
    const valueEl = document.getElementById('se_wi_injected_cond_value');
    let value = valueEl && !valueEl.disabled ? valueEl.value : '';

    if (!varName || !operator) {
        alert('Please select a variable and operator');
        return;
    }

    if (operator === 'index_eq') {
        // condValue has no separate index field of its own - encode both
        // into the single stored value string as "<index>:<value>",
        // decoded back apart in wi-conditions.js's index_eq operator.
        const indexInput = document.getElementById('se_wi_injected_cond_index');
        const index = indexInput ? indexInput.value.trim() : '';
        if (index === '' || value === '') {
            alert('Please enter both an index and a value');
            return;
        }
        value = `${index}:${value}`;
    } else if ((operator !== 'is_true' && operator !== 'is_false') && !value) {
        alert('Please enter a value');
        return;
    }

    const condition = {
        variable: varName,
        operator: operator,
        value: operator.startsWith('is_') ? '' : value
    };

    if (editingCondition && editingCondition.entryKey === entryKey) {
        // Editing: replace the existing condition, do not add another.
        updateWICondition(entryKey, editingCondition.index, condition);
    } else {
        setWICondition(entryKey, condition);
    }

    // Refresh condition list and close editor
    renderInjectedWIConditions(entryKey);
    handleWICancelCondition();
}

function handleWIOperatorChange() {
    const operator = document.getElementById('se_wi_injected_cond_operator').value;
    const varSelect = document.getElementById('se_wi_injected_cond_variable');
    const varMeta = cachedConditionVariables.find(v => v.name === varSelect?.value) || null;
    updateValueUI(varMeta, operator);
}

function renderInjectedWIConditions(entryKey) {
    const list = document.getElementById('se_wi_injected_conditions_list');
    if (!list) return;

    const conditions = getWIConditions(entryKey);

    // A malformed list is shown as empty (and left alone), never rendered.
    if (!Array.isArray(conditions) || conditions.length === 0) {
        list.innerHTML = '<div class="se-wi-empty">No conditions — entry will always display.</div>';
        return;
    }

    // Show variables by name: condition.variable holds the variable's id.
    const names = new Map(getAvailableVariablesForConditions().map((v) => [v.name, v.variableName]));
    list.innerHTML = conditions.map((cond, index) =>
        conditionItemHtml(cond, index, entryKey, (v) => names.get(v) ?? v)).join('');

    // Wire edit / delete buttons
    list.querySelectorAll('.se-edit-injected-condition').forEach(btn => {
        btn.removeEventListener('click', handleWIEditCondition);
        btn.addEventListener('click', handleWIEditCondition);
    });
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

    // Deleting shifts later indexes: an open edit of this entry is abandoned.
    if (editingCondition && editingCondition.entryKey === entryKey) handleWICancelCondition();

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
