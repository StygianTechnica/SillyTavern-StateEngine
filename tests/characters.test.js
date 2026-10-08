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
