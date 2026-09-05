// State Engine — World Info condition manager panel

import { getWorldInfoEntries } from './wi-filtering.js';
import { makeWIEntryKey, getWIConditions, setWICondition, deleteWICondition, shouldDisplayWIEntry, getAvailableVariablesForConditions } from './wi-conditions.js';

export function populateWIEntrySelect() {
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

export function renderWIConditions(entryKey) {
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

export function openWIConditionEditor(entryKey) {
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

export function closeWIConditionEditor() {
    const editor = document.getElementById('se_wi_condition_editor');
    if (editor) {
        editor.style.display = 'none';
        editor._editingEntryKey = null;
    }
}

export function saveWIConditionFromUI() {
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

export function deleteWIConditionFromUI(entryKey, index) {
    deleteWICondition(entryKey, index);
    renderWIConditions(entryKey);
    updateWIEntryStatus(entryKey);
}

export function updateWIEntryStatus(entryKey) {
    // Update the status badge showing if entry is currently active
    const statusDiv = document.getElementById('se_wi_entry_status');
    if (!statusDiv) return;

    const isActive = shouldDisplayWIEntry(entryKey);
    statusDiv.className = 'se-wi-status ' + (isActive ? 'active' : 'inactive');
    statusDiv.innerHTML = isActive ? '✓ Currently displayed' : '✗ Filtered out';
}

export function openWorldInfoConditionManager() {
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
