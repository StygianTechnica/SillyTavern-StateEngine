import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { ensureInstanceId } from '../src/api/identity.js';
import * as wiConditions from '../src/world-info/wi-conditions.js';
import { filterLoadedWorldInfo } from '../src/world-info/wi-filtering.js';
import * as bindings from '../src/core/lorebook-bindings.js';
import { exportPreset, importPreset, importPresetDetailed } from '../src/core/preset-export.js';
import { exportLorebookBundle, importLorebookBundle } from '../src/core/lorebook-bundle.js';
import { offerLorebookPresets } from '../src/core/initialization-engine.js';
import { addPresetToChat, getPresetsForChat } from '../src/core/preset-manager.js';
import { StateEngineWI, exposeStateEngineWI } from '../src/world-info/wi-api.js';
import * as bindingsUi from '../src/ui/lorebook-bindings-ui.js';
import * as uiTemplates from '../src/ui/manager-modal/ui-templates.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');
const saves = () => context.saveSettingsDebounced.mock.calls.length;

// A preset with variables straight into settings (the harness's preset-manager
// mock has no variable editing).
let counter = 0;
function makePreset(name, variables = {}, extra = {}) {
    const id = `preset-${++counter}`;
    const vars = {};
    for (const [varId, def] of Object.entries(variables)) vars[varId] = { id: varId, type: 'number', defaultValue: 0, ...def };
    getSettings().presets[id] = { id, name, namespace: 'se', description: '', triggers: ['ai'], showInTracker: false, variables: vars, ...extra };
    return id;
}
const activate = (chatId, presetId) => addPresetToChat(chatId, presetId);

const extras = ['getWorldInfoNames', 'loadWorldInfo', 'saveWorldInfo', 'updateWorldInfoList', 'chatMetadata', 'characters', 'characterId', 'groupId', 'groups'];
beforeEach(() => {
    settings.reset();
    for (const k of extras) delete context[k];
    vi.stubGlobal('window', Object.assign(globalThis, { confirm: vi.fn(() => true) }));
    context.saveSettingsDebounced.mockClear();
});
afterEach(() => { for (const k of extras) delete context[k]; });

// ---------------------------------------------------------------------------

describe('WI conditions persist', () => {
    const cond = { variable: 'v1', operator: 'equals', value: '1' };

    it('setWICondition / updateWICondition / deleteWICondition / clearWIConditionsForEntry each save', () => {
        let before = saves();
        wiConditions.setWICondition('Book.1', cond);
        expect(saves()).toBe(before + 1);

        before = saves();
        wiConditions.updateWICondition('Book.1', 0, { ...cond, value: '2' });
        expect(saves()).toBe(before + 1);
        expect(getSettings().wiConditions['Book.1'][0].value).toBe('2');

        wiConditions.setWICondition('Book.1', cond);
        before = saves();
        wiConditions.deleteWICondition('Book.1', 0);
        expect(saves()).toBe(before + 1);
        expect(getSettings().wiConditions['Book.1']).toHaveLength(1);

        before = saves();
        wiConditions.clearWIConditionsForEntry('Book.1');
        expect(saves()).toBe(before + 1);
        expect(getSettings().wiConditions['Book.1']).toBeUndefined();
    });

    it('a call that changes nothing does not save', () => {
        const before = saves();
        wiConditions.updateWICondition('Nope.1', 0, cond);
        wiConditions.deleteWICondition('Nope.1', 0);
        wiConditions.clearWIConditionsForEntry('Nope.1');
        expect(saves()).toBe(before);
    });

    it('what is saved is what the settings blob holds', () => {
        wiConditions.setWICondition('Book.7', cond);
        expect(settings.snapshot().wiConditions['Book.7']).toEqual([cond]);
    });
});

describe('world name normalisation', () => {
    it('normalizeWorldName: world, then book, then folder, then "default"', () => {
        expect(wiConditions.normalizeWorldName({ world: 'W', book: 'B', folder: 'F' })).toBe('W');
        expect(wiConditions.normalizeWorldName({ book: 'B', folder: 'F' })).toBe('B');
        expect(wiConditions.normalizeWorldName({ folder: 'F' })).toBe('F');
        expect(wiConditions.normalizeWorldName({})).toBe('default');
        expect(wiConditions.normalizeWorldName(undefined)).toBe('default');
        expect(wiConditions.normalizeWorldName({ world: '' })).toBe('default');
    });

    it('every entry key is built from it', () => {
        expect(wiConditions.makeWIEntryKeyForEntry({ world: 'W', uid: 4 })).toBe('W.4');
        expect(wiConditions.makeWIEntryKeyForEntry({ book: 'B', uid: 4 })).toBe('B.4');
        expect(wiConditions.makeWIEntryKeyForEntry({ uid: 4 })).toBe('default.4');
        for (const file of ['wi-filtering.js', 'wi-manager-ui.js']) {
            expect(read('src', 'world-info', file), file).not.toMatch(/entry\.world \|\| entry\.book \|\| 'unknown'/);
        }
    });

    it('conditions saved under the old "unknown" world still apply to a world-less entry, and can be edited', () => {
        getSettings().wiConditions['unknown.9'] = [{ variable: 'x', operator: 'equals', value: '1' }];
        expect(wiConditions.getWIConditions('default.9')).toHaveLength(1);
        wiConditions.setWICondition('default.9', { variable: 'y', operator: 'equals', value: '2' });
        expect(getSettings().wiConditions['unknown.9']).toHaveLength(2);
        expect(getSettings().wiConditions['default.9']).toBeUndefined();
        wiConditions.deleteWICondition('default.9', 0);
        wiConditions.deleteWICondition('default.9', 0);
        expect(getSettings().wiConditions['unknown.9']).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------

describe('conditional filtering', () => {
    let presetId;
    beforeEach(() => {
        presetId = makePreset('Story', { 'var-mood': { name: 'se__mood', type: 'number' } });
        activate('chat-1', presetId);
        context.variables.local.set('se__mood', 5);
    });

    const payload = () => ({
        globalLore: [{ uid: 1, world: 'Book' }, { uid: 2, world: 'Book' }],
        characterLore: [{ uid: 3, world: 'Book' }],
        chatLore: [{ uid: 4, book: 'Other' }],
        personaLore: [{ uid: 5 }],
    });

    it('removes entries whose conditions are not met, from every lore list, in place', () => {
        wiConditions.setWICondition('Book.1', { variable: 'var-mood', operator: 'greater_than', value: '10' }); // 5 > 10: no
        wiConditions.setWICondition('Book.2', { variable: 'var-mood', operator: 'greater_than', value: '1' });  // yes
        wiConditions.setWICondition('Book.3', { variable: 'var-mood', operator: 'less_than', value: '1' });     // no
        wiConditions.setWICondition('Other.4', { variable: 'var-mood', operator: 'equals', value: '9' });       // no (book name)
        wiConditions.setWICondition('default.5', { variable: 'var-mood', operator: 'equals', value: '5' });     // yes (no world)

        const data = payload();
        const globalRef = data.globalLore;
        expect(filterLoadedWorldInfo(data)).toBe(3);

        expect(data.globalLore.map((e) => e.uid)).toEqual([2]);
        expect(data.characterLore).toEqual([]);
        expect(data.chatLore).toEqual([]);
        expect(data.personaLore.map((e) => e.uid)).toEqual([5]);
        expect(data.globalLore).toBe(globalRef); // the SAME array - SillyTavern reads it after the event
    });

    it('entries with no conditions are untouched', () => {
        const data = payload();
        expect(filterLoadedWorldInfo(data)).toBe(0);
        expect(data.globalLore).toHaveLength(2);
    });

    it('a condition on a variable that no active preset defines is fail-open (met)', () => {
        wiConditions.setWICondition('Book.1', { variable: 'var-from-a-declined-preset', operator: 'equals', value: 'never' });
        const data = payload();
        expect(filterLoadedWorldInfo(data)).toBe(0);
        expect(data.globalLore.map((e) => e.uid)).toEqual([1, 2]);
    });

    it('with the preset inactive, its conditions no longer hide anything', () => {
        wiConditions.setWICondition('Book.1', { variable: 'var-mood', operator: 'greater_than', value: '10' });
        const data = payload();
        expect(filterLoadedWorldInfo(data)).toBe(1);
        getSettings().chatPresetBindings['chat-1'].presetIds = [];
        const again = payload();
        expect(filterLoadedWorldInfo(again)).toBe(0);
    });

    it('a variable may be named by its id or its name in the condition', () => {
        wiConditions.setWICondition('Book.1', { variable: 'se__mood', operator: 'greater_than', value: '10' });
        expect(filterLoadedWorldInfo(payload())).toBe(1);
    });

    it('conditions saved under the legacy "unknown" world apply to a world-less entry', () => {
        getSettings().wiConditions['unknown.5'] = [{ variable: 'var-mood', operator: 'equals', value: '99' }];
        const data = payload();
        expect(filterLoadedWorldInfo(data)).toBe(1);
        expect(data.personaLore).toEqual([]);
    });

    it('never throws on odd payloads', () => {
        for (const bad of [undefined, null, 5, 'x', {}, { globalLore: 'nope' }, { globalLore: [null] }]) {
            expect(() => filterLoadedWorldInfo(bad)).not.toThrow();
        }
    });
});

describe('the filter is registered on an event that can filter', () => {
    const src = read('src', 'events', 'event-engine.js');
    it('registers filterLoadedWorldInfo on WORLDINFO_ENTRIES_LOADED, not the commented-out WORLD_INFO_ACTIVATED', () => {
        expect(src).toMatch(/eventSource\.on\(eventTypes\.WORLDINFO_ENTRIES_LOADED, \(payload\) => \{\s*filterLoadedWorldInfo\(payload\)/);
        const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
        expect(code).not.toContain('eventTypes.WORLD_INFO_ACTIVATED,');
        expect(code).not.toContain('applyWorldInfoConditionalFiltering');
    });

    it('offers the lorebook presets on chat change', () => {
        expect(src).toContain('offerLorebookPresets(chatId)');
    });
});

// ---------------------------------------------------------------------------

describe('lorebook -> preset bindings', () => {
    let a; let b;
    beforeEach(() => { a = makePreset('A'); b = makePreset('B'); });

    it('the setting exists by default and is repaired when missing or corrupt', () => {
        expect(getSettings().lorebookPresetBindings).toEqual({});
        expect(getSettings().lorebookPresetDeclines).toEqual({});
        getSettings().lorebookPresetBindings = 'junk';
        getSettings().lorebookPresetDeclines = [];
        expect(getSettings().lorebookPresetBindings).toEqual({});
        expect(getSettings().lorebookPresetDeclines).toEqual({});
        delete getSettings().lorebookPresetBindings;
        expect(getSettings().lorebookPresetBindings).toEqual({});
    });

    it('bind / get / unbind, with the { world: { lorebookId: [presetId] } } shape', () => {
        expect(bindings.getPresetsForLorebook('Book', 'Book')).toEqual([]);
        expect(bindings.bindPresetToLorebook('Book', 'Book', a)).toBe(true);
        expect(bindings.bindPresetToLorebook('Book', 'Book', b)).toBe(true);
        expect(bindings.bindPresetToLorebook('Book', 'Book', a)).toBe(true); // already bound
        expect(bindings.getPresetsForLorebook('Book', 'Book')).toEqual([a, b]);
        expect(getSettings().lorebookPresetBindings).toEqual({ Book: { Book: [a, b] } });
        expect(bindings.getLorebookBindings()).toEqual({ Book: { Book: [a, b] } });

        expect(bindings.unbindPresetFromLorebook('Book', 'Book', a)).toBe(true);
        expect(bindings.getPresetsForLorebook('Book', 'Book')).toEqual([b]);
        expect(bindings.unbindPresetFromLorebook('Book', 'Book', a)).toBe(false);
        bindings.unbindPresetFromLorebook('Book', 'Book', b);
        expect(getSettings().lorebookPresetBindings).toEqual({}); // empty containers are removed
    });

    it('binding and unbinding save; reads and no-ops do not', () => {
        let before = saves();
        bindings.bindPresetToLorebook('Book', 'Book', a);
        expect(saves()).toBe(before + 1);
        before = saves();
        bindings.bindPresetToLorebook('Book', 'Book', a);
        bindings.getPresetsForLorebook('Book', 'Book');
        bindings.getLorebookBindings();
        bindings.unbindPresetFromLorebook('Book', 'Book', 'nope');
        expect(saves()).toBe(before);
        bindings.unbindPresetFromLorebook('Book', 'Book', a);
        expect(saves()).toBe(before + 1);
        expect(settings.snapshot().lorebookPresetBindings).toEqual({});
    });

    it('refuses an unknown preset, defaults lorebookId to the world, and skips deleted presets', () => {
        expect(bindings.bindPresetToLorebook('Book', 'Book', 'ghost')).toBe(false);
        expect(bindings.bindPresetToLorebook('Book', undefined, a)).toBe(true);
        expect(getSettings().lorebookPresetBindings.Book.Book).toEqual([a]);
        expect(bindings.getPresetsForLorebook('Book')).toEqual([a]);
        delete getSettings().presets[a];
        expect(bindings.getPresetsForLorebook('Book', 'Book')).toEqual([]);
    });

    it('getLorebookBindings returns a copy', () => {
        bindings.bindPresetToLorebook('Book', 'Book', a);
        bindings.getLorebookBindings().Book.Book.push('x');
        expect(getSettings().lorebookPresetBindings.Book.Book).toEqual([a]);
    });

    it('lists lorebooks from SillyTavern plus the ones State Engine knows', () => {
        context.getWorldInfoNames = () => ['Zed', 'Alpha'];
        bindings.bindPresetToLorebook('Bound', 'Bound', a);
        wiConditions.setWICondition('Conds.3', { variable: 'x', operator: 'equals', value: '1' });
        expect(bindings.listLorebookNames()).toEqual(['Alpha', 'Bound', 'Conds', 'Zed']);
    });

    it('finds the lorebooks attached to the chat: chat, character and group members', () => {
        context.chatMetadata = { world_info: 'ChatBook' };
        context.characters = [{ avatar: 'a.png', data: { extensions: { world: 'CharBook' } } }, { avatar: 'b.png', data: { extensions: { world: 'MemberBook' } } }];
        context.characterId = 0;
        expect(bindings.getActiveLorebookNames().sort()).toEqual(['CharBook', 'ChatBook']);
        context.groupId = 'g1';
        context.groups = [{ id: 'g1', members: ['b.png'] }];
        expect(bindings.getActiveLorebookNames().sort()).toEqual(['ChatBook', 'MemberBook']);
    });
});

// ---------------------------------------------------------------------------

describe('auto-activating bound presets when a chat loads', () => {
    let a; let b;
    beforeEach(() => {
        a = makePreset('Alpha'); b = makePreset('Beta');
        context.chatMetadata = { world_info: 'Book' };
        bindings.bindPresetToLorebook('Book', 'Book', a);
        bindings.bindPresetToLorebook('Book', 'Book', b);
        addPresetToChat.mockClear();
    });

    it('asks once, naming the lorebook and presets; Yes activates them', () => {
        expect(offerLorebookPresets('chat-1')).toEqual([a, b]);
        expect(window.confirm).toHaveBeenCalledTimes(1);
        expect(window.confirm.mock.calls[0][0]).toBe('This lorebook ("Book") requires the presets Alpha, Beta. Activate them?');
        expect(addPresetToChat).toHaveBeenCalledWith('chat-1', a);
        expect(getPresetsForChat('chat-1')).toEqual([a, b]);
    });

    it('No activates nothing, and the question is not repeated for that chat', () => {
        window.confirm.mockReturnValue(false);
        expect(offerLorebookPresets('chat-1')).toEqual([]);
        expect(getPresetsForChat('chat-1')).toEqual([]);
        expect(settings.snapshot().lorebookPresetDeclines['chat-1']).toHaveLength(2);
        offerLorebookPresets('chat-1');
        expect(window.confirm).toHaveBeenCalledTimes(1);
        // another chat is asked afresh
        offerLorebookPresets('chat-2');
        expect(window.confirm).toHaveBeenCalledTimes(2);
    });

    it('only the presets that are not already active are asked about', () => {
        activate('chat-1', a);
        offerLorebookPresets('chat-1');
        expect(window.confirm.mock.calls[0][0]).toContain('presets Beta.');
        expect(getPresetsForChat('chat-1')).toEqual([a, b]);
    });

    it('does not ask when everything is active, when no lorebook is bound, or without a chat', () => {
        activate('chat-1', a); activate('chat-1', b);
        offerLorebookPresets('chat-1');
        context.chatMetadata = { world_info: 'Unbound' };
        offerLorebookPresets('chat-2');
        offerLorebookPresets(undefined);
        expect(window.confirm).not.toHaveBeenCalled();
    });

    it('asks per lorebook, and one lorebook\'s No does not lose the other\'s', () => {
        const c = makePreset('Gamma');
        context.chatMetadata = { world_info: 'Book' };
        context.characters = [{ data: { extensions: { world: 'Book2' } } }];
        context.characterId = 0;
        bindings.bindPresetToLorebook('Book2', 'Book2', c);
        window.confirm.mockReturnValue(false);
        offerLorebookPresets('chat-1');
        expect(window.confirm).toHaveBeenCalledTimes(2);
        expect(settings.snapshot().lorebookPresetDeclines['chat-1']).toHaveLength(3);
    });

    it('never throws', () => {
        window.confirm.mockImplementation(() => { throw new Error('boom'); });
        expect(() => offerLorebookPresets('chat-1')).not.toThrow();
    });
});

// ---------------------------------------------------------------------------

describe('preset export / import', () => {
    it('exportPreset returns a deep copy, or null', () => {
        const id = makePreset('Src', { v1: { name: 'se__hp' } });
        const out = exportPreset(id);
        expect(out).toEqual(getSettings().presets[id]);
        out.variables.v1.name = 'changed';
        expect(getSettings().presets[id].variables.v1.name).toBe('se__hp');
        expect(exportPreset('ghost')).toBeNull();
    });

    it('importPreset stores a NEW preset with a new id, and saves', () => {
        const src = makePreset('Src', { v1: { name: 'se__hp', defaultValue: 7 } }, { description: 'about hp' });
        const data = exportPreset(src);
        const before = saves();
        const id = importPreset(data);
        expect(saves()).toBeGreaterThan(before);
        expect(id).not.toBe(src);
        const stored = getSettings().presets[id];
        expect(stored).toMatchObject({ id, description: 'about hp', triggers: ['ai'], namespace: 'se' });
        expect(stored.name).toBe('Src (imported)');           // never a duplicate display name
        expect(getSettings().presets[src].name).toBe('Src');   // the original is untouched
        expect(settings.snapshot().presets[id]).toBeDefined();
    });

    it('imported variables get fresh ids and names that collide with nothing', () => {
        const src = makePreset('Src', { v1: { name: 'se__hp', defaultValue: 7 }, v2: { name: 'se__mp' } });
        const { presetId, idMap, nameMap } = importPresetDetailed(exportPreset(src));
        const vars = Object.values(getSettings().presets[presetId].variables);
        expect(vars.map((v) => v.name).sort()).toEqual(['se__hp_2', 'se__mp_2']);
        expect(nameMap).toEqual({ se__hp: 'se__hp_2', se__mp: 'se__mp_2' });
        expect(Object.keys(idMap).sort()).toEqual(['v1', 'v2']);
        expect(new Set(Object.values(idMap)).size).toBe(2);
        expect(Object.values(idMap)).not.toContain('v1');
        expect(getSettings().presets[presetId].variables[idMap.v1]).toMatchObject({ id: idMap.v1, defaultValue: 7 });
        // every variable name across all presets is unique
        const all = Object.values(getSettings().presets).flatMap((p) => Object.values(p.variables).map((v) => v.name));
        expect(new Set(all).size).toBe(all.length);
    });

    it('a name that is free keeps its name', () => {
        const id = importPreset({ name: 'Fresh', variables: { x: { id: 'x', name: 'se__fresh', type: 'number' } } });
        expect(Object.values(getSettings().presets[id].variables)[0].name).toBe('se__fresh');
        expect(getSettings().presets[id].name).toBe('Fresh');
    });

    it('calculated variables follow their renamed siblings (word-boundary safe)', () => {
        const src = makePreset('Calc', {
            hp: { name: 'se__hp' }, hp_max: { name: 'se__hp_max' },
            pct: { name: 'se__pct', type: 'calculated', dependencies: ['se__hp', 'se__hp_max'], expression: 'se__hp / se__hp_max * 100' },
        });
        const { presetId } = importPresetDetailed(exportPreset(src));
        const pct = Object.values(getSettings().presets[presetId].variables).find((v) => v.type === 'calculated');
        expect(pct.dependencies).toEqual(['se__hp_2', 'se__hp_max_2']);
        expect(pct.expression).toBe('se__hp_2 / se__hp_max_2 * 100');
    });

    it('an unknown namespace is imported into the built-in one, swapping the variable prefix', () => {
        const id = importPreset({ name: 'Foreign', namespace: 'zz', variables: { x: { id: 'x', name: 'zz__mood', type: 'number' } } });
        const preset = getSettings().presets[id];
        expect(preset.namespace).toBe('se');
        expect(Object.values(preset.variables)[0].name).toBe('se__mood');
    });

    it('rejects anything that is not a preset', () => {
        for (const bad of [null, undefined, 5, 'x', [], {}, { variables: [] }, { variables: 'no' }]) {
            expect(importPreset(bad), String(bad)).toBeNull();
        }
    });

    it('importing does not mutate the data it was given', () => {
        const data = { name: 'Frozen', variables: { x: { id: 'x', name: 'se__frozen', type: 'number' } } };
        const copy = JSON.parse(JSON.stringify(data));
        importPreset(data);
        expect(data).toEqual(copy);
    });

    it('the manager modal has Export and Import buttons wired', () => {
        expect(uiTemplates.buildPresetsTabContainer('')).toContain('id="se-manager-import-preset"');
        const row = uiTemplates.buildPresetRow('p1', { name: 'P', variables: {} }, [], [], 'c');
        expect(row).toContain('se-manager-export-preset');
        const events = read('src', 'ui', 'manager-modal', 'ui-events.js');
        expect(events).toContain("'.se-manager-export-preset'");
        expect(events).toContain("'#se-manager-import-preset'");
    });
});

// ---------------------------------------------------------------------------

describe('lorebook bundles', () => {
    const LOREBOOK = { entries: { 1: { uid: 1, comment: 'Dragon', content: 'A dragon.' }, 2: { uid: 2, comment: 'Elf', content: 'An elf.' } } };
    let presetId;
    beforeEach(() => {
        presetId = makePreset('Story', { v1: { name: 'se__mood' }, v2: { name: 'se__trust' } });
        bindings.bindPresetToLorebook('Book', 'Book', presetId);
        wiConditions.setWICondition('Book.1', { variable: 'v1', operator: 'greater_than', value: '3' });
        wiConditions.setWICondition('Book.2', { variable: 'v2', operator: 'equals', value: 'high' });
        wiConditions.setWICondition('Other.1', { variable: 'v1', operator: 'equals', value: 'nope' });
        context.loadWorldInfo = vi.fn(async (name) => (name === 'Book' ? JSON.parse(JSON.stringify(LOREBOOK)) : null));
        context.saveWorldInfo = vi.fn(async () => {});
        context.updateWorldInfoList = vi.fn(async () => {});
        context.getWorldInfoNames = () => ['Book'];
    });

    it('exports the lorebook with its conditions, bound presets and binding', async () => {
        const bundle = await exportLorebookBundle('Book', 'Book');
        expect(bundle.lorebook).toEqual(LOREBOOK);
        expect(bundle.lorebookName).toBe('Book');
        expect(Object.keys(bundle.stateEngine.presets)).toEqual([presetId]);
        expect(bundle.stateEngine.presets[presetId].name).toBe('Story');
        expect(Object.keys(bundle.stateEngine.wiConditions).sort()).toEqual(['Book.1', 'Book.2']); // not Other.1
        expect(bundle.stateEngine.lorebookPresetBindings).toEqual({ Book: { Book: [presetId] } });
        // JSON-safe
        expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
    });

    it('export is null for a lorebook that cannot be loaded; a lorebook with nothing bound still exports', async () => {
        expect(await exportLorebookBundle('Missing', 'Missing')).toBeNull();
        bindings.unbindPresetFromLorebook('Book', 'Book', presetId);
        const bundle = await exportLorebookBundle('Book', 'Book');
        // parts with nothing in them are left out, not written as empty lists
        expect(bundle.stateEngine).not.toHaveProperty('presets');
        expect(bundle.stateEngine).not.toHaveProperty('lorebookPresetBindings');
        expect(Object.keys(bundle.stateEngine.wiConditions).sort()).toEqual(['Book.1', 'Book.2']);
        for (const key of ['Book.1', 'Book.2']) wiConditions.clearWIConditionsForEntry(key);
        expect((await exportLorebookBundle('Book', 'Book')).stateEngine).toEqual({});
    });

    it('does not match a world whose name merely starts with the same letters', async () => {
        wiConditions.setWICondition('BookTwo.1', { variable: 'v1', operator: 'equals', value: 'x' });
        const bundle = await exportLorebookBundle('Book', 'Book');
        expect(Object.keys(bundle.stateEngine.wiConditions)).not.toContain('BookTwo.1');
    });

    describe('import', () => {
        let bundle;
        beforeEach(async () => { bundle = await exportLorebookBundle('Book', 'Book'); });

        // a fresh install: nothing of the bundle's is there
        const freshInstall = () => {
            settings.reset();
            context.getWorldInfoNames = () => [];
            context.saveSettingsDebounced.mockClear();
            window.confirm.mockClear();
            window.confirm.mockReturnValue(true);
            context.saveWorldInfo.mockClear();
        };

        it('imports the lorebook into SillyTavern under its name', async () => {
            freshInstall();
            await importLorebookBundle(bundle);
            expect(context.saveWorldInfo).toHaveBeenCalledWith('Book', LOREBOOK, true);
            expect(context.updateWorldInfoList).toHaveBeenCalled();
        });

        it('imports the presets, merges the conditions (re-pointed at the imported variables) and the bindings, and saves', async () => {
            freshInstall();
            const result = await importLorebookBundle(bundle);
            expect(saves()).toBeGreaterThan(0);

            const [newPresetId] = result.boundPresetIds;
            const preset = getSettings().presets[newPresetId];
            expect(preset.name).toBe('Story');
            const idOf = (name) => Object.values(preset.variables).find((v) => v.name === name).id;

            expect(getSettings().wiConditions['Book.1']).toEqual([{ variable: idOf('se__mood'), operator: 'greater_than', value: '3' }]);
            expect(getSettings().wiConditions['Book.2']).toEqual([{ variable: idOf('se__trust'), operator: 'equals', value: 'high' }]);
            expect(getSettings().wiConditions['Other.1']).toBeUndefined();
            expect(getSettings().lorebookPresetBindings).toEqual({ Book: { Book: [newPresetId] } });
            expect(result).toMatchObject({ lorebook: 'Book', conditions: 2 });
        });

        it('on an install that already has those variable names, the conditions follow the renamed variables', async () => {
            // a DIFFERENT preset already owns these variable names (an identical one would be reused)
            getSettings().presets[presetId].name = 'Something else';
            const result = await importLorebookBundle(bundle, { name: 'Book Copy' });
            const [newPresetId] = result.boundPresetIds;
            expect(newPresetId).not.toBe(presetId);
            const preset = getSettings().presets[newPresetId];
            expect(Object.values(preset.variables).map((v) => v.name).sort()).toEqual(['se__mood_2', 'se__trust_2']);
            const cond = getSettings().wiConditions['Book Copy.1'][0];
            expect(preset.variables[cond.variable].name).toBe('se__mood_2'); // re-pointed
            expect(getSettings().lorebookPresetBindings['Book Copy']['Book Copy']).toEqual([newPresetId]);
            expect(context.saveWorldInfo).toHaveBeenCalledWith('Book Copy', LOREBOOK, true);
        });

        it('importing the same bundle twice reuses the preset and does not duplicate conditions', async () => {
            freshInstall();
            await importLorebookBundle(bundle);
            const presetCount = Object.keys(getSettings().presets).length;
            const again = await importLorebookBundle(bundle);
            expect(Object.keys(getSettings().presets)).toHaveLength(presetCount);
            expect(again.conditions).toBe(0);
            expect(getSettings().wiConditions['Book.1']).toHaveLength(1);
            expect(getSettings().lorebookPresetBindings.Book.Book).toHaveLength(1);
        });

        it('asks before overwriting an existing lorebook, and stops when refused', async () => {
            freshInstall();
            context.getWorldInfoNames = () => ['Book'];
            window.confirm.mockReturnValue(false);
            expect(await importLorebookBundle(bundle)).toBeNull();
            expect(context.saveWorldInfo).not.toHaveBeenCalled();
            expect(window.confirm.mock.calls[0][0]).toContain('already exists');
        });

        it('offers to activate the bundle\'s presets for the open chat', async () => {
            freshInstall();
            const result = await importLorebookBundle(bundle);
            expect(window.confirm.mock.calls.at(-1)[0]).toContain('comes with the presets Story');
            expect(result.activated).toBe(true);
            expect(getPresetsForChat('chat-1')).toEqual(result.boundPresetIds);

            freshInstall();
            window.confirm.mockImplementation((msg) => !msg.includes('comes with'));
            const declined = await importLorebookBundle(bundle);
            expect(declined.activated).toBe(false);
            expect(getPresetsForChat('chat-1')).toEqual([]);
        });

        it('rejects a bundle without a lorebook', async () => {
            for (const bad of [null, {}, { lorebook: {} }, { lorebook: 'x' }, 'text']) {
                expect(await importLorebookBundle(bad), JSON.stringify(bad)).toBeNull();
            }
            expect(context.saveWorldInfo).not.toHaveBeenCalledWith(expect.anything(), undefined, true);
        });

        it('needs a name from somewhere', async () => {
            freshInstall();
            expect(await importLorebookBundle({ lorebook: LOREBOOK, stateEngine: {} })).toBeNull();
            expect(await importLorebookBundle({ lorebook: LOREBOOK, stateEngine: {} }, { name: 'Named' })).toMatchObject({ lorebook: 'Named' });
        });
    });
});

// ---------------------------------------------------------------------------

describe('window.StateEngineWI', () => {
    it('exposes the whole API', () => {
        delete window.StateEngineWI;
        exposeStateEngineWI();
        for (const fn of ['getWIConditions', 'setWICondition', 'deleteWICondition', 'shouldDisplayWIEntry', 'getPresetsForLorebook',
            'bindPresetToLorebook', 'unbindPresetFromLorebook', 'exportPreset', 'importPreset', 'exportLorebookBundle', 'importLorebookBundle']) {
            expect(typeof window.StateEngineWI[fn], fn).toBe('function');
        }
        expect(window.StateEngineWI).toBe(StateEngineWI);
    });

    it('is wired at startup', () => {
        const index = read('index.js');
        expect(index).toContain('exposeStateEngineWI()');
        expect(index).toContain('initLorebookBindingsUi()');
    });

    it('works through the public object', () => {
        const id = makePreset('Api');
        const me = ['se', ensureInstanceId()]; // the caller identity every function now takes first
        window.StateEngineWI = StateEngineWI;
        expect(window.StateEngineWI.bindPresetToLorebook(...me, 'B', 'B', id)).toBe(true);
        expect(window.StateEngineWI.getPresetsForLorebook(...me, 'B', 'B')).toEqual([id]);
        window.StateEngineWI.setWICondition(...me, 'B.1', { variable: 'x', operator: 'equals', value: '1' });
        expect(window.StateEngineWI.getWIConditions(...me, 'B.1')).toHaveLength(1);
        expect(window.StateEngineWI.shouldDisplayWIEntry(...me, 'B.9')).toBe(true);
    });
});

describe('the Lorebook Preset Bindings section', () => {
    const html = read('settings.html');

    it('has the dropdown, preset list and Bind / Unbind buttons', () => {
        expect(html).toContain('Lorebook Preset Bindings');
        for (const id of ['se_lorebook_select', 'se_lorebook_presets', 'se_lorebook_bind', 'se_lorebook_unbind', 'se_lorebook_export_bundle', 'se_lorebook_import_bundle']) {
            expect(html, id).toContain(`id="${id}"`);
        }
    });

    it('its logic is exported and every control is wired', () => {
        for (const fn of ['populateLorebookSelect', 'renderLorebookPresetBindings', 'bindPresetToLorebookFromUI', 'unbindPresetFromLorebookFromUI', 'initLorebookBindingsUi']) {
            expect(typeof bindingsUi[fn], fn).toBe('function');
        }
        const src = read('src', 'ui', 'lorebook-bindings-ui.js');
        for (const id of ['#se_lorebook_select', '#se_lorebook_bind', '#se_lorebook_unbind', '#se_lorebook_export_bundle', '#se_lorebook_import_bundle']) {
            expect(src, id).toContain(`'${id}'`);
        }
    });
});
