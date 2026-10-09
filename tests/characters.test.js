// Requirements spec 1.42: characters - settings (global containers of
// canonical characters with baseline data and variants), each chat's layer
// (its setting, presence, matches, its own unpromoted characters), character
// variables holding ids, extraction through prompted variables, promotion,
// merge/delete, and the Character Manager hook.
import fs from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { loadChatState, getVar, setVar } from '../src/core/chat-state.js';
import * as C from '../src/core/characters.js';
import { characterValueText } from '../src/core/character-display.js';
import { describeConstraint, formatValueForDisplay } from '../src/ui/formatting-utils.js';
import { listNotifications } from '../src/core/notification-core.js';
import { runPromptedStateUpdate } from '../src/core/prompted-engine.js';
import { callBackgroundLLM } from '../src/core/background-llm.js';
import { offerNewChatStart, NEW_CHAT_CHOICES } from '../src/core/initialization-engine.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

const CHAT = 'chat-1';
let id;
const api = (fn, ...args) => stateEngine[fn]('pp', id, ...args);
// A setting that does not auto-confirm, so new characters stay in the chat.
let story;

beforeEach(() => {
    id = ensureInstanceId();
    registerNamespaces('pp');
    story = C.createSetting({ name: 'Story', autoConfirm: false });
    C.setChatSetting(CHAT, story.id);
    context.chatId = CHAT;
});

describe('settings', () => {
    it('Default always exists, auto-confirms, and comes first', () => {
        expect(C.listSettings()[0]).toMatchObject({ id: 'default', name: 'Default', isDefault: true, autoConfirm: true });
    });

    it('create / rename / toggle / delete; names are unique; Default cannot be deleted', () => {
        expect(() => C.createSetting({ name: 'story' })).toThrow(/already exists/);
        expect(C.updateSetting(story.id, { name: 'Saga', autoConfirm: true })).toMatchObject({ name: 'Saga', autoConfirm: true });
        expect(() => C.deleteSetting('default')).toThrow(/cannot be deleted/);
        expect(C.deleteSetting(story.id)).toBe(true);
        expect(C.getChatSetting(CHAT)).toBeNull(); // asked again on next use
    });

    it('ensureChatSetting: with only Default it is chosen silently; otherwise the user is asked once', async () => {
        C.deleteSetting(story.id);
        const ask = vi.fn();
        expect(await C.ensureChatSetting('chat-a', ask)).toBe('default');
        expect(ask).not.toHaveBeenCalled();
        const other = C.createSetting({ name: 'Other' });
        const ask2 = vi.fn(async () => other.id);
        expect(await C.ensureChatSetting('chat-b', ask2)).toBe(other.id);
        expect(await C.ensureChatSetting('chat-b', ask2)).toBe(other.id);
        expect(ask2).toHaveBeenCalledTimes(1);
        expect(await C.ensureChatSetting('chat-c', async () => null)).toBe('default'); // dismissed
    });
});

describe('characters: create, match, edit', () => {
    it('an unconfirmed chat character stays in the chat (setting without auto-confirm)', () => {
        const kael = C.createUnconfirmedCharacter(CHAT, 'Kael', 'Kael stepped out of the rain.');
        expect(kael).toMatchObject({ name: 'Kael', confirmed: false, scope: 'chat', introduction_snippet: 'Kael stepped out of the rain.' });
        expect(kael.id).toMatch(/^chr_/);
        expect(C.listCharacters(null, { settingId: story.id })).toEqual([]);
    });

    it('on an auto-confirming setting (Default) it is confirmed at once - and so in the setting', () => {
        C.setChatSetting(CHAT, 'default');
        expect(C.createUnconfirmedCharacter(CHAT, 'Mira')).toMatchObject({ scope: 'setting', settingId: 'default', confirmed: true });
    });

    it('alias matching: name or alias, case and quotes ignored; chat characters first, then the setting', () => {
        const kael = C.createUnconfirmedCharacter(CHAT, 'Kael');
        C.updateCharacterAliases(CHAT, kael.id, 'the stranger');
        const canon = C.createCharacter(story.id, { name: 'Captain Rhys', aliases: ['Rhys'] });
        expect(C.getCharacterByAlias(CHAT, '"The Stranger"').id).toBe(kael.id);
        expect(C.getCharacterByAlias(CHAT, 'rhys').id).toBe(canon.id);
        expect(C.getCharacterByAlias(CHAT, 'nobody')).toBeNull();
    });

    it('editing and saving confirms (canonicalization) - which puts it in the setting; a canonical edit changes the baseline for every chat', () => {
        const kael = C.createUnconfirmedCharacter(CHAT, 'Kael');
        expect(C.updateCharacter(CHAT, kael.id, { faction: 'Ashguard' })).toMatchObject({ id: kael.id, confirmed: true, faction: 'Ashguard', scope: 'setting', settingId: story.id });
        expect(loadChatState(CHAT).characters.local).toEqual({});
        const canon = C.createCharacter(story.id, { name: 'Rhys' });
        C.setChatSetting('chat-2', story.id);
        C.updateCharacter(CHAT, canon.id, { biography: 'A smuggler.' });
        expect(C.getCharacter('chat-2', canon.id).biography).toBe('A smuggler.');
    });

    it('giving a chat character an image is an edit: confirmed, in the setting', () => {
        const kael = C.createUnconfirmedCharacter(CHAT, 'Kael');
        expect(C.updateCharacterImage(CHAT, kael.id, 'user/images/kael.png')).toMatchObject({ confirmed: true, scope: 'setting', image: 'user/images/kael.png' });
    });

    it('confirming as it is moves it into the setting, keeping its id', () => {
        const kael = C.createUnconfirmedCharacter(CHAT, 'Kael');
        expect(C.confirmCharacter(CHAT, kael.id)).toMatchObject({ id: kael.id, confirmed: true, scope: 'setting', settingId: story.id });
        expect(loadChatState(CHAT).characters.local).toEqual({});
    });

    it('there is no separate promotion: confirmed <=> in the setting', () => {
        expect(C.promoteCharacter).toBeUndefined();
        expect(stateEngine.promoteCharacter).toBeUndefined();
    });

    it('resolving a detection to an existing character: its name becomes an alias, the target is confirmed', () => {
        const luc = C.createUnconfirmedCharacter(CHAT, 'Luc');
        const lucian = C.createUnconfirmedCharacter(CHAT, 'Lucian Hale');
        setVar(CHAT, 'pp__who', luc.id, { name: 'pp__who', type: 'character' });
        const resolved = api('resolveCharacter', CHAT, luc.id, lucian.id);
        expect(resolved).toMatchObject({ id: lucian.id, confirmed: true, scope: 'setting', aliases: ['Luc'] });
        expect(C.getCharacter(CHAT, luc.id)).toBeNull();
        expect(getVar(CHAT, 'pp__who').value).toBe(lucian.id);
        expect(C.getCharacterByAlias(CHAT, 'luc').id).toBe(lucian.id);
    });

    it('presence is per chat', () => {
        const canon = C.createCharacter(story.id, { name: 'Rhys' });
        C.markCharacterPresent(CHAT, canon.id);
        C.setChatSetting('chat-2', story.id);
        expect(C.getCharacter(CHAT, canon.id).present).toBe(true);
        expect(C.getCharacter('chat-2', canon.id).present).toBe(false);
        expect(C.markCharacterAbsent(CHAT, canon.id).present).toBe(false);
    });
});

describe('variants (one active variant per character, for its setting)', () => {
    it('the active variant\'s overrides are what shows and what matches', () => {
        const canon = C.createCharacter(story.id, { name: 'Rhys', faction: 'Smugglers' });
        const withVariant = C.addCharacterVariant(CHAT, canon.id, { name: 'Turncoat', overrides: { faction: 'Crown', aliases: ['the traitor'] } });
        const vid = withVariant.variants[0].id;
        expect(C.getCharacter(CHAT, canon.id).faction).toBe('Smugglers');
        C.setActiveVariant(CHAT, canon.id, vid);
        C.setChatSetting('chat-2', story.id);
        expect(C.getCharacter('chat-2', canon.id)).toMatchObject({ faction: 'Crown', activeVariant: vid, base: expect.objectContaining({ faction: 'Smugglers' }) });
        expect(C.getCharacterByAlias('chat-2', 'the traitor').id).toBe(canon.id);
        C.deleteCharacterVariant(CHAT, canon.id, vid);
        expect(C.getCharacter(CHAT, canon.id)).toMatchObject({ activeVariant: null, faction: 'Smugglers' });
    });

    it('variant names are unique per character', () => {
        const canon = C.createCharacter(story.id, { name: 'Rhys' });
        C.addCharacterVariant(CHAT, canon.id, { name: 'Young' });
        expect(() => C.addCharacterVariant(CHAT, canon.id, { name: 'young' })).toThrow(/already exists/);
    });
});

describe('extraction (resolveCharacterNames)', () => {
    it('matches known names, creates unknown ones with a snippet, and posts one review notification', () => {
        const canon = C.createCharacter(story.id, { name: 'Rhys' });
        const { ids, created } = C.resolveCharacterNames(CHAT, ['Rhys', 'the hooded woman', 'Rhys'], {
            source: 'Rhys nodded. The hooded woman said nothing at all. Rain fell.',
        });
        expect(ids).toHaveLength(2);
        expect(ids[0]).toBe(canon.id);
        expect(created).toEqual([expect.objectContaining({ name: 'the hooded woman', confirmed: false, introduction_snippet: 'The hooded woman said nothing at all.' })]);
        expect(listNotifications().find((n) => n.message.startsWith('New characters detected for review'))).toMatchObject({ callbackId: 'characters.review' });
    });

    it('a chat character matched CONFIRM_AFTER_MATCHES times is confirmed (and so in the setting)', () => {
        const kael = C.createUnconfirmedCharacter(CHAT, 'Kael');
        for (let i = 0; i < C.CONFIRM_AFTER_MATCHES - 1; i++) C.resolveCharacterNames(CHAT, ['Kael']);
        expect(C.getCharacter(CHAT, kael.id)).toMatchObject({ confirmed: false, scope: 'chat' });
        C.resolveCharacterNames(CHAT, ['kael']);
        expect(C.getCharacter(CHAT, kael.id)).toMatchObject({ confirmed: true, scope: 'setting', matches: C.CONFIRM_AFTER_MATCHES });
    });

    it('snippetFor finds the sentence and trims long ones', () => {
        expect(C.snippetFor('A door opened. Kael walked in, dripping! Nobody moved.', 'kael')).toBe('Kael walked in, dripping!');
        expect(C.snippetFor('nothing here', 'Kael')).toBeNull();
        expect(C.snippetFor(`Kael ${'x'.repeat(400)}`, 'Kael').length).toBeLessThanOrEqual(300);
    });
});

describe('character variables', () => {
    const presetAndVars = () => {
        api('createPreset', { namespace: 'pp', name: 'Scene' });
        api('activatePreset', CHAT, 'pp', 'Scene');
        api('createVariable', { namespace: 'pp', presetName: 'Scene', name: 'speaker', type: 'character', behaviors: { prompted: true, increment: false }, prompted: { instructions: 'who speaks' } });
        api('createVariable', { namespace: 'pp', presetName: 'Scene', name: 'cast', type: 'array', itemType: 'character', behaviors: { prompted: true, increment: false }, prompted: { instructions: 'who is present' } });
    };

    it('a character variable has no default and cannot be incremented', () => {
        presetAndVars();
        expect(stateEngine.getVariable('pp', id, { namespace: 'pp', presetName: 'Scene', variableName: 'speaker' }).defaultValue).toBe('');
        expect(api('createVariable', { namespace: 'pp', presetName: 'Scene', name: 'bad', type: 'character', behaviors: { increment: true } })).toBeNull();
    });

    it('the model is asked for names; ids are shown as names in prompts, the tracker and macros', () => {
        const kael = C.createUnconfirmedCharacter(CHAT, 'Kael');
        expect(describeConstraint({ type: 'character' })).toMatch(/character's name/);
        expect(describeConstraint({ type: 'array', itemType: 'character' })).toMatch(/JSON array of names/);
        expect(characterValueText({ type: 'array', itemType: 'character' }, [kael.id, 'chr_gone'])).toBe('Kael, chr_gone');
        expect(formatValueForDisplay(kael.id, { type: 'character' })).toBe('Kael');
        expect(formatValueForDisplay('', { type: 'character' })).toBe('—');
    });

    // Reported 2026-10-08: the tracker showed "—" for a filled character list -
    // it read the macro mirror (names as text) and treated that text as ids.
    it('a list already turned into names (the macro mirror) displays as those names, not "—"', () => {
        const list = { type: 'array', itemType: 'character' };
        expect(characterValueText(list, 'Lucian, Soren')).toBe('Lucian, Soren');
        expect(formatValueForDisplay('Lucian, Soren', list)).toBe('Lucian, Soren');
    });

    it('the tracker reads character values from the store, not the macro mirror', () => {
        const src = fs.readFileSync(new URL('../src/ui/tracker-panel-ui.js', import.meta.url), 'utf8');
        expect(src).toContain("? (getVar(chatId, def.name)?.value ?? getDefaultValue(def))");
    });

    it('a prompted update resolves names to ids, records new characters and sets presence', async () => {
        presetAndVars();
        const rhys = C.createCharacter(story.id, { name: 'Rhys' });
        context.chat = [{ is_user: true, mes: 'Rhys and a tall stranger enter. The tall stranger bows.' }];
        callBackgroundLLM.mockResolvedValue(JSON.stringify({ pp__speaker: 'Rhys', pp__cast: ['Rhys', 'the tall stranger'] }));
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(getVar(CHAT, 'pp__cast')?.value).toHaveLength(2));
        expect(getVar(CHAT, 'pp__speaker').value).toBe(rhys.id);
        const stranger = C.getCharacterByAlias(CHAT, 'the tall stranger');
        expect(stranger).toMatchObject({ confirmed: false, present: true, introduction_snippet: 'The tall stranger bows.' });
        expect(getVar(CHAT, 'pp__cast').value).toEqual([rhys.id, stranger.id]);
        expect(C.getCharacter(CHAT, rhys.id).present).toBe(true);

        // Next round: only Rhys - the stranger is no longer present.
        callBackgroundLLM.mockResolvedValue(JSON.stringify({ pp__speaker: 'Rhys', pp__cast: ['Rhys'] }));
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(getVar(CHAT, 'pp__cast')?.value).toEqual([rhys.id]));
        expect(C.getCharacter(CHAT, stranger.id).present).toBe(false);
    });

    it('merge: the target gains the source\'s name as an alias, and every variable now holds the target', () => {
        presetAndVars();
        const rhys = C.createCharacter(story.id, { name: 'Rhys' });
        const stranger = C.createUnconfirmedCharacter(CHAT, 'the stranger');
        setVar(CHAT, 'pp__speaker', stranger.id, { name: 'pp__speaker', type: 'character' });
        setVar(CHAT, 'pp__cast', [stranger.id, rhys.id], { name: 'pp__cast', type: 'array', itemType: 'character' });
        const merged = C.mergeCharacters(CHAT, stranger.id, rhys.id);
        expect(merged.aliases).toContain('the stranger');
        expect(getVar(CHAT, 'pp__speaker').value).toBe(rhys.id);
        expect(getVar(CHAT, 'pp__cast').value).toEqual([rhys.id]);
        expect(C.getCharacter(CHAT, stranger.id)).toBeNull();
        expect(C.getCharacterByAlias(CHAT, 'The Stranger').id).toBe(rhys.id);
    });

    it('delete removes the character from every variable', () => {
        presetAndVars();
        const kael = C.createUnconfirmedCharacter(CHAT, 'Kael');
        setVar(CHAT, 'pp__speaker', kael.id, { name: 'pp__speaker', type: 'character' });
        expect(C.deleteCharacter(CHAT, kael.id)).toBe(true);
        expect(getVar(CHAT, 'pp__speaker').value).toBe('');
    });
});

describe('new chats and the setting', () => {
    it('a chat started from another (Same presets) uses its setting; a clean slate is asked', async () => {
        const hp = (() => {
            api('createPreset', { namespace: 'pp', name: 'Vitals' });
            return Object.keys(settings.get().presets).find((pid) => settings.get().presets[pid].name === 'Vitals');
        })();
        const src = loadChatState('chat-src');
        src.characterAvatar = 'a.png';
        src.lastUpdated = 9000;
        api('activatePreset', 'chat-src', 'pp', 'Vitals');
        C.setChatSetting('chat-src', story.id);
        loadChatState('chat-new').characterAvatar = 'a.png';
        await offerNewChatStart('chat-new', async () => NEW_CHAT_CHOICES.PRESETS, async () => 'default');
        expect(C.getChatSetting('chat-new')).toBe(story.id);
        loadChatState('chat-new2').characterAvatar = 'a.png';
        const askSetting = vi.fn(async () => 'default');
        await offerNewChatStart('chat-new2', async () => NEW_CHAT_CHOICES.CLEAN, askSetting);
        expect(askSetting).toHaveBeenCalled();
        expect(C.getChatSetting('chat-new2')).toBe('default');
        expect(hp).toBeTruthy();
    });
});

describe('Character API and the manager hook', () => {
    it('identity is checked; a registered opener is what the drawer button and notification call', () => {
        expect(() => stateEngine.listCharacters('pp', 'wrong', CHAT)).toThrow(/wrong instance/);
        expect(api('openCharacterManager', {})).toBe(false);
        const opener = vi.fn();
        expect(api('registerCharacterManager', opener)).toBe(true);
        expect(stateEngine.hasCharacterManager()).toBe(true);
        expect(api('openCharacterManager', { view: 'setting' })).toBe(true);
        expect(opener).toHaveBeenCalledWith({ view: 'setting' });
    });

    it('rejections return null, never a partial write', () => {
        expect(api('createCharacter', 'no-such-setting', { name: 'X' })).toBeNull();
        expect(api('updateCharacter', CHAT, 'chr_missing', { name: 'X' })).toBeNull();
        expect(api('mergeCharacters', CHAT, 'a', 'a')).toBeNull();
        expect(api('createCharacterSetting', { name: '' })).toBeNull();
    });
});

describe('migration to "confirmed <=> in the setting"', () => {
    it('confirmed characters left in a chat move into its setting; autoPromote becomes autoConfirm', () => {
        const state = loadChatState(CHAT);
        state.characters.local.chr_old = { id: 'chr_old', name: 'Old Hand', confirmed: true };
        state.characters.local.chr_new = { id: 'chr_new', name: 'Newcomer', confirmed: false };
        const legacy = C.createSetting({ name: 'Legacy' });
        const stored = settings.get().variableStore.characterSettings[legacy.id];
        delete stored.autoConfirm;
        stored.autoPromote = true;
        expect(C.migrateCharacterData()).toBe(1);
        expect(C.getCharacter(CHAT, 'chr_old')).toMatchObject({ scope: 'setting', settingId: story.id, confirmed: true });
        expect(C.getCharacter(CHAT, 'chr_new')).toMatchObject({ scope: 'chat', confirmed: false });
        expect(C.getSetting(legacy.id).autoConfirm).toBe(true);
        expect('autoPromote' in settings.get().variableStore.characterSettings[legacy.id]).toBe(false);
        expect(C.migrateCharacterData()).toBe(0);
    });
});

// Requirements spec 1.43: runtime state - per chat, ephemeral, fields per setting.
describe('runtime state', () => {
    const listVar = () => {
        api('createPreset', { namespace: 'pp', name: 'Scene' });
        api('activatePreset', CHAT, 'pp', 'Scene');
        api('createVariable', { namespace: 'pp', presetName: 'Scene', name: 'cast', type: 'array', itemType: 'character', behaviors: { prompted: true, increment: false }, prompted: { instructions: 'who is present' } });
    };

    it('every setting starts with thought, mood (enum) and intent', () => {
        expect(C.getRuntimeFields(story.id).map((f) => [f.name, f.type, f.prompted, f.builtIn])).toEqual([
            ['thought', 'string', true, true], ['mood', 'enum', true, true], ['intent', 'string', true, true],
        ]);
        expect(C.getRuntimeFields(story.id)[1].values).toEqual([...C.DEFAULT_MOODS]);
    });

    it('custom fields are added and removed; built-ins stay; enum values and names are validated', () => {
        const fields = C.setRuntimeFields(story.id, [
            { name: 'amorousness', type: 'number', prompted: true, min: 0, max: 100 },
            { name: 'fear_level', type: 'enum', prompted: false, values: ['Low', 'Medium', 'High'] },
        ]);
        expect(fields.map((f) => f.name)).toEqual(['thought', 'mood', 'intent', 'amorousness', 'fear_level']);
        expect(C.setRuntimeFields(story.id, []).map((f) => f.name)).toEqual(['thought', 'mood', 'intent']);
        expect(() => C.setRuntimeFields(story.id, [{ name: 'x', type: 'enum', values: [] }])).toThrow(/no values/);
        expect(() => C.setRuntimeFields(story.id, [{ name: 'x', type: 'enum', values: ['A', 'a'] }])).toThrow(/twice/);
        expect(() => C.setRuntimeFields(story.id, [{ name: 'Bad Name' }])).toThrow(/not valid/);
        expect(() => C.setRuntimeFields(story.id, [{ name: 'present' }])).toThrow(/presence/);
        expect(api('setCharacterRuntimeFields', story.id, [{ name: 'x', type: 'colour' }])).toBeNull();
    });

    it('runtime lives in the chat, never in the setting; outside a chat it is null', () => {
        const rhys = C.createCharacter(story.id, { name: 'Rhys' });
        C.markCharacterPresent(CHAT, rhys.id);
        C.applyRuntimeUpdates(CHAT, { [rhys.id]: { thought: 'Trust no one.', mood: 'suspicious', intent: 'Watch the door' } });
        expect(C.getCharacter(CHAT, rhys.id).runtime).toEqual({ present: true, thought: 'Trust no one.', mood: 'Suspicious', intent: 'Watch the door', custom: {}, images: {} });
        expect(C.getCharacter(null, rhys.id, story.id).runtime).toBeNull();
        expect(JSON.stringify(settings.get().variableStore.characterSettings[story.id].characters)).not.toContain('Trust no one');
        C.setChatSetting('chat-2', story.id);
        expect(C.getCharacter('chat-2', rhys.id).runtime.thought).toBeNull();
    });

    it('an enum answer off the list keeps the previous value; an empty one clears it; numbers are clamped to min/max', () => {
        C.setRuntimeFields(story.id, [{ name: 'amorousness', type: 'number', min: 0, max: 100 }]);
        const rhys = C.createCharacter(story.id, { name: 'Rhys' });
        C.applyRuntimeUpdates(CHAT, { [rhys.id]: { mood: 'Elated', amorousness: 250 } });
        expect(C.getCharacter(CHAT, rhys.id).runtime).toMatchObject({ mood: null, custom: { amorousness: 100 } });
        C.applyRuntimeUpdates(CHAT, { [rhys.id]: { mood: 'Sad' } });
        C.applyRuntimeUpdates(CHAT, { [rhys.id]: { mood: 'Resigned' } });
        expect(C.getCharacter(CHAT, rhys.id).runtime.mood).toBe('Sad');
        C.applyRuntimeUpdates(CHAT, { [rhys.id]: { mood: '' } });
        expect(C.getCharacter(CHAT, rhys.id).runtime.mood).toBeNull();
    });

    // Spec 1.46: an image per enum value, shown in place of the word.
    describe('enum images', () => {
        const moodWith = (images) => ({ name: 'mood', type: 'enum', values: ['Calm', 'Angry'], images });

        it('are stored per value as spelled; unknown values are dropped; empty means none', () => {
            const [, mood] = C.setRuntimeFields(story.id, [moodWith({ calm: 'user/images/calm.png', Angry: ' ', Gone: 'x.png' })]);
            expect(mood.images).toEqual({ Calm: 'user/images/calm.png' });
            const [, plain] = C.setRuntimeFields(story.id, [moodWith({})]);
            expect(plain.images).toBeUndefined();
        });

        it('a non-string image or a non-object map is refused', () => {
            expect(() => C.setRuntimeFields(story.id, [moodWith({ Calm: 5 })])).toThrow(/must be a string/);
            expect(() => C.setRuntimeFields(story.id, [moodWith('calm.png')])).toThrow(/object of value/);
        });

        it('runtime.images holds the image for the current value, and only one that may be loaded', () => {
            C.setRuntimeFields(story.id, [
                moodWith({ Calm: 'user/images/calm.png', Angry: 'javascript:alert(1)' }),
                { name: 'stance', type: 'enum', values: ['Guard'], images: { Guard: 'https://example.com/guard.webp' } },
            ]);
            const rhys = C.createCharacter(story.id, { name: 'Rhys' });
            C.markCharacterPresent(CHAT, rhys.id);
            C.applyRuntimeUpdates(CHAT, { [rhys.id]: { mood: 'calm', stance: 'Guard' } });
            expect(C.getCharacter(CHAT, rhys.id).runtime.images).toEqual({ mood: 'user/images/calm.png', stance: 'https://example.com/guard.webp' });
            C.applyRuntimeUpdates(CHAT, { [rhys.id]: { mood: 'Angry' } });
            expect(C.getCharacter(CHAT, rhys.id).runtime.images).toEqual({ stance: 'https://example.com/guard.webp' });
            expect(C.runtimeImageSrc({ type: 'string', images: { a: 'a.png' } }, 'a')).toBeNull();
        });

        it('pass through the API', () => {
            api('setCharacterRuntimeFields', story.id, [moodWith({ Angry: 'user/images/angry.png' })]);
            expect(api('getCharacterRuntimeFields', story.id)[1].images).toEqual({ Angry: 'user/images/angry.png' });
        });
    });

    it('leaving the scene clears runtime', () => {
        const rhys = C.createCharacter(story.id, { name: 'Rhys' });
        C.markCharacterPresent(CHAT, rhys.id);
        C.applyRuntimeUpdates(CHAT, { [rhys.id]: { thought: 'Hm.' } });
        C.markCharacterAbsent(CHAT, rhys.id);
        expect(C.getCharacter(CHAT, rhys.id).runtime).toMatchObject({ present: false, thought: null });
    });

    it('non-prompted fields are set by hand; prompted ones are refused', () => {
        C.setRuntimeFields(story.id, [{ name: 'fear_level', type: 'enum', prompted: false, values: ['Low', 'High'] }]);
        const rhys = C.createCharacter(story.id, { name: 'Rhys' });
        expect(api('setCharacterRuntimeValue', CHAT, rhys.id, 'fear_level', 'high').runtime.custom.fear_level).toBe('High');
        expect(api('setCharacterRuntimeValue', CHAT, rhys.id, 'mood', 'Sad')).toBeNull();
        expect(api('setCharacterRuntimeValue', CHAT, rhys.id, 'fear_level', 'Extreme')).toBeNull();
    });

    it('the prompted update asks for "__characters" and writes runtime for the characters in the list only', async () => {
        listVar();
        C.setRuntimeFields(story.id, [
            { name: 'amorousness', type: 'number', prompted: true, min: 0, max: 100 },
            { name: 'fear_level', type: 'enum', prompted: false, values: ['Low', 'High'] },
        ]);
        const rhys = C.createCharacter(story.id, { name: 'Rhys' });
        const mara = C.createCharacter(story.id, { name: 'Mara' });
        context.chat = [{ is_user: false, name: 'GM', mes: 'Rhys leans on the bar.' }];
        callBackgroundLLM.mockResolvedValue(JSON.stringify({
            pp__cast: ['Rhys'],
            __characters: { Rhys: { thought: 'Where is she?', mood: 'Curious', intent: 'Find Mara', amorousness: '40' }, Mara: { thought: 'not here' } },
        }));
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(C.getCharacter(CHAT, rhys.id).runtime.thought).toBe('Where is she?'));
        const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
        expect(prompt).toContain('"__characters"');
        expect(prompt).toContain('"mood": EXACTLY one of ["Neutral","Angry","Afraid","Curious","Confident","Sad","Suspicious","Determined"] (no other word; if none fits exactly, pick the closest)');
        expect(prompt).toContain('must be one of those values, spelled as shown');
        expect(prompt).toContain('"amorousness": number from 0 to 100');
        expect(prompt).not.toContain('fear_level');
        expect(prompt).toContain('Start from the current list');
        expect(C.getCharacter(CHAT, rhys.id).runtime).toMatchObject({ present: true, mood: 'Curious', intent: 'Find Mara', custom: { amorousness: 40 } });
        expect(C.getCharacter(CHAT, mara.id).runtime.thought).toBeNull(); // not in the list
    });

    // A real chat (2026-10-09): a small model answers in the shape of
    // "currently" - a thought left out of it once (empty) was never answered
    // again, and a thought shown in it was copied back word for word.
    it('"currently" never shows the thought, and shows every other prompted field, empty ones as null', async () => {
        listVar();
        const rhys = C.createCharacter(story.id, { name: 'Rhys' });
        C.markCharacterPresent(CHAT, rhys.id);
        C.applyRuntimeUpdates(CHAT, { [rhys.id]: { thought: 'Old thought.', mood: 'Sad' } });
        context.chat = [{ is_user: false, name: 'GM', mes: 'Rhys leans on the bar.' }];
        callBackgroundLLM.mockResolvedValue(JSON.stringify({ pp__cast: ['Rhys'] }));
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(callBackgroundLLM).toHaveBeenCalled());
        const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
        expect(prompt).toContain('"thought": short text, new for this turn');
        expect(prompt).toContain('currently {"Rhys":{"mood":"Sad","intent":null}}');
        expect(prompt).not.toContain('Old thought.');
    });
});
