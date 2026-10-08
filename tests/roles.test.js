// Requirements spec 1.40 / 1.41: roles - GLOBAL, namespaced semantic tags
// (id "<namespace>__<publicName>", like variables), each assigned ONE
// variable per chat; defined by their namespace's owner, requested and
// resolved by extensions that render by role (Pretty Panels).
import { describe, it, expect, beforeEach } from 'vitest';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { loadChatState } from '../src/core/chat-state.js';
import {
    copyChatRoles, variableTypeFitsRole, isValidPublicName, parseRoleId, roleId, candidateVariables, migrateRoleData, listRoleDefinitions,
} from '../src/core/roles.js';
import { buildRolesTab } from '../src/ui/manager-modal/ui-templates.js';

const CHAT = 'chat-1';
let id;
const pp = (fn, ...args) => stateEngine[fn]('pp', id, ...args);
const qq = (fn, ...args) => stateEngine[fn]('qq', id, ...args);
const variable = (name, type, extra = {}) => pp('createVariable', { namespace: 'pp', presetName: 'Scene', name, type, ...extra });

beforeEach(() => {
    id = ensureInstanceId();
    registerNamespaces('pp', 'qq');
    pp('createPreset', { namespace: 'pp', name: 'Scene' });
    pp('activatePreset', CHAT, 'pp', 'Scene');
    variable('title', 'string', { defaultValue: 'The Docks' });
    variable('hp', 'number', { defaultValue: 10 });
    variable('when', 'datetime');
    variable('mood', 'enum', { enumValues: ['calm', 'tense'], defaultValue: 'calm' });
});

describe('names, ids and types', () => {
    it.each(['scene.title', 'character.health', 'quest_current', 'a.b.c'])('%j is a valid public name', (name) => {
        expect(isValidPublicName(name)).toBe(true);
    });
    it.each(['', 'Scene.Title', 'scene.', '.scene', 'scene..title', '1scene', 'scene title', 'scene-title', 'x'.repeat(65)])('%j is not', (name) => {
        expect(isValidPublicName(name)).toBe(false);
    });

    it('an id joins namespace and publicName with the variable delimiter', () => {
        expect(roleId('prettyPanels', 'scene.title')).toBe('prettyPanels__scene.title');
        expect(parseRoleId('prettyPanels__scene.title')).toEqual({ namespace: 'prettyPanels', publicName: 'scene.title' });
        expect(parseRoleId('scene.title')).toBeNull();
        expect(parseRoleId('pp__Bad Name')).toBeNull();
    });

    it('type rules: a variable fits a role of a matching type only', () => {
        expect(variableTypeFitsRole('text', 'string')).toBe(true);
        expect(variableTypeFitsRole('text', 'enum')).toBe(true);
        expect(variableTypeFitsRole('text', 'number')).toBe(false);
        expect(variableTypeFitsRole('number', 'calculated')).toBe(true);
        expect(variableTypeFitsRole('date', 'datetime')).toBe(true);
        expect(variableTypeFitsRole('image', 'imageMap')).toBe(true);
        expect(variableTypeFitsRole('list', 'array')).toBe(true);
        expect(variableTypeFitsRole('any', 'boolean')).toBe(true);
    });

    it('getRoleTypes lists them', () => {
        expect(stateEngine.getRoleTypes()).toEqual(['text', 'number', 'boolean', 'date', 'image', 'list', 'any']);
    });
});

describe('createRole / listRoles (POST /roles/create, GET /roles)', () => {
    it('defines a global role in the caller\'s namespace', () => {
        const role = pp('createRole', { publicName: 'scene.title', type: 'text', label: 'Scene title' });
        expect(role).toMatchObject({ id: 'pp__scene.title', namespace: 'pp', publicName: 'scene.title', type: 'text', label: 'Scene title' });
        expect(settings.get().variableStore.roles.globalDefinitions['pp__scene.title']).toMatchObject({ publicName: 'scene.title' });
    });

    it('is available in every chat, unassigned until a chat assigns it', () => {
        pp('createRole', { publicName: 'scene.title', type: 'text' });
        for (const chat of [CHAT, 'chat-2', null]) {
            expect(pp('listRoles', chat)).toEqual([expect.objectContaining({
                id: 'pp__scene.title', publicName: 'scene.title', namespace: 'pp', exists: true, requestedBy: [], variable: null, valid: false,
            })]);
        }
    });

    it('refuses a duplicate publicName in the same namespace', () => {
        pp('createRole', { publicName: 'scene.title', type: 'text' });
        expect(pp('createRole', { publicName: 'scene.title', type: 'number' })).toBeNull();
        expect(listRoleDefinitions()).toHaveLength(1);
    });

    it('the same publicName in another namespace is a different role; both are listed, side by side', () => {
        pp('createRole', { publicName: 'scene.title', type: 'text' });
        qq('createRole', { publicName: 'scene.title', type: 'text' });
        qq('createRole', { publicName: 'a.first', type: 'text' });
        expect(pp('listRoles', CHAT).map((r) => r.id)).toEqual(['qq__a.first', 'pp__scene.title', 'qq__scene.title']);
    });

    it('rejects a bad name and an unknown type (null, nothing written)', () => {
        expect(pp('createRole', { publicName: 'Scene Title', type: 'text' })).toBeNull();
        expect(pp('createRole', { publicName: 'scene.title', type: 'colour' })).toBeNull();
        expect(listRoleDefinitions()).toEqual([]);
    });

    it('only the namespace owner may define, update or delete its roles', () => {
        expect(() => pp('createRole', { namespace: 'qq', publicName: 'x', type: 'text' })).toThrow(/does not own namespace/);
        qq('createRole', { publicName: 'x', type: 'text' });
        expect(() => pp('updateRole', 'qq__x', { type: 'number' })).toThrow(/does not own namespace/);
        expect(() => pp('deleteRole', 'qq__x')).toThrow(/does not own namespace/);
        expect(() => stateEngine.listRoles('pp', 'wrong', CHAT)).toThrow(/wrong instance/);
    });
});

describe('updateRole / deleteRole / setNamespaceRoles', () => {
    beforeEach(() => {
        pp('createRole', { publicName: 'scene.title', type: 'text' });
        pp('assignRole', CHAT, 'pp__scene.title', 'pp__title');
    });

    it('a rename moves the id, every chat\'s assignment and every request', () => {
        pp('requestRoles', { key: 'layout', chatId: CHAT, roles: ['pp__scene.title'] });
        const renamed = pp('updateRole', 'pp__scene.title', { publicName: 'scene.name' });
        expect(renamed).toMatchObject({ id: 'pp__scene.name', publicName: 'scene.name' });
        expect(loadChatState(CHAT).roles.assignments).toEqual({ 'pp__scene.name': 'pp__title' });
        expect(pp('getRequiredRoles', CHAT).map((r) => r.id)).toEqual(['pp__scene.name']);
    });

    it('a rename onto a taken name is refused', () => {
        pp('createRole', { publicName: 'scene.name', type: 'text' });
        expect(pp('updateRole', 'pp__scene.title', { publicName: 'scene.name' })).toBeNull();
    });

    it('a type change that no longer fits leaves the assignment, reported as a problem', () => {
        pp('updateRole', 'pp__scene.title', { type: 'number' });
        expect(pp('listRoles', CHAT)[0]).toMatchObject({ type: 'number', valid: false, problem: expect.stringContaining('needs number') });
    });

    it('delete removes the role and its assignment in every chat', () => {
        expect(pp('deleteRole', 'pp__scene.title')).toBe(true);
        expect(pp('listRoles', CHAT)).toEqual([]);
        expect(loadChatState(CHAT).roles.assignments).toEqual({});
    });

    it('setNamespaceRoles keeps listed roles (and assignments), adds new ones, removes the rest - only in the caller\'s namespace', () => {
        pp('createRole', { publicName: 'old.one', type: 'text' });
        qq('createRole', { publicName: 'theirs', type: 'text' });
        const result = pp('setNamespaceRoles', [{ publicName: 'scene.title', type: 'text' }, { publicName: 'scene.date', type: 'date' }]);
        expect(result).toEqual({ added: ['pp__scene.date'], updated: [], removed: ['pp__old.one'] });
        expect(listRoleDefinitions().map((d) => d.id)).toEqual(['pp__scene.date', 'pp__scene.title', 'qq__theirs']);
        expect(loadChatState(CHAT).roles.assignments).toEqual({ 'pp__scene.title': 'pp__title' });
    });

    it('setNamespaceRoles refuses a publicName listed twice', () => {
        expect(pp('setNamespaceRoles', [{ publicName: 'a', type: 'text' }, { publicName: 'a', type: 'number' }])).toBeNull();
    });
});

describe('assignRole (POST /roles/assign) and candidates', () => {
    beforeEach(() => {
        pp('createRole', { publicName: 'scene.title', type: 'text' });
        pp('createRole', { publicName: 'character.health', type: 'number' });
    });

    it('assigns a fitting variable per chat; another chat is unaffected', () => {
        expect(qq('assignRole', CHAT, 'pp__scene.title', 'pp__title')).toMatchObject({ variable: 'pp__title', valid: true });
        expect(pp('listRoles', 'chat-2').find((r) => r.id === 'pp__scene.title').variable).toBeNull();
    });

    it('refuses the wrong type, an unknown variable, an unknown role, an inactive preset', () => {
        expect(pp('assignRole', CHAT, 'pp__character.health', 'pp__title')).toBeNull();
        expect(pp('assignRole', CHAT, 'pp__scene.title', 'pp__ghost')).toBeNull();
        expect(pp('assignRole', CHAT, 'pp__no.such', 'pp__title')).toBeNull();
        pp('createPreset', { namespace: 'pp', name: 'Other' });
        pp('createVariable', { namespace: 'pp', presetName: 'Other', name: 'elsewhere', type: 'string' });
        expect(pp('assignRole', CHAT, 'pp__scene.title', 'pp__elsewhere')).toBeNull();
        expect(loadChatState(CHAT).roles).toBeUndefined();
    });

    it('null clears; a later deactivated preset is reported', () => {
        pp('assignRole', CHAT, 'pp__scene.title', 'pp__title');
        pp('deactivatePreset', CHAT, 'pp', 'Scene');
        expect(pp('listRoles', CHAT).find((r) => r.id === 'pp__scene.title')).toMatchObject({ valid: false, problem: expect.stringContaining('not active') });
        expect(pp('assignRole', CHAT, 'pp__scene.title', null)).toMatchObject({ variable: null });
    });

    it('getRoleCandidates offers only existing, fitting variables of active presets', () => {
        expect(pp('getRoleCandidates', CHAT, 'pp__character.health').map((c) => c.name)).toEqual(['pp__hp']);
        expect(candidateVariables(CHAT, 'pp__scene.title').map((c) => c.name).sort()).toEqual(['pp__mood', 'pp__title']);
        expect(pp('getRoleCandidates', CHAT, 'pp__nope')).toEqual([]);
    });
});

describe('requestRoles / getRequiredRoles (GET /roles/required) / resolveRoles', () => {
    beforeEach(() => {
        pp('createRole', { publicName: 'scene.title', type: 'text' });
        pp('createRole', { publicName: 'character.health', type: 'number' });
    });

    it('a request for one chat marks those roles required there only', () => {
        expect(pp('requestRoles', { key: 'layout', label: 'Layout: HUD', chatId: CHAT, roles: ['pp__scene.title'] })).toBe(true);
        expect(pp('getRequiredRoles', CHAT)).toEqual([expect.objectContaining({ id: 'pp__scene.title', requestedBy: [{ extensionId: 'pp', label: 'Layout: HUD' }] })]);
        expect(pp('getRequiredRoles', 'chat-2')).toEqual([]);
    });

    it('an id nobody defined is listed as required but not defined', () => {
        pp('requestRoles', { key: 'layout', chatId: CHAT, roles: ['qq__weather.now'] });
        expect(pp('getRequiredRoles', CHAT)[0]).toMatchObject({ id: 'qq__weather.now', publicName: 'weather.now', namespace: 'qq', exists: false, valid: false });
    });

    it('replaces under the same key; empty removes; identical is not rewritten; bad ids are refused', () => {
        pp('requestRoles', { key: 'layout', chatId: CHAT, roles: ['pp__scene.title'] });
        expect(pp('requestRoles', { key: 'layout', chatId: CHAT, roles: ['pp__scene.title'] })).toBe(false);
        expect(pp('requestRoles', { key: 'layout', chatId: CHAT, roles: [] })).toBe(true);
        expect(settings.get().roleRequests).toEqual({});
        expect(pp('requestRoles', { key: 'layout', chatId: CHAT, roles: ['scene.title'] })).toBeNull();
    });

    it('resolveRoles reports exists / assigned / variable / valid, and the missing ids', () => {
        pp('assignRole', CHAT, 'pp__scene.title', 'pp__title');
        const result = pp('resolveRoles', CHAT, ['pp__scene.title', 'pp__character.health', 'qq__unknown']);
        expect(result.roles).toEqual([
            { id: 'pp__scene.title', namespace: 'pp', publicName: 'scene.title', type: 'text', exists: true, assigned: true, variable: 'pp__title', valid: true, problem: null },
            { id: 'pp__character.health', namespace: 'pp', publicName: 'character.health', type: 'number', exists: true, assigned: false, variable: null, valid: false, problem: 'not assigned' },
            expect.objectContaining({ id: 'qq__unknown', exists: false, valid: false }),
        ]);
        expect(result.missing).toEqual(['pp__character.health', 'qq__unknown']);
        expect(result.allAssigned).toBe(false);
    });
});

describe('new chats carry assignments (spec 1.14.1)', () => {
    it('copies the assignments whose variable the new chat has', () => {
        pp('createRole', { publicName: 'scene.title', type: 'text' });
        pp('assignRole', CHAT, 'pp__scene.title', 'pp__title');
        pp('activatePreset', 'chat-new', 'pp', 'Scene');
        expect(copyChatRoles(CHAT, 'chat-new')).toBe(1);
        expect(copyChatRoles(CHAT, 'chat-bare')).toBe(0);
        expect(pp('listRoles', 'chat-new')[0]).toMatchObject({ variable: 'pp__title', valid: true });
    });
});

describe('migration from un-namespaced roles', () => {
    it('per-chat definitions become global "se" roles; bare assignments move to their ids; old requests are dropped', () => {
        qq('createRole', { publicName: 'weather.now', type: 'text' });
        loadChatState(CHAT).roles = {
            definitions: { 'scene.title': { name: 'scene.title', type: 'text', label: 'T', description: '' } },
            assignments: { 'scene.title': 'pp__title', 'weather.now': 'pp__mood', 'gone.role': 'pp__hp' },
        };
        settings.get().roleRequests = { pp: { '*::old': { key: 'old', chatId: null, roles: [{ name: 'x', type: 'text' }] } } };
        expect(migrateRoleData()).toBe(true);
        expect(listRoleDefinitions().map((d) => d.id)).toEqual(['se__scene.title', 'qq__weather.now']);
        expect(loadChatState(CHAT).roles).toEqual({ assignments: { 'se__scene.title': 'pp__title', 'qq__weather.now': 'pp__mood' } });
        expect(settings.get().roleRequests).toEqual({});
        expect(migrateRoleData()).toBe(false);
    });
});

describe('Roles tab', () => {
    const view = (chatId, extra = {}) => buildRolesTab({
        chatId, roles: pp('listRoles', chatId), candidates: {}, roleTypes: stateEngine.getRoleTypes(),
        acceptedTypes: { text: ['string', 'enum', 'calculated'] }, ...extra,
    });

    it('shows publicNames, the id on hover, and the namespace only when asked', () => {
        pp('createRole', { publicName: 'scene.title', type: 'text' });
        qq('createRole', { publicName: 'scene.title', type: 'text' });
        const html = view(CHAT);
        expect(html).toContain('title="pp__scene.title">scene.title</code>');
        expect(html).toContain('title="qq__scene.title">scene.title</code>');
        expect(html).toContain('Another role has this name');
        expect(html).not.toContain('<th>Namespace</th>');
        expect(view(CHAT, { showNamespaces: true })).toContain('<th>Namespace</th>');
    });

    it('without a chat it still lists roles but cannot assign', () => {
        pp('createRole', { publicName: 'scene.title', type: 'text' });
        const html = view(null);
        expect(html).toContain('scene.title');
        expect(html).toContain('Open a chat to assign a variable.');
        expect(html).not.toContain('se-role-assign');
    });

    it('marks missing required roles; only se roles get a delete button; never offers to create a variable', () => {
        pp('createRole', { publicName: 'scene.title', type: 'text' });
        pp('requestRoles', { key: 'layout', label: 'Layout: HUD', chatId: CHAT, roles: ['pp__scene.title'] });
        const html = view(CHAT);
        expect(html).toContain('1 missing');
        expect(html).toContain('Layout: HUD');
        expect(html).toContain('create one in the Variables tab');
        expect(html).not.toContain('se-role-delete');
        expect(html).toContain('se-role-owned');
    });

    it('escapes everything a role carries', () => {
        pp('createRole', { publicName: 'x', type: 'text', label: '<img src=y>' });
        expect(view(CHAT)).not.toContain('<img src=y>');
    });
});
