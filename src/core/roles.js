// State Engine — Roles (requirements spec 1.40)
//
// A role is a semantic tag for what a variable represents ("scene.title",
// "character.health"). Roles hold no value and are not variables: a role
// maps MEANING to ONE variable, per chat, so an extension (Pretty Panels, a
// quest or weather extension) can ask for "the scene title" without knowing
// which variable this chat uses for it.
//
// Per chat, stored on the chat's own state (chat-state.js) so it lives and
// dies with the chat:
//   state.roles = {
//     definitions: { [roleName]: { name, type, label, description, createdAt } },
//     assignments: { [roleName]: variableName },
//   }
// A chat's roles are the roles DEFINED in it (by the user, in the Roles tab
// or through createRole) plus the roles extensions REQUEST for it (below)
// that it has not defined itself.
//
// Requests (global, settings.roleRequests): an extension declares the roles
// it needs, for every chat or for one chat:
//   settings.roleRequests = { [extensionId]: { [requestId]: {
//       key, label, chatId (null = every chat), roles: [{ name, type, label, description }], updatedAt } } }
// requestId is `${chatId ?? '*'}::${key}`, so one extension can keep one
// request per chat under the same key (Pretty Panels: the layout chosen in
// that chat).
//
// This module holds the rules and the storage; src/api/role-api.js is the
// public, identity-checked API, and the manager modal's Roles tab calls this
// module directly (through manager-api.js) like every other tab.

import { getSettings, persistSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { loadChatState, saveChatState } from './chat-state.js';

// The role types and the variable types each accepts. A calculated
// variable's result type is not known in advance, so it is accepted for
// the scalar types; 'any' accepts every variable.
export const ROLE_TYPES = Object.freeze(['text', 'number', 'boolean', 'date', 'image', 'list', 'any']);
const ACCEPTED_VARIABLE_TYPES = {
    text: ['string', 'enum', 'calculated'],
    number: ['number', 'calculated'],
    boolean: ['boolean', 'calculated'],
    date: ['datetime'],
    image: ['image', 'imageList', 'imageMap'],
    list: ['array'],
};

// "scene.title", "character.health", "quest_current": lowercase words
// separated by dots. At most 64 characters.
const ROLE_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const MAX_ROLE_NAME_LENGTH = 64;
const MAX_LABEL_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;

export function isValidRoleName(name) {
    return typeof name === 'string' && name.length <= MAX_ROLE_NAME_LENGTH && ROLE_NAME.test(name);
}

export function isValidRoleType(type) {
    return ROLE_TYPES.includes(type);
}

// Whether a variable of `variableType` can fulfil a role of `roleType`.
export function variableTypeFitsRole(roleType, variableType) {
    if (roleType === 'any') return typeof variableType === 'string' && variableType !== '';
    return (ACCEPTED_VARIABLE_TYPES[roleType] ?? []).includes(variableType);
}

// The variable types a role of `roleType` accepts (for the Roles tab's hint
// text), or null for 'any'.
export function acceptedVariableTypes(roleType) {
    return roleType === 'any' ? null : [...(ACCEPTED_VARIABLE_TYPES[roleType] ?? [])];
}

function text(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// A role spec ({ name, type, label?, description? }) validated and copied.
// Throws with a reason. Used for createRole and for every requested role.
export function normalizeRoleSpec(spec, what = 'role') {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${what} must be an object`);
    const name = typeof spec.name === 'string' ? spec.name.trim() : '';
    if (!isValidRoleName(name)) {
        throw new Error(`${what} name ${JSON.stringify(spec.name)} is not valid - use lowercase words separated by dots, e.g. "scene.title" (max ${MAX_ROLE_NAME_LENGTH} characters)`);
    }
    const type = spec.type ?? 'any';
    if (!isValidRoleType(type)) throw new Error(`${what} "${name}" has unknown type ${JSON.stringify(type)} (use one of: ${ROLE_TYPES.join(', ')})`);
    return { name, type, label: text(spec.label, MAX_LABEL_LENGTH), description: text(spec.description, MAX_DESCRIPTION_LENGTH) };
}

// ---------------------------------------------------------------- storage

function rolesOf(state) {
    const roles = state.roles && typeof state.roles === 'object' ? state.roles : {};
    return {
        definitions: roles.definitions && typeof roles.definitions === 'object' ? roles.definitions : {},
        assignments: roles.assignments && typeof roles.assignments === 'object' ? roles.assignments : {},
    };
}

// A chat's own role data (copies). Never throws.
export function getChatRoleData(chatId) {
    const { definitions, assignments } = rolesOf(loadChatState(chatId));
    return { definitions: structuredClone(definitions), assignments: { ...assignments } };
}

function writeChatRoles(chatId, mutate) {
    const state = loadChatState(chatId);
    const roles = rolesOf(state);
    mutate(roles);
    state.roles = roles;
    saveChatState(chatId, state);
}

// The variable definitions of the presets active in `chatId`, by name.
function activeVariables(chatId) {
    const byName = new Map();
    for (const def of Object.values(getAllVariablesFromPresets(getPresetsForChat(chatId)) || {})) {
        if (def && typeof def.name === 'string' && def.name) byName.set(def.name, def);
    }
    return byName;
}

// Any preset's definition of `variableName` (active or not), or null.
function anyVariable(variableName) {
    for (const preset of Object.values(getSettings().presets || {})) {
        for (const def of Object.values(preset?.variables || {})) {
            if (def?.name === variableName) return def;
        }
    }
    return null;
}

// --------------------------------------------------------------- requests

function requestStore() {
    const settings = getSettings();
    if (!settings.roleRequests || typeof settings.roleRequests !== 'object') settings.roleRequests = {};
    return settings.roleRequests;
}

function requestId(chatId, key) {
    return `${chatId ?? '*'}::${key}`;
}

// Replaces `extensionId`'s request `key` (for `chatId`, or every chat when
// chatId is null). An empty role list removes the request. Roles are
// validated first (throws); a role named twice keeps its first spec.
// Returns true if anything changed (an identical request is not rewritten).
export function setRoleRequest(extensionId, { key, chatId = null, label = '', roles = [] }) {
    if (typeof key !== 'string' || !key.trim()) throw new Error('role request key must be a non-empty string');
    if (chatId !== null && (typeof chatId !== 'string' || !chatId)) throw new Error('role request chatId must be a chat id or null');
    if (!Array.isArray(roles)) throw new Error('role request roles must be an array');
    const seen = new Set();
    const normalized = [];
    roles.forEach((spec, i) => {
        const role = normalizeRoleSpec(spec, `requested role #${i + 1}`);
        if (seen.has(role.name)) return;
        seen.add(role.name);
        normalized.push(role);
    });

    const store = requestStore();
    const id = requestId(chatId, key.trim());
    const mine = store[extensionId] ?? {};
    const before = mine[id];
    if (normalized.length === 0) {
        if (!before) return false;
        delete mine[id];
        if (Object.keys(mine).length === 0) delete store[extensionId];
        persistSettings();
        return true;
    }
    const next = { key: key.trim(), label: text(label, MAX_LABEL_LENGTH), chatId, roles: normalized };
    if (before && JSON.stringify({ ...before, updatedAt: undefined }) === JSON.stringify({ ...next, updatedAt: undefined })) return false;
    store[extensionId] = { ...mine, [id]: { ...next, updatedAt: Date.now() } };
    persistSettings();
    return true;
}

// Every request that applies to `chatId` (every-chat requests plus that
// chat's own), as [{ extensionId, key, label, chatId, roles }] - copies.
export function getRoleRequests(chatId) {
    const out = [];
    for (const [extensionId, requests] of Object.entries(requestStore())) {
        for (const request of Object.values(requests || {})) {
            if (!request || !Array.isArray(request.roles)) continue;
            if (request.chatId !== null && request.chatId !== chatId) continue;
            out.push({ extensionId, key: request.key, label: request.label ?? '', chatId: request.chatId, roles: structuredClone(request.roles) });
        }
    }
    return out.sort((a, b) => a.extensionId.localeCompare(b.extensionId) || a.key.localeCompare(b.key));
}

// ------------------------------------------------------------ resolution

// Why an assignment does not fulfil its role, or null if it does.
function assignmentProblem(roleType, variableName, active) {
    const def = active.get(variableName);
    if (!def) {
        return anyVariable(variableName)
            ? `"${variableName}" belongs to a preset that is not active in this chat`
            : `"${variableName}" no longer exists`;
    }
    if (!variableTypeFitsRole(roleType, def.type)) return `"${variableName}" is a ${def.type} variable, but this role needs ${roleType}`;
    return null;
}

// Every role of `chatId` - defined ones and requested ones - with its
// assignment and whether that assignment is usable:
//   [{ name, type, label, description, defined, requestedBy: [{ extensionId, label }],
//      variable: name|null, valid, problem: string|null }]
// A role both defined and requested keeps its definition's type; a request
// asking for a different type is reported as a problem. Sorted by name.
export function listChatRoles(chatId) {
    const { definitions, assignments } = rolesOf(loadChatState(chatId));
    const active = activeVariables(chatId);
    const roles = new Map();

    for (const def of Object.values(definitions)) {
        if (!def || !isValidRoleName(def.name)) continue;
        roles.set(def.name, {
            name: def.name, type: isValidRoleType(def.type) ? def.type : 'any', label: def.label ?? '', description: def.description ?? '',
            defined: true, requestedBy: [], requestedTypes: [],
        });
    }
    for (const request of getRoleRequests(chatId)) {
        for (const spec of request.roles) {
            let role = roles.get(spec.name);
            if (!role) {
                role = { name: spec.name, type: spec.type, label: spec.label, description: spec.description, defined: false, requestedBy: [], requestedTypes: [] };
                roles.set(spec.name, role);
            }
            role.requestedBy.push({ extensionId: request.extensionId, label: request.label });
            role.requestedTypes.push(spec.type);
        }
    }

    return [...roles.values()]
        .map(({ requestedTypes, ...role }) => {
            const variable = typeof assignments[role.name] === 'string' && assignments[role.name] ? assignments[role.name] : null;
            let problem = variable ? assignmentProblem(role.type, variable, active) : null;
            if (!problem && variable) {
                // A request wanting a different type than the role's own.
                const def = active.get(variable);
                const unmet = requestedTypes.find((type) => !variableTypeFitsRole(type, def.type));
                if (unmet) problem = `an extension needs this role to be ${unmet}, but "${variable}" is a ${def.type} variable`;
            }
            return { ...role, variable, valid: !!variable && !problem, problem };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

// The roles `chatId` needs that are not fulfilled: every requested role
// without a valid assignment. -> [role entries as listChatRoles gives them]
export function missingRoles(chatId) {
    return listChatRoles(chatId).filter((role) => role.requestedBy.length > 0 && !role.valid);
}

// For an extension rendering by role: the status of `specs` (role names, or
// { name, type } specs) in `chatId`. A name the chat does not know is
// reported missing; a spec's type is checked against the assigned
// variable.
//   { roles: [{ name, type, exists, assigned, variable, valid, problem }], missing: [names], allAssigned }
export function resolveRoles(chatId, specs) {
    const known = new Map(listChatRoles(chatId).map((role) => [role.name, role]));
    const active = activeVariables(chatId);
    const roles = (Array.isArray(specs) ? specs : []).map((spec) => {
        const name = typeof spec === 'string' ? spec : spec?.name;
        const role = known.get(name);
        const type = (typeof spec === 'object' && isValidRoleType(spec?.type) ? spec.type : null) ?? role?.type ?? 'any';
        if (!role) return { name, type, exists: false, assigned: false, variable: null, valid: false, problem: 'not defined or requested in this chat' };
        let problem = role.variable ? role.problem : 'not assigned';
        if (!problem && role.variable && !variableTypeFitsRole(type, active.get(role.variable)?.type)) {
            problem = `"${role.variable}" is a ${active.get(role.variable)?.type} variable, but ${type} is needed`;
        }
        return { name, type, exists: true, assigned: !!role.variable, variable: role.variable, valid: !problem, problem };
    });
    const missing = roles.filter((r) => !r.valid).map((r) => r.name);
    return { roles, missing, allAssigned: missing.length === 0 };
}

// ------------------------------------------------------------- mutations

// Defines a role in `chatId`. Throws if the spec is invalid or the chat
// already defines a role by that name. Returns the stored definition.
export function createChatRole(chatId, spec) {
    if (!chatId) throw new Error('createRole needs a chat');
    const role = normalizeRoleSpec(spec);
    const { definitions } = rolesOf(loadChatState(chatId));
    if (definitions[role.name]) throw new Error(`role "${role.name}" already exists in this chat`);
    const stored = { ...role, createdAt: Date.now() };
    writeChatRoles(chatId, (roles) => { roles.definitions[role.name] = stored; });
    return structuredClone(stored);
}

// Removes a role this chat DEFINED, with its assignment. A role that is
// only requested cannot be deleted (the extension asking for it still needs
// it). Returns true if a definition was removed.
export function deleteChatRole(chatId, name) {
    if (!chatId || !isValidRoleName(name)) return false;
    const { definitions } = rolesOf(loadChatState(chatId));
    if (!definitions[name]) return false;
    writeChatRoles(chatId, (roles) => {
        delete roles.definitions[name];
        delete roles.assignments[name];
    });
    return true;
}

// Assigns `variableName` to the role `name` in `chatId` (null/'' clears the
// assignment). The role must be defined in or requested for this chat; the
// variable must belong to a preset active in this chat and its type must
// fit the role. Throws with the reason otherwise. Returns the role's entry
// (as listChatRoles gives it).
export function assignChatRole(chatId, name, variableName) {
    if (!chatId) throw new Error('assignRole needs a chat');
    const role = listChatRoles(chatId).find((r) => r.name === name);
    if (!role) throw new Error(`role ${JSON.stringify(name)} is not defined or requested in this chat`);
    if (variableName === null || variableName === undefined || variableName === '') {
        writeChatRoles(chatId, (roles) => { delete roles.assignments[name]; });
    } else {
        if (typeof variableName !== 'string') throw new Error('variable name must be a string');
        const problem = assignmentProblem(role.type, variableName, activeVariables(chatId));
        if (problem) throw new Error(`cannot assign: ${problem}`);
        writeChatRoles(chatId, (roles) => { roles.assignments[name] = variableName; });
    }
    return listChatRoles(chatId).find((r) => r.name === name);
}

// The variables of `chatId`'s active presets that could fulfil a role of
// `roleType`: [{ name, label, type }] sorted by label. For the Roles tab's
// assignment dropdown - it only ever offers existing variables.
export function candidateVariables(chatId, roleType) {
    return [...activeVariables(chatId).values()]
        .filter((def) => variableTypeFitsRole(roleType, def.type))
        .map((def) => ({ name: def.name, label: def.label || def.name, type: def.type }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

// New chat start (spec 1.14.1): copies `sourceChatId`'s role definitions,
// and the assignments whose variable `targetChatId`'s active presets define,
// into `targetChatId`. Existing definitions/assignments in the target are
// kept. Returns the number of roles copied (definitions + assignments).
export function copyChatRoles(sourceChatId, targetChatId) {
    const source = rolesOf(loadChatState(sourceChatId));
    const active = activeVariables(targetChatId);
    let copied = 0;
    const definitions = Object.values(source.definitions).filter((def) => def && isValidRoleName(def.name));
    const assignments = Object.entries(source.assignments).filter(([name, variable]) => isValidRoleName(name) && active.has(variable));
    if (definitions.length === 0 && assignments.length === 0) return 0;
    writeChatRoles(targetChatId, (roles) => {
        for (const def of definitions) {
            if (roles.definitions[def.name]) continue;
            roles.definitions[def.name] = structuredClone(def);
            copied++;
        }
        for (const [name, variable] of assignments) {
            if (roles.assignments[name]) continue;
            roles.assignments[name] = variable;
            copied++;
        }
    });
    return copied;
}
