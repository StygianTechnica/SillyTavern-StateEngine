// Character API (requirements spec 1.42)
//
// Characters live in two layers (src/core/characters.js): SETTINGS - global
// containers of canonical characters (baseline data and variants) - and each
// CHAT - its setting, presence, match counts and its own not-yet-promoted
// characters - the UNCONFIRMED ones, not yet reviewed. Confirmed <=> in the
// setting: confirming a chat character (or saving an edit to it) moves it
// into the setting; there is no separate promotion. Character variables hold
// character ids.
//
// Settings
//   listCharacterSettings / getCharacterSetting / createCharacterSetting /
//   updateCharacterSetting ({ name?, autoConfirm? }) / deleteCharacterSetting
//   getChatCharacterSetting / setChatCharacterSetting
//   ensureChatCharacterSetting  (async) the chat's setting, asking the user
//                               which one when it has none ("ask on first use")
// Characters (the spec's methods, with the chat they act in first)
//   listCharacters(chatId, { settingId? })   a chat's characters, or a setting's
//   getCharacter / getCharacterByAlias
//   createUnconfirmedCharacter(chatId, name, snippet)
//   createCharacter(settingId, data)          canonical, confirmed
//   updateCharacter(chatId, id, patch, { settingId? })  edits the baseline; confirms (-> setting)
//   updateCharacterAliases(chatId, id, alias) / updateCharacterImage(chatId, id, url)
//   markCharacterPresent / markCharacterAbsent
//   mergeCharacters(chatId, sourceId, targetId, { settingId? })
//   deleteCharacter / confirmCharacter (-> setting)
//   resolveCharacter(chatId, sourceId, targetId)  a detection that is really
//                               someone known: its name becomes their alias,
//                               variables follow, they are confirmed
// Variants
//   addCharacterVariant / updateCharacterVariant / deleteCharacterVariant /
//   setCharacterActiveVariant (one active variant per character, for its setting)
// The Character Manager modal (lives in a UI extension)
//   registerCharacterManager(extensionId, instanceId, opener) / openCharacterManager(options)
//
// A character as returned:
//   { id, name, aliases, image, introduction_snippet, biography, personality, faction, role,
//     confirmed, scope: 'chat' | 'setting', settingId, present, matches,
//     activeVariant, variants: [{ id, name, overrides }], base: { name, aliases, image, ... },
//     createdAt, updatedAt }
// name/aliases/image/... are the active variant's (base = the baseline).
//
// Open to any registered caller (resolveCallerRecord) - characters belong to
// settings and chats, not to a namespace. Identity failures throw; any other
// rejection is logged and returns null (false for deletes). Changes emit
// VARIABLES_CHANGED_EVENT.

import { LOG_PREFIX } from '../core/settings-core.js';
import { resolveCallerRecord } from './identity.js';
import * as characters from '../core/characters.js';
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

// ---------------------------------------------------------------- settings

export function listCharacterSettings(extensionId, instanceId) {
    return guard('listCharacterSettings', extensionId, instanceId, () => characters.listSettings(), []);
}

export function getCharacterSetting(extensionId, instanceId, settingId) {
    return guard('getCharacterSetting', extensionId, instanceId, () => characters.getSetting(settingId));
}

export function createCharacterSetting(extensionId, instanceId, { name, autoConfirm } = {}) {
    return guard('createCharacterSetting', extensionId, instanceId, () => characters.createSetting({ name, autoConfirm }));
}

export function updateCharacterSetting(extensionId, instanceId, settingId, patch = {}) {
    return guard('updateCharacterSetting', extensionId, instanceId, () => characters.updateSetting(settingId, patch));
}

export function deleteCharacterSetting(extensionId, instanceId, settingId) {
    return guard('deleteCharacterSetting', extensionId, instanceId, () => characters.deleteSetting(settingId), false);
}

export function getChatCharacterSetting(extensionId, instanceId, chatId) {
    return guard('getChatCharacterSetting', extensionId, instanceId, () => characters.getChatSetting(chatId));
}

export function setChatCharacterSetting(extensionId, instanceId, chatId, settingId) {
    return guard('setChatCharacterSetting', extensionId, instanceId, () => characters.setChatSetting(chatId, settingId));
}

// The chat's setting; when it has none, asks the user (State Engine's own
// question) - or picks Default when that is the only setting.
export async function ensureChatCharacterSetting(extensionId, instanceId, chatId) {
    resolveCallerRecord(extensionId, instanceId);
    try {
        return await characters.ensureChatSetting(chatId, askChatSetting);
    } catch (err) {
        console.warn(LOG_PREFIX, `ensureChatCharacterSetting rejected: ${err?.message ?? err}`);
        return null;
    }
}

// --------------------------------------------------------------- characters

export function listCharacters(extensionId, instanceId, chatId, options = {}) {
    return guard('listCharacters', extensionId, instanceId, () => characters.listCharacters(chatId || null, options), []);
}

export function getCharacter(extensionId, instanceId, chatId, id, settingId = null) {
    return guard('getCharacter', extensionId, instanceId, () => characters.getCharacter(chatId || null, id, settingId));
}

export function getCharacterByAlias(extensionId, instanceId, chatId, name) {
    return guard('getCharacterByAlias', extensionId, instanceId, () => characters.getCharacterByAlias(chatId, name));
}

export function createUnconfirmedCharacter(extensionId, instanceId, chatId, name, snippet = null) {
    return guard('createUnconfirmedCharacter', extensionId, instanceId, () => characters.createUnconfirmedCharacter(chatId, name, snippet));
}

export function createCharacter(extensionId, instanceId, settingId, data = {}) {
    return guard('createCharacter', extensionId, instanceId, () => characters.createCharacter(settingId, data));
}

export function updateCharacter(extensionId, instanceId, chatId, id, patch = {}, options = {}) {
    return guard('updateCharacter', extensionId, instanceId, () => characters.updateCharacter(chatId || null, id, patch, options));
}

export function updateCharacterAliases(extensionId, instanceId, chatId, id, alias, options = {}) {
    return guard('updateCharacterAliases', extensionId, instanceId, () => characters.updateCharacterAliases(chatId || null, id, alias, options));
}

export function updateCharacterImage(extensionId, instanceId, chatId, id, imageUrl, options = {}) {
    return guard('updateCharacterImage', extensionId, instanceId, () => characters.updateCharacterImage(chatId || null, id, imageUrl, options));
}

export function markCharacterPresent(extensionId, instanceId, chatId, id) {
    return guard('markCharacterPresent', extensionId, instanceId, () => characters.markCharacterPresent(chatId, id));
}

export function markCharacterAbsent(extensionId, instanceId, chatId, id) {
    return guard('markCharacterAbsent', extensionId, instanceId, () => characters.markCharacterAbsent(chatId, id));
}

export function mergeCharacters(extensionId, instanceId, chatId, sourceId, targetId, options = {}) {
    return guard('mergeCharacters', extensionId, instanceId, () => characters.mergeCharacters(chatId || null, sourceId, targetId, options));
}

export function deleteCharacter(extensionId, instanceId, chatId, id, options = {}) {
    return guard('deleteCharacter', extensionId, instanceId, () => characters.deleteCharacter(chatId || null, id, options), false);
}

export function confirmCharacter(extensionId, instanceId, chatId, id, options = {}) {
    return guard('confirmCharacter', extensionId, instanceId, () => characters.confirmCharacter(chatId || null, id, options));
}

// Resolves `sourceId` (a detection with the wrong name) to `targetId`: the
// detected name becomes the target's alias, every variable holding the
// source holds the target, the source is deleted, the target is confirmed
// (and so in the setting). Returns the target, or null.
export function resolveCharacter(extensionId, instanceId, chatId, sourceId, targetId, options = {}) {
    return guard('resolveCharacter', extensionId, instanceId, () => characters.resolveCharacter(chatId || null, sourceId, targetId, options));
}

// ----------------------------------------------------------------- variants

export function addCharacterVariant(extensionId, instanceId, chatId, id, variant = {}, options = {}) {
    return guard('addCharacterVariant', extensionId, instanceId, () => characters.addCharacterVariant(chatId || null, id, variant, options));
}

export function updateCharacterVariant(extensionId, instanceId, chatId, id, variantId, patch = {}, options = {}) {
    return guard('updateCharacterVariant', extensionId, instanceId, () => characters.updateCharacterVariant(chatId || null, id, variantId, patch, options));
}

export function deleteCharacterVariant(extensionId, instanceId, chatId, id, variantId, options = {}) {
    return guard('deleteCharacterVariant', extensionId, instanceId, () => characters.deleteCharacterVariant(chatId || null, id, variantId, options));
}

export function setCharacterActiveVariant(extensionId, instanceId, chatId, id, variantId, options = {}) {
    return guard('setCharacterActiveVariant', extensionId, instanceId, () => characters.setActiveVariant(chatId || null, id, variantId ?? null, options));
}

// ------------------------------------------------------- the manager modal

// A UI extension registers the function that opens its Character Manager;
// the latest registration wins. opener(options) - options: { characterId?,
// view?: 'chat' | 'setting', settingId?, filter?: 'unconfirmed' }.
export function registerCharacterManager(extensionId, instanceId, opener) {
    return guard('registerCharacterManager', extensionId, instanceId, () => {
        if (typeof opener !== 'function') throw new Error('opener must be a function');
        characters.setCharacterManager(opener);
        return true;
    }, false);
}

// Opens the registered Character Manager; false when none is registered.
export function openCharacterManager(extensionId, instanceId, options = {}) {
    return guard('openCharacterManager', extensionId, instanceId, () => characters.openCharacterManager(options), false);
}

export function hasCharacterManager() {
    return characters.hasCharacterManager();
}
