// State Engine — Roles (requirements spec 1.40, namespaced 1.41)
//
// A role is a semantic tag for what a variable represents ("scene.title",
// "character.health"). Roles hold no value and are not variables. A role is
// a GLOBAL concept - defined once, available in every chat - and each chat
// ASSIGNS it one of its variables.
//
// Every role belongs to a namespace, exactly like a variable: the State
// Engine namespace of whoever defined it (Pretty Panels' layout roles are
// "prettyPanels", roles the user creates in the manager's Roles tab are
// "se"). Its id joins the two with the same delimiter variables use:
//   id = `${namespace}__${publicName}`         "prettyPanels__scene.title"
// Lists show the publicName; the namespace / id appear on hover and in
// advanced views. Two roles with the same publicName in different
// namespaces are different roles; a namespace never holds two roles with
// the same publicName.
//
// Storage:
//   settings.variableStore.roles.globalDefinitions =
//       { [id]: { id, namespace, publicName, type, label, description, createdAt, updatedAt } }
//   chat state (chat-state.js), per chat:
//       state.roles = { assignments: { [roleId]: variableName } }
//   settings.roleRequests - which roles an extension needs, for every chat or
//       one chat: { [extensionId]: { [requestId]: { key, label, chatId, roles: [roleId], updatedAt } } }
//       requestId is `${chatId ?? '*'}::${key}` (Pretty Panels keeps one per
//       chat: the roles of the layout chosen there).
//
// This module holds the rules and the storage; src/api/role-api.js is the
// public, identity-checked API, and the manager modal's Roles tab calls this
// module directly (through manager-api.js) like every other tab.

import { getSettings, persistSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { loadChatState, saveChatState } from './chat-state.js';
import { notifyVariablesChanged } from './variable-change-signal.js';

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

// publicName: "scene.title", "character.health", "quest_current" -
// lowercase words separated by dots, at most 64 characters. Namespace: a
// State Engine namespace (letters and digits, starting with a letter).
const PUBLIC_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const NAMESPACE = /^[A-Za-z][A-Za-z0-9]*$/;
const MAX_PUBLIC_NAME_LENGTH = 64;
const MAX_LABEL_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const DELIMITER = '__';

export function isValidPublicName(name) {
    return typeof name === 'string' && name.length <= MAX_PUBLIC_NAME_LENGTH && PUBLIC_NAME.test(name);
}

export function isValidRoleType(type) {
    return ROLE_TYPES.includes(type);
}

export function roleId(namespace, publicName) {
    return `${namespace}${DELIMITER}${publicName}`;
}

// "prettyPanels__scene.title" -> { namespace, publicName }, or null.
export function parseRoleId(id) {
    if (typeof id !== 'string') return null;
    const at = id.indexOf(DELIMITER);
    if (at <= 0) return null;
    const namespace = id.slice(0, at);
    const publicName = id.slice(at + DELIMITER.length);
    return NAMESPACE.test(namespace) && isValidPublicName(publicName) ? { namespace, publicName } : null;
}

// Whether a variable of `variableType` can fulfil a role of `roleType`.
export function variableTypeFitsRole(roleType, variableType) {
    if (roleType === 'any') return typeof variableType === 'string' && variableType !== '';
    return (ACCEPTED_VARIABLE_TYPES[roleType] ?? []).includes(variableType);
}

// The variable types a role of `roleType` accepts, or null for 'any'.
export function acceptedVariableTypes(roleType) {
    return roleType === 'any' ? null : [...(ACCEPTED_VARIABLE_TYPES[roleType] ?? [])];
}

function text(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// A role spec ({ publicName, type, label?, description? }) validated and
// copied. Throws with a reason.
export function normalizeRoleSpec(spec, what = 'role') {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`${what} must be an object`);
    const publicName = typeof spec.publicName === 'string' ? spec.publicName.trim() : '';
    if (!isValidPublicName(publicName)) {
        throw new Error(`${what} name ${JSON.stringify(spec.publicName)} is not valid - use lowercase words separated by dots, e.g. "scene.title" (max ${MAX_PUBLIC_NAME_LENGTH} characters)`);
    }
    const type = spec.type ?? 'any';
    if (!isValidRoleType(type)) throw new Error(`${what} "${publicName}" has unknown type ${JSON.stringify(type)} (use one of: ${ROLE_TYPES.join(', ')})`);
    return { publicName, type, label: text(spec.label, MAX_LABEL_LENGTH), description: text(spec.description, MAX_DESCRIPTION_LENGTH) };
}

// ------------------------------------------------------- global definitions

function definitionStore() {
    const settings = getSettings();
    const store = settings.variableStore;
    if (!store.roles || typeof store.roles !== 'object') store.roles = {};
    if (!store.roles.globalDefinitions || typeof store.roles.globalDefinitions !== 'object') store.roles.globalDefinitions = {};
    return store.roles.globalDefinitions;
}

// Every role definition (copies), sorted by publicName then namespace - so
// roles sharing a publicName sit together.
export function listRoleDefinitions() {
    return Object.values(definitionStore())
        .filter((def) => def && parseRoleId(def.id))
        .map((def) => structuredClone(def))
        .sort((a, b) => a.publicName.localeCompare(b.publicName) || a.namespace.localeCompare(b.namespace));
}

export function getRoleDefinition(id) {
    const def = definitionStore()[id];
    return def ? structuredClone(def) : null;
}

// Defines a role in `namespace`. Throws if the spec is invalid or the
// namespace already has a role with that publicName. Returns the definition.
export function defineRole(namespace, spec) {
    if (!NAMESPACE.test(namespace ?? '')) throw new Error(`role namespace ${JSON.stringify(namespace)} is not valid`);
    const role = normalizeRoleSpec(spec);
    const id = roleId(namespace, role.publicName);
    const store = definitionStore();
    if (store[id]) throw new Error(`a role named "${role.publicName}" already exists in namespace "${namespace}"`);
    const now = Date.now();
    store[id] = { id, namespace, ...role, createdAt: now, updatedAt: now };
    persistSettings();
    notifyVariablesChanged(null);
    return structuredClone(store[id]);
}

// Changes a role's type, label, description and/or publicName. A new
// publicName changes the id: every chat's assignment and every extension
// request follow it. Throws if the role is unknown, the patch invalid, or
// the new publicName is taken in the namespace. Returns the definition.
export function updateRole(id, patch) {
    const store = definitionStore();
    const current = store[id];
    if (!current) throw new Error(`role ${JSON.stringify(id)} does not exist`);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('role patch must be an object');
    const next = normalizeRoleSpec({
        publicName: patch.publicName ?? current.publicName,
        type: patch.type ?? current.type,
        label: patch.label ?? current.label,
        description: patch.description ?? current.description,
    });
    const nextId = roleId(current.namespace, next.publicName);
    if (nextId !== id && store[nextId]) throw new Error(`a role named "${next.publicName}" already exists in namespace "${current.namespace}"`);
    const updated = { ...current, ...next, id: nextId, updatedAt: Date.now() };
    if (nextId !== id) {
        delete store[id];
        renameRoleReferences(id, nextId);
    }
    store[nextId] = updated;
    persistSettings();
    notifyVariablesChanged(null);
    return structuredClone(updated);
}

// Removes a role, its assignment in every chat, and it from every request.
// Returns true if it existed.
export function deleteRole(id) {
    const store = definitionStore();
    if (!store[id]) return false;
    delete store[id];
    renameRoleReferences(id, null);
    persistSettings();
    notifyVariablesChanged(null);
    return true;
}

// Replaces every role of `namespace` with `specs` (an extension keeping its
// roles in step with its own data - Pretty Panels' layout roles). Roles
// whose publicName stays keep their id, assignments and createdAt; roles no
// longer listed are deleted like deleteRole. A publicName twice in `specs`
// is refused. Returns { added, updated, removed } (ids).
export function setNamespaceRoles(namespace, specs) {
    if (!NAMESPACE.test(namespace ?? '')) throw new Error(`role namespace ${JSON.stringify(namespace)} is not valid`);
    if (!Array.isArray(specs)) throw new Error('roles must be an array');
    const wanted = new Map();
    specs.forEach((spec, i) => {
        const role = normalizeRoleSpec(spec, `role #${i + 1}`);
        if (wanted.has(role.publicName)) throw new Error(`role "${role.publicName}" is listed twice`);
        wanted.set(role.publicName, role);
    });
    const store = definitionStore();
    const result = { added: [], updated: [], removed: [] };
    const now = Date.now();
    for (const def of Object.values(store)) {
        if (def?.namespace !== namespace || wanted.has(def.publicName)) continue;
        delete store[def.id];
        renameRoleReferences(def.id, null);
        result.removed.push(def.id);
    }
    for (const role of wanted.values()) {
        const id = roleId(namespace, role.publicName);
        const current = store[id];
        if (!current) {
            store[id] = { id, namespace, ...role, createdAt: now, updatedAt: now };
            result.added.push(id);
        } else if (current.type !== role.type || current.label !== role.label || current.description !== role.description) {
            store[id] = { ...current, ...role, updatedAt: now };
            result.updated.push(id);
        }
    }
    if (result.added.length || result.updated.length || result.removed.length) {
        persistSettings();
        notifyVariablesChanged(null);
    }
    return result;
}

// Moves (or, with `to` null, drops) every reference to role `from`: each
// chat's assignment and each extension request.
function renameRoleReferences(from, to) {
    for (const [chatId, state] of Object.entries(getSettings().variableStore?.chats || {})) {
        const assignments = state?.roles?.assignments;
        if (!assignments || !(from in assignments)) continue;
        if (to && !(to in assignments)) assignments[to] = assignments[from];
        delete assignments[from];
        saveChatState(chatId, state);
    }
    for (const requests of Object.values(requestStore())) {
        for (const request of Object.values(requests || {})) {
            if (!Array.isArray(request?.roles) || !request.roles.includes(from)) continue;
            request.roles = [...new Set(request.roles.map((r) => (r === from ? to : r)).filter(Boolean))];
        }
    }
}

// --------------------------------------------------------- per-chat storage

function assignmentsOf(state) {
    const assignments = state.roles?.assignments;
    return assignments && typeof assignments === 'object' ? assignments : {};
}

// A chat's assignments (copy): { [roleId]: variableName }.
export function getChatAssignments(chatId) {
    return { ...assignmentsOf(loadChatState(chatId)) };
}

function writeAssignments(chatId, mutate) {
    const state = loadChatState(chatId);
    const assignments = { ...assignmentsOf(state) };
    mutate(assignments);
    state.roles = { assignments };
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
// chatId is null) with `roles` - role ids. An id need not be defined (it is
// then reported missing). An empty list removes the request. Returns true
// if anything changed (an identical request is not rewritten).
export function setRoleRequest(extensionId, { key, chatId = null, label = '', roles = [] }) {
    if (typeof key !== 'string' || !key.trim()) throw new Error('role request key must be a non-empty string');
    if (chatId !== null && (typeof chatId !== 'string' || !chatId)) throw new Error('role request chatId must be a chat id or null');
    if (!Array.isArray(roles)) throw new Error('role request roles must be an array of role ids');
    const ids = [];
    for (const id of roles) {
        if (!parseRoleId(id)) throw new Error(`${JSON.stringify(id)} is not a role id (expected "<namespace>__<name>", e.g. "se__scene.title")`);
        if (!ids.includes(id)) ids.push(id);
    }

    const store = requestStore();
    const rid = requestId(chatId, key.trim());
    const mine = store[extensionId] ?? {};
    const before = mine[rid];
    if (ids.length === 0) {
        if (!before) return false;
        delete mine[rid];
        if (Object.keys(mine).length === 0) delete store[extensionId];
        persistSettings();
        return true;
    }
    const next = { key: key.trim(), label: text(label, MAX_LABEL_LENGTH), chatId, roles: ids };
    if (before && before.label === next.label && JSON.stringify(before.roles) === JSON.stringify(ids)) return false;
    store[extensionId] = { ...mine, [rid]: { ...next, updatedAt: Date.now() } };
    persistSettings();
    return true;
}

// Every request that applies to `chatId` (every-chat requests plus that
// chat's own): [{ extensionId, key, label, chatId, roles: [ids] }].
export function getRoleRequests(chatId) {
    const out = [];
    for (const [extensionId, requests] of Object.entries(requestStore())) {
        for (const request of Object.values(requests || {})) {
            if (!request || !Array.isArray(request.roles)) continue;
            if (request.chatId !== null && request.chatId !== chatId) continue;
            out.push({ extensionId, key: request.key, label: request.label ?? '', chatId: request.chatId, roles: [...request.roles] });
        }
    }
    return out.sort((a, b) => a.extensionId.localeCompare(b.extensionId) || a.key.localeCompare(b.key));
}

// ------------------------------------------------------------ resolution

// Why an assignment does not fulfil a role of `roleType`, or null.
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

// One role as seen from a chat.
function roleEntry(def, id, chatContext) {
    const { assignments, active, requestedBy } = chatContext;
    const parsed = parseRoleId(id);
    const variable = typeof assignments[id] === 'string' && assignments[id] ? assignments[id] : null;
    const base = def
        ? { id, namespace: def.namespace, publicName: def.publicName, type: def.type, label: def.label ?? '', description: def.description ?? '', exists: true }
        : { id, namespace: parsed?.namespace ?? '', publicName: parsed?.publicName ?? id, type: 'any', label: '', description: '', exists: false };
    let problem = null;
    if (!def) problem = 'this role is not defined';
    else if (variable) problem = assignmentProblem(def.type, variable, active);
    return { ...base, requestedBy: requestedBy.get(id) ?? [], variable, valid: !!def && !!variable && !problem, problem };
}

function chatContext(chatId) {
    const requestedBy = new Map();
    for (const request of chatId ? getRoleRequests(chatId) : []) {
        for (const id of request.roles) {
            if (!requestedBy.has(id)) requestedBy.set(id, []);
            requestedBy.get(id).push({ extensionId: request.extensionId, label: request.label });
        }
    }
    return {
        assignments: chatId ? assignmentsOf(loadChatState(chatId)) : {},
        active: chatId ? activeVariables(chatId) : new Map(),
        requestedBy,
    };
}

// Every role - every definition, plus requested ids nobody defined - as seen
// from `chatId` (assignment, validity, who requested it there):
//   [{ id, namespace, publicName, type, label, description, exists,
//      requestedBy: [{ extensionId, label }], variable, valid, problem }]
// Sorted by publicName then namespace. Without a chat, no assignments.
export function listChatRoles(chatId) {
    const context = chatContext(chatId);
    const defs = definitionStore();
    const ids = new Set(Object.keys(defs).filter((id) => parseRoleId(id)));
    for (const id of context.requestedBy.keys()) ids.add(id);
    return [...ids]
        .map((id) => roleEntry(defs[id] ?? null, id, context))
        .sort((a, b) => a.publicName.localeCompare(b.publicName) || a.namespace.localeCompare(b.namespace));
}

// The roles `chatId` needs that are not fulfilled: every requested role
// without a valid assignment.
export function missingRoles(chatId) {
    return listChatRoles(chatId).filter((role) => role.requestedBy.length > 0 && !role.valid);
}

// For an extension rendering by role: the status of `ids` in `chatId`.
//   { roles: [{ id, namespace, publicName, type, exists, assigned, variable, valid, problem }],
//     missing: [ids], allAssigned }
export function resolveRoles(chatId, ids) {
    const context = chatContext(chatId);
    const defs = definitionStore();
    const roles = (Array.isArray(ids) ? ids : []).map((id) => {
        const entry = roleEntry(defs[id] ?? null, id, context);
        const problem = entry.problem ?? (entry.variable ? null : 'not assigned');
        return {
            id, namespace: entry.namespace, publicName: entry.publicName, type: entry.type,
            exists: entry.exists, assigned: !!entry.variable, variable: entry.variable, valid: !problem, problem,
        };
    });
    const missing = roles.filter((r) => !r.valid).map((r) => r.id);
    return { roles, missing, allAssigned: missing.length === 0 };
}

// ------------------------------------------------------------- assignment

// Assigns `variableName` to role `id` in `chatId` (null/'' clears it). The
// role must be defined; the variable must belong to a preset active in the
// chat and fit the role's type. Throws with the reason otherwise. Returns
// the role's entry (as listChatRoles gives it).
export function assignChatRole(chatId, id, variableName) {
    if (!chatId) throw new Error('assignRole needs a chat');
    const def = definitionStore()[id];
    if (!def) throw new Error(`role ${JSON.stringify(id)} is not defined`);
    if (variableName === null || variableName === undefined || variableName === '') {
        writeAssignments(chatId, (assignments) => { delete assignments[id]; });
    } else {
        if (typeof variableName !== 'string') throw new Error('variable name must be a string');
        const problem = assignmentProblem(def.type, variableName, activeVariables(chatId));
        if (problem) throw new Error(`cannot assign: ${problem}`);
        writeAssignments(chatId, (assignments) => { assignments[id] = variableName; });
    }
    return listChatRoles(chatId).find((r) => r.id === id);
}

// The variables of `chatId`'s active presets that could fulfil role `id`:
// [{ name, label, type }] sorted by label. It only ever offers existing
// variables.
export function candidateVariables(chatId, id) {
    const def = definitionStore()[id];
    if (!def || !chatId) return [];
    return [...activeVariables(chatId).values()]
        .filter((variable) => variableTypeFitsRole(def.type, variable.type))
        .map((variable) => ({ name: variable.name, label: variable.label || variable.name, type: variable.type }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

// New chat start (spec 1.14.1): copies `sourceChatId`'s assignments to
// variables `targetChatId`'s active presets define (definitions are global
// already). Existing assignments in the target are kept. Returns the
// number copied.
export function copyChatRoles(sourceChatId, targetChatId) {
    const source = assignmentsOf(loadChatState(sourceChatId));
    const active = activeVariables(targetChatId);
    const copy = Object.entries(source).filter(([id, variable]) => parseRoleId(id) && active.has(variable));
    if (copy.length === 0) return 0;
    let copied = 0;
    writeAssignments(targetChatId, (assignments) => {
        for (const [id, variable] of copy) {
            if (assignments[id]) continue;
            assignments[id] = variable;
            copied++;
        }
    });
    return copied;
}

// ---------------------------------------------------------------- migration

// Role data from before namespaces (1.40 as first released): roles defined
// per chat (`state.roles.definitions`, keyed by bare name) become global
// "se" roles; bare-name assignments move to that id (or, for a role only an
// extension requested, to that extension's namespace if it defines the
// name); old request specs ({ name, type }) are dropped - every extension
// re-sends its request when a chat opens. Idempotent; run on startup.
export function migrateRoleData() {
    let changed = false;
    const defs = definitionStore();
    for (const [chatId, state] of Object.entries(getSettings().variableStore?.chats || {})) {
        const roles = state?.roles;
        if (!roles || typeof roles !== 'object') continue;
        const hasOld = roles.definitions || Object.keys(roles.assignments || {}).some((key) => !parseRoleId(key));
        if (!hasOld) continue;
        for (const def of Object.values(roles.definitions || {})) {
            if (!def || !isValidPublicName(def.name)) continue;
            const id = roleId('se', def.name);
            if (!defs[id]) {
                defs[id] = {
                    id, namespace: 'se', publicName: def.name, type: isValidRoleType(def.type) ? def.type : 'any',
                    label: def.label ?? '', description: def.description ?? '', createdAt: def.createdAt ?? Date.now(), updatedAt: Date.now(),
                };
            }
        }
        const assignments = {};
        for (const [key, variable] of Object.entries(roles.assignments || {})) {
            if (parseRoleId(key)) { assignments[key] = variable; continue; }
            if (!isValidPublicName(key)) continue;
            const owner = Object.values(defs).find((d) => d.publicName === key && d.namespace !== 'se')?.namespace;
            const id = defs[roleId('se', key)] ? roleId('se', key) : (owner ? roleId(owner, key) : null);
            if (id) assignments[id] = variable;
        }
        state.roles = { assignments };
        changed = true;
    }
    for (const [extensionId, requests] of Object.entries(requestStore())) {
        for (const [rid, request] of Object.entries(requests || {})) {
            if (Array.isArray(request?.roles) && request.roles.some((r) => typeof r !== 'string')) {
                delete requests[rid];
                changed = true;
            }
        }
        if (Object.keys(requests || {}).length === 0) {
            delete requestStore()[extensionId];
            changed = true;
        }
    }
    if (changed) persistSettings();
    return changed;
}
