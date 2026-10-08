// Requirements spec 1.40: roles - semantic tags mapping meaning to ONE
// variable per chat, created by the user, requested by extensions, resolved
// by extensions that render by role (Pretty Panels).
import { describe, it, expect, beforeEach } from 'vitest';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { loadChatState } from '../src/core/chat-state.js';
import { copyChatRoles, variableTypeFitsRole, isValidRoleName, candidateVariables } from '../src/core/roles.js';
import { buildRolesTab } from '../src/ui/manager-modal/ui-templates.js';

const CHAT = 'chat-1';
let id;
const api = (fn, ...args) => stateEngine[fn]('pp', id, ...args);
const variable = (name, type, extra = {}) => api('createVariable', { namespace: 'pp', presetName: 'Scene', name, type, ...extra });

beforeEach(() => {
    id = ensureInstanceId();
    registerNamespaces('pp', 'qq');
    api('createPreset', { namespace: 'pp', name: 'Scene' });
    api('activatePreset', CHAT, 'pp', 'Scene');
    variable('title', 'string', { defaultValue: 'The Docks' });
    variable('hp', 'number', { defaultValue: 10 });
    variable('when', 'datetime');
    variable('mood', 'enum', { enumValues: ['calm', 'tense'], defaultValue: 'calm' });
});

describe('role names and types', () => {
    it.each(['scene.title', 'character.health', 'quest_current', 'a.b.c'])('%j is a valid name', (name) => {
        expect(isValidRoleName(name)).toBe(true);
    });
    it.each(['', 'Scene.Title', 'scene.', '.scene', 'scene..title', '1scene', 'scene title', 'scene-title', 'x'.repeat(65)])('%j is not', (name) => {
        expect(isValidRoleName(name)).toBe(false);
    });

    it('type rules: a variable fits a role of a matching type only', () => {
        expect(variableTypeFitsRole('text', 'string')).toBe(true);
        expect(variableTypeFitsRole('text', 'enum')).toBe(true);
        expect(variableTypeFitsRole('text', 'number')).toBe(false);
        expect(variableTypeFitsRole('number', 'number')).toBe(true);
        expect(variableTypeFitsRole('number', 'calculated')).toBe(true);
        expect(variableTypeFitsRole('date', 'datetime')).toBe(true);
        expect(variableTypeFitsRole('date', 'string')).toBe(false);
        expect(variableTypeFitsRole('image', 'imageMap')).toBe(true);
        expect(variableTypeFitsRole('list', 'array')).toBe(true);
        expect(variableTypeFitsRole('any', 'boolean')).toBe(true);
    });

    it('getRoleTypes lists them', () => {
        expect(stateEngine.getRoleTypes()).toEqual(['text', 'number', 'boolean', 'date', 'image', 'list', 'any']);
    });
});

describe('createRole / listRoles (GET /roles, POST /roles/create)', () => {
    it('creates a role in the chat and lists it unassigned', () => {
        const role = api('createRole', CHAT, { name: 'scene.title', type: 'text', label: 'Scene title' });
        expect(role).toMatchObject({ name: 'scene.title', type: 'text', label: 'Scene title' });
        expect(api('listRoles', CHAT)).toEqual([expect.objectContaining({
            name: 'scene.title', type: 'text', defined: true, requestedBy: [], variable: null, valid: false, problem: null,
        })]);
    });

    it('is per chat', () => {
        api('createRole', CHAT, { name: 'scene.title', type: 'text' });
        expect(api('listRoles', 'chat-2')).toEqual([]);
    });

    it('rejects a bad name, an unknown type, and a duplicate (null, nothing written)', () => {
        expect(api('createRole', CHAT, { name: 'Scene Title', type: 'text' })).toBeNull();
        expect(api('createRole', CHAT, { name: 'scene.title', type: 'colour' })).toBeNull();
        api('createRole', CHAT, { name: 'scene.title', type: 'text' });
        expect(api('createRole', CHAT, { name: 'scene.title', type: 'number' })).toBeNull();
        expect(api('listRoles', CHAT)).toHaveLength(1);
    });

    it('deleteRole removes a defined role with its assignment', () => {
        api('createRole', CHAT, { name: 'scene.title', type: 'text' });
        api('assignRole', CHAT, 'scene.title', 'pp__title');
        expect(api('deleteRole', CHAT, 'scene.title')).toBe(true);
        expect(api('listRoles', CHAT)).toEqual([]);
        expect(loadChatState(CHAT).roles.assignments).toEqual({});
    });

    it('identity is checked first (a wrong instance throws)', () => {
        expect(() => stateEngine.listRoles('pp', 'wrong', CHAT)).toThrow(/wrong instance/);
        expect(() => stateEngine.createRole('nobody', id, CHAT, { name: 'a', type: 'text' })).toThrow();
    });
});

describe('assignRole (POST /roles/assign)', () => {
    beforeEach(() => {
        api('createRole', CHAT, { name: 'scene.title', type: 'text' });
        api('createRole', CHAT, { name: 'character.health', type: 'number' });
    });

    it('assigns a variable whose type fits, and the role becomes valid', () => {
        const role = api('assignRole', CHAT, 'scene.title', 'pp__title');
        expect(role).toMatchObject({ name: 'scene.title', variable: 'pp__title', valid: true, problem: null });
    });

    it('an enum fits a text role', () => {
        expect(api('assignRole', CHAT, 'scene.title', 'pp__mood')).toMatchObject({ valid: true });
    });

    it('refuses a variable of the wrong type, an unknown variable, and an unknown role', () => {
        expect(api('assignRole', CHAT, 'character.health', 'pp__title')).toBeNull();
        expect(api('assignRole', CHAT, 'scene.title', 'pp__ghost')).toBeNull();
        expect(api('assignRole', CHAT, 'no.such.role', 'pp__title')).toBeNull();
        expect(api('listRoles', CHAT).every((r) => r.variable === null)).toBe(true);
    });

    it('refuses a variable whose preset is not active in this chat', () => {
        api('createPreset', { namespace: 'pp', name: 'Other' });
        api('createVariable', { namespace: 'pp', presetName: 'Other', name: 'elsewhere', type: 'string' });
        expect(api('assignRole', CHAT, 'scene.title', 'pp__elsewhere')).toBeNull();
    });

    it('null clears the assignment', () => {
        api('assignRole', CHAT, 'scene.title', 'pp__title');
        expect(api('assignRole', CHAT, 'scene.title', null)).toMatchObject({ variable: null, valid: false });
    });

    it('a preset deactivated later leaves the assignment, reported as a problem', () => {
        api('assignRole', CHAT, 'scene.title', 'pp__title');
        api('deactivatePreset', CHAT, 'pp', 'Scene');
        expect(api('listRoles', CHAT).find((r) => r.name === 'scene.title')).toMatchObject({
            variable: 'pp__title', valid: false, problem: expect.stringContaining('not active'),
        });
    });

    it('candidateVariables offers only existing, fitting variables of active presets', () => {
        expect(candidateVariables(CHAT, 'number').map((c) => c.name)).toEqual(['pp__hp']);
        expect(candidateVariables(CHAT, 'text').map((c) => c.name).sort()).toEqual(['pp__mood', 'pp__title']);
        expect(candidateVariables(CHAT, 'date').map((c) => c.name)).toEqual(['pp__when']);
    });
});

describe('requestRoles / getRequiredRoles (GET /roles/required)', () => {
    it('an extension request for one chat adds its roles to that chat only', () => {
        expect(api('requestRoles', { key: 'layout', label: 'Layout: Scene HUD', chatId: CHAT, roles: [
            { name: 'scene.title', type: 'text' }, { name: 'scene.date', type: 'date' },
        ] })).toBe(true);
        const required = api('getRequiredRoles', CHAT);
        expect(required.map((r) => r.name)).toEqual(['scene.date', 'scene.title']);
        expect(required[0]).toMatchObject({ defined: false, requestedBy: [{ extensionId: 'pp', label: 'Layout: Scene HUD' }], valid: false });
        expect(api('getRequiredRoles', 'chat-2')).toEqual([]);
    });

    it('a request without a chat applies to every chat', () => {
        api('requestRoles', { key: 'quests', roles: [{ name: 'quest.current', type: 'text' }] });
        expect(api('getRequiredRoles', 'chat-9').map((r) => r.name)).toEqual(['quest.current']);
    });

    it('replaces the earlier request under the same key; an empty list removes it; identical is not rewritten', () => {
        api('requestRoles', { key: 'layout', chatId: CHAT, roles: [{ name: 'scene.title', type: 'text' }] });
        expect(api('requestRoles', { key: 'layout', chatId: CHAT, roles: [{ name: 'scene.title', type: 'text' }] })).toBe(false);
        api('requestRoles', { key: 'layout', chatId: CHAT, roles: [{ name: 'scene.date', type: 'date' }] });
        expect(api('getRequiredRoles', CHAT).map((r) => r.name)).toEqual(['scene.date']);
        expect(api('requestRoles', { key: 'layout', chatId: CHAT, roles: [] })).toBe(true);
        expect(api('getRequiredRoles', CHAT)).toEqual([]);
        expect(settings.get().roleRequests).toEqual({});
    });

    it('two extensions can request the same role; both are listed', () => {
        api('requestRoles', { key: 'a', roles: [{ name: 'scene.title', type: 'text' }] });
        stateEngine.requestRoles('qq', id, { key: 'b', label: 'Weather', roles: [{ name: 'scene.title', type: 'text' }] });
        expect(api('getRequiredRoles', CHAT)[0].requestedBy.map((r) => r.extensionId)).toEqual(['pp', 'qq']);
    });

    it('a requested role can be assigned without being created', () => {
        api('requestRoles', { key: 'layout', chatId: CHAT, roles: [{ name: 'scene.title', type: 'text' }] });
        expect(api('assignRole', CHAT, 'scene.title', 'pp__title')).toMatchObject({ valid: true });
    });

    it('a request needing a different type than the chat defined is reported', () => {
        api('createRole', CHAT, { name: 'scene.mood', type: 'any' });
        api('assignRole', CHAT, 'scene.mood', 'pp__hp');
        api('requestRoles', { key: 'layout', chatId: CHAT, roles: [{ name: 'scene.mood', type: 'text' }] });
        expect(api('listRoles', CHAT)[0]).toMatchObject({ type: 'any', valid: false, problem: expect.stringContaining('needs this role to be text') });
    });

    it('rejects an invalid request (null, nothing stored)', () => {
        expect(api('requestRoles', { key: '', roles: [] })).toBeNull();
        expect(api('requestRoles', { key: 'x', roles: [{ name: 'Bad Name', type: 'text' }] })).toBeNull();
        expect(settings.get().roleRequests).toEqual({});
    });
});

describe('resolveRoles (rendering by role)', () => {
    it('reports exists / assigned / variable / valid per role, and the missing ones', () => {
        api('requestRoles', { key: 'layout', chatId: CHAT, roles: [
            { name: 'scene.title', type: 'text' }, { name: 'character.health', type: 'number' },
        ] });
        api('assignRole', CHAT, 'scene.title', 'pp__title');
        const result = api('resolveRoles', CHAT, [{ name: 'scene.title', type: 'text' }, 'character.health', 'never.heard.of']);
        expect(result.roles).toEqual([
            { name: 'scene.title', type: 'text', exists: true, assigned: true, variable: 'pp__title', valid: true, problem: null },
            { name: 'character.health', type: 'number', exists: true, assigned: false, variable: null, valid: false, problem: 'not assigned' },
            expect.objectContaining({ name: 'never.heard.of', exists: false, valid: false }),
        ]);
        expect(result.missing).toEqual(['character.health', 'never.heard.of']);
        expect(result.allAssigned).toBe(false);
    });

    it('checks a spec type against the assigned variable', () => {
        api('createRole', CHAT, { name: 'thing', type: 'any' });
        api('assignRole', CHAT, 'thing', 'pp__title');
        expect(api('resolveRoles', CHAT, [{ name: 'thing', type: 'number' }]).roles[0]).toMatchObject({ valid: false, problem: expect.stringContaining('number is needed') });
        expect(api('resolveRoles', CHAT, [{ name: 'thing', type: 'text' }]).allAssigned).toBe(true);
    });
});

describe('new chats carry roles (spec 1.14.1)', () => {
    it('copies definitions, and assignments to variables the new chat has', () => {
        api('createRole', CHAT, { name: 'scene.title', type: 'text' });
        api('createRole', CHAT, { name: 'character.health', type: 'number' });
        api('assignRole', CHAT, 'scene.title', 'pp__title');
        api('assignRole', CHAT, 'character.health', 'pp__hp');
        api('activatePreset', 'chat-new', 'pp', 'Scene');
        expect(copyChatRoles(CHAT, 'chat-new')).toBe(4);
        expect(api('listRoles', 'chat-new').map((r) => [r.name, r.variable, r.valid])).toEqual([
            ['character.health', 'pp__hp', true], ['scene.title', 'pp__title', true],
        ]);
    });

    it('skips assignments whose variable the new chat does not have', () => {
        api('createRole', CHAT, { name: 'scene.title', type: 'text' });
        api('assignRole', CHAT, 'scene.title', 'pp__title');
        expect(copyChatRoles(CHAT, 'chat-bare')).toBe(1); // the definition only
        expect(api('listRoles', 'chat-bare')[0]).toMatchObject({ name: 'scene.title', variable: null });
    });
});

describe('Roles tab', () => {
    const view = (roles, extra = {}) => buildRolesTab({
        chatId: CHAT, roles, candidates: {}, roleTypes: stateEngine.getRoleTypes(), acceptedTypes: { text: ['string', 'enum', 'calculated'] }, ...extra,
    });

    it('without a chat says to open one', () => {
        expect(buildRolesTab({ chatId: null, roles: [] })).toContain('Open a chat to manage its roles.');
    });

    it('shows required, missing, and never offers to create a variable - only to assign one', () => {
        api('requestRoles', { key: 'layout', label: 'Layout: HUD', chatId: CHAT, roles: [{ name: 'scene.title', type: 'text' }] });
        const html = view(api('listRoles', CHAT));
        expect(html).toContain('1 required by extensions');
        expect(html).toContain('1 missing');
        expect(html).toContain('Layout: HUD');
        expect(html).toContain('— not assigned —');
        expect(html).toContain('create one in the Variables tab');
        expect(html).not.toMatch(/create (a )?variable<\/button>/i);
    });

    it('escapes everything a role carries', () => {
        api('createRole', CHAT, { name: 'x', type: 'text', label: '<img src=y>' });
        const html = view(api('listRoles', CHAT));
        expect(html).not.toContain('<img src=y>');
        expect(html).toContain('&lt;img src=y&gt;');
    });
});
