// Objects: settings (worlds holding canonical world objects), each chat's
// layer (its setting, presence, matches, its own unconfirmed and story
// objects), object variables holding ids, extraction through prompted
// variables, confirmation, merge/delete, runtime state, the object manager
// hook, and migration from the character-only engine. Characters are just
// one object type: every behaviour characters had is tested here against
// type "character", and the other types against the same rules.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { loadChatState, getVar, setVar } from '../src/core/chat-state.js';
import * as O from '../src/core/objects.js';
import { OBJECT_TYPE_IDS, objectTypeOfId } from '../src/core/object-types.js';
import { objectValueText } from '../src/core/object-display.js';
import { variableTypeFitsRole } from '../src/core/roles.js';
import { describeConstraint, formatValueForDisplay, definitionTypeLabel } from '../src/ui/formatting-utils.js';
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
const CHARACTER = { type: 'object', objectType: 'character' };
const CHARACTER_LIST = { type: 'array', itemType: 'object', itemObjectType: 'character' };
// A setting that does not auto-confirm, so new objects stay in the chat.
let story;

beforeEach(() => {
    id = ensureInstanceId();
    registerNamespaces('pp');
    story = O.createSetting({ name: 'Story', autoConfirm: false });
    O.setChatSetting(CHAT, story.id);
    context.chatId = CHAT;
});

describe('the registry', () => {
    it('describes every type with its scope, colour, icon and fields', () => {
        const types = stateEngine.listObjectTypes();
        expect(types.map((t) => t.id)).toEqual(['character', 'location', 'faction', 'item', 'creature', 'lore', 'quest', 'scene', 'event']);
        expect(types.find((t) => t.id === 'quest')).toMatchObject({ scope: 'story', color: expect.stringMatching(/^#/), icon: expect.stringMatching(/^fa-/) });
        expect(types.find((t) => t.id === 'item').fields.map((f) => f.name)).toEqual(['owner', 'location']);
        expect(objectTypeOfId('loc_abc').id).toBe('location');
        expect(objectTypeOfId('nope')).toBeNull();
    });

    // Characters are an object type like any other: no special case left.
    it('no source file outside the registry special-cases the character type', () => {
        const offenders = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.js') && !full.endsWith('object-types.js')) {
                    const src = fs.readFileSync(full, 'utf8');
                    if (/===\s*'character'|'character'\s*===|case 'character'/.test(src)) offenders.push(full);
                }
            }
        };
        walk(fileURLToPath(new URL('../src', import.meta.url)));
        expect(offenders).toEqual([]);
    });
});

describe('settings', () => {
    it('Default always exists, auto-confirms, and comes first', () => {
        expect(O.listSettings()[0]).toMatchObject({ id: 'default', name: 'Default', isDefault: true, autoConfirm: true });
    });

    it('create / rename / toggle / delete; names are unique; Default cannot be deleted', () => {
        expect(() => O.createSetting({ name: 'story' })).toThrow(/already exists/);
        expect(O.updateSetting(story.id, { name: 'Saga', autoConfirm: true })).toMatchObject({ name: 'Saga', autoConfirm: true });
        expect(() => O.deleteSetting('default')).toThrow(/cannot be deleted/);
        expect(O.deleteSetting(story.id)).toBe(true);
        expect(O.getChatSetting(CHAT)).toBeNull(); // asked again on next use
    });

    it('counts objects per type', () => {
        O.createObject(story.id, 'character', { name: 'Rhys' });
        O.createObject(story.id, 'location', { name: 'Brass Market' });
        expect(O.getSetting(story.id)).toMatchObject({ objectCount: 2, counts: expect.objectContaining({ character: 1, location: 1, item: 0 }) });
    });

    it('ensureChatSetting: with only Default it is chosen silently; otherwise the user is asked once', async () => {
        O.deleteSetting(story.id);
        const ask = vi.fn();
        expect(await O.ensureChatSetting('chat-a', ask)).toBe('default');
        expect(ask).not.toHaveBeenCalled();
        const other = O.createSetting({ name: 'Other' });
        const ask2 = vi.fn(async () => other.id);
        expect(await O.ensureChatSetting('chat-b', ask2)).toBe(other.id);
        expect(await O.ensureChatSetting('chat-b', ask2)).toBe(other.id);
        expect(ask2).toHaveBeenCalledTimes(1);
        expect(await O.ensureChatSetting('chat-c', async () => null)).toBe('default'); // dismissed
    });
});

describe('world objects: create, match, edit (characters)', () => {
    it('an unconfirmed chat object stays in the chat (setting without auto-confirm)', () => {
        const kael = O.createChatObject(CHAT, 'character', 'Kael', 'Kael stepped out of the rain.');
        expect(kael).toMatchObject({ type: 'character', name: 'Kael', confirmed: false, scope: 'chat', introduction_snippet: 'Kael stepped out of the rain.' });
        expect(kael.id).toMatch(/^chr_/);
        expect(O.listObjects(null, 'character', { settingId: story.id })).toEqual([]);
    });

    it('on an auto-confirming setting (Default) it is confirmed at once - and so in the setting', () => {
        O.setChatSetting(CHAT, 'default');
        expect(O.createChatObject(CHAT, 'character', 'Mira')).toMatchObject({ scope: 'setting', settingId: 'default', confirmed: true });
    });

    it('alias matching: name or alias, case and quotes ignored; chat objects first, then the setting', () => {
        const kael = O.createChatObject(CHAT, 'character', 'Kael');
        O.addObjectAlias(CHAT, kael.id, 'the stranger');
        const canon = O.createObject(story.id, 'character', { name: 'Captain Rhys', aliases: ['Rhys'] });
        expect(O.getObjectByAlias(CHAT, 'character', '"The Stranger"').id).toBe(kael.id);
        expect(O.getObjectByAlias(CHAT, 'character', 'rhys').id).toBe(canon.id);
        expect(O.getObjectByAlias(CHAT, 'character', 'nobody')).toBeNull();
        expect(O.getObjectByAlias(CHAT, 'location', 'rhys')).toBeNull(); // per type
    });

    it('editing and saving confirms - which puts it in the setting; a canonical edit changes it for every chat', () => {
        const kael = O.createChatObject(CHAT, 'character', 'Kael');
        const edited = O.updateObject(CHAT, kael.id, { role: 'Scout', startValues: { factions: ['Ashguard'] } });
        expect(edited).toMatchObject({ id: kael.id, confirmed: true, role: 'Scout', scope: 'setting', settingId: story.id });
        // A faction is a faction object: the name is matched, or recorded as a new one.
        expect(edited.startValues.factions).toEqual([O.getObjectByAlias(CHAT, 'faction', 'Ashguard').id]);
        expect(loadChatState(CHAT).objects.character.local).toEqual({});
        const canon = O.createObject(story.id, 'character', { name: 'Rhys' });
        O.setChatSetting('chat-2', story.id);
        O.updateObject(CHAT, canon.id, { description: 'A smuggler.' });
        expect(O.getObject('chat-2', canon.id).description).toBe('A smuggler.');
    });

    it('giving a chat object an image is an edit: confirmed, in the setting', () => {
        const kael = O.createChatObject(CHAT, 'character', 'Kael');
        expect(O.updateObject(CHAT, kael.id, { image: 'user/images/kael.png' })).toMatchObject({ confirmed: true, scope: 'setting', image: 'user/images/kael.png' });
    });

    it('confirming as it is moves it into the setting, keeping its id', () => {
        const kael = O.createChatObject(CHAT, 'character', 'Kael');
        expect(O.confirmObject(CHAT, kael.id)).toMatchObject({ id: kael.id, confirmed: true, scope: 'setting', settingId: story.id });
        expect(loadChatState(CHAT).objects.character.local).toEqual({});
    });

    it('there is no separate promotion: confirmed <=> in the setting', () => {
        expect(O.promoteObject).toBeUndefined();
        expect(stateEngine.promoteCharacter).toBeUndefined();
    });

    it('resolving a detection to an existing object: its name becomes an alias, the target is confirmed', () => {
        const luc = O.createChatObject(CHAT, 'character', 'Luc');
        const lucian = O.createChatObject(CHAT, 'character', 'Lucian Hale');
        setVar(CHAT, 'pp__who', luc.id, { name: 'pp__who', ...CHARACTER });
        const resolved = api('resolveObject', CHAT, luc.id, lucian.id);
        expect(resolved).toMatchObject({ id: lucian.id, confirmed: true, scope: 'setting', aliases: ['Luc'] });
        expect(O.getObject(CHAT, luc.id)).toBeNull();
        expect(getVar(CHAT, 'pp__who').value).toBe(lucian.id);
        expect(O.getObjectByAlias(CHAT, 'character', 'luc').id).toBe(lucian.id);
    });

    it('presence is per chat, and only for types that have it', () => {
        const canon = O.createObject(story.id, 'character', { name: 'Rhys' });
        O.markObjectPresent(CHAT, canon.id);
        O.setChatSetting('chat-2', story.id);
        expect(O.getObject(CHAT, canon.id).present).toBe(true);
        expect(O.getObject('chat-2', canon.id).present).toBe(false);
        expect(O.markObjectAbsent(CHAT, canon.id).present).toBe(false);
        const market = O.createObject(story.id, 'location', { name: 'Brass Market' });
        expect(() => O.markObjectPresent(CHAT, market.id)).toThrow(/no presence/);
        expect(O.getObject(CHAT, market.id).present).toBeUndefined();
    });
});

describe('every world type works the same way', () => {
    it.each(['location', 'faction', 'item', 'creature', 'lore'])('%s: unconfirmed in the chat, confirmed into the setting, matched by alias', (type) => {
        const obj = O.createChatObject(CHAT, type, 'The Thing', 'The Thing appeared.');
        expect(obj).toMatchObject({ type, scope: 'chat', confirmed: false });
        O.addObjectAlias(CHAT, obj.id, 'that thing');
        expect(O.getObjectByAlias(CHAT, type, 'That Thing').id).toBe(obj.id);
        expect(O.confirmObject(CHAT, obj.id)).toMatchObject({ scope: 'setting', settingId: story.id, confirmed: true });
        expect(O.listObjects(null, type, { settingId: story.id }).map((o) => o.id)).toEqual([obj.id]);
    });

    it('type fields are validated by kind: enum, list, ref', () => {
        const wolf = O.createObject(story.id, 'creature', { name: 'Grey wolf', danger_level: 'high', traits: ['fast', '', 'pack hunter'], location: 'loc_x' });
        expect(wolf).toMatchObject({ danger_level: 'High', traits: ['fast', 'pack hunter'], location: 'loc_x' });
        expect(O.updateObject(null, wolf.id, { danger_level: 'apocalyptic' }, { settingId: story.id }).danger_level).toBe('');
    });

    it('objects of different types cannot be merged', () => {
        const a = O.createChatObject(CHAT, 'location', 'Docks');
        const b = O.createChatObject(CHAT, 'item', 'Docks key');
        expect(() => O.mergeObjects(CHAT, a.id, b.id)).toThrow(/same type/);
    });
});

describe('story types belong to their chat', () => {
    it('a quest is the chat\'s, always confirmed, never moved into a setting', () => {
        const quest = O.createChatObject(CHAT, 'quest', 'Find the ledger', null, { objectives: ['Search the docks'] });
        expect(quest).toMatchObject({ type: 'quest', scope: 'chat', confirmed: true, objectives: ['Search the docks'] });
        expect(O.updateObject(CHAT, quest.id, { objectives: ['Search the docks', 'Ask Mira'] })).toMatchObject({ scope: 'chat', objectives: ['Search the docks', 'Ask Mira'] });
        expect(O.listObjects(CHAT, 'quest').map((q) => q.id)).toEqual([quest.id]);
        O.setChatSetting('chat-2', story.id);
        expect(O.listObjects('chat-2', 'quest')).toEqual([]);
        expect(() => O.createObject(story.id, 'quest', { name: 'X' })).toThrow(/belong to a chat/);
    });

    it('a scene references a location and characters by id', () => {
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        const docks = O.createObject(story.id, 'location', { name: 'the Docks' });
        const scene = O.createChatObject(CHAT, 'scene', 'Ambush at the docks', null, { location: docks.id, characters: [rhys.id], summary: 'Rhys is ambushed.' });
        expect(O.describeObject(CHAT, scene.id)).toBe('Ambush at the docks [Scene]\nLocation: the Docks\nCharacters present: Rhys\nSummary: Rhys is ambushed.');
    });
});

describe('references', () => {
    it('deleting an object clears it from other objects\' references and related ids', () => {
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        const sword = O.createObject(story.id, 'item', { name: 'Sword', owner: rhys.id, related_entity_ids: [rhys.id] });
        const guild = O.createObject(story.id, 'faction', { name: 'Guild', members: [rhys.id] });
        O.deleteObject(null, rhys.id, { settingId: story.id });
        expect(O.getObject(null, sword.id, story.id)).toMatchObject({ owner: '', related_entity_ids: [] });
        expect(O.getObject(null, guild.id, story.id).members).toEqual([]);
    });

    it('merging repoints references to the target', () => {
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        const stranger = O.createChatObject(CHAT, 'character', 'the stranger');
        const sword = O.createObject(story.id, 'item', { name: 'Sword', owner: stranger.id });
        O.mergeObjects(CHAT, stranger.id, rhys.id);
        expect(O.getObject(CHAT, sword.id).owner).toBe(rhys.id);
    });
});

describe('variants (one active variant per object, for its setting)', () => {
    it('the active variant\'s overrides are what shows and what matches', () => {
        const canon = O.createObject(story.id, 'character', { name: 'Rhys', role: 'Smuggler', faction: 'Smugglers' });
        // References (the faction) are not overridden by a variant.
        const withVariant = O.addObjectVariant(CHAT, canon.id, { name: 'Turncoat', overrides: { role: 'Informant', faction: 'Crown', aliases: ['the traitor'] } });
        const vid = withVariant.variants[0].id;
        expect(withVariant.variants[0].overrides).toEqual({ role: 'Informant', aliases: ['the traitor'] });
        expect(O.getObject(CHAT, canon.id).role).toBe('Smuggler');
        O.setObjectActiveVariant(CHAT, canon.id, vid);
        O.setChatSetting('chat-2', story.id);
        expect(O.getObject('chat-2', canon.id)).toMatchObject({ role: 'Informant', activeVariant: vid, base: expect.objectContaining({ role: 'Smuggler' }) });
        expect(O.getObjectByAlias('chat-2', 'character', 'the traitor').id).toBe(canon.id);
        O.deleteObjectVariant(CHAT, canon.id, vid);
        expect(O.getObject(CHAT, canon.id)).toMatchObject({ activeVariant: null, role: 'Smuggler' });
    });

    it('variant names are unique per object; other world types have variants too', () => {
        const canon = O.createObject(story.id, 'character', { name: 'Rhys' });
        O.addObjectVariant(CHAT, canon.id, { name: 'Young' });
        expect(() => O.addObjectVariant(CHAT, canon.id, { name: 'young' })).toThrow(/already exists/);
        const market = O.createObject(story.id, 'location', { name: 'Brass Market', description: 'Busy.' });
        const v = O.addObjectVariant(CHAT, market.id, { name: 'Burned', overrides: { description: 'Ash and ruin.' } }).variants[0].id;
        expect(O.setObjectActiveVariant(CHAT, market.id, v).description).toBe('Ash and ruin.');
    });
});

describe('extraction (resolveObjectNames)', () => {
    it('matches known names, creates unknown ones with a snippet, and posts one review notification per type', () => {
        const canon = O.createObject(story.id, 'character', { name: 'Rhys' });
        const { ids, created } = O.resolveObjectNames(CHAT, 'character', ['Rhys', 'the hooded woman', 'Rhys'], {
            source: 'Rhys nodded. The hooded woman said nothing at all. Rain fell.',
        });
        expect(ids).toHaveLength(2);
        expect(ids[0]).toBe(canon.id);
        expect(created).toEqual([expect.objectContaining({ name: 'the hooded woman', confirmed: false, introduction_snippet: 'The hooded woman said nothing at all.' })]);
        expect(listNotifications().find((n) => n.message.startsWith('New characters detected for review'))).toMatchObject({ callbackId: 'objects.review.character' });
        O.resolveObjectNames(CHAT, 'location', ['the Rusty Anchor']);
        expect(listNotifications().find((n) => n.message.startsWith('New locations detected for review'))).toMatchObject({ callbackId: 'objects.review.location' });
    });

    it('a name written as an id becomes words, and the id still matches it', () => {
        expect(O.displayName('rocky_terrain')).toBe('Rocky Terrain');
        expect(O.displayName('wastes_beyond_the_walls')).toBe('Wastes Beyond the Walls');
        expect(O.displayName('Old Inn')).toBe('Old Inn');
        expect(O.displayName('R2_D2')).toBe('R2_D2');
        const { created } = O.resolveObjectNames(CHAT, 'location', ['rocky_terrain']);
        expect(created[0].name).toBe('Rocky Terrain');
        expect(O.resolveObjectNames(CHAT, 'location', ['rocky_terrain']).created).toEqual([]);
        expect(O.getObjectByAlias(CHAT, 'location', 'Rocky Terrain').id).toBe(created[0].id);
    });

    it('review notifications follow the open chat, and go once everything is reviewed', () => {
        const review = () => listNotifications().filter((n) => n.callbackId === 'objects.review.character').map((n) => n.message);
        O.resolveObjectNames(CHAT, 'character', ['Syrvanus', 'the gremlin']);
        expect(review()).toEqual(['New characters detected for review: Syrvanus, the gremlin']);

        O.syncObjectReviewNotifications('another-chat');
        expect(review()).toEqual([]);
        O.syncObjectReviewNotifications(null);
        expect(review()).toEqual([]);

        O.syncObjectReviewNotifications(CHAT);
        expect(review()).toEqual(['Characters to review in this chat: Syrvanus, the gremlin']);

        context.chatId = CHAT;
        for (const object of O.listObjects(CHAT, 'character').filter((o) => !o.confirmed)) O.confirmObject(CHAT, object.id);
        expect(review()).toEqual([]);
    });

    it('a chat object matched CONFIRM_AFTER_MATCHES times is confirmed (and so in the setting)', () => {
        const kael = O.createChatObject(CHAT, 'character', 'Kael');
        for (let i = 0; i < O.CONFIRM_AFTER_MATCHES - 1; i++) O.resolveObjectNames(CHAT, 'character', ['Kael']);
        expect(O.getObject(CHAT, kael.id)).toMatchObject({ confirmed: false, scope: 'chat' });
        O.resolveObjectNames(CHAT, 'character', ['kael']);
        expect(O.getObject(CHAT, kael.id)).toMatchObject({ confirmed: true, scope: 'setting', matches: O.CONFIRM_AFTER_MATCHES });
    });

    it('snippetFor finds the sentence and trims long ones', () => {
        expect(O.snippetFor('A door opened. Kael walked in, dripping! Nobody moved.', 'kael')).toBe('Kael walked in, dripping!');
        expect(O.snippetFor('nothing here', 'Kael')).toBeNull();
        expect(O.snippetFor(`Kael ${'x'.repeat(400)}`, 'Kael').length).toBeLessThanOrEqual(300);
    });
});

describe('object variables', () => {
    const presetAndVars = () => {
        api('createPreset', { namespace: 'pp', name: 'Scene' });
        api('activatePreset', CHAT, 'pp', 'Scene');
        api('createVariable', { namespace: 'pp', presetName: 'Scene', name: 'speaker', ...CHARACTER, behaviors: { prompted: true, increment: false }, prompted: { instructions: 'who speaks' } });
        api('createVariable', { namespace: 'pp', presetName: 'Scene', name: 'cast', ...CHARACTER_LIST, behaviors: { prompted: true, increment: false }, prompted: { instructions: 'who is present' } });
    };

    it('an object variable has no default, cannot be incremented, and needs a known object type', () => {
        presetAndVars();
        expect(stateEngine.getVariable('pp', id, { namespace: 'pp', presetName: 'Scene', variableName: 'speaker' }).defaultValue).toBe('');
        expect(api('createVariable', { namespace: 'pp', presetName: 'Scene', name: 'bad', ...CHARACTER, behaviors: { increment: true } })).toBeNull();
        expect(api('createVariable', { namespace: 'pp', presetName: 'Scene', name: 'bad2', type: 'object', objectType: 'spaceship' })).toBeNull();
        expect(api('createVariable', { namespace: 'pp', presetName: 'Scene', name: 'bad3', type: 'array', itemType: 'object' })).toBeNull();
    });

    it('the model is asked for names in the type\'s own words; ids are shown as names in prompts, the tracker and macros', () => {
        const kael = O.createChatObject(CHAT, 'character', 'Kael');
        expect(describeConstraint(CHARACTER)).toMatch(/character's name/);
        expect(describeConstraint(CHARACTER_LIST)).toMatch(/JSON array of names/);
        expect(describeConstraint({ type: 'object', objectType: 'location' })).toMatch(/location's name/);
        expect(objectValueText(CHARACTER_LIST, [kael.id, 'chr_gone'])).toBe('Kael, chr_gone');
        expect(formatValueForDisplay(kael.id, CHARACTER)).toBe('Kael');
        expect(formatValueForDisplay('', CHARACTER)).toBe('—');
        expect(definitionTypeLabel({ type: 'object', objectType: 'location' })).toBe('Location');
        expect(definitionTypeLabel({ type: 'array', itemType: 'object', itemObjectType: 'item' })).toBe('List of Items');
    });

    // Reported 2026-10-08: the tracker showed "—" for a filled character list -
    // it read the macro mirror (names as text) and treated that text as ids.
    it('a list already turned into names (the macro mirror) displays as those names, not "—"', () => {
        expect(objectValueText(CHARACTER_LIST, 'Lucian, Soren')).toBe('Lucian, Soren');
        expect(formatValueForDisplay('Lucian, Soren', CHARACTER_LIST)).toBe('Lucian, Soren');
    });

    it('the tracker reads object values from the store, not the macro mirror', () => {
        const src = fs.readFileSync(new URL('../src/ui/tracker-panel-ui.js', import.meta.url), 'utf8');
        expect(src).toContain("? (getVar(chatId, def.name)?.value ?? getDefaultValue(def))");
    });

    it('a prompted update resolves names to ids, records new objects and sets presence', async () => {
        presetAndVars();
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        context.chat = [{ is_user: true, mes: 'Rhys and a tall stranger enter. The tall stranger bows.' }];
        callBackgroundLLM.mockResolvedValue(JSON.stringify({ pp__speaker: 'Rhys', pp__cast: ['Rhys', 'the tall stranger'] }));
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(getVar(CHAT, 'pp__cast')?.value).toHaveLength(2));
        expect(getVar(CHAT, 'pp__speaker').value).toBe(rhys.id);
        const stranger = O.getObjectByAlias(CHAT, 'character', 'the tall stranger');
        expect(stranger).toMatchObject({ confirmed: false, present: true, introduction_snippet: 'The tall stranger bows.' });
        expect(getVar(CHAT, 'pp__cast').value).toEqual([rhys.id, stranger.id]);
        expect(O.getObject(CHAT, rhys.id).present).toBe(true);

        // Next round: only Rhys - the stranger is no longer present.
        callBackgroundLLM.mockResolvedValue(JSON.stringify({ pp__speaker: 'Rhys', pp__cast: ['Rhys'] }));
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(getVar(CHAT, 'pp__cast')?.value).toEqual([rhys.id]));
        expect(O.getObject(CHAT, stranger.id).present).toBe(false);
    });

    it('a prompted location list extracts locations and writes their runtime under "__locations"', async () => {
        api('createPreset', { namespace: 'pp', name: 'World' });
        api('activatePreset', CHAT, 'pp', 'World');
        api('createVariable', { namespace: 'pp', presetName: 'World', name: 'places', type: 'array', itemType: 'object', itemObjectType: 'location', behaviors: { prompted: true, increment: false }, prompted: { instructions: 'places in play' } });
        context.chat = [{ is_user: false, name: 'GM', mes: 'Rain lashes the Rusty Anchor.' }];
        callBackgroundLLM.mockResolvedValue(JSON.stringify({ pp__places: ['the Rusty Anchor'], __locations: { 'the Rusty Anchor': { conditions: 'Stormy, lamplit' } } }));
        await runPromptedStateUpdate('ai');
        const anchor = await vi.waitFor(() => {
            const found = O.getObjectByAlias(CHAT, 'location', 'the rusty anchor');
            expect(found?.runtime.values.conditions).toBe('Stormy, lamplit');
            return found;
        });
        expect(anchor).toMatchObject({ scope: 'chat', confirmed: false });
        expect(getVar(CHAT, 'pp__places').value).toEqual([anchor.id]);
        const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
        expect(prompt).toContain('"__locations" [object with one entry per location named in "pp__places"');
        expect(prompt).toContain('list of the locations in play right now');
    });

    it('merge: the target gains the source\'s name as an alias, and every variable now holds the target', () => {
        presetAndVars();
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        const stranger = O.createChatObject(CHAT, 'character', 'the stranger');
        setVar(CHAT, 'pp__speaker', stranger.id, { name: 'pp__speaker', ...CHARACTER });
        setVar(CHAT, 'pp__cast', [stranger.id, rhys.id], { name: 'pp__cast', ...CHARACTER_LIST });
        const merged = O.mergeObjects(CHAT, stranger.id, rhys.id);
        expect(merged.aliases).toContain('the stranger');
        expect(getVar(CHAT, 'pp__speaker').value).toBe(rhys.id);
        expect(getVar(CHAT, 'pp__cast').value).toEqual([rhys.id]);
        expect(O.getObject(CHAT, stranger.id)).toBeNull();
        expect(O.getObjectByAlias(CHAT, 'character', 'The Stranger').id).toBe(rhys.id);
    });

    it('delete removes the object from every variable', () => {
        presetAndVars();
        const kael = O.createChatObject(CHAT, 'character', 'Kael');
        setVar(CHAT, 'pp__speaker', kael.id, { name: 'pp__speaker', ...CHARACTER });
        expect(O.deleteObject(CHAT, kael.id)).toBe(true);
        expect(getVar(CHAT, 'pp__speaker').value).toBe('');
    });

    it('getVariablePromptTexts describes objects instead of showing ids', () => {
        presetAndVars();
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys', description: 'A smuggler.', role: 'Captain', startValues: { factions: ['Ashguard'] } });
        setVar(CHAT, 'pp__speaker', rhys.id, { name: 'pp__speaker', ...CHARACTER });
        const texts = api('getVariablePromptTexts', CHAT, ['pp__speaker', 'pp__missing']);
        expect(texts).toEqual({ pp__speaker: 'Rhys [Character]\nA smuggler.\nRole: Captain\nFactions (now): Ashguard' });
    });

    it('an object role accepts object variables', () => {
        expect(variableTypeFitsRole('object', 'object')).toBe(true);
        expect(variableTypeFitsRole('object', 'string')).toBe(false);
        expect(stateEngine.getRoleTypes()).toContain('object');
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
        O.setChatSetting('chat-src', story.id);
        loadChatState('chat-new').characterAvatar = 'a.png';
        await offerNewChatStart('chat-new', async () => NEW_CHAT_CHOICES.PRESETS, async () => 'default');
        expect(O.getChatSetting('chat-new')).toBe(story.id);
        loadChatState('chat-new2').characterAvatar = 'a.png';
        const askSetting = vi.fn(async () => 'default');
        await offerNewChatStart('chat-new2', async () => NEW_CHAT_CHOICES.CLEAN, askSetting);
        expect(askSetting).toHaveBeenCalled();
        expect(O.getChatSetting('chat-new2')).toBe('default');
        expect(hp).toBeTruthy();
    });
});

describe('Object API and the manager hook', () => {
    it('identity is checked; a registered opener is what the drawer button and notifications call', () => {
        expect(() => stateEngine.listObjects('pp', 'wrong', CHAT, 'character')).toThrow(/wrong instance/);
        expect(api('openObjectManager', {})).toBe(false);
        const opener = vi.fn();
        expect(api('registerObjectManager', opener)).toBe(true);
        expect(stateEngine.hasObjectManager()).toBe(true);
        expect(api('openObjectManager', { type: 'location', view: 'setting' })).toBe(true);
        expect(opener).toHaveBeenCalledWith({ type: 'location', view: 'setting' });
    });

    it('rejections return null, never a partial write', () => {
        expect(api('createObject', 'no-such-setting', 'character', { name: 'X' })).toBeNull();
        expect(api('createObject', story.id, 'spaceship', { name: 'X' })).toBeNull();
        expect(api('updateObject', CHAT, 'chr_missing', { name: 'X' })).toBeNull();
        expect(api('mergeObjects', CHAT, 'chr_a', 'chr_a')).toBeNull();
        expect(api('createSetting', { name: '' })).toBeNull();
    });

    it('the Character API is gone', () => {
        expect(stateEngine.listCharacters).toBeUndefined();
        expect(stateEngine.registerCharacterManager).toBeUndefined();
    });
});

describe('migration from the character-only engine', () => {
    it('character settings, chat character layers and character variables become objects; idempotent', () => {
        const store = settings.get().variableStore;
        store.characterSettings = {
            set_legacy: {
                id: 'set_legacy', name: 'Legacy', autoPromote: true, createdAt: 5,
                characters: { chr_canon: { id: 'chr_canon', name: 'Canon', biography: 'Old bio.', faction: 'Guild' } },
                runtimeFields: { thought: { name: 'thought', type: 'string', prompted: true }, mood: { name: 'mood', type: 'enum', prompted: true, values: ['Calm'] }, intent: { name: 'intent', type: 'string', prompted: true }, fear: { name: 'fear', type: 'enum', prompted: false, values: ['Low', 'High'] } },
            },
        };
        const state = loadChatState('chat-legacy');
        state.characters = {
            setting: 'set_legacy',
            entries: { chr_canon: { present: true, matches: 2, runtime: { thought: 'Hm.', mood: 'Calm', intent: null, custom: { fear: 'Low' } } } },
            local: { chr_old: { id: 'chr_old', name: 'Old Hand', confirmed: true }, chr_new: { id: 'chr_new', name: 'Newcomer', confirmed: false } },
        };
        settings.get().presets.p_legacy = { id: 'p_legacy', name: 'Legacy', namespace: 'pp', variables: {
            who: { name: 'pp__who', type: 'character' },
            cast: { name: 'pp__cast', type: 'array', itemType: 'character' },
            rows: { name: 'pp__rows', type: 'array', itemType: 'object', itemSchema: { a: { type: 'string' } } },
        } };

        expect(O.migrateObjectData()).toMatchObject({ settings: 1, chats: 1, variables: 3, moved: 1 });
        expect(O.migrateObjectFields()).toMatchObject({ references: 1 });
        expect(store.characterSettings).toBeUndefined();
        expect(O.getSetting('set_legacy')).toMatchObject({ name: 'Legacy', autoConfirm: true });
        const guild = O.getObjectByAlias('chat-legacy', 'faction', 'Guild');
        expect(guild).toMatchObject({ scope: 'setting', settingId: 'set_legacy' });
        expect(O.getObject('chat-legacy', 'chr_canon')).toMatchObject({ description: 'Old bio.', startValues: { factions: [guild.id] }, present: true, matches: 2,
            runtime: { present: true, values: { thought: 'Hm.', mood: 'Calm', intent: null, fear: 'Low' }, images: {} } });
        expect(O.getObject('chat-legacy', 'chr_old')).toMatchObject({ scope: 'setting', settingId: 'set_legacy', confirmed: true });
        expect(O.getObject('chat-legacy', 'chr_new')).toMatchObject({ scope: 'chat', confirmed: false });
        expect(O.getRuntimeFields('set_legacy', 'character').map((f) => f.name)).toEqual(['thought', 'mood', 'intent', 'factions', 'faction_ties', 'fear']);
        expect(O.getRuntimeFields('set_legacy', 'character')[0].fresh).toBe(true); // from the registry
        expect(settings.get().presets.p_legacy.variables).toMatchObject({
            who: { type: 'object', objectType: 'character' },
            cast: { type: 'array', itemType: 'object', itemObjectType: 'character' },
            rows: { type: 'array', itemType: 'record' },
        });
        expect(loadChatState('chat-legacy').characters).toBeUndefined();

        expect(O.migrateObjectData()).toEqual({ settings: 0, chats: 0, variables: 0, moved: 0 });
    });
});

// Runtime state - per chat, ephemeral, fields per setting and type.
describe('runtime state', () => {
    const listVar = () => {
        api('createPreset', { namespace: 'pp', name: 'Scene' });
        api('activatePreset', CHAT, 'pp', 'Scene');
        api('createVariable', { namespace: 'pp', presetName: 'Scene', name: 'cast', ...CHARACTER_LIST, behaviors: { prompted: true, increment: false }, prompted: { instructions: 'who is present' } });
    };

    it('every setting starts with each type\'s built-ins - characters: thought, mood (enum) and intent', () => {
        expect(O.getRuntimeFields(story.id, 'character').map((f) => [f.name, f.type, f.prompted, f.builtIn])).toEqual([
            ['thought', 'string', true, true], ['mood', 'enum', true, true], ['intent', 'string', true, true], ['factions', 'array', false, true], ['faction_ties', 'array', true, true],
        ]);
        expect(O.getRuntimeFields(story.id, 'character')[1].values).toEqual(['Neutral', 'Angry', 'Afraid', 'Curious', 'Confident', 'Sad', 'Suspicious', 'Determined']);
        expect(O.getRuntimeFields(story.id, 'quest').map((f) => f.name)).toEqual(['status']);
        expect(O.getRuntimeFields(story.id, 'lore')).toEqual([]);
        for (const type of OBJECT_TYPE_IDS) expect(Array.isArray(O.getRuntimeFields(story.id, type))).toBe(true);
    });

    it('custom fields are added and removed; built-ins stay; enum values and names are validated', () => {
        const fields = O.setRuntimeFields(story.id, 'character', [
            { name: 'amorousness', type: 'number', prompted: true, min: 0, max: 100 },
            { name: 'fear_level', type: 'enum', prompted: false, values: ['Low', 'Medium', 'High'] },
        ]);
        expect(fields.map((f) => f.name)).toEqual(['thought', 'mood', 'intent', 'factions', 'faction_ties', 'amorousness', 'fear_level']);
        expect(O.setRuntimeFields(story.id, 'character', []).map((f) => f.name)).toEqual(['thought', 'mood', 'intent', 'factions', 'faction_ties']);
        // A list field comes back through this view unchanged.
        const views = O.getRuntimeFields(story.id, 'character');
        O.setRuntimeFields(story.id, 'character', views);
        expect(O.getObjectFields(story.id, 'character').find((d) => d.name === 'factions')).toMatchObject({ type: 'array', itemObjectType: 'faction' });
        expect(() => O.setRuntimeFields(story.id, 'character', [{ name: 'x', type: 'enum', values: [] }])).toThrow(/no values/);
        expect(() => O.setRuntimeFields(story.id, 'character', [{ name: 'x', type: 'enum', values: ['A', 'a'] }])).toThrow(/twice/);
        expect(() => O.setRuntimeFields(story.id, 'character', [{ name: 'Bad Name' }])).toThrow(/not valid/);
        expect(() => O.setRuntimeFields(story.id, 'character', [{ name: 'present' }])).toThrow(/presence/);
        expect(api('setObjectRuntimeFields', story.id, 'character', [{ name: 'x', type: 'colour' }])).toBeNull();
        expect(O.setRuntimeFields(story.id, 'location', [{ name: 'crowd', type: 'enum', values: ['Empty', 'Busy'] }]).map((f) => f.name)).toEqual(['conditions', 'factions', 'crowd']);
    });

    it('runtime lives in the chat, never in the setting; outside a chat it is null', () => {
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        O.markObjectPresent(CHAT, rhys.id);
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { thought: 'Trust no one.', mood: 'suspicious', intent: 'Watch the door' } });
        expect(O.getObject(CHAT, rhys.id).runtime).toEqual({ present: true, values: { thought: 'Trust no one.', mood: 'Suspicious', intent: 'Watch the door', factions: null, faction_ties: null }, images: {} });
        expect(O.getObject(null, rhys.id, story.id).runtime).toBeNull();
        expect(JSON.stringify(settings.get().variableStore.settings[story.id].objects)).not.toContain('Trust no one');
        O.setChatSetting('chat-2', story.id);
        expect(O.getObject('chat-2', rhys.id).runtime.values.thought).toBeNull();
    });

    it('an empty fresh field (the thought) keeps the last one - the card never blanks', () => {
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        O.markObjectPresent(CHAT, rhys.id);
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { thought: 'Where is she?' } });
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { thought: '' } });
        expect(O.getObject(CHAT, rhys.id).runtime.values.thought).toBe('Where is she?');
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { thought: 'Found her.' } });
        expect(O.getObject(CHAT, rhys.id).runtime.values.thought).toBe('Found her.');
    });

    it('an enum answer off the list keeps the previous value; an empty one clears it; numbers are clamped to min/max', () => {
        O.setRuntimeFields(story.id, 'character', [{ name: 'amorousness', type: 'number', min: 0, max: 100 }]);
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { mood: 'Elated', amorousness: 250 } });
        expect(O.getObject(CHAT, rhys.id).runtime.values).toMatchObject({ mood: null, amorousness: 100 });
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { mood: 'Sad' } });
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { mood: 'Resigned' } });
        expect(O.getObject(CHAT, rhys.id).runtime.values.mood).toBe('Sad');
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { mood: '' } });
        expect(O.getObject(CHAT, rhys.id).runtime.values.mood).toBeNull();
    });

    it('a type without presence keeps its runtime (a quest\'s status)', () => {
        const quest = O.createChatObject(CHAT, 'quest', 'Find the ledger');
        O.applyRuntimeUpdates(CHAT, 'quest', { [quest.id]: { status: 'active' } });
        expect(O.getObject(CHAT, quest.id).runtime).toEqual({ values: { status: 'Active' }, images: {} });
    });

    // An image per enum value, shown in place of the word.
    describe('enum images', () => {
        const moodWith = (images) => ({ name: 'mood', type: 'enum', values: ['Calm', 'Angry'], images });

        it('are stored per value as spelled; unknown values are dropped; empty means none', () => {
            const [, mood] = O.setRuntimeFields(story.id, 'character', [moodWith({ calm: 'user/images/calm.png', Angry: ' ', Gone: 'x.png' })]);
            expect(mood.images).toEqual({ Calm: 'user/images/calm.png' });
            const [, plain] = O.setRuntimeFields(story.id, 'character', [moodWith({})]);
            expect(plain.images).toBeUndefined();
        });

        it('a non-string image or a non-object map is refused', () => {
            expect(() => O.setRuntimeFields(story.id, 'character', [moodWith({ Calm: 5 })])).toThrow(/must be a string/);
            expect(() => O.setRuntimeFields(story.id, 'character', [moodWith('calm.png')])).toThrow(/object of value/);
        });

        it('runtime.images holds the image for the current value, and only one that may be loaded', () => {
            O.setRuntimeFields(story.id, 'character', [
                moodWith({ Calm: 'user/images/calm.png', Angry: 'javascript:alert(1)' }),
                { name: 'stance', type: 'enum', values: ['Guard'], images: { Guard: 'https://example.com/guard.webp' } },
            ]);
            const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
            O.markObjectPresent(CHAT, rhys.id);
            O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { mood: 'calm', stance: 'Guard' } });
            expect(O.getObject(CHAT, rhys.id).runtime.images).toEqual({ mood: 'user/images/calm.png', stance: 'https://example.com/guard.webp' });
            O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { mood: 'Angry' } });
            expect(O.getObject(CHAT, rhys.id).runtime.images).toEqual({ stance: 'https://example.com/guard.webp' });
            expect(O.runtimeImageSrc({ type: 'string', images: { a: 'a.png' } }, 'a')).toBeNull();
        });

        it('pass through the API', () => {
            api('setObjectRuntimeFields', story.id, 'character', [moodWith({ Angry: 'user/images/angry.png' })]);
            expect(api('getObjectRuntimeFields', story.id, 'character')[1].images).toEqual({ Angry: 'user/images/angry.png' });
        });
    });

    it('leaving the scene clears runtime', () => {
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        O.markObjectPresent(CHAT, rhys.id);
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { thought: 'Hm.' } });
        O.markObjectAbsent(CHAT, rhys.id);
        expect(O.getObject(CHAT, rhys.id).runtime).toMatchObject({ present: false, values: { thought: null } });
    });

    it('non-prompted fields are set by hand; prompted ones are refused', () => {
        O.setRuntimeFields(story.id, 'character', [{ name: 'fear_level', type: 'enum', prompted: false, values: ['Low', 'High'] }]);
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        expect(api('setObjectRuntimeValue', CHAT, rhys.id, 'fear_level', 'high').runtime.values.fear_level).toBe('High');
        expect(api('setObjectRuntimeValue', CHAT, rhys.id, 'mood', 'Sad')).toBeNull();
        expect(api('setObjectRuntimeValue', CHAT, rhys.id, 'fear_level', 'Extreme')).toBeNull();
    });

    it('the prompted update asks for "__characters" and writes runtime for the characters in the list only', async () => {
        listVar();
        O.setRuntimeFields(story.id, 'character', [
            { name: 'amorousness', type: 'number', prompted: true, min: 0, max: 100 },
            { name: 'fear_level', type: 'enum', prompted: false, values: ['Low', 'High'] },
        ]);
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        const mara = O.createObject(story.id, 'character', { name: 'Mara' });
        context.chat = [{ is_user: false, name: 'GM', mes: 'Rhys leans on the bar.' }];
        callBackgroundLLM.mockResolvedValue(JSON.stringify({
            pp__cast: ['Rhys'],
            __characters: { Rhys: { thought: 'Where is she?', mood: 'Curious', intent: 'Find Mara', amorousness: '40' }, Mara: { thought: 'not here' } },
        }));
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(O.getObject(CHAT, rhys.id).runtime.values.thought).toBe('Where is she?'));
        const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
        expect(prompt).toContain('"__characters"');
        expect(prompt).toContain('"mood": EXACTLY one of ["Neutral","Angry","Afraid","Curious","Confident","Sad","Suspicious","Determined"] (no other word; if none fits exactly, pick the closest)');
        expect(prompt).toContain('must be one of those values, spelled as shown');
        expect(prompt).toContain('"amorousness": number from 0 to 100');
        expect(prompt).not.toContain('fear_level');
        expect(prompt).toContain('Start from the current list');
        expect(O.getObject(CHAT, rhys.id).runtime).toMatchObject({ present: true, values: { mood: 'Curious', intent: 'Find Mara', amorousness: 40 } });
        expect(O.getObject(CHAT, mara.id).runtime.values.thought).toBeNull(); // not in the list
    });

    // A real chat (2026-10-28): a small model's answer stopped before
    // "__characters", asked last, every turn - no thought or mood for anyone.
    it('asks the characters\' runtime in a call of its own when the answers would not fit in one, and again when an answer leaves it out', async () => {
        listVar();
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        const mara = O.createObject(story.id, 'character', { name: 'Mara' });
        setVar(CHAT, 'pp__cast', [rhys.id, mara.id]);
        context.chat = [{ is_user: false, name: 'GM', mes: 'Rhys and Mara lean on the bar.' }];
        settings.get().responseLength = 60; // room for the cast, not for everyone's thoughts too
        settings.get().promptedAnswerScale = 1;
        const bodies = [];
        callBackgroundLLM.mockImplementation(async (_ctx, _settings, messages) => {
            const body = messages[0].content;
            bodies.push(body);
            if (body.includes('"__characters"')) return JSON.stringify({ __characters: { Rhys: { thought: 'Where is she?', mood: 'Curious', intent: 'Wait' }, Mara: { thought: 'Not him again.', mood: 'Suspicious', intent: 'Leave' } } });
            return JSON.stringify({ pp__cast: ['Rhys', 'Mara'] });
        });
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(O.getObject(CHAT, mara.id).runtime.values.thought).toBe('Not him again.'));
        expect(bodies.length).toBe(2);
        expect(bodies[0]).toContain('"pp__cast"');
        expect(bodies[0]).not.toContain('"__characters"');
        expect(bodies[1]).toContain('"__characters"');
        expect(bodies[1]).not.toContain('"pp__cast" [');
        expect(O.getObject(CHAT, rhys.id).runtime.values).toMatchObject({ thought: 'Where is she?', mood: 'Curious' });

        // Room for everything in one call, but the answer leaves the characters out: asked once more.
        settings.get().responseLength = 4000;
        bodies.length = 0;
        let call = 0;
        callBackgroundLLM.mockImplementation(async (_ctx, _settings, messages) => {
            bodies.push(messages[0].content);
            call++;
            return call === 1 ? JSON.stringify({ pp__cast: ['Rhys', 'Mara'] }) : JSON.stringify({ __characters: { Rhys: { thought: 'Still waiting.', mood: 'Sad', intent: 'Wait' } } });
        });
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(O.getObject(CHAT, rhys.id).runtime.values.thought).toBe('Still waiting.'));
        expect(bodies.length).toBe(2);
        expect(bodies[0]).toContain('"__characters"');
        expect(bodies[1]).toContain('"__characters"');
    });

    // A real chat (2026-10-09): a small model answers in the shape of
    // "currently" - a thought left out of it once (empty) was never answered
    // again, and a thought shown in it was copied back word for word.
    it('"currently" never shows the thought or the intent, and shows every other prompted field, empty ones as null', async () => {
        listVar();
        const rhys = O.createObject(story.id, 'character', { name: 'Rhys' });
        O.markObjectPresent(CHAT, rhys.id);
        O.applyRuntimeUpdates(CHAT, 'character', { [rhys.id]: { thought: 'Old thought.', mood: 'Sad' } });
        context.chat = [{ is_user: false, name: 'GM', mes: 'Rhys leans on the bar.' }];
        callBackgroundLLM.mockResolvedValue(JSON.stringify({ pp__cast: ['Rhys'] }));
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(callBackgroundLLM).toHaveBeenCalled());
        const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
        expect(prompt).toContain('"thought": short text, NEW EACH TURN');
        expect(prompt).toContain('write a new thought for every character, never empty');
        // The intent is asked new each turn too: shown back, it got stuck.
        expect(prompt).toContain('"intent": short text, NEW EACH TURN');
        // Factions is settable, not asked; Faction ties is what the story is asked for.
        expect(prompt).toContain('currently {"Rhys":{"mood":"Sad","faction_ties":null}}');
        expect(prompt).not.toContain('Old thought.');
    });
});
