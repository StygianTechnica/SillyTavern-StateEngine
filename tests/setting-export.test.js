// A setting as plain data and back (a copy of a world for a fresh
// playthrough), and objects copied from one setting into another: new ids,
// references between them kept, nothing of a chat carried along.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import context from './harness/context.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import * as O from '../src/core/objects.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

let id;
let world;
let rhys;
let market;
let sword;

beforeEach(() => {
    id = ensureInstanceId();
    registerNamespaces('pp');
    world = O.createSetting({ name: `World ${Math.random()}` });
    context.chatId = 'chat-x';
    rhys = O.createObject(world.id, 'character', { name: 'Rhys', aliases: ['Captain'] });
    market = O.createObject(world.id, 'location', { name: 'Brass Market', related_entity_ids: [rhys.id] });
    sword = O.createObject(world.id, 'item', { name: 'Dawnblade', owner: rhys.id, location: market.id });
});

describe('exportSetting / importSetting', () => {
    it('makes a new world with new ids and every reference following', () => {
        const data = O.exportSetting(world.id);
        expect(data).toMatchObject({ format: 'state-engine-setting', version: 1, name: world.name });
        const { setting, idMap } = O.importSetting(data, { name: 'Playthrough 2' });
        expect(setting.name).toBe('Playthrough 2');
        expect(setting.objectCount).toBe(3);
        const copy = O.getObject(null, idMap[sword.id], setting.id);
        expect(copy.id).not.toBe(sword.id);
        expect(copy.owner).toBe(idMap[rhys.id]);
        expect(copy.location).toBe(idMap[market.id]);
        expect(O.getObject(null, idMap[market.id], setting.id).related_entity_ids).toEqual([idMap[rhys.id]]);
        expect(O.getObject(null, idMap[rhys.id], setting.id).aliases).toContain('Captain');
        // The original is untouched.
        expect(O.getObject(null, sword.id, world.id).owner).toBe(rhys.id);
    });

    it('keeps the fields a setting added, and makes the name unique', () => {
        const defs = O.exportSetting(world.id).fields.character;
        stateEngine.setObjectFields('pp', id, world.id, 'character', [...defs, { name: 'oath', type: 'string', scope: 'global' }]);
        O.updateObject(null, rhys.id, { oath: 'Never again' }, { settingId: world.id });
        const data = O.exportSetting(world.id);
        const { setting, idMap } = O.importSetting(data);
        expect(setting.name).toBe(`${world.name} (2)`);
        expect(O.getObject(null, idMap[rhys.id], setting.id).oath).toBe('Never again');
    });

    it('refuses what is not an export, and an unknown version', () => {
        expect(() => O.importSetting({ hello: 1 })).toThrow(/not a State Engine setting export/);
        expect(() => O.importSetting({ ...O.exportSetting(world.id), version: 99 })).toThrow(/version/);
    });

    it('is on the public API', () => {
        const data = stateEngine.exportSetting('pp', id, world.id);
        const result = stateEngine.importSetting('pp', id, data, { name: 'Via API' });
        expect(result.setting.name).toBe('Via API');
    });
});

describe('copyObjects', () => {
    it('copies a character into another world, finding namesakes for what it points at', () => {
        const other = O.createSetting({ name: `Other ${Math.random()}` });
        const theirMarket = O.createObject(other.id, 'location', { name: 'brass market' });
        const { idMap } = O.copyObjects(world.id, [sword.id, rhys.id], other.id);
        const copy = O.getObject(null, idMap[sword.id], other.id);
        expect(copy.owner).toBe(idMap[rhys.id]);
        // The market stayed behind; the other world has one of the same name.
        expect(copy.location).toBe(theirMarket.id);
        expect(O.getSetting(other.id).objectCount).toBe(3);
    });

    it('drops a reference with nothing to point at', () => {
        const other = O.createSetting({ name: `Other ${Math.random()}` });
        const { idMap } = O.copyObjects(world.id, [sword.id], other.id);
        const copy = O.getObject(null, idMap[sword.id], other.id);
        expect(copy.owner).toBe('');
        expect(copy.location).toBe('');
    });

    it('lists fields the other world does not have', () => {
        const defs = O.exportSetting(world.id).fields.character;
        stateEngine.setObjectFields('pp', id, world.id, 'character', [...defs, { name: 'oath', type: 'string', scope: 'global' }]);
        O.updateObject(null, rhys.id, { oath: 'Never again' }, { settingId: world.id });
        const other = O.createSetting({ name: `Other ${Math.random()}` });
        const { idMap, droppedFields } = O.copyObjects(world.id, [rhys.id], other.id);
        expect(droppedFields[idMap[rhys.id]]).toEqual(['oath']);
    });

    it('refuses the same world, and ids it does not hold', () => {
        expect(() => O.copyObjects(world.id, [rhys.id], world.id)).toThrow(/different setting/);
        const other = O.createSetting({ name: `Other ${Math.random()}` });
        expect(() => O.copyObjects(world.id, ['chr_nope'], other.id)).toThrow(/not in that setting/);
    });
});
