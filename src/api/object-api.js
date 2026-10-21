// Object API
//
// Objects are story entities with stable ids - characters, locations,
// factions, items, creatures, lore (world types: canonical in a SETTING,
// unconfirmed per chat) and quests, scenes, events (story types: their
// chat's). What each type is comes from listObjectTypes(); every function
// works for every type. Object variables hold object ids. See
// src/core/objects.js for the rules (confirmed <=> in the setting, merge,
// variants, runtime state).
//
// Types
//   listObjectTypes()   the registry: [{ id, label, plural, noun, scope, idPrefix,
//                        color, icon, hasPresence, fields, runtime, fieldRoles }]
//                        (fields/runtime: the DEFAULT fields a setting starts with)
// Settings
//   listSettings / getSetting / createSetting({ name, autoConfirm? }) /
//   updateSetting / deleteSetting
//   exportSetting(settingId, { ids? }) / importSetting(data, { name?, autoConfirm? })
//   copyObjects(fromSettingId, ids, toSettingId)   new ids, references follow
//   getChatSetting / setChatSetting / ensureChatSetting (async, asks once)
// Objects (an id says its type: "chr_...", "loc_...")
//   listObjects(chatId, type, { settingId? })     a chat's objects of a type, or a setting's
//   getObject(chatId, id, settingId?) / getObjectByAlias(chatId, type, name)
//   createChatObject(chatId, type, name, snippet?, data?)  unconfirmed (world) / the chat's (story)
//   createObject(settingId, type, data)           canonical, confirmed (world types)
//   updateObject(chatId, id, patch, { settingId? })  edits; confirms (-> setting)
//   addObjectAlias / confirmObject / resolveObject / mergeObjects / deleteObject
//   markObjectPresent / markObjectAbsent           types with presence
// Fields - each setting's OBJECT PRESET per type (docs/DESIGN - OBJECT PRESETS.md):
// variable definitions with local names; scope 'global' = baseline (on the
// record, every chat on the setting), 'chat' = runtime (per chat)
//   getObjectFields(settingId, type) / setObjectFields(settingId, type, defs)
//                        a def keeping an existing field's id under a new name renames it
//   getObjectField(chatId, id, fieldOrRole, { settingId? })      a field's value
//   setObjectField(chatId, id, fieldOrRole, value, { settingId? }) baseline or
//                        non-prompted runtime; object fields take names or ids
// Field roles - what a field MEANS ("se__character.mood"); each setting assigns them
//   getObjectFieldRoles(settingId, type)   [{ id, publicName, type, objectType, label, field, assigned }]
//   assignObjectFieldRole(settingId, roleId, fieldName | null)
// Runtime fields - the older view of a setting's chat-scope fields (string/number/enum)
//   getObjectRuntimeFields(settingId, type) / setObjectRuntimeFields(settingId, type, fields)
//   setObjectRuntimeValue(chatId, id, field, value)   a NON-prompted field, by hand
// Variants (one active variant per object, for its setting)
//   addObjectVariant / updateObjectVariant / deleteObjectVariant / setObjectActiveVariant
// Prompt text
//   describeObject(chatId, id)                    an object as prompt-ready text
//   getVariablePromptTexts(chatId, names)         variables' values as prompt text
//                                                 (objects described, not ids)
// The object manager window (lives in a UI extension)
//   registerObjectManager(extensionId, instanceId, opener) / openObjectManager(options)
//
// An object as returned:
//   { id, type, name, aliases, image, description, introduction_snippet,
//     related_entity_ids, related_memory_ids, ...its baseline fields,
//     confirmed, scope: 'chat' | 'setting', settingId, present? (types with presence),
//     matches, runtime: { present?, values, images } | null,
//     activeVariant, variants: [{ id, name, overrides }], base, createdAt, updatedAt }
//
// Every function takes (extensionId, instanceId, ...) first and is open to
// any registered caller (objects belong to settings and chats, not to a
// namespace). Identity failures throw; any other rejection is logged and
// returns null (false for deletes). Changes emit VARIABLES_CHANGED_EVENT.

import { LOG_PREFIX } from '../core/settings-core.js';
import { resolveCallerRecord } from './identity.js';
import * as objects from '../core/objects.js';
import { describeObjectTypes } from '../core/object-types.js';
import { isObjectDefinition } from '../core/object-display.js';
import { getVariableValue } from './variable-value-api.js';
import { askChatSetting } from '../ui/setting-prompt.js';

function guard(fnName, extensionId, instanceId, run, fallback = null) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return run();
    } catch (err) {
        console.warn(LOG_PREFIX, `${fnName} rejected: ${err?.message ?? err}`);
        return fallback;
    }
}

// ------------------------------------------------------------------ types

// Open to anyone, like the other discovery reads.
export function listObjectTypes() {
    return describeObjectTypes();
}

// ---------------------------------------------------------------- settings

export function listSettings(extensionId, instanceId) {
    return guard('listSettings', extensionId, instanceId, () => objects.listSettings(), []);
}

export function getSetting(extensionId, instanceId, settingId) {
    return guard('getSetting', extensionId, instanceId, () => objects.getSetting(settingId));
}

export function createSetting(extensionId, instanceId, { name, autoConfirm } = {}) {
    return guard('createSetting', extensionId, instanceId, () => objects.createSetting({ name, autoConfirm }));
}

export function updateSetting(extensionId, instanceId, settingId, patch = {}) {
    return guard('updateSetting', extensionId, instanceId, () => objects.updateSetting(settingId, patch));
}

export function deleteSetting(extensionId, instanceId, settingId) {
    return guard('deleteSetting', extensionId, instanceId, () => objects.deleteSetting(settingId), false);
}

// A setting as plain data (its fields, field roles and canonical objects) /
// a new setting made from one (new ids; { setting, idMap, droppedFields }) /
// objects copied into another setting (new ids; { idMap, droppedFields }).
export function exportSetting(extensionId, instanceId, settingId, options = {}) {
    return guard('exportSetting', extensionId, instanceId, () => objects.exportSetting(settingId, options));
}

export function importSetting(extensionId, instanceId, data, options = {}) {
    return guard('importSetting', extensionId, instanceId, () => objects.importSetting(data, options));
}

export function copyObjects(extensionId, instanceId, fromSettingId, ids, toSettingId) {
    return guard('copyObjects', extensionId, instanceId, () => objects.copyObjects(fromSettingId, ids, toSettingId));
}

export function getChatSetting(extensionId, instanceId, chatId) {
    return guard('getChatSetting', extensionId, instanceId, () => objects.getChatSetting(chatId));
}

export function setChatSetting(extensionId, instanceId, chatId, settingId) {
    return guard('setChatSetting', extensionId, instanceId, () => objects.setChatSetting(chatId, settingId));
}

// The chat's setting; when it has none, asks the user (State Engine's own
// question) - or picks Default when that is the only setting.
export async function ensureChatSetting(extensionId, instanceId, chatId) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return await objects.ensureChatSetting(chatId, askChatSetting);
    } catch (err) {
        console.warn(LOG_PREFIX, `ensureChatSetting rejected: ${err?.message ?? err}`);
        return null;
    }
}

// ----------------------------------------------------------------- objects

export function listObjects(extensionId, instanceId, chatId, type, options = {}) {
    return guard('listObjects', extensionId, instanceId, () => objects.listObjects(chatId || null, type, options), []);
}

export function getObject(extensionId, instanceId, chatId, id, settingId = null) {
    return guard('getObject', extensionId, instanceId, () => objects.getObject(chatId || null, id, settingId));
}

export function getObjectByAlias(extensionId, instanceId, chatId, type, name) {
    return guard('getObjectByAlias', extensionId, instanceId, () => objects.getObjectByAlias(chatId, type, name));
}

export function createChatObject(extensionId, instanceId, chatId, type, name, snippet = null, data = {}) {
    return guard('createChatObject', extensionId, instanceId, () => objects.createChatObject(chatId, type, name, snippet, data));
}

export function createObject(extensionId, instanceId, settingId, type, data = {}) {
    return guard('createObject', extensionId, instanceId, () => objects.createObject(settingId, type, data));
}

export function updateObject(extensionId, instanceId, chatId, id, patch = {}, options = {}) {
    return guard('updateObject', extensionId, instanceId, () => objects.updateObject(chatId || null, id, patch, options));
}

export function addObjectAlias(extensionId, instanceId, chatId, id, alias, options = {}) {
    return guard('addObjectAlias', extensionId, instanceId, () => objects.addObjectAlias(chatId || null, id, alias, options));
}

export function confirmObject(extensionId, instanceId, chatId, id, options = {}) {
    return guard('confirmObject', extensionId, instanceId, () => objects.confirmObject(chatId || null, id, options));
}

// Resolves `sourceId` (a detection with the wrong name) to `targetId`: the
// detected name becomes the target's alias, every variable holding the
// source holds the target, the source is deleted, the target is confirmed.
export function resolveObject(extensionId, instanceId, chatId, sourceId, targetId, options = {}) {
    return guard('resolveObject', extensionId, instanceId, () => objects.resolveObject(chatId || null, sourceId, targetId, options));
}

export function mergeObjects(extensionId, instanceId, chatId, sourceId, targetId, options = {}) {
    return guard('mergeObjects', extensionId, instanceId, () => objects.mergeObjects(chatId || null, sourceId, targetId, options));
}

export function deleteObject(extensionId, instanceId, chatId, id, options = {}) {
    return guard('deleteObject', extensionId, instanceId, () => objects.deleteObject(chatId || null, id, options), false);
}

export function markObjectPresent(extensionId, instanceId, chatId, id) {
    return guard('markObjectPresent', extensionId, instanceId, () => objects.markObjectPresent(chatId, id));
}

export function markObjectAbsent(extensionId, instanceId, chatId, id) {
    return guard('markObjectAbsent', extensionId, instanceId, () => objects.markObjectAbsent(chatId, id));
}

// ------------------------------------------------------------ fields

export function getObjectFields(extensionId, instanceId, settingId, type) {
    return guard('getObjectFields', extensionId, instanceId, () => objects.getObjectFields(settingId, type), []);
}

export function setObjectFields(extensionId, instanceId, settingId, type, defs) {
    return guard('setObjectFields', extensionId, instanceId, () => objects.setObjectFields(settingId, type, defs));
}

// undefined when the object or the field is unknown.
export function getObjectField(extensionId, instanceId, chatId, id, fieldOrRole, options = {}) {
    return guard('getObjectField', extensionId, instanceId, () => objects.getObjectFieldValue(chatId || null, id, fieldOrRole, options), undefined);
}

export function setObjectField(extensionId, instanceId, chatId, id, fieldOrRole, value, options = {}) {
    return guard('setObjectField', extensionId, instanceId, () => objects.setObjectFieldValue(chatId || null, id, fieldOrRole, value, options));
}

export function getObjectFieldRoles(extensionId, instanceId, settingId, type) {
    return guard('getObjectFieldRoles', extensionId, instanceId, () => objects.getObjectFieldRoles(settingId, type), []);
}

export function assignObjectFieldRole(extensionId, instanceId, settingId, roleId, fieldName) {
    return guard('assignObjectFieldRole', extensionId, instanceId, () => objects.assignObjectFieldRole(settingId, roleId, fieldName));
}

// ------------------------------------------------------------ runtime state

export function getObjectRuntimeFields(extensionId, instanceId, settingId, type) {
    return guard('getObjectRuntimeFields', extensionId, instanceId, () => objects.getRuntimeFields(settingId, type), []);
}

export function setObjectRuntimeFields(extensionId, instanceId, settingId, type, fields) {
    return guard('setObjectRuntimeFields', extensionId, instanceId, () => objects.setRuntimeFields(settingId, type, fields));
}

export function setObjectRuntimeValue(extensionId, instanceId, chatId, id, field, value) {
    return guard('setObjectRuntimeValue', extensionId, instanceId, () => objects.setRuntimeValue(chatId, id, field, value));
}

// ----------------------------------------------------------------- variants

export function addObjectVariant(extensionId, instanceId, chatId, id, variant = {}, options = {}) {
    return guard('addObjectVariant', extensionId, instanceId, () => objects.addObjectVariant(chatId || null, id, variant, options));
}

export function updateObjectVariant(extensionId, instanceId, chatId, id, variantId, patch = {}, options = {}) {
    return guard('updateObjectVariant', extensionId, instanceId, () => objects.updateObjectVariant(chatId || null, id, variantId, patch, options));
}

export function deleteObjectVariant(extensionId, instanceId, chatId, id, variantId, options = {}) {
    return guard('deleteObjectVariant', extensionId, instanceId, () => objects.deleteObjectVariant(chatId || null, id, variantId, options));
}

export function setObjectActiveVariant(extensionId, instanceId, chatId, id, variantId, options = {}) {
    return guard('setObjectActiveVariant', extensionId, instanceId, () => objects.setObjectActiveVariant(chatId || null, id, variantId ?? null, options));
}

// -------------------------------------------------------------- prompt text

export function describeObject(extensionId, instanceId, chatId, id) {
    return guard('describeObject', extensionId, instanceId, () => objects.describeObject(chatId || null, id), '');
}

// Variables' values as prompt text, by fully-qualified name: an object is
// described (describeObject), an object list described item by item, any
// other value shown as text (objects as JSON). A name the chat holds no
// value for is left out. { [name]: text }.
export function getVariablePromptTexts(extensionId, instanceId, chatId, names) {
    return guard('getVariablePromptTexts', extensionId, instanceId, () => {
        const out = {};
        for (const name of Array.isArray(names) ? names : []) {
            const entry = getVariableValue(extensionId, instanceId, chatId, name);
            if (!entry) continue;
            const { value, def } = entry;
            if (isObjectDefinition(def)) {
                const ids = Array.isArray(value) ? value : (value ? [value] : []);
                out[name] = ids.map((id) => objects.describeObject(chatId, id)).filter(Boolean).join('\n\n');
            } else if (value === null || value === undefined) {
                out[name] = '';
            } else {
                out[name] = typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : String(value);
            }
        }
        return out;
    }, {});
}

// ------------------------------------------------------- the manager window

// A UI extension registers the function that opens its object manager; the
// latest registration wins. opener(options) - options: { type?, objectId?,
// view?: 'chat' | 'setting', settingId?, filter?: 'unconfirmed' }.
export function registerObjectManager(extensionId, instanceId, opener) {
    return guard('registerObjectManager', extensionId, instanceId, () => {
        if (typeof opener !== 'function') throw new Error('opener must be a function');
        objects.setObjectManager(opener);
        return true;
    }, false);
}

// Opens the registered object manager; false when none is registered.
export function openObjectManager(extensionId, instanceId, options = {}) {
    return guard('openObjectManager', extensionId, instanceId, () => objects.openObjectManager(options), false);
}

export function hasObjectManager() {
    return objects.hasObjectManager();
}
