import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { ensureInstanceId } from '../src/api/identity.js';
import * as wi from '../src/world-info/wi-conditions.js';
import { filterLoadedWorldInfo } from '../src/world-info/wi-filtering.js';
import * as editor from '../src/world-info/wi-condition-ui.js';
import { StateEngineWI } from '../src/world-info/wi-api.js';
import * as bindings from '../src/core/lorebook-bindings.js';
import { importLorebookBundle, exportLorebookBundle } from '../src/core/lorebook-bundle.js';
import { offerLorebookPresets } from '../src/core/initialization-engine.js';
import { addPresetToChat, getPresetsForChat } from '../src/core/preset-manager.js';
import { registerNamespaces } from './harness/namespaces.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

let counter = 0;
function makePreset(name, variables = {}) {
    const id = `gap-preset-${++counter}`;
    const vars = {};
    for (const [varId, def] of Object.entries(variables)) vars[varId] = { id: varId, type: 'number', defaultValue: 0, ...def };
    getSettings().presets[id] = { id, name, namespace: 'se', description: '', triggers: ['ai'], showInTracker: false, variables: vars };
    return id;
}

const extras = ['getWorldInfoNames', 'loadWorldInfo', 'saveWorldInfo', 'updateWorldInfoList', 'chatMetadata', 'characters', 'characterId', 'groupId', 'groups'];
beforeEach(() => {
    settings.reset();
    for (const k of extras) delete context[k];
    Object.assign(globalThis, { window: globalThis, confirm: vi.fn(() => true) });
    globalThis.window.confirm = vi.fn(() => true);
    context.saveSettingsDebounced.mockClear();
});
afterEach(() => { for (const k of extras) delete context[k]; });

// A chat with a number variable `hp` (id "v-hp") = 5.
function chatWithHp(value = 5) {
    const presetId = makePreset('Story', { 'v-hp': { name: 'se__hp' } });
    addPresetToChat('chat-1', presetId);
    context.variables.local.set('se__hp', value);
    return presetId;
}
const payload = () => ({
    globalLore: [{ uid: 1, world: 'Book' }, { uid: 2, world: 'Book' }, { uid: 3, world: 'Book' }],
    characterLore: [{ uid: 4, world: 'Book' }],
});
const hide = (key) => wi.setWICondition(key, { variable: 'v-hp', operator: 'greater_than', value: '100' }); // 5 > 100: unmet

// ---------------------------------------------------------------------------

describe('1. "Enable State Engine" guards the filter', () => {
    beforeEach(() => { chatWithHp(); hide('Book.1'); });

    it('enabled: the entry is removed', () => {
        const data = payload();
        expect(filterLoadedWorldInfo(data)).toBe(1);
        expect(data.globalLore.map((e) => e.uid)).toEqual([2, 3]);
    });

    it('disabled: nothing is removed - every entry passes through untouched', () => {
        getSettings().enabled = false;
        const data = payload();
        const before = JSON.stringify(data);
        expect(filterLoadedWorldInfo(data)).toBe(0);
        expect(JSON.stringify(data)).toBe(before);
    });

    it('switching it off and on again follows immediately (no reload)', () => {
        getSettings().enabled = false;
        expect(filterLoadedWorldInfo(payload())).toBe(0);
        getSettings().enabled = true;
        expect(filterLoadedWorldInfo(payload())).toBe(1);
    });

    it('a settings blob with no "enabled" value counts as enabled (the default)', () => {
        delete context.extensionSettings.state_engine.enabled;
        expect(filterLoadedWorldInfo(payload())).toBe(1);
    });

    it('the hook is still registered (guarded, not removed)', () => {
        expect(read('src', 'events', 'event-engine.js')).toContain('eventTypes.WORLDINFO_ENTRIES_LOADED');
        expect(read('src', 'world-info', 'wi-filtering.js')).toMatch(/if \(!getSettings\(\)\.enabled\) return 0;/);
    });
});

describe('2. a malformed condition list only affects its own entry', () => {
    beforeEach(() => { chatWithHp(); });

    it.each([['a string', 'corrupt'], ['a number', 42], ['an object', { a: 1 }], ['true', true]])('%s: that entry is kept, the others are still filtered', (_l, bad) => {
        getSettings().wiConditions['Book.1'] = bad;   // malformed - listed FIRST in the payload
        hide('Book.2');                                // a normal unmet condition after it
        hide('Book.4');                                // and one in another list
        const data = payload();
        expect(filterLoadedWorldInfo(data)).toBe(2);
        expect(data.globalLore.map((e) => e.uid)).toEqual([1, 3]);
        expect(data.characterLore).toEqual([]);
    });

    it('logs a warning naming the entry, and fails open for it', () => {
        getSettings().wiConditions['Book.1'] = 'corrupt';
        console.warn.mockClear();
        expect(wi.shouldDisplayWIEntry('Book.1')).toBe(true);
        const logged = console.warn.mock.calls.flat().join(' ');
        expect(logged).toContain('[State Engine]');
        expect(logged).toContain('Book.1');
        expect(logged).toContain('malformed');
    });

    it('a malformed condition INSIDE a list is treated as met and the rest of the list still applies', () => {
        getSettings().wiConditions['Book.1'] = [null, 'x', 5, { variable: 'v-hp', operator: 'greater_than', value: '100' }];
        expect(wi.shouldDisplayWIEntry('Book.1')).toBe(false); // the real, unmet one still hides it
        getSettings().wiConditions['Book.2'] = [null, 'x', 5];
        expect(wi.shouldDisplayWIEntry('Book.2')).toBe(true);
    });

    it('an evaluation that throws is logged and the entry is shown', () => {
        const boom = { get variable() { throw new Error('boom'); }, operator: 'equals', value: '1' };
        getSettings().wiConditions['Book.1'] = [boom];
        console.warn.mockClear();
        expect(wi.shouldDisplayWIEntry('Book.1')).toBe(true);
        expect(console.warn).toHaveBeenCalled();
    });

    it('an entry that cannot even be keyed is kept and the pass continues', () => {
        hide('Book.2');
        const data = { globalLore: [null, undefined, { uid: 2, world: 'Book' }, 7], characterLore: [] };
        expect(() => filterLoadedWorldInfo(data)).not.toThrow();
        expect(data.globalLore.some((e) => e && e.uid === 2)).toBe(false);
    });
});

// ---------------------------------------------------------------------------

describe('3. the WI editor escapes everything it renders', () => {
    const EVIL = '<img src=x onerror=alert(1)>"\'&<script>';

    it('escapeText covers & < > " \'', () => {
        expect(editor.escapeText('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
        expect(editor.escapeText(null)).toBe('');
        expect(editor.escapeText(undefined)).toBe('');
        expect(editor.escapeText(0)).toBe('0');            // not swallowed like a falsy value
        expect(editor.escapeText(false)).toBe('false');
    });

    it('a condition row cannot inject HTML through variable, operator, value or entry key', () => {
        const html = editor.conditionItemHtml({ variable: EVIL, operator: EVIL, value: EVIL }, 0, `Book"${EVIL}.1`);
        expect(html).not.toMatch(/<img/i);
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toContain('onerror=alert(1)>');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        // the attributes stay intact (a quote cannot end them early)
        expect(html.match(/data-entry-key="[^"]*"/g)).toHaveLength(2);
    });

    it('the variable dropdown escapes preset and variable names', () => {
        const html = editor.variableOptionsHtml([{ name: 'id"><b>', presetName: EVIL, variableName: EVIL }]);
        expect(html).not.toMatch(/<b>|<img|<script/i);
        expect(html).toContain('value="id&quot;&gt;&lt;b&gt;"');
    });

    it('numbers and zero are shown, not dropped', () => {
        expect(editor.conditionItemHtml({ variable: 'v', operator: 'equals', value: 0 }, 0, 'B.1')).toContain('<code>0</code>');
    });

    it('the source has no unescaped template for stored data (no raw ${cond.value} / ${v.name} left)', () => {
        const src = read('src', 'world-info', 'wi-condition-ui.js');
        expect(src).not.toMatch(/\$\{cond\.value\}/);
        expect(src).not.toMatch(/\$\{cond\.variable\}/);
        expect(src).not.toMatch(/\$\{v\.presetName\} \/ \$\{v\.name\}/);
    });
});

describe('4. arrays of objects cannot be turned into conditions', () => {
    const obj = { name: 'v', type: 'array', itemType: 'object' };

    it('no operator is offered (so no contains / index_eq / length)', () => {
        expect(editor.isObjectArray(obj)).toBe(true);
        expect(editor.operatorsFor(obj)).toEqual([]);
    });

    it('every other variable type keeps the operators it had', () => {
        expect(editor.operatorsFor(null)).toHaveLength(12);
        expect(editor.operatorsFor({ type: 'number' })).toHaveLength(12);
        expect(editor.operatorsFor({ type: 'array', itemType: 'string' }).map((o) => o.value)).toEqual(['contains', 'not_contains', 'length_gt', 'length_eq', 'index_eq']);
        expect(editor.operatorsFor({ type: 'array', itemType: 'enum' })).toHaveLength(5);
        expect(editor.operatorsFor({ type: 'array', itemType: 'any' }).map((o) => o.value)).toEqual(['contains', 'not_contains', 'length_gt', 'length_eq']);
        expect(editor.isObjectArray({ type: 'array', itemType: 'string' })).toBe(false);
        expect(editor.isObjectArray({ type: 'string', itemType: 'object' })).toBe(false);
    });

    it('the value field is DISABLED with an explanation, and still exists (so nothing reads through null)', () => {
        const src = read('src', 'world-info', 'wi-condition-ui.js');
        const branch = src.slice(src.indexOf('if (isObjectArray(varMeta)) {\n            valueContainer') >= 0 ? src.indexOf('if (isObjectArray(varMeta)) {\r\n            valueContainer') : 0);
        expect(src).toContain('id="se_wi_injected_cond_value" type="text" class="text_pole" style="font-size: 0.9em;" disabled');
        expect(src).toContain('Conditions on arrays of objects are not supported yet');
        expect(branch.length).toBeGreaterThan(0);
    });

    it('Save refuses an object array before reading the value, and the value read is null-safe', () => {
        const src = read('src', 'world-info', 'wi-condition-ui.js');
        const save = src.slice(src.indexOf('function handleWISaveCondition'));
        expect(save.indexOf('isObjectArray(varMeta)')).toBeGreaterThan(-1);
        expect(save.indexOf('isObjectArray(varMeta)')).toBeLessThan(save.indexOf("getElementById('se_wi_injected_cond_value')"));
        expect(save).toContain('valueEl && !valueEl.disabled ? valueEl.value');
        expect(save).not.toMatch(/getElementById\('se_wi_injected_cond_value'\)\.value/);
    });
});

describe('5. variable NAMES, not ids, in the editor', () => {
    it('getAvailableVariablesForConditions carries the name, and keeps the id as the stored key', () => {
        chatWithHp();
        const [v] = wi.getAvailableVariablesForConditions();
        expect(v.name).toBe('v-hp');            // what a condition stores (unchanged)
        expect(v.variableName).toBe('se__hp');  // what the editor shows
        expect(v.presetName).toBe('Story');
    });

    it('falls back to the label, then to the id', () => {
        const id = makePreset('P', { a: { name: '', label: 'Health' }, b: { name: '', label: '' } });
        addPresetToChat('chat-1', id);
        const byId = Object.fromEntries(wi.getAvailableVariablesForConditions().map((x) => [x.name, x.variableName]));
        expect(byId).toEqual({ a: 'Health', b: 'b' });
    });

    it('the dropdown reads "<preset> / <variable name>" and stores the id', () => {
        chatWithHp();
        const html = editor.variableOptionsHtml(wi.getAvailableVariablesForConditions());
        expect(html).toContain('<option value="v-hp">Story / se__hp</option>');
        expect(html).not.toContain('Story / v-hp');
    });

    it('the condition list shows the name too (unknown variables show as stored)', () => {
        const label = (v) => ({ 'v-hp': 'se__hp' })[v] ?? v;
        expect(editor.conditionItemHtml({ variable: 'v-hp', operator: 'equals', value: '1' }, 0, 'B.1', label)).toContain('<code>se__hp</code>');
        expect(editor.conditionItemHtml({ variable: 'gone', operator: 'equals', value: '1' }, 0, 'B.1', label)).toContain('<code>gone</code>');
    });
});

describe('6. editing a condition', () => {
    it('every row has an Edit button next to Delete, carrying its entry key and index', () => {
        const html = editor.conditionItemHtml({ variable: 'v', operator: 'equals', value: '1' }, 3, 'Book.7');
        expect(html).toMatch(/class="se-edit-injected-condition[^"]*" data-entry-key="Book.7" data-index="3"/);
        expect(html).toMatch(/class="se-delete-injected-condition[^"]*" data-entry-key="Book.7" data-index="3"/);
        expect(html.indexOf('se-edit-injected-condition')).toBeLessThan(html.indexOf('se-delete-injected-condition'));
    });

    it('saving while editing REPLACES the condition; otherwise it adds one', () => {
        const src = read('src', 'world-info', 'wi-condition-ui.js');
        expect(src).toContain('updateWICondition(entryKey, editingCondition.index, condition)');
        expect(src).toMatch(/if \(editingCondition && editingCondition\.entryKey === entryKey\) \{[\s\S]*updateWICondition[\s\S]*\} else \{\s*setWICondition\(entryKey, condition\)/);
        expect(src).toContain("editingCondition ? 'Save changes' : 'Add condition'");
        expect(src).toContain('.se-edit-injected-condition');
    });

    it('the update primitive replaces in place (same position, same count) and saves', () => {
        wi.setWICondition('B.1', { variable: 'a', operator: 'equals', value: '1' });
        wi.setWICondition('B.1', { variable: 'b', operator: 'equals', value: '2' });
        context.saveSettingsDebounced.mockClear();
        wi.updateWICondition('B.1', 0, { variable: 'a', operator: 'not_equals', value: '9' });
        expect(getSettings().wiConditions['B.1']).toEqual([
            { variable: 'a', operator: 'not_equals', value: '9' }, { variable: 'b', operator: 'equals', value: '2' }]);
        expect(context.saveSettingsDebounced).toHaveBeenCalled();
    });

    it('an index_eq value is split back into index and value for the form', () => {
        expect(editor.splitConditionValue('index_eq', '0:sword')).toEqual({ index: '0', value: 'sword' });
        expect(editor.splitConditionValue('index_eq', '2:a:b')).toEqual({ index: '2', value: 'a:b' });
        expect(editor.splitConditionValue('index_eq', 'nocolon')).toEqual({ index: '', value: 'nocolon' });
        expect(editor.splitConditionValue('equals', '0:sword')).toEqual({ index: '', value: '0:sword' });
        expect(editor.splitConditionValue('is_true', '')).toEqual({ index: '', value: '' });
    });

    it('cancelling, or deleting a condition of the entry being edited, abandons the edit', () => {
        const src = read('src', 'world-info', 'wi-condition-ui.js');
        expect(src).toMatch(/function handleWICancelCondition\(\) \{[\s\S]*editingCondition = null;/);
        expect(src).toMatch(/if \(editingCondition && editingCondition\.entryKey === entryKey\) handleWICancelCondition\(\);/);
    });
});

// ---------------------------------------------------------------------------

describe('7. declined activation prompts are cleared when they should be', () => {
    let a; let b;
    beforeEach(() => {
        a = makePreset('Alpha'); b = makePreset('Beta');
        context.chatMetadata = { world_info: 'Book' };
        bindings.bindPresetToLorebook('Book', 'Book', a);
        bindings.bindPresetToLorebook('Book', 'Book', b);
        window.confirm.mockReturnValue(false);
        offerLorebookPresets('chat-1');
        window.confirm.mockClear();
        window.confirm.mockReturnValue(true);
    });
    const declines = () => JSON.parse(JSON.stringify(getSettings().lorebookPresetDeclines));

    it('setup: the No was remembered and stops the prompt', () => {
        expect(declines()['chat-1']).toHaveLength(2);
        offerLorebookPresets('chat-1');
        expect(window.confirm).not.toHaveBeenCalled();
    });

    it('the Clear Declines button function forgets every decline in every chat', () => {
        getSettings().lorebookPresetDeclines['chat-2'] = ['Other|Other|x'];
        expect(bindings.clearLorebookPresetDeclines()).toBe(3);
        expect(declines()).toEqual({});
        offerLorebookPresets('chat-1');
        expect(window.confirm).toHaveBeenCalledTimes(1); // asked again
        expect(bindings.clearLorebookPresetDeclines()).toBe(0);
    });

    it('Clear Declines is in the settings panel and wired', () => {
        expect(read('settings.html')).toContain('id="se_lorebook_clear_declines"');
        expect(read('src', 'ui', 'lorebook-bindings-ui.js')).toContain("'#se_lorebook_clear_declines', clearDeclinesFromUI");
    });

    it('a binding change for the lorebook clears its declines (bind), but not another lorebook\'s', () => {
        getSettings().lorebookPresetDeclines['chat-1'].push('Other|Other|zzz');
        const c = makePreset('Gamma');
        bindings.bindPresetToLorebook('Book', 'Book', c);
        expect(declines()['chat-1']).toEqual(['Other|Other|zzz']);
    });

    it('unbinding clears them too', () => {
        bindings.unbindPresetFromLorebook('Book', 'Book', a);
        expect(declines()['chat-1']).toBeUndefined();
    });

    it('binding something already bound is not a change', () => {
        bindings.bindPresetToLorebook('Book', 'Book', a);
        expect(declines()['chat-1']).toHaveLength(2);
    });

    it('activating a declined preset yourself clears that decline (that chat, that preset)', () => {
        getSettings().lorebookPresetDeclines['chat-2'] = [`Book|Book|${a}`];
        addPresetToChat('chat-1', a);
        expect(declines()['chat-1']).toEqual([`Book|Book|${b}`]);
        expect(declines()['chat-2']).toEqual([`Book|Book|${a}`]); // another chat is untouched
    });

    it('a lorebook that is no longer attached to the chat takes its declines with it', () => {
        getSettings().lorebookPresetDeclines['chat-1'].push('Gone|Gone|p9');
        context.chatMetadata = { world_info: 'Book' };       // Book still attached, Gone is not
        offerLorebookPresets('chat-1');
        expect(declines()['chat-1']).toHaveLength(2);
        context.chatMetadata = {};                            // nothing attached any more
        offerLorebookPresets('chat-1');
        expect(declines()['chat-1']).toBeUndefined();
        // re-attaching it asks again
        context.chatMetadata = { world_info: 'Book' };
        offerLorebookPresets('chat-1');
        expect(window.confirm).toHaveBeenCalledTimes(1);
    });

    it('a corrupt decline entry does not break any of this', () => {
        getSettings().lorebookPresetDeclines['chat-9'] = 'junk';
        expect(() => bindings.clearDeclinesForPreset('chat-9', a)).not.toThrow();
        expect(() => bindings.pruneDeclinesForChat('chat-9', ['Book'])).not.toThrow();
        expect(() => bindings.clearLorebookPresetDeclines()).not.toThrow();
    });
});

// ---------------------------------------------------------------------------

describe('8. window.StateEngineWI checks who is calling', () => {
    let instanceId;
    beforeEach(() => {
        instanceId = ensureInstanceId();
        registerNamespaces('pp');
        context.loadWorldInfo = vi.fn(async () => null); // the bundle functions read the lorebook
    });

    const calls = {
        getWIConditions: (e, i) => StateEngineWI.getWIConditions(e, i, 'B.1'),
        setWICondition: (e, i) => StateEngineWI.setWICondition(e, i, 'B.1', { variable: 'x', operator: 'equals', value: '1' }),
        deleteWICondition: (e, i) => StateEngineWI.deleteWICondition(e, i, 'B.1', 0),
        shouldDisplayWIEntry: (e, i) => StateEngineWI.shouldDisplayWIEntry(e, i, 'B.1'),
        getPresetsForLorebook: (e, i) => StateEngineWI.getPresetsForLorebook(e, i, 'B', 'B'),
        bindPresetToLorebook: (e, i) => StateEngineWI.bindPresetToLorebook(e, i, 'B', 'B', 'nope'),
        unbindPresetFromLorebook: (e, i) => StateEngineWI.unbindPresetFromLorebook(e, i, 'B', 'B', 'nope'),
        exportPreset: (e, i) => StateEngineWI.exportPreset(e, i, 'nope'),
        importPreset: (e, i) => StateEngineWI.importPreset(e, i, {}),
        exportLorebookBundle: (e, i) => StateEngineWI.exportLorebookBundle(e, i, 'B', 'B'),
        importLorebookBundle: (e, i) => StateEngineWI.importLorebookBundle(e, i, null),
    };

    it('covers the whole public surface', () => {
        expect(Object.keys(calls).sort()).toEqual(Object.keys(StateEngineWI).sort());
    });

    for (const [name, call] of Object.entries(calls)) {
        it(`${name}: rejects a wrong or missing instanceId with the stateEngine.* error`, () => {
            for (const bad of ['not-the-instance', undefined, null, 42]) {
                expect(() => call('pp', bad)).toThrow('State Engine API call rejected: wrong instance');
            }
        });

        it(`${name}: rejects an unknown extension (owns no namespace)`, () => {
            expect(() => call('stranger', instanceId)).toThrow("Extension 'stranger' does not own a namespace - call createNamespace() first");
        });

        it(`${name}: a registered extension with the right instanceId is let through`, () => {
            expect(() => call('pp', instanceId)).not.toThrow();
            expect(() => call('se', instanceId)).not.toThrow();
        });
    }

    it('the async functions reject a bad caller SYNCHRONOUSLY, not with a promise', () => {
        let result;
        expect(() => { result = StateEngineWI.exportLorebookBundle('stranger', instanceId, 'B'); }).toThrow(/does not own a namespace/);
        expect(result).toBeUndefined();
        expect(() => StateEngineWI.importLorebookBundle('pp', 'bad', {})).toThrow(/wrong instance/);
    });

    it('a rejected call changes nothing', () => {
        expect(() => StateEngineWI.setWICondition('stranger', instanceId, 'B.1', { variable: 'x', operator: 'equals', value: '1' })).toThrow();
        expect(getSettings().wiConditions['B.1']).toBeUndefined();
    });

    it('it returns what the underlying function returns', () => {
        expect(StateEngineWI.setWICondition('pp', instanceId, 'B.1', { variable: 'x', operator: 'equals', value: '1' })).toBeUndefined();
        expect(StateEngineWI.getWIConditions('pp', instanceId, 'B.1')).toHaveLength(1);
        expect(StateEngineWI.shouldDisplayWIEntry('pp', instanceId, 'B.1')).toBe(true);
    });
});

// ---------------------------------------------------------------------------

describe('9. shouldDisplayWIEntry gives the filter\'s answer', () => {
    beforeEach(() => { chatWithHp(); });

    const cases = {
        'no conditions': [],
        'unmet condition': [{ variable: 'v-hp', operator: 'greater_than', value: '100' }],
        'met condition': [{ variable: 'v-hp', operator: 'less_than', value: '100' }],
        'missing variable': [{ variable: 'no-such-variable', operator: 'equals', value: 'x' }],
        'missing variable + unmet real one': [{ variable: 'no-such-variable', operator: 'equals', value: 'x' }, { variable: 'v-hp', operator: 'greater_than', value: '100' }],
        'missing variable + met real one': [{ variable: 'no-such-variable', operator: 'equals', value: 'x' }, { variable: 'v-hp', operator: 'less_than', value: '100' }],
        'unknown operator': [{ variable: 'v-hp', operator: 'bogus', value: '1' }],
        'invalid regex': [{ variable: 'v-hp', operator: 'regex', value: '([' }],
        'by variable name': [{ variable: 'se__hp', operator: 'greater_than', value: '100' }],
        'malformed list': 'junk',
        'malformed condition': [null, 5],
        'no operator': [{ variable: 'v-hp', value: '1' }],
    };

    it.each(Object.entries(cases))('%s: same answer from the filter and from shouldDisplayWIEntry', (_name, conds) => {
        getSettings().wiConditions['Book.1'] = conds;
        const data = { globalLore: [{ uid: 1, world: 'Book' }] };
        const removed = filterLoadedWorldInfo(data);
        expect(wi.shouldDisplayWIEntry('Book.1')).toBe(removed === 0);
    });

    it('the expected answers', () => {
        const shown = (conds) => { getSettings().wiConditions['Book.9'] = conds; return wi.shouldDisplayWIEntry('Book.9'); };
        expect(shown(cases['no conditions'])).toBe(true);
        expect(shown(cases['unmet condition'])).toBe(false);
        expect(shown(cases['met condition'])).toBe(true);
        expect(shown(cases['missing variable'])).toBe(true);                    // fail open
        expect(shown(cases['missing variable + unmet real one'])).toBe(false);  // the real one still applies
        expect(shown(cases['missing variable + met real one'])).toBe(true);
        expect(shown(cases['unknown operator'])).toBe(true);                    // fail open
        expect(shown(cases['invalid regex'])).toBe(true);                       // fail open
        expect(shown(cases['by variable name'])).toBe(false);
        expect(shown(cases['malformed list'])).toBe(true);
    });

    it('with the preset inactive its variable is "missing": shown', () => {
        getSettings().wiConditions['Book.1'] = cases['unmet condition'];
        expect(wi.shouldDisplayWIEntry('Book.1')).toBe(false);
        getSettings().chatPresetBindings['chat-1'].presetIds = [];
        expect(wi.shouldDisplayWIEntry('Book.1')).toBe(true);
    });

    it('errors are logged, never thrown', () => {
        getSettings().wiConditions['Book.1'] = 'junk';
        console.warn.mockClear();
        expect(() => wi.shouldDisplayWIEntry('Book.1')).not.toThrow();
        expect(console.warn).toHaveBeenCalled();
        expect(() => wi.shouldDisplayWIEntry(undefined)).not.toThrow();
        expect(wi.shouldDisplayWIEntry(undefined)).toBe(true);
    });

    it('works with no chat open', () => {
        context.chatId = undefined;
        getSettings().wiConditions['Book.1'] = cases['unmet condition'];
        expect(() => wi.shouldDisplayWIEntry('Book.1')).not.toThrow();
    });

    it('the operator table is untouched (spot check of the operators it defines)', () => {
        const src = read('src', 'world-info', 'wi-conditions.js');
        for (const op of ['equals', 'not_equals', 'greater_than', 'less_than', 'greater_or_equal', 'less_or_equal', 'contains', 'not_contains', 'length_gt', 'length_eq', 'index_eq', 'regex', 'in_list', 'is_true', 'is_false']) {
            expect(src, op).toContain(`'${op}':`);
        }
    });
});

// ---------------------------------------------------------------------------

describe('10.1 world names are normalised everywhere', () => {
    it('one shared definition, re-exported', () => {
        expect(wi.normalizeWorldName({ book: 'B' })).toBe('B');
        expect(read('src', 'world-info', 'wi-conditions.js')).toContain("export { normalizeWorldName };");
        expect(read('src', 'world-info', 'world-names.js')).toContain('entry?.world || entry?.book || entry?.folder');
    });

    it('bindings: a blank / missing world is "default", names are trimmed', () => {
        const id = makePreset('P');
        expect(bindings.bindPresetToLorebook('', '', id)).toBe(true);
        expect(getSettings().lorebookPresetBindings).toEqual({ default: { default: [id] } });
        expect(bindings.getPresetsForLorebook(undefined, undefined)).toEqual([id]);
        expect(bindings.getPresetsForLorebook('default')).toEqual([id]);
        expect(bindings.bindPresetToLorebook('  Book  ', undefined, id)).toBe(true);
        expect(getSettings().lorebookPresetBindings.Book.Book).toEqual([id]);
    });

    it('no place still hand-builds a key from entry.world / entry.book', () => {
        for (const file of ['wi-filtering.js', 'wi-manager-ui.js', 'wi-condition-ui.js', 'wi-conditions.js']) {
            expect(read('src', 'world-info', file), file).not.toMatch(/entry\.world \|\| entry\.book/);
        }
        for (const file of ['wi-filtering.js', 'wi-manager-ui.js', 'wi-condition-ui.js']) {
            expect(read('src', 'world-info', file), file).not.toContain("|| 'unknown'"); // the old world fallback
        }
    });
});

describe('10.2 - 10.5 bundle import leaves nothing dangling, export leaves out empties', () => {
    const LOREBOOK = { entries: { 1: { uid: 1 }, 2: { uid: 2 } } };
    const preset = (name, vars) => ({ id: name, name, namespace: 'se', description: '', triggers: ['ai'], variables: vars });
    const V = (id, name) => ({ id, name, type: 'number', defaultValue: 0 });

    let bundle;
    beforeEach(() => {
        context.getWorldInfoNames = () => [];
        context.saveWorldInfo = vi.fn(async () => {});
        context.updateWorldInfoList = vi.fn(async () => {});
        context.loadWorldInfo = vi.fn(async () => JSON.parse(JSON.stringify(LOREBOOK)));
        bundle = {
            lorebook: LOREBOOK, lorebookName: 'Imp',
            stateEngine: {
                presets: {
                    pBound: preset('Bound', { vb: V('vb', 'se__bound') }),
                    pUsed: preset('UsedByCondition', { vu: V('vu', 'se__used') }),
                    pLoose: preset('Loose', { vl: V('vl', 'se__loose') }),
                },
                wiConditions: {
                    'Imp.1': [{ variable: 'vb', operator: 'equals', value: '1' }],
                    'Imp.2': [{ variable: 'vu', operator: 'equals', value: '2' }],
                },
                lorebookPresetBindings: { Imp: { Imp: ['pBound'] } },
            },
        };
    });
    const namesOfPresets = () => Object.values(getSettings().presets).map((p) => p.name).sort();

    it('the presets: bound + condition-referenced are imported; a loose one is not', async () => {
        const result = await importLorebookBundle(bundle);
        expect(namesOfPresets()).toEqual(['Bound', 'UsedByCondition']);
        expect(result.skipped.presets).toBe(1);
    });

    it('the bindings: only the bound preset, and only to presets that exist here', async () => {
        const result = await importLorebookBundle(bundle);
        const bound = getSettings().lorebookPresetBindings.Imp.Imp;
        expect(bound).toHaveLength(1);
        expect(getSettings().presets[bound[0]].name).toBe('Bound');
        expect(result.boundPresetIds).toEqual(bound);
        for (const id of bound) expect(getSettings().presets[id]).toBeDefined();
    });

    it('the conditions: kept, on existing entries, pointing at imported variables', async () => {
        await importLorebookBundle(bundle);
        const c1 = getSettings().wiConditions['Imp.1'][0];
        const owner = Object.values(getSettings().presets).find((p) => p.variables[c1.variable]);
        expect(owner.name).toBe('Bound');
    });

    it('a condition for an entry the lorebook does not have is dropped', async () => {
        bundle.stateEngine.wiConditions['Imp.99'] = [{ variable: 'vb', operator: 'equals', value: '1' }];
        const result = await importLorebookBundle(bundle);
        expect(getSettings().wiConditions['Imp.99']).toBeUndefined();
        expect(result.skipped.conditions).toBe(1);
    });

    it('a condition on a variable that exists nowhere is dropped, not stored dangling', async () => {
        bundle.stateEngine.wiConditions['Imp.1'].push({ variable: 'ghost-variable', operator: 'equals', value: '1' });
        const result = await importLorebookBundle(bundle);
        expect(getSettings().wiConditions['Imp.1']).toHaveLength(1);
        expect(result.skipped.conditions).toBe(1);
    });

    it('a preset used only by a DROPPED condition is not imported', async () => {
        bundle.stateEngine.wiConditions['Imp.2'] = undefined;                                   // no longer used
        bundle.stateEngine.wiConditions['Imp.77'] = [{ variable: 'vu', operator: 'equals', value: '2' }]; // entry missing
        await importLorebookBundle(bundle);
        expect(namesOfPresets()).toEqual(['Bound']);
        expect(getSettings().wiConditions['Imp.77']).toBeUndefined();
    });

    it('a condition on a variable this install already has is kept (no bundled preset needed)', async () => {
        const existing = makePreset('Mine', { 'my-var': { name: 'se__mine' } });
        bundle.stateEngine = { wiConditions: { 'Imp.1': [{ variable: 'my-var', operator: 'equals', value: '1' }] } };
        const result = await importLorebookBundle(bundle);
        expect(getSettings().wiConditions['Imp.1']).toEqual([{ variable: 'my-var', operator: 'equals', value: '1' }]);
        expect(getSettings().presets[existing]).toBeDefined();
        expect(result.skipped).toEqual({ conditions: 0, presets: 0 });
    });

    it('a binding to a preset that is not in the bundle creates no binding', async () => {
        bundle.stateEngine.lorebookPresetBindings = { Imp: { Imp: ['not-in-bundle'] } };
        await importLorebookBundle(bundle);
        expect(getSettings().lorebookPresetBindings.Imp).toBeUndefined();
    });

    it('a corrupt preset in the bundle is skipped and does not become a binding', async () => {
        bundle.stateEngine.presets.pBound = { name: 'Broken' };   // no variables
        await importLorebookBundle(bundle);
        expect(getSettings().lorebookPresetBindings.Imp).toBeUndefined();
        expect(namesOfPresets()).not.toContain('Broken');
    });

    it('pre-existing dangling ids in the merged binding are cleaned up', async () => {
        getSettings().lorebookPresetBindings.Imp = { Imp: ['deleted-long-ago'] };
        await importLorebookBundle(bundle);
        expect(getSettings().lorebookPresetBindings.Imp.Imp).not.toContain('deleted-long-ago');
    });

    it('a bundle with nothing State Engine-related imports just the lorebook', async () => {
        const result = await importLorebookBundle({ lorebook: LOREBOOK, lorebookName: 'Plain' });
        expect(result).toMatchObject({ lorebook: 'Plain', conditions: 0, boundPresetIds: [] });
        expect(Object.keys(getSettings().presets)).toHaveLength(0);
        expect(getSettings().wiConditions).toEqual({});
    });

    it('running it twice creates nothing new the second time', async () => {
        await importLorebookBundle(bundle);
        const snapshot = JSON.stringify([getSettings().presets, getSettings().wiConditions, getSettings().lorebookPresetBindings]);
        await importLorebookBundle(bundle);
        expect(JSON.stringify([getSettings().presets, getSettings().wiConditions, getSettings().lorebookPresetBindings])).toBe(snapshot);
    });

    describe('export leaves out empties', () => {
        beforeEach(() => { context.loadWorldInfo = vi.fn(async () => JSON.parse(JSON.stringify(LOREBOOK))); });

        it('nothing tied to the lorebook: an empty stateEngine block', async () => {
            expect((await exportLorebookBundle('Book', 'Book')).stateEngine).toEqual({});
        });

        it('an empty condition list is not exported; a real one is', async () => {
            getSettings().wiConditions['Book.1'] = [];
            expect((await exportLorebookBundle('Book', 'Book')).stateEngine).toEqual({});
            getSettings().wiConditions['Book.2'] = [{ variable: 'x', operator: 'equals', value: '1' }];
            expect(Object.keys((await exportLorebookBundle('Book', 'Book')).stateEngine)).toEqual(['wiConditions']);
        });

        it('a binding whose presets were all deleted is not exported', async () => {
            getSettings().lorebookPresetBindings = { Book: { Book: ['deleted'] } };
            expect((await exportLorebookBundle('Book', 'Book')).stateEngine).toEqual({});
        });

        it('with a bound preset: presets and the binding appear, and no empty conditions', async () => {
            const id = makePreset('P');
            bindings.bindPresetToLorebook('Book', 'Book', id);
            const se = (await exportLorebookBundle('Book', 'Book')).stateEngine;
            expect(Object.keys(se).sort()).toEqual(['lorebookPresetBindings', 'presets']);
            expect(se.lorebookPresetBindings).toEqual({ Book: { Book: [id] } });
        });

        it('what export leaves out, import copes with', async () => {
            const b = await exportLorebookBundle('Book', 'Book');
            context.getWorldInfoNames = () => [];
            context.saveWorldInfo = vi.fn(async () => {});
            expect(await importLorebookBundle(b)).toMatchObject({ lorebook: 'Book', conditions: 0 });
        });
    });
});

describe('10.6 dark-theme contrast for the injected editor', () => {
    const css = read('style.css');
    const ui = read('src', 'world-info', 'wi-condition-ui.js');

    it('no fixed light backgrounds are left in the injected markup', () => {
        expect(ui).not.toContain('rgba(255,255,255');
        expect(ui).not.toContain('rgba(255, 255, 255');
        expect(ui).toContain('class="se-wi-injected-conditions se-wi-box"');
        expect(ui).toContain('class="se-wi-editor"');
    });

    it('the boxes take their colours from SillyTavern\'s theme variables', () => {
        for (const cls of ['.se-wi-box', '.se-wi-editor', '.se-wi-condition-item']) {
            const rule = css.slice(css.indexOf(`${cls} {`), css.indexOf('}', css.indexOf(`${cls} {`)));
            expect(rule, cls).toContain('var(--SmartThemeBodyColor');
            expect(rule, cls).toContain('var(--black30a');
        }
        for (const cls of ['.se-wi-editor', '.se-wi-condition-item']) {
            const rule = css.slice(css.indexOf(`${cls} {`), css.indexOf('}', css.indexOf(`${cls} {`)));
            expect(rule, cls).toContain('var(--SmartThemeBorderColor');
        }
    });
});

describe('tester round 1: datetime conditions take a date, array items with colons', () => {
    it('a datetime condition is written as a date and compared as seconds', () => {
        const presetId = makePreset('Clock', { 'v-when': { name: 'se__when', type: 'datetime', calendar: 'gregorian', defaultValue: 0 } });
        addPresetToChat('chat-1', presetId);
        const seconds = (text) => Date.UTC(...text.split(/[- :]/).map((n, i) => (i === 1 ? Number(n) - 1 : Number(n)))) / 1000;
        context.variables.local.set('se__when', seconds('2022-05-11 12:00:00'));

        expect(wi.evaluateCondition('v-when', 'greater_than', '2022-05-11 00:00:00')).toBe(true);
        expect(wi.evaluateCondition('v-when', 'less_than', '2022-05-11 00:00:00')).toBe(false);
        expect(wi.evaluateCondition('v-when', 'equals', '2022-05-11 12:00:00')).toBe(true);
        expect(wi.evaluateCondition('v-when', 'greater_or_equal', '2022-05-11')).toBe(true);
        // plain seconds still work
        expect(wi.evaluateCondition('v-when', 'greater_than', String(seconds('2022-05-11 00:00:00')))).toBe(true);
    });

    it('the editor offers a date box for datetime variables and rejects a non-date', () => {
        expect(editor.isDatetimeDateOperator({ type: 'datetime' }, 'greater_than')).toBe(true);
        expect(editor.isDatetimeDateOperator({ type: 'datetime' }, 'regex')).toBe(false);
        expect(editor.isDatetimeDateOperator({ type: 'number' }, 'greater_than')).toBe(false);
    });

    it('index_eq compares an item that itself contains a colon (0:a:b)', () => {
        const presetId = makePreset('Bag', { 'v-inv': { name: 'se__inv', type: 'array', itemType: 'string', defaultValue: [] } });
        addPresetToChat('chat-1', presetId);
        context.variables.local.set('se__inv', ['a:b', 'c']);
        expect(wi.evaluateCondition('v-inv', 'index_eq', '0:a:b')).toBe(true);
        expect(wi.evaluateCondition('v-inv', 'index_eq', '1:a:b')).toBe(false);
    });

    it('a condition that names the variable (not its id) reads the right variable', () => {
        chatWithHp(20);
        expect(wi.evaluateCondition('se__hp', 'greater_than', '10')).toBe(true);
        expect(wi.evaluateCondition('se__hp', 'greater_than', '30')).toBe(false);
    });
});

describe('tester round 1: a character\'s additional lorebooks are seen', () => {
    it('getActiveLorebookNames includes world_info.charLore extraBooks for the current character', () => {
        context.characters = [{ avatar: 'Ann.png', data: { extensions: { world: 'Primary' } } }];
        context.characterId = 0;
        bindings.setStWorldInfoModuleForTests({ world_info: { charLore: [{ name: 'Ann', extraBooks: ['Extra1', 'Extra2'] }, { name: 'Bob', extraBooks: ['Nope'] }] } });
        expect(bindings.getActiveLorebookNames().sort()).toEqual(['Extra1', 'Extra2', 'Primary']);
        bindings.setStWorldInfoModuleForTests(null);
        expect(bindings.getActiveLorebookNames()).toEqual(['Primary']);
    });
});

describe('every kind of attached lorebook is seen', () => {
    it('chat lore, character lore (primary + additional), persona lore and global lore', () => {
        context.chatMetadata = { world_info: 'ChatBook' };
        context.characters = [{ avatar: 'Ann.png', data: { extensions: { world: 'Primary' } } }];
        context.characterId = 0;
        context.powerUserSettings = { persona_description_lorebook: 'PersonaBook' };
        bindings.setStWorldInfoModuleForTests({ world_info: { charLore: [{ name: 'Ann', extraBooks: ['Extra'] }] } });
        expect(bindings.getActiveLorebookNames().sort()).toEqual(['ChatBook', 'Extra', 'PersonaBook', 'Primary']);
        bindings.setStWorldInfoModuleForTests(null);
        delete context.powerUserSettings;
    });
});
