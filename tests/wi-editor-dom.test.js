// @vitest-environment jsdom
//
// The World Info editor injection, run in a real DOM against markup copied from
// SillyTavern 1.18 (public/index.html + scripts/world-info.js):
//   #world_editor_select                       the book being edited
//   #world_popup_entries_list > form.world_entry[uid]
//        .inline-drawer-outlet > .world_entry_edit    (built only when expanded)
//   #entry_edit_template .world_entry_edit     hidden, cloned for every entry
//   input#character_world[name=world]          the CHARACTER's linked lorebook (a decoy)
// This is the test that would have caught the box never appearing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { addPresetToChat } from '../src/core/preset-manager.js';
import { injectConditionBoxes, observeWIEditorChanges, buildEntryKey } from '../src/world-info/wi-condition-ui.js';

const ST_MARKUP = `
    <input id="character_world" name="world" type="hidden" value="Character's Own Book">
    <select id="world_editor_select">
        <option value="0">Other Book</option>
        <option value="1" selected>QA-Book</option>
    </select>
    <div id="world_popup_entries_list">
        <form class="world_entry" uid="3"><div class="inline-drawer"><div class="inline-drawer-outlet"></div></div></form>
        <form class="world_entry" uid="7"><div class="inline-drawer"><div class="inline-drawer-outlet"></div></div></form>
    </div>
    <div id="entry_edit_template" class="template_element">
        <div class="world_entry_edit"><textarea name="comment"></textarea></div>
    </div>
`;

// ST builds this when an entry is expanded.
const expand = (uid) => {
    const outlet = document.querySelector(`.world_entry[uid="${uid}"] .inline-drawer-outlet`);
    const form = document.createElement('div');
    form.className = 'world_entry_edit';
    form.innerHTML = '<textarea name="comment"></textarea>';
    outlet.appendChild(form);
    return form;
};
const box = (uid) => document.querySelector(`.world_entry[uid="${uid}"] .se-wi-injected-conditions`);
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const change = (el) => el.dispatchEvent(new Event('change', { bubbles: true }));
const $ = (sel) => document.querySelector(sel);

let counter = 0;
function makeVariables() {
    const id = `dom-preset-${++counter}`;
    getSettings().presets[id] = {
        id, name: 'Story', namespace: 'se', description: '', triggers: ['ai'], showInTracker: false,
        variables: {
            'v-hp': { id: 'v-hp', name: 'se__hp', type: 'number', defaultValue: 0 },
            'v-inv': { id: 'v-inv', name: 'se__inventory', type: 'array', itemType: 'string', defaultValue: [] },
            'v-tags': { id: 'v-tags', name: 'se__tags', type: 'array', itemType: 'enum', itemEnumValues: ['red', 'green'], defaultValue: [] },
            'v-party': { id: 'v-party', name: 'se__party', type: 'array', itemType: 'object', defaultValue: [] },
        },
    };
    addPresetToChat('chat-1', id);
}

// Opens the editor in a box, fills it in and presses the save button.
function addCondition(uid, variable, operator, value, index) {
    click(box(uid).querySelector('.se-wi-add-condition-btn'));
    $('#se_wi_injected_cond_variable').value = variable;
    change($('#se_wi_injected_cond_variable'));
    $('#se_wi_injected_cond_operator').value = operator;
    change($('#se_wi_injected_cond_operator'));
    const valueEl = $('#se_wi_injected_cond_value');
    if (valueEl && !valueEl.disabled) valueEl.value = value ?? '';
    if (index !== undefined) $('#se_wi_injected_cond_index').value = index;
    click($('.se-wi-save-condition-btn'));
}

beforeEach(async () => {
    settings.reset();
    document.body.innerHTML = ST_MARKUP;
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('confirm', vi.fn(() => true));
    makeVariables();
    context.saveSettingsDebounced.mockClear();
    observeWIEditorChanges(); // installs the listeners and the observer (idempotent listeners)
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('injection into ST\'s real markup', () => {
    it('adds a "State Engine Conditions" box to an EXPANDED entry, with an Add condition button', () => {
        expand(3);
        expect(injectConditionBoxes()).toBe(1);
        expect(box(3)).not.toBeNull();
        expect(box(3).textContent).toContain('State Engine Conditions');
        expect(box(3).querySelector('.se-wi-add-condition-btn').textContent).toContain('Add condition');
        expect(box(3).textContent).toContain('No conditions — entry will always display.');
        expect(box(7)).toBeNull(); // collapsed: no edit form, nothing to inject into
    });

    it('sits INSIDE the entry\'s edit form', () => {
        expand(3);
        injectConditionBoxes();
        expect(box(3).parentElement.classList.contains('world_entry_edit')).toBe(true);
    });

    it('never touches the hidden template ST clones for every entry', () => {
        expand(3);
        injectConditionBoxes();
        expect(document.querySelector('#entry_edit_template .se-wi-injected-conditions')).toBeNull();
    });

    it('several expanded entries each get exactly one box; running again adds nothing', () => {
        expand(3); expand(7);
        expect(injectConditionBoxes()).toBe(2);
        expect(document.querySelectorAll('.se-wi-injected-conditions')).toHaveLength(2);
        expect(injectConditionBoxes()).toBe(0);
        expect(document.querySelectorAll('.se-wi-injected-conditions')).toHaveLength(2);
    });

    it('the observer injects into a form ST builds LATER (no manual call)', async () => {
        expand(3);
        await vi.waitFor(() => expect(box(3)).not.toBeNull());
        expand(7);
        await vi.waitFor(() => expect(box(7)).not.toBeNull());
        expect(document.querySelectorAll('.se-wi-injected-conditions')).toHaveLength(2);
    });

    it('when ST collapses and re-expands an entry (form rebuilt) the new form gets its box', async () => {
        const first = expand(3);
        await vi.waitFor(() => expect(box(3)).not.toBeNull());
        first.remove();
        expand(3);
        await vi.waitFor(() => expect(document.querySelectorAll('.se-wi-injected-conditions')).toHaveLength(1));
        expect(box(3)).not.toBeNull();
    });

    it('does not loop: with nothing to add, the page is left alone', async () => {
        expand(3);
        await vi.waitFor(() => expect(box(3)).not.toBeNull());
        const seen = [];
        const watcher = new MutationObserver((records) => seen.push(...records));
        watcher.observe(document.body, { childList: true, subtree: true });
        await new Promise((resolve) => setTimeout(resolve, 100));
        watcher.disconnect();
        expect(seen).toHaveLength(0);
    });
});

describe('entry keys', () => {
    it('buildEntryKey needs both a book and a uid', () => {
        expect(buildEntryKey('QA-Book', 3)).toBe('QA-Book.3');
        expect(buildEntryKey('  QA-Book ', ' 3 ')).toBe('QA-Book.3');
        expect(buildEntryKey('', 3)).toBeNull();
        expect(buildEntryKey('QA-Book', '')).toBeNull();
        expect(buildEntryKey('QA-Book', null)).toBeNull();
        expect(buildEntryKey(undefined, undefined)).toBeNull();
    });

    it('a condition is stored under the SELECTED BOOK and the entry\'s uid - not the character\'s lorebook', () => {
        expand(3);
        injectConditionBoxes();
        addCondition(3, 'v-hp', 'greater_than', '10');
        expect(Object.keys(getSettings().wiConditions)).toEqual(['QA-Book.3']);
        expect(getSettings().wiConditions['QA-Book.3']).toEqual([{ variable: 'v-hp', operator: 'greater_than', value: '10' }]);
    });

    it('two open entries keep their conditions apart', () => {
        expand(3); expand(7);
        injectConditionBoxes();
        addCondition(3, 'v-hp', 'equals', '1');
        addCondition(7, 'v-hp', 'equals', '2');
        expect(getSettings().wiConditions['QA-Book.3']).toHaveLength(1);
        expect(getSettings().wiConditions['QA-Book.7']).toHaveLength(1);
        expect(box(3).textContent).toContain('equals');
        expect(box(3).textContent).not.toContain('2</code>');
    });

    it('switching the selected book changes the key used for the next condition', () => {
        expand(3);
        injectConditionBoxes();
        $('#world_editor_select').value = '0';
        addCondition(3, 'v-hp', 'equals', '1');
        expect(Object.keys(getSettings().wiConditions)).toEqual(['Other Book.3']);
    });

    it('if the book cannot be determined, Save refuses (alert) and stores nothing', () => {
        expand(3);
        injectConditionBoxes();
        $('#world_editor_select').innerHTML = '';
        addCondition(3, 'v-hp', 'equals', '1');
        expect(alert).toHaveBeenCalledWith(expect.stringContaining('Could not identify the entry'));
        expect(getSettings().wiConditions).toEqual({});
    });
});

describe('the add / edit / delete flows in the real DOM', () => {
    beforeEach(() => { expand(3); injectConditionBoxes(); });

    it('Add condition opens ONE editor listing the variables by name, and Cancel closes it', () => {
        click(box(3).querySelector('.se-wi-add-condition-btn'));
        expect(document.querySelectorAll('#se_wi_injected_condition_editor')).toHaveLength(1);
        const options = [...$('#se_wi_injected_cond_variable').options].map((o) => o.textContent);
        expect(options).toContain('Story / se__hp');
        expect(options.join()).not.toContain('v-hp');
        click($('.se-wi-cancel-condition-btn'));
        expect($('#se_wi_injected_condition_editor')).toBeNull();
    });

    it('opening the editor in a second entry closes the first one\'s (ids stay unique)', () => {
        expand(7); injectConditionBoxes();
        click(box(3).querySelector('.se-wi-add-condition-btn'));
        click(box(7).querySelector('.se-wi-add-condition-btn'));
        expect(document.querySelectorAll('#se_wi_injected_condition_editor')).toHaveLength(1);
        expect(box(7).querySelector('#se_wi_injected_condition_editor')).not.toBeNull();
        expect(box(3).querySelector('#se_wi_injected_condition_editor')).toBeNull();
    });

    it('a saved condition is listed by variable NAME, persisted, and the editor closes', () => {
        addCondition(3, 'v-hp', 'greater_than', '10');
        expect(box(3).querySelector('.se-condition-text').textContent).toBe('se__hp greater_than 10');
        expect($('#se_wi_injected_condition_editor')).toBeNull();
        expect(context.saveSettingsDebounced).toHaveBeenCalled();
    });

    it('validation alerts: no variable, no value', () => {
        click(box(3).querySelector('.se-wi-add-condition-btn'));
        click($('.se-wi-save-condition-btn'));
        expect(alert).toHaveBeenLastCalledWith('Please select a variable and operator');
        $('#se_wi_injected_cond_variable').value = 'v-hp';
        change($('#se_wi_injected_cond_variable'));
        click($('.se-wi-save-condition-btn'));
        expect(alert).toHaveBeenLastCalledWith('Please enter a value');
        expect(getSettings().wiConditions).toEqual({});
    });

    it('is_true needs no value; the value box is hidden for it', () => {
        click(box(3).querySelector('.se-wi-add-condition-btn'));
        $('#se_wi_injected_cond_variable').value = 'v-hp';
        change($('#se_wi_injected_cond_variable'));
        $('#se_wi_injected_cond_operator').value = 'is_true';
        change($('#se_wi_injected_cond_operator'));
        expect($('#se_wi_injected_cond_value_container').style.display).toBe('none');
        click($('.se-wi-save-condition-btn'));
        expect(getSettings().wiConditions['QA-Book.3']).toEqual([{ variable: 'v-hp', operator: 'is_true', value: '' }]);
    });

    it('array variables get array operators; index_eq shows the index box and stores index:value', () => {
        click(box(3).querySelector('.se-wi-add-condition-btn'));
        $('#se_wi_injected_cond_variable').value = 'v-inv';
        change($('#se_wi_injected_cond_variable'));
        expect([...$('#se_wi_injected_cond_operator').options].map((o) => o.value)).toEqual(['contains', 'not_contains', 'length_gt', 'length_eq', 'index_eq']);
        $('#se_wi_injected_cond_operator').value = 'index_eq';
        change($('#se_wi_injected_cond_operator'));
        expect($('#se_wi_injected_cond_index_container').style.display).toBe('block');
        $('#se_wi_injected_cond_value').value = 'sword';
        $('#se_wi_injected_cond_index').value = '0';
        click($('.se-wi-save-condition-btn'));
        expect(getSettings().wiConditions['QA-Book.3'][0]).toEqual({ variable: 'v-inv', operator: 'index_eq', value: '0:sword' });
    });

    it('an array of enum shows a dropdown of its allowed values', () => {
        click(box(3).querySelector('.se-wi-add-condition-btn'));
        $('#se_wi_injected_cond_variable').value = 'v-tags';
        change($('#se_wi_injected_cond_variable'));
        expect([...$('#se_wi_injected_cond_value').options].map((o) => o.value)).toEqual(['red', 'green']);
    });

    it('an array of objects cannot be saved: no operators, value disabled with a note, no exception', () => {
        click(box(3).querySelector('.se-wi-add-condition-btn'));
        $('#se_wi_injected_cond_variable').value = 'v-party';
        change($('#se_wi_injected_cond_variable'));
        expect($('#se_wi_injected_cond_operator').disabled).toBe(true);
        expect($('#se_wi_injected_cond_value').disabled).toBe(true);
        expect($('.se-wi-object-array-note').textContent).toContain('not supported yet');
        expect(() => click($('.se-wi-save-condition-btn'))).not.toThrow();
        expect(alert).toHaveBeenLastCalledWith(expect.stringContaining('not supported yet'));
        expect(getSettings().wiConditions).toEqual({});
    });

    it('Edit fills the form in; Save changes REPLACES the condition (same count, same place)', () => {
        addCondition(3, 'v-hp', 'greater_than', '10');
        addCondition(3, 'v-hp', 'less_than', '99');
        click(box(3).querySelectorAll('.se-edit-injected-condition')[0]);
        expect($('#se_wi_injected_cond_variable').value).toBe('v-hp');
        expect($('#se_wi_injected_cond_operator').value).toBe('greater_than');
        expect($('#se_wi_injected_cond_value').value).toBe('10');
        expect($('.se-wi-save-condition-btn').textContent).toBe('Save changes');
        $('#se_wi_injected_cond_value').value = '55';
        click($('.se-wi-save-condition-btn'));
        expect(getSettings().wiConditions['QA-Book.3']).toEqual([
            { variable: 'v-hp', operator: 'greater_than', value: '55' },
            { variable: 'v-hp', operator: 'less_than', value: '99' },
        ]);
        expect(box(3).querySelectorAll('.se-condition-item')).toHaveLength(2);
    });

    it('editing an index_eq condition shows index and value separately', () => {
        addCondition(3, 'v-inv', 'index_eq', 'sword', '2');
        click(box(3).querySelector('.se-edit-injected-condition'));
        expect($('#se_wi_injected_cond_index').value).toBe('2');
        expect($('#se_wi_injected_cond_value').value).toBe('sword');
    });

    it('Cancel during an edit changes nothing, and the next Add starts fresh', () => {
        addCondition(3, 'v-hp', 'greater_than', '10');
        click(box(3).querySelector('.se-edit-injected-condition'));
        $('#se_wi_injected_cond_value').value = '999';
        click($('.se-wi-cancel-condition-btn'));
        expect(getSettings().wiConditions['QA-Book.3'][0].value).toBe('10');
        click(box(3).querySelector('.se-wi-add-condition-btn'));
        expect($('.se-wi-save-condition-btn').textContent).toBe('Add condition');
        expect($('#se_wi_injected_cond_value').value).toBe('');
    });

    it('Delete asks first, removes only that condition, and re-renders', () => {
        addCondition(3, 'v-hp', 'equals', '1');
        addCondition(3, 'v-hp', 'equals', '2');
        confirm.mockReturnValueOnce(false);
        click(box(3).querySelectorAll('.se-delete-injected-condition')[0]);
        expect(getSettings().wiConditions['QA-Book.3']).toHaveLength(2);
        click(box(3).querySelectorAll('.se-delete-injected-condition')[0]);
        expect(getSettings().wiConditions['QA-Book.3']).toEqual([{ variable: 'v-hp', operator: 'equals', value: '2' }]);
        click(box(3).querySelector('.se-delete-injected-condition'));
        expect(getSettings().wiConditions['QA-Book.3']).toBeUndefined();
        expect(box(3).textContent).toContain('No conditions');
    });

    it('existing conditions are shown when an entry is (re)expanded', async () => {
        addCondition(3, 'v-hp', 'equals', '1');
        document.querySelector('.world_entry[uid="3"] .world_entry_edit').remove();
        expand(3);
        await vi.waitFor(() => expect(box(3)).not.toBeNull());
        expect(box(3).querySelector('.se-condition-text').textContent).toBe('se__hp equals 1');
    });

    it('nothing typed can inject markup into the page', () => {
        addCondition(3, 'v-hp', 'equals', '<img src=x onerror=alert(1)>');
        expect(box(3).querySelector('img')).toBeNull();
        expect(box(3).querySelector('.se-condition-text code:last-child').textContent).toBe('<img src=x onerror=alert(1)>');
    });
});
