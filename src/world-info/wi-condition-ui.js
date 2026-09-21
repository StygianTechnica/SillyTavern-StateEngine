// State Engine — condition UI injected directly into the World Info entry editor
//
// SillyTavern's markup (verified against 1.18: public/index.html and
// scripts/world-info.js): every entry is a `<form class="world_entry" uid="N">`
// listed in #world_popup_entries_list. Its edit form (`.world_entry_edit`) is
// built only when the entry is EXPANDED and thrown away when it is collapsed, and
// many entries can be expanded at once. The book being edited is the selected
// option of #world_editor_select.
//
// So this module injects ONE box into each `.world_entry_edit` as it appears
// (a MutationObserver), works out that entry's key from its own `uid` attribute
// and the selected book, and handles every click through a single delegated
// listener - nothing is looked up by a global id except the one condition editor,
// of which at most one exists at a time.

import { LOG_PREFIX, DEFAULT_CALENDAR_ID } from '../core/settings-core.js';
import { toScalar } from '../core/calendar-engine.js';
import { makeWIEntryKey, normalizeWorldName, getWIConditions, setWICondition, updateWICondition, deleteWICondition, getAvailableVariablesForConditions } from './wi-conditions.js';

const BOX_HTML = `
    <div class="se-wi-injected-conditions se-wi-box">
        <div style="margin-bottom: 8px;">
            <label style="font-weight: bold; display: block; margin-bottom: 4px;">
                <i class="fa-solid fa-filter"></i> State Engine Conditions
            </label>
            <small style="opacity: 0.8; display: block; margin-bottom: 8px;">Control if this entry displays based on variable state (all must be true)</small>
        </div>
        <div class="se-wi-conditions-list se-conditions-list" style="margin-bottom: 8px;"></div>
        <button type="button" class="se-wi-add-condition-btn menu_button" style="font-size: 0.9em;">
            <i class="fa-solid fa-plus"></i> Add condition
        </button>
        <div class="se-wi-editor-slot"></div>
    </div>
`;

// The add / edit form. It is put into the box that asked for it, and any other
// copy is removed first, so its ids are always unique.
const EDITOR_HTML = `
    <div id="se_wi_injected_condition_editor" class="se-wi-editor">
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
`;

// ---------------------------------------------------------------------------
// Entry keys
// ---------------------------------------------------------------------------

// "<book>.<uid>" for an entry, or null when either part is missing - a wrong key
// would silently never match the filter's, so it is better to refuse (Save then
// says it could not identify the entry).
export function buildEntryKey(bookName, uid) {
    const book = String(bookName ?? '').trim();
    const id = String(uid ?? '').trim();
    if (!book || !id) return null;
    return makeWIEntryKey(normalizeWorldName({ world: book }), id);
}

// The lorebook being edited: the selected option of ST's book dropdown. (Not the
// hidden `name="world"` input on the character panel - that is the CHARACTER's
// linked lorebook, which is a different thing.)
function currentBookName() {
    const option = document.querySelector('#world_editor_select option:checked');
    return option ? option.textContent : '';
}

function entryKeyForBox(box) {
    const entry = box ? box.closest('.world_entry') : null;
    return buildEntryKey(currentBookName(), entry ? entry.getAttribute('uid') : null);
}

const boxOf = (el) => (el && el.closest ? el.closest('.se-wi-injected-conditions') : null);

// Cached by the editor each time it opens, so the variable-select change handler
// doesn't need to re-fetch it.
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

// A datetime variable compared with equals / greater than / ...: the condition's
// value is a DATE (same form as the variable's default), not the stored seconds.
const DATE_OPERATORS = ['equals', 'not_equals', 'greater_than', 'less_than', 'greater_or_equal', 'less_or_equal'];
export function isDatetimeDateOperator(varMeta, operator) {
    return varMeta?.type === 'datetime' && DATE_OPERATORS.includes(operator);
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

// ---------------------------------------------------------------------------
// Editor form
// ---------------------------------------------------------------------------

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
    } else if (isDatetimeDateOperator(varMeta, operator)) {
        valueContainer.innerHTML = `
            <label for="se_wi_injected_cond_value" style="font-size: 0.9em;">Date</label>
            <input id="se_wi_injected_cond_value" type="text" class="text_pole" style="font-size: 0.9em;" placeholder="2022-05-11 00:00:00" />
        `;
    } else {
        valueContainer.innerHTML = `
            <label for="se_wi_injected_cond_value" style="font-size: 0.9em;">Value</label>
            <input id="se_wi_injected_cond_value" type="text" class="text_pole" style="font-size: 0.9em;" placeholder="comma-separated for 'in list'" />
        `;
    }
}

function setSaveButtonLabel() {
    const saveBtn = document.querySelector('.se-wi-save-condition-btn');
    if (saveBtn) saveBtn.textContent = editingCondition ? 'Save changes' : 'Add condition';
}

// Puts a fresh editor form into `box`'s slot. Any editor already open elsewhere is
// removed first, so there is never more than one (its ids stay unique).
function openEditor(box) {
    const existing = document.getElementById('se_wi_injected_condition_editor');
    if (existing) existing.remove();
    const slot = box.querySelector('.se-wi-editor-slot');
    if (!slot) return null;
    slot.innerHTML = EDITOR_HTML;
    return document.getElementById('se_wi_injected_condition_editor');
}

// Opens the editor for a NEW condition.
function handleWIAddCondition(box) {
    editingCondition = null;
    if (!openEditor(box)) return;
    setSaveButtonLabel();

    cachedConditionVariables = getAvailableVariablesForConditions();
    document.getElementById('se_wi_injected_cond_variable').innerHTML = variableOptionsHtml(cachedConditionVariables);
    updateOperatorAndValueUI(null);
}

// Opens the editor filled in with an existing condition; saving replaces it.
function handleWIEditCondition(btn) {
    const box = boxOf(btn);
    const entryKey = btn.getAttribute('data-entry-key');
    const index = parseInt(btn.getAttribute('data-index'), 10);
    const list = getWIConditions(entryKey);
    const cond = Array.isArray(list) ? list[index] : undefined;
    if (!box || !cond) return;
    if (!openEditor(box)) return;

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
}

function handleWICancelCondition() {
    const editor = document.getElementById('se_wi_injected_condition_editor');
    if (editor) editor.remove();
    editingCondition = null;
}

function handleWISaveCondition() {
    const editorEl = document.getElementById('se_wi_injected_condition_editor');
    const box = boxOf(editorEl);
    const entryKey = box ? entryKeyForBox(box) : null;
    if (!entryKey) {
        alert('Could not identify the entry being edited (or its lorebook). Make sure the entry is open in the World Info editor.');
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
    } else if (isDatetimeDateOperator(varMeta, operator)
        && toScalar(varMeta.calendar || DEFAULT_CALENDAR_ID, value) === null) {
        alert("Please enter a date this variable's calendar understands, e.g. 2022-05-11 00:00:00");
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
    renderInjectedWIConditions(entryKey, box);
    handleWICancelCondition();
}

function handleWIVariableChange() {
    const varSelect = document.getElementById('se_wi_injected_cond_variable');
    updateOperatorAndValueUI(varSelect ? varSelect.value : null);
}

function handleWIOperatorChange() {
    const operator = document.getElementById('se_wi_injected_cond_operator').value;
    const varSelect = document.getElementById('se_wi_injected_cond_variable');
    const varMeta = cachedConditionVariables.find(v => v.name === varSelect?.value) || null;
    updateValueUI(varMeta, operator);
}

// ---------------------------------------------------------------------------
// The condition list
// ---------------------------------------------------------------------------

function renderInjectedWIConditions(entryKey, box) {
    const list = box ? box.querySelector('.se-wi-conditions-list') : null;
    if (!list) return;

    const conditions = entryKey ? getWIConditions(entryKey) : [];

    // A malformed list is shown as empty (and left alone), never rendered.
    if (!Array.isArray(conditions) || conditions.length === 0) {
        list.innerHTML = '<div class="se-wi-empty">No conditions — entry will always display.</div>';
        return;
    }

    // Show variables by name: condition.variable holds the variable's id.
    const names = new Map(getAvailableVariablesForConditions().map((v) => [v.name, v.variableName]));
    list.innerHTML = conditions.map((cond, index) =>
        conditionItemHtml(cond, index, entryKey, (v) => names.get(v) ?? v)).join('');
}

function handleWIDeleteCondition(btn) {
    const box = boxOf(btn);
    const entryKey = btn.getAttribute('data-entry-key');
    const index = parseInt(btn.getAttribute('data-index'), 10);

    if (!confirm('Delete this condition?')) return;

    // Deleting shifts later indexes: an open edit of this entry is abandoned.
    if (editingCondition && editingCondition.entryKey === entryKey) handleWICancelCondition();

    deleteWICondition(entryKey, index);
    renderInjectedWIConditions(entryKey, box);
}

// ---------------------------------------------------------------------------
// Injection and wiring
// ---------------------------------------------------------------------------

// Adds a box to every expanded entry's edit form that does not have one yet, and
// fills it. Idempotent: it changes the page only when something is missing, so
// the observer that calls it does not feed itself. Returns how many were added.
//
// Only forms inside the entries list are used: ST also keeps a hidden
// `.world_entry_edit` in #entry_edit_template that it clones for every entry, and
// a box put there would be copied into each one.
export function injectConditionBoxes() {
    let added = 0;
    document.querySelectorAll('#world_popup_entries_list .world_entry_edit').forEach((form) => {
        if (Array.from(form.children).some((child) => child.classList.contains('se-wi-injected-conditions'))) return;

        const holder = document.createElement('div');
        holder.innerHTML = BOX_HTML.trim();
        const box = holder.firstElementChild;
        form.appendChild(box);
        renderInjectedWIConditions(entryKeyForBox(box), box);
        added++;
    });
    return added;
}

let listenersInstalled = false;

// One listener for every button and select in every box, so nothing has to be
// re-wired when ST rebuilds an entry.
function installDelegatedListeners() {
    if (listenersInstalled) return;
    listenersInstalled = true;

    document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        const add = target.closest('.se-wi-add-condition-btn');
        if (add) { handleWIAddCondition(boxOf(add)); return; }
        if (target.closest('.se-wi-save-condition-btn')) { handleWISaveCondition(); return; }
        if (target.closest('.se-wi-cancel-condition-btn')) { handleWICancelCondition(); return; }
        const edit = target.closest('.se-edit-injected-condition');
        if (edit) { handleWIEditCondition(edit); return; }
        const del = target.closest('.se-delete-injected-condition');
        if (del) { handleWIDeleteCondition(del); }
    });

    document.addEventListener('change', (event) => {
        const id = event.target && event.target.id;
        if (id === 'se_wi_injected_cond_variable') handleWIVariableChange();
        else if (id === 'se_wi_injected_cond_operator') handleWIOperatorChange();
    });
}

export function observeWIEditorChanges() {
    installDelegatedListeners();

    // ST builds an entry's edit form when it is expanded, so watch for them.
    // Coalesced to one pass per frame.
    let scheduled = false;
    const observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            injectConditionBoxes();
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: false,
    });

    injectConditionBoxes(); // entries that are already expanded
    console.log(`${LOG_PREFIX} Monitoring WI editor for changes`);
}
