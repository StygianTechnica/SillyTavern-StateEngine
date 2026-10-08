// Role API (requirements spec 1.40)
//
// Roles map MEANING to variables, per chat: "scene.title" -> whichever
// variable this chat uses for it. See src/core/roles.js for the model.
//
//   listRoles         every role of a chat (defined + requested), with its
//                     assigned variable and whether that assignment is
//                     usable                                   (GET  /roles)
//   createRole        define a role in a chat                  (POST /roles/create)
//   deleteRole        remove a role the chat defined
//   assignRole        assign a variable to a role, or clear it (POST /roles/assign)
//   getRequiredRoles  the roles extensions request for a chat  (GET  /roles/required)
//   requestRoles      declare the roles your extension needs, for every
//                     chat or for one chat (replaces your earlier request
//                     under the same key; an empty list removes it)
//   resolveRoles      the status of a set of roles in a chat, for rendering
//                     by role: which exist, are assigned, to what, and
//                     whether the variable's type fits
//   getRoleTypes      the role types: text, number, boolean, date, image, list, any
//
// Open to any registered caller (resolveCallerRecord: right instance, owns
// some namespace) - roles belong to the chat, not to a namespace, and any
// display extension needs them. requestRoles is recorded under the CALLER's
// extension id. Identity failures throw (outside the try/catch, like every
// API entry point); any other rejection is logged and returns null (false
// for deleteRole), never a partial write. Values are copies.
//
// Role changes are saved on the chat's state, so they emit State Engine's
// variables-changed event (VARIABLES_CHANGED_EVENT) like a value write -
// a display extension already listening for that re-resolves its roles.

import { LOG_PREFIX } from '../core/settings-core.js';
import { resolveCallerRecord } from './identity.js';
import {
    ROLE_TYPES, listChatRoles, createChatRole, deleteChatRole, assignChatRole, setRoleRequest, resolveRoles as resolveChatRoles,
} from '../core/roles.js';

function rejected(fnName, err) {
    console.warn(LOG_PREFIX, `${fnName} rejected: ${err?.message ?? err}`);
    return null;
}

// [{ name, type, label, description, defined, requestedBy: [{ extensionId, label }],
//    variable, valid, problem }] for `chatId`, sorted by name. [] without a chat.
export function listRoles(extensionId, instanceId, chatId) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return chatId ? listChatRoles(chatId) : [];
    } catch (err) {
        console.warn(LOG_PREFIX, 'listRoles failed (gracefully handled)', err);
        return [];
    }
}

// Defines a role in `chatId`: { name, type, label?, description? }. `name` is
// lowercase words separated by dots ("scene.title"); `type` one of
// getRoleTypes(). Returns the stored definition, or null (invalid spec, or
// the chat already defines that role).
export function createRole(extensionId, instanceId, chatId, spec) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return createChatRole(chatId, spec);
    } catch (err) {
        return rejected('createRole', err);
    }
}

// Removes a role `chatId` defined, and its assignment. A role that is only
// requested by an extension cannot be deleted. Returns true if removed.
export function deleteRole(extensionId, instanceId, chatId, name) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return deleteChatRole(chatId, name);
    } catch (err) {
        rejected('deleteRole', err);
        return false;
    }
}

// Assigns `variableName` (fully qualified, e.g. "se__scene_title") to the
// role `name` in `chatId`; null clears the assignment. The variable must
// belong to a preset active in the chat and its type must fit the role.
// Returns the role's updated entry (as listRoles gives it), or null.
export function assignRole(extensionId, instanceId, chatId, name, variableName) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return assignChatRole(chatId, name, variableName ?? null);
    } catch (err) {
        return rejected('assignRole', err);
    }
}

// The roles extensions request for `chatId` (every-chat requests plus that
// chat's own), each as listRoles gives it - requestedBy says who asked.
export function getRequiredRoles(extensionId, instanceId, chatId) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return chatId ? listChatRoles(chatId).filter((role) => role.requestedBy.length > 0) : [];
    } catch (err) {
        console.warn(LOG_PREFIX, 'getRequiredRoles failed (gracefully handled)', err);
        return [];
    }
}

// Declares the roles the caller needs:
//   { key, label?, chatId?, roles: [{ name, type, label?, description? }] }
// `key` names the request (one per key per chat); `chatId` limits it to one
// chat (omit or null for every chat); `label` says what needs them, for the
// Roles tab ("Layout: Scene HUD"). Replaces the caller's earlier request
// under the same key and chat; an empty `roles` removes it. Returns true if
// anything changed, false if it was already so, null if rejected.
export function requestRoles(extensionId, instanceId, request) {
    const record = resolveCallerRecord(extensionId, instanceId);
    try {
        return setRoleRequest(record.id ?? extensionId, { ...request, chatId: request?.chatId ?? null });
    } catch (err) {
        return rejected('requestRoles', err);
    }
}

// The status of `roles` (names, or { name, type } specs - a spec's type is
// checked against the assigned variable) in `chatId`:
//   { roles: [{ name, type, exists, assigned, variable, valid, problem }],
//     missing: [names not usable], allAssigned }
export function resolveRoles(extensionId, instanceId, chatId, roles) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        if (!chatId) return { roles: [], missing: [], allAssigned: true };
        return resolveChatRoles(chatId, roles);
    } catch (err) {
        return rejected('resolveRoles', err);
    }
}

export function getRoleTypes() {
    return [...ROLE_TYPES];
}
