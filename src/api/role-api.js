// Role API (requirements spec 1.40, namespaced 1.41)
//
// A role is a GLOBAL semantic tag for what a variable represents; each chat
// assigns it one of its variables. Roles are namespaced like variables:
// id = "<namespace>__<publicName>" ("prettyPanels__scene.title"). See
// src/core/roles.js for the model.
//
//   listRoles          every role, as seen from a chat (assignment,
//                      validity, who requested it)        (GET  /roles)
//   createRole         define a role in your namespace     (POST /roles/create)
//   updateRole         rename / retype / relabel one of your roles (a
//                      rename moves every chat's assignment with it)
//   deleteRole         delete one of your roles (and its assignments)
//   setNamespaceRoles  replace ALL of your namespace's roles with a list
//                      (keeping an extension's roles in step with its data)
//   assignRole         assign a variable to a role in a chat, or clear it
//                                                          (POST /roles/assign)
//   getRoleCandidates  the chat's existing variables that could fulfil a role
//   getRequiredRoles   the roles extensions request for a chat
//                                                          (GET  /roles/required)
//   requestRoles       declare which roles (ids) your extension needs, for
//                      every chat or one chat
//   resolveRoles       the status of a set of role ids in a chat
//   getRoleTypes       text, number, boolean, date, image, list, any
//
// Identity: defining, updating, deleting and setNamespaceRoles are
// OWNER-ONLY - the role's namespace must be the caller's (validateCallerIdentity),
// exactly like variables. Reads, assignments and requests are open to any
// registered caller (resolveCallerRecord) - assignments belong to the chat,
// not to a namespace. Identity failures throw (outside the try/catch, like
// every API entry point); any other rejection is logged and returns null
// (false for deleteRole), with nothing written. Values are copies.
//
// Role changes emit State Engine's variables-changed event
// (VARIABLES_CHANGED_EVENT) - for one chat when an assignment changes, for
// every chat (null) when a definition does.

import { LOG_PREFIX } from '../core/settings-core.js';
import { validateCallerIdentity, resolveCallerRecord } from './identity.js';
import {
    ROLE_TYPES, parseRoleId, listChatRoles, defineRole, updateRole as updateRoleDefinition, deleteRole as deleteRoleDefinition,
    setNamespaceRoles as replaceNamespaceRoles, assignChatRole, candidateVariables, setRoleRequest, resolveRoles as resolveChatRoles,
} from '../core/roles.js';

function rejected(fnName, err) {
    console.warn(LOG_PREFIX, `${fnName} rejected: ${err?.message ?? err}`);
    return null;
}

// The namespace a role id belongs to, for the owner check (a malformed id
// is checked against no namespace, which the identity check refuses).
function namespaceOf(id) {
    return parseRoleId(id)?.namespace ?? '';
}

// Every role - every definition, plus ids requested in the chat that nobody
// defined - as seen from `chatId` (optional; without it, no assignments):
// [{ id, namespace, publicName, type, label, description, exists,
//    requestedBy: [{ extensionId, label }], variable, valid, problem }],
// sorted by publicName then namespace.
export function listRoles(extensionId, instanceId, chatId = null) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return listChatRoles(chatId || null);
    } catch (err) {
        console.warn(LOG_PREFIX, 'listRoles failed (gracefully handled)', err);
        return [];
    }
}

// Defines a role: { namespace?, publicName, type, label?, description? }.
// `namespace` defaults to the caller's own and must be one it owns.
// `publicName` is lowercase words separated by dots ("scene.title"); a
// namespace never holds two roles with the same publicName. Returns the
// definition ({ id, namespace, publicName, type, label, description,
// createdAt, updatedAt }), or null.
export function createRole(extensionId, instanceId, spec) {
    const record = resolveCallerRecord(extensionId, instanceId);
    const namespace = spec?.namespace ?? record.namespace;
    validateCallerIdentity(extensionId, instanceId, namespace);
    try {
        return defineRole(namespace, spec);
    } catch (err) {
        return rejected('createRole', err);
    }
}

// Changes one of the caller's roles: { publicName?, type?, label?,
// description? }. A new publicName gives the role a new id; every chat's
// assignment and every request move with it. Returns the definition, or null.
export function updateRole(extensionId, instanceId, id, patch) {
    validateCallerIdentity(extensionId, instanceId, namespaceOf(id));
    try {
        return updateRoleDefinition(id, patch);
    } catch (err) {
        return rejected('updateRole', err);
    }
}

// Deletes one of the caller's roles, with its assignment in every chat.
// Returns true if it existed.
export function deleteRole(extensionId, instanceId, id) {
    validateCallerIdentity(extensionId, instanceId, namespaceOf(id));
    try {
        return deleteRoleDefinition(id);
    } catch (err) {
        rejected('deleteRole', err);
        return false;
    }
}

// Replaces every role in the caller's namespace with `roles`
// ([{ publicName, type, label?, description? }]): roles that stay keep their
// assignments, roles left out are deleted. Returns { added, updated,
// removed } (ids), or null.
export function setNamespaceRoles(extensionId, instanceId, roles) {
    const record = resolveCallerRecord(extensionId, instanceId);
    try {
        return replaceNamespaceRoles(record.namespace, roles);
    } catch (err) {
        return rejected('setNamespaceRoles', err);
    }
}

// Assigns `variableName` (fully qualified, e.g. "se__scene_title") to role
// `id` in `chatId`; null clears it. The variable must belong to a preset
// active in the chat and its type must fit the role. Returns the role's
// entry (as listRoles gives it), or null.
export function assignRole(extensionId, instanceId, chatId, id, variableName) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return assignChatRole(chatId, id, variableName ?? null);
    } catch (err) {
        return rejected('assignRole', err);
    }
}

// The variables of `chatId`'s active presets that could fulfil role `id`:
// [{ name, label, type }] sorted by label ([] for an unknown role).
export function getRoleCandidates(extensionId, instanceId, chatId, id) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return candidateVariables(chatId, id);
    } catch (err) {
        console.warn(LOG_PREFIX, 'getRoleCandidates failed (gracefully handled)', err);
        return [];
    }
}

// The roles extensions request for `chatId` (every-chat requests plus that
// chat's own), each as listRoles gives it - requestedBy says who.
export function getRequiredRoles(extensionId, instanceId, chatId) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return chatId ? listChatRoles(chatId).filter((role) => role.requestedBy.length > 0) : [];
    } catch (err) {
        console.warn(LOG_PREFIX, 'getRequiredRoles failed (gracefully handled)', err);
        return [];
    }
}

// Declares the roles the caller needs: { key, label?, chatId?, roles:
// [role ids] } (any namespace; an id nobody defined is reported missing).
// `key` names the request (one per key per chat); `chatId` limits it to one
// chat (omit or null for every chat); `label` says what needs them ("Pretty
// Panels layout \"HUD\""). Replaces the caller's earlier request under the
// same key and chat; an empty `roles` removes it. Returns true if anything
// changed, false if not, null if rejected.
export function requestRoles(extensionId, instanceId, request) {
    const record = resolveCallerRecord(extensionId, instanceId);
    try {
        return setRoleRequest(record.id ?? extensionId, { ...request, chatId: request?.chatId ?? null });
    } catch (err) {
        return rejected('requestRoles', err);
    }
}

// The status of role `ids` in `chatId`:
//   { roles: [{ id, namespace, publicName, type, exists, assigned, variable, valid, problem }],
//     missing: [ids], allAssigned }
export function resolveRoles(extensionId, instanceId, chatId, ids) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return resolveChatRoles(chatId || null, ids);
    } catch (err) {
        return rejected('resolveRoles', err);
    }
}

export function getRoleTypes() {
    return [...ROLE_TYPES];
}
