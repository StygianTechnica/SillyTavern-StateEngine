// State Engine — objects and settings
//
// An OBJECT is a story entity with a stable id - a character, a location, a
// faction, an item, a creature, lore (WORLD types), or a quest, a scene, an
// event (STORY types). What each type is - its fields, per-chat state,
// prompt wording, colour - lives in object-types.js; this module holds the
// rules every type shares, and never special-cases one.
//
// Two layers:
//
//   SETTINGS (global, settings.variableStore.settings) - containers of
//   CANONICAL world objects, like presets or world folders, not tied to any
//   chat: { id, name, autoConfirm, createdAt, objects: { [type]: { [id]:
//   record } }, runtimeFields: { [type]: { [name]: field } } }. Editing a
//   canonical object edits it for every chat using the setting. One setting,
//   "default", always exists; with autoConfirm on it collects every object
//   chats on it meet.
//
//   CHAT (per chat, on the chat's state) - state.setting: which setting the
//   chat uses; state.objects[type] = { entries: { [id]: { present?, matches,
//   runtime } }, local: { [id]: record } }: per-object chat state, and the
//   chat's OWN objects - unconfirmed world objects (met, not yet reviewed)
//   and every story object (they belong to the chat). Canonical objects are
//   never copied into a chat.
//
// An object record:
//   { id, type, name, aliases: [], image, description, introduction_snippet,
//     related_entity_ids: [], related_memory_ids: [], ...the type's fields,
//     confirmed, variants: { [variantId]: { id, name, overrides } },
//     activeVariant, createdAt, updatedAt }
// Ids carry the type's prefix ("chr_", "loc_"...), so an id says its type.
//
// THE RULE (world types): confirmed <=> in the setting. An object extraction
// creates is unconfirmed and lives only in its chat. Confirming it - the
// user saving an edit, or confirming it as it is - moves it into the chat's
// setting (same id, so every variable keeps pointing at it). Automatic
// confirmation: matched CONFIRM_AFTER_MATCHES times, or at once when the
// setting auto-confirms. A detection that is really something already known
// is RESOLVED to it (its name becomes an alias). Story objects are always
// confirmed and never leave their chat.
//
// RUNTIME STATE: per chat, ephemeral - never in a setting. Each object in a
// chat has runtime = { present? (types with presence), values: { [field]:
// value }, images }, rewritten by the prompted update; which fields exist is
// per setting and type (setting.runtimeFields[type]) - the type's built-ins
// plus the user's own, each a string, number or enum, prompted or not. For
// types with presence it is cleared when the object leaves the scene.

import { LOG_PREFIX, BUILTIN_NAMESPACE, getSettings, persistSettings } from './settings-core.js';
import { loadChatState, saveChatState, hydrateMacroStoreForChat } from './chat-state.js';
import { notifyVariablesChanged } from './variable-change-signal.js';
import { putNotification, removeNotification, getNotification, notificationId, setCallback } from './notification-core.js';
import { genId } from './variable-schema.js';
import { setObjectNameResolver, objectTypeOf } from './object-display.js';
import { safeImageSrc } from './image-variables.js';
import { OBJECT_TYPES, OBJECT_TYPE_IDS, getObjectType, objectTypeOfId, isObjectType } from './object-types.js';

export const DEFAULT_SETTING_ID = 'default';
export const CONFIRM_AFTER_MATCHES = 10;
const MAX_NAME = 100;
const MAX_ALIAS = 100;
const MAX_ALIASES = 50;
const MAX_TEXT = 4000;
const MAX_SHORT = 300;
const MAX_LIST_ITEM = 200;
const MAX_LIST = 50;
const MAX_REFS = 200;
const MAX_SNIPPET = 300;

function text(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mustType(type) {
    const t = getObjectType(type);
    if (!t) throw new Error(`unknown object type ${JSON.stringify(type)} (one of: ${OBJECT_TYPE_IDS.join(', ')})`);
    return t;
}

// The type of id `id`, or throws.
function typeOfId(id) {
    const t = objectTypeOfId(id);
    if (!t) throw new Error(`${JSON.stringify(id)} is not an object id`);
    return t;
}

// A name for matching: lowercased, single-spaced, without surrounding quotes
// or a trailing possessive.
export function nameKey(name) {
    return typeof name === 'string'
        ? name.normalize('NFKC').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/['’]s$/i, '').replace(/\s+/g, ' ').toLowerCase()
        : '';
}

function cleanAliases(list, name = '') {
    const own = nameKey(name);
    const seen = new Set(own ? [own] : []);
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const alias = text(raw, MAX_ALIAS);
        const key = nameKey(alias);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(alias);
        if (out.length >= MAX_ALIASES) break;
    }
    return out;
}

function cleanImage(value) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : null;
}

function cleanIds(list, max = MAX_REFS) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        if (typeof raw === 'string' && raw.trim() && !out.includes(raw.trim())) out.push(raw.trim());
        if (out.length >= max) break;
    }
    return out;
}

// One type field's value, cleaned by its kind.
function cleanField(field, raw) {
    switch (field.kind) {
        case 'longtext': return text(raw, MAX_TEXT);
        case 'list': return (Array.isArray(raw) ? raw : []).map((v) => text(typeof v === 'string' ? v : String(v ?? ''), MAX_LIST_ITEM)).filter(Boolean).slice(0, MAX_LIST);
        case 'enum': {
            const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
            return field.values.find((v) => v.toLowerCase() === value) ?? '';
        }
        case 'ref': return typeof raw === 'string' ? raw.trim() : '';
        case 'refs': return cleanIds(raw);
        case 'timestamp':
        case 'text':
        default:
            return text(typeof raw === 'number' ? String(raw) : raw, MAX_SHORT);
    }
}

// Fields a variant may override: the common display fields and the type's
// own (not its references).
function variantFields(t) {
    return ['name', 'aliases', 'image', 'description', ...t.fields.filter((f) => f.kind !== 'ref' && f.kind !== 'refs').map((f) => f.name)];
}

function cleanOverrides(t, raw) {
    const out = {};
    if (!isObject(raw)) return out;
    if (typeof raw.name === 'string' && raw.name.trim()) out.name = text(raw.name, MAX_NAME);
    if (Array.isArray(raw.aliases)) out.aliases = cleanAliases(raw.aliases);
    if ('image' in raw) out.image = cleanImage(raw.image);
    if (typeof raw.description === 'string') out.description = text(raw.description, MAX_TEXT);
    for (const field of t.fields) {
        if (field.kind === 'ref' || field.kind === 'refs' || !(field.name in raw)) continue;
        out[field.name] = cleanField(field, raw[field.name]);
    }
    return out;
}

function cleanVariants(t, raw) {
    const out = {};
    for (const variant of Object.values(isObject(raw) ? raw : {})) {
        if (!isObject(variant) || typeof variant.id !== 'string' || !variant.id) continue;
        out[variant.id] = { id: variant.id, name: text(variant.name, MAX_NAME) || 'Variant', overrides: cleanOverrides(t, variant.overrides) };
    }
    return out;
}

// An object record of `type`, validated (any missing field gets its default).
export function normalizeObject(type, raw, id = raw?.id) {
    const t = mustType(type);
    const name = text(raw?.name, MAX_NAME) || 'Unnamed';
    const variants = cleanVariants(t, raw?.variants);
    const out = {
        id,
        type: t.id,
        name,
        aliases: cleanAliases(raw?.aliases, name),
        image: cleanImage(raw?.image),
        description: text(raw?.description, MAX_TEXT),
        introduction_snippet: typeof raw?.introduction_snippet === 'string' && raw.introduction_snippet.trim() ? raw.introduction_snippet.trim().slice(0, MAX_SNIPPET) : null,
        related_entity_ids: cleanIds(raw?.related_entity_ids),
        related_memory_ids: cleanIds(raw?.related_memory_ids),
        // Story objects belong to their chat and are always confirmed.
        confirmed: t.scope === 'story' ? true : raw?.confirmed === true,
        variants,
        activeVariant: typeof raw?.activeVariant === 'string' && variants[raw.activeVariant] ? raw.activeVariant : null,
        createdAt: Number.isFinite(raw?.createdAt) ? raw.createdAt : Date.now(),
        updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : Date.now(),
    };
    for (const field of t.fields) out[field.name] = cleanField(field, raw?.[field.name]);
    return out;
}

// ------------------------------------------------------- runtime fields

export const RUNTIME_FIELD_TYPES = Object.freeze(['string', 'number', 'enum']);
const RUNTIME_FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_RUNTIME_TEXT = 200;
const MAX_ENUM_VALUES = 30;

function builtInNames(t) {
    return t.runtime.map((f) => f.name);
}

export function defaultRuntimeFields(type) {
    return Object.fromEntries(mustType(type).runtime.map((f) => [f.name, structuredClone(f)]));
}

function allDefaultRuntimeFields() {
    return Object.fromEntries(OBJECT_TYPE_IDS.map((type) => [type, defaultRuntimeFields(type)]));
}

// One runtime field definition, validated. Throws with a reason.
function normalizeRuntimeField(t, raw, what = 'runtime field') {
    if (!isObject(raw)) throw new Error(`${what} must be an object`);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!RUNTIME_FIELD_NAME.test(name)) throw new Error(`${what} name ${JSON.stringify(raw.name)} is not valid - lowercase letters, digits and _, starting with a letter (max 40)`);
    if (name === 'present') throw new Error('"present" is not a runtime field you define - it is the object\'s presence');
    const type = raw.type ?? 'string';
    if (!RUNTIME_FIELD_TYPES.includes(type)) throw new Error(`runtime field "${name}" has unknown type ${JSON.stringify(type)} (string, number or enum)`);
    const out = { name, type, prompted: raw.prompted !== false, description: text(raw.description, 300) };
    // A built-in "fresh" field (asked new each turn) stays fresh.
    if (t.runtime.find((f) => f.name === name)?.fresh) out.fresh = true;
    if (type === 'enum') {
        const values = [];
        for (const v of Array.isArray(raw.values) ? raw.values : []) {
            const value = text(typeof v === 'string' ? v : String(v ?? ''), 60);
            if (!value) continue;
            if (values.some((x) => x.toLowerCase() === value.toLowerCase())) throw new Error(`runtime field "${name}" lists "${value}" twice`);
            values.push(value);
        }
        if (values.length === 0) throw new Error(`runtime field "${name}" is an enum but has no values`);
        if (values.length > MAX_ENUM_VALUES) throw new Error(`runtime field "${name}" has more than ${MAX_ENUM_VALUES} values`);
        out.values = values;
        // An image per value: { [value]: reference } - shown in place of the
        // word. Keys match values case-insensitively and are stored as the
        // value is spelled; an image for a value no longer listed is dropped;
        // an empty reference means none.
        if (raw.images !== undefined && raw.images !== null && !isObject(raw.images)) throw new Error(`runtime field "${name}": images must be an object of value -> image`);
        const images = {};
        for (const [key, ref] of Object.entries(raw.images ?? {})) {
            const value = values.find((v) => v.toLowerCase() === String(key).trim().toLowerCase());
            if (!value) continue;
            if (typeof ref !== 'string') throw new Error(`runtime field "${name}": the image for "${value}" must be a string`);
            if (ref.trim()) images[value] = ref.trim();
        }
        if (Object.keys(images).length) out.images = images;
    }
    if (type === 'number') {
        const min = Number.isFinite(raw.min) ? raw.min : null;
        const max = Number.isFinite(raw.max) ? raw.max : null;
        if (min !== null && max !== null && min >= max) throw new Error(`runtime field "${name}": min must be below max`);
        out.min = min;
        out.max = max;
    }
    return out;
}

function settingRuntimeFields(setting, type) {
    if (!isObject(setting.runtimeFields[type])) setting.runtimeFields[type] = defaultRuntimeFields(type);
    return setting.runtimeFields[type];
}

// A setting's runtime fields for a type, built-ins first then the user's, in
// order: [{ name, type, prompted, description, values?, min?, max?, fresh?, builtIn }].
export function getRuntimeFields(settingId, type) {
    const t = mustType(type);
    const setting = settingStore()[settingId];
    if (!setting) return [];
    const builtIns = builtInNames(t);
    const order = (f) => (builtIns.includes(f.name) ? builtIns.indexOf(f.name) : 100);
    // Whether a built-in is asked fresh each turn is the registry's to say
    // (definitions saved before it knew are not missing it).
    const fresh = new Set(t.runtime.filter((f) => f.fresh).map((f) => f.name));
    return Object.values(settingRuntimeFields(setting, type))
        .map((f, i) => {
            const field = { ...structuredClone(f), builtIn: builtIns.includes(f.name), _i: i };
            if (fresh.has(f.name)) field.fresh = true;
            else delete field.fresh;
            return field;
        })
        .sort((a, b) => order(a) - order(b) || a._i - b._i)
        .map(({ _i, ...f }) => f);
}

// Replaces a setting's runtime fields for a type with `fields` (validated -
// throws). The type's built-ins cannot be removed (a missing one keeps its
// current definition); their type, values, description and prompted switch
// can change. Returns the new list.
export function setRuntimeFields(settingId, type, fields) {
    const t = mustType(type);
    const setting = settingStore()[settingId];
    if (!setting) throw new Error(`setting ${JSON.stringify(settingId)} does not exist`);
    if (!Array.isArray(fields)) throw new Error('runtime fields must be an array');
    const current = settingRuntimeFields(setting, type);
    const next = {};
    fields.forEach((raw, i) => {
        const field = normalizeRuntimeField(t, raw, `runtime field #${i + 1}`);
        if (next[field.name]) throw new Error(`runtime field "${field.name}" is listed twice`);
        next[field.name] = field;
    });
    for (const name of builtInNames(t)) {
        if (!next[name]) next[name] = current[name] ?? defaultRuntimeFields(type)[name];
    }
    setting.runtimeFields[type] = next;
    persistSettings();
    changed(null);
    return getRuntimeFields(settingId, type);
}

// A runtime value for `field`, or null when it is not a valid one (enum: one
// of the values, case-insensitive, given back as defined; number: finite,
// within min/max; string: trimmed, at most MAX_RUNTIME_TEXT characters).
export function coerceRuntimeValue(field, raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (field.type === 'number') {
        const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
        if (!Number.isFinite(n)) return null;
        return Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, n));
    }
    const value = String(raw).trim();
    if (!value) return null;
    if (field.type === 'enum') return field.values.find((v) => v.toLowerCase() === value.toLowerCase()) ?? null;
    return value.length > MAX_RUNTIME_TEXT ? `${value.slice(0, MAX_RUNTIME_TEXT - 1).trim()}…` : value;
}

// The image an enum field shows for `value`, ready for <img src>, or null.
export function runtimeImageSrc(field, value) {
    if (field?.type !== 'enum' || typeof value !== 'string' || !isObject(field.images)) return null;
    return safeImageSrc(field.images[value] ?? null);
}

// An object's runtime in a chat, by the chat's setting's fields for its type:
// { present? , values: { [field]: value }, images: { [field]: src } } -
// fields the setting no longer defines are left out; images holds each enum
// field whose current value has an image, already checked with safeImageSrc.
function runtimeView(chatId, t, id) {
    const entry = typeLayer(readChat(chatId), t.id).entries[id];
    const stored = isObject(entry?.runtime?.values) ? entry.runtime.values : {};
    const out = { values: {}, images: {} };
    if (t.hasPresence) out.present = entry?.present === true;
    for (const field of getRuntimeFields(effectiveSetting(chatId).id, t.id)) {
        const clean = stored[field.name] === undefined ? null : coerceRuntimeValue(field, stored[field.name]);
        out.values[field.name] = clean;
        const src = runtimeImageSrc(field, clean);
        if (src) out.images[field.name] = src;
    }
    return out;
}

// The prompted update's runtime answer for objects of one type in play this
// turn: `updates` = { [objectId]: { [field]: rawValue } }. Only PROMPTED
// fields are written (each validated; an invalid value clears it).
export function applyRuntimeUpdates(chatId, type, updates) {
    mustType(type);
    if (!chatId || !isObject(updates)) return;
    const fields = getRuntimeFields(effectiveSetting(chatId).id, type).filter((f) => f.prompted);
    writeChat(chatId, (state) => {
        const layer = typeLayer(state, type);
        for (const [id, raw] of Object.entries(updates)) {
            if (!isObject(raw)) continue;
            const entry = { matches: 0, ...(layer.entries[id] ?? {}) };
            const values = { ...(isObject(entry.runtime?.values) ? entry.runtime.values : {}) };
            for (const field of fields) {
                if (!(field.name in raw)) continue;
                const value = coerceRuntimeValue(field, raw[field.name]);
                // An enum answer off the list ("Grateful" for a mood) keeps the
                // value it had - a model drifting off the list never blanks it.
                // An empty answer still clears it.
                if (value === null && field.type === 'enum' && String(raw[field.name] ?? '').trim() !== '') {
                    console.warn(LOG_PREFIX, `runtime field "${field.name}": ${JSON.stringify(raw[field.name])} is not one of its values - kept the previous value`);
                    continue;
                }
                // A fresh field is answered new each turn; an empty answer (a
                // small model skipping it) keeps the last one rather than
                // blanking the card.
                if (value === null && field.fresh) continue;
                values[field.name] = value;
            }
            entry.runtime = { values };
            layer.entries[id] = entry;
        }
    });
    changed(chatId);
}

// Sets one NON-prompted runtime field by hand (the object manager, or an
// extension). Prompted fields are the prompted update's. Throws with the
// reason; returns the object.
export function setRuntimeValue(chatId, id, fieldName, value) {
    if (!chatId) throw new Error('setRuntimeValue needs a chat');
    const t = typeOfId(id);
    mustLocate(chatId, id);
    const field = getRuntimeFields(effectiveSetting(chatId).id, t.id).find((f) => f.name === fieldName);
    if (!field) throw new Error(`runtime field ${JSON.stringify(fieldName)} is not defined for ${t.plural.toLowerCase()} in this chat's setting`);
    if (field.prompted) throw new Error(`runtime field "${fieldName}" is prompted - the prompted update writes it`);
    const clean = coerceRuntimeValue(field, value);
    if (clean === null && value !== null && value !== undefined && value !== '') throw new Error(`${JSON.stringify(value)} is not a valid ${field.type} for "${fieldName}"`);
    writeChat(chatId, (state) => {
        const layer = typeLayer(state, t.id);
        const entry = { matches: 0, ...(layer.entries[id] ?? {}) };
        entry.runtime = { values: { ...(isObject(entry.runtime?.values) ? entry.runtime.values : {}), [fieldName]: clean } };
        layer.entries[id] = entry;
    });
    changed(chatId);
    return getObject(chatId, id);
}

// ----------------------------------------------------------------- settings

function newSetting(id, name, autoConfirm) {
    return { id, name, autoConfirm, createdAt: Date.now(), objects: Object.fromEntries(OBJECT_TYPE_IDS.map((type) => [type, {}])), runtimeFields: allDefaultRuntimeFields() };
}

function settingStore() {
    const store = getSettings().variableStore;
    if (!isObject(store.settings)) store.settings = {};
    const settings = store.settings;
    if (!isObject(settings[DEFAULT_SETTING_ID])) settings[DEFAULT_SETTING_ID] = newSetting(DEFAULT_SETTING_ID, 'Default', true);
    for (const setting of Object.values(settings)) {
        if (!isObject(setting.objects)) setting.objects = {};
        if (!isObject(setting.runtimeFields)) setting.runtimeFields = {};
        for (const type of OBJECT_TYPE_IDS) {
            if (!isObject(setting.objects[type])) setting.objects[type] = {};
        }
    }
    return settings;
}

function settingSummary(setting) {
    const counts = Object.fromEntries(OBJECT_TYPE_IDS.map((type) => [type, Object.keys(setting.objects[type] ?? {}).length]));
    return {
        id: setting.id, name: setting.name, autoConfirm: setting.autoConfirm === true, isDefault: setting.id === DEFAULT_SETTING_ID,
        counts, objectCount: Object.values(counts).reduce((a, b) => a + b, 0), createdAt: setting.createdAt,
    };
}

// Every setting (Default first, then by name): [{ id, name, autoConfirm, isDefault, counts, objectCount, createdAt }].
export function listSettings() {
    return Object.values(settingStore())
        .map(settingSummary)
        .sort((a, b) => (b.isDefault - a.isDefault) || a.name.localeCompare(b.name));
}

export function getSetting(settingId) {
    const setting = settingStore()[settingId];
    return setting ? settingSummary(setting) : null;
}

export function createSetting({ name, autoConfirm = false } = {}) {
    const clean = text(name, MAX_NAME);
    if (!clean) throw new Error('a setting needs a name');
    if (listSettings().some((s) => s.name.toLowerCase() === clean.toLowerCase())) throw new Error(`a setting named "${clean}" already exists`);
    const id = `set_${genId()}`;
    settingStore()[id] = newSetting(id, clean, autoConfirm === true);
    persistSettings();
    changed(null);
    return getSetting(id);
}

export function updateSetting(settingId, { name, autoConfirm } = {}) {
    const setting = settingStore()[settingId];
    if (!setting) throw new Error(`setting ${JSON.stringify(settingId)} does not exist`);
    if (name !== undefined) {
        const clean = text(name, MAX_NAME);
        if (!clean) throw new Error('a setting needs a name');
        if (listSettings().some((s) => s.id !== settingId && s.name.toLowerCase() === clean.toLowerCase())) throw new Error(`a setting named "${clean}" already exists`);
        setting.name = clean;
    }
    if (autoConfirm !== undefined) setting.autoConfirm = autoConfirm === true;
    persistSettings();
    changed(null);
    return getSetting(settingId);
}

// Deletes a setting and its canonical objects (they leave every chat's
// variables). Chats that used it have no setting again (asked on next use).
// The Default setting cannot be deleted.
export function deleteSetting(settingId) {
    if (settingId === DEFAULT_SETTING_ID) throw new Error('the Default setting cannot be deleted');
    const settings = settingStore();
    const setting = settings[settingId];
    if (!setting) return false;
    const gone = OBJECT_TYPE_IDS.flatMap((type) => Object.keys(setting.objects[type] ?? {}));
    delete settings[settingId];
    for (const id of gone) removeReferences(id, null);
    for (const [chatId, state] of Object.entries(getSettings().variableStore?.chats || {})) {
        if (state?.setting === settingId) {
            state.setting = null;
            saveChatState(chatId, state);
        }
    }
    persistSettings();
    changed(null);
    return true;
}

// -------------------------------------------------------------- chat layer

function typeLayer(state, type) {
    if (!isObject(state.objects)) state.objects = {};
    if (!isObject(state.objects[type])) state.objects[type] = {};
    const layer = state.objects[type];
    if (!isObject(layer.entries)) layer.entries = {};
    if (!isObject(layer.local)) layer.local = {};
    return layer;
}

function readChat(chatId) {
    return loadChatState(chatId);
}

function writeChat(chatId, mutate) {
    const state = loadChatState(chatId);
    mutate(state);
    saveChatState(chatId, state);
}

// The setting a chat uses, or null when it has not chosen one.
export function getChatSetting(chatId) {
    if (!chatId) return null;
    const id = readChat(chatId).setting;
    return typeof id === 'string' && settingStore()[id] ? id : null;
}

export function setChatSetting(chatId, settingId) {
    if (!chatId) throw new Error('setChatSetting needs a chat');
    if (!settingStore()[settingId]) throw new Error(`setting ${JSON.stringify(settingId)} does not exist`);
    writeChat(chatId, (state) => { state.setting = settingId; });
    changed(chatId);
    return settingId;
}

// The setting a chat effectively uses right now (Default until it chooses).
function effectiveSetting(chatId) {
    return settingStore()[getChatSetting(chatId) ?? DEFAULT_SETTING_ID];
}

// "Ask on first use": the chat's setting, choosing one if it has none. With
// only the Default setting there is nothing to ask - it is chosen. Otherwise
// `ask(settings)` (a UI prompt) picks one; asked once per chat per session;
// a dismissed question means Default.
const askedThisSession = new Map();
export async function ensureChatSetting(chatId, ask = null) {
    if (!chatId) return null;
    const current = getChatSetting(chatId);
    if (current) return current;
    const settings = listSettings();
    if (settings.length <= 1 || typeof ask !== 'function') {
        setChatSetting(chatId, DEFAULT_SETTING_ID);
        return DEFAULT_SETTING_ID;
    }
    if (!askedThisSession.has(chatId)) {
        askedThisSession.set(chatId, (async () => {
            let picked = null;
            try {
                picked = await ask(settings);
            } catch (err) {
                console.warn(LOG_PREFIX, 'setting question failed (gracefully handled)', err);
            }
            const id = settingStore()[picked] ? picked : DEFAULT_SETTING_ID;
            if (!getChatSetting(chatId)) setChatSetting(chatId, id);
            return getChatSetting(chatId);
        })());
    }
    return askedThisSession.get(chatId);
}

// ---------------------------------------------------------------- lookups

// Where object `id` lives for a chat: { scope: 'chat' | 'setting', settingId, record } or null.
function locate(chatId, id, settingId = null) {
    const t = objectTypeOfId(id);
    if (!t) return null;
    if (chatId) {
        const local = typeLayer(readChat(chatId), t.id).local[id];
        if (local) return { scope: 'chat', settingId: null, record: local };
    }
    if (t.scope === 'story') return null;
    const setting = settingId ? settingStore()[settingId] : (chatId ? effectiveSetting(chatId) : null);
    if (setting?.objects[t.id]?.[id]) return { scope: 'setting', settingId: setting.id, record: setting.objects[t.id][id] };
    // Any setting (a chat showing an object of another setting).
    if (!settingId) {
        for (const other of Object.values(settingStore())) {
            if (other.objects[t.id]?.[id]) return { scope: 'setting', settingId: other.id, record: other.objects[t.id][id] };
        }
    }
    return null;
}

// An object as displayed: its active variant's overrides applied.
function applyVariant(record) {
    const variant = record.activeVariant ? record.variants?.[record.activeVariant] : null;
    return variant ? { ...record, ...variant.overrides } : record;
}

function baseFields(t, record) {
    const out = { name: record.name, aliases: [...record.aliases], image: record.image, description: record.description };
    for (const field of t.fields) out[field.name] = structuredClone(record[field.name]);
    return out;
}

function view(chatId, found) {
    const t = typeOfId(found.record.id);
    const record = normalizeObject(t.id, found.record);
    const shown = applyVariant(record);
    const entry = chatId ? typeLayer(readChat(chatId), t.id).entries[record.id] : null;
    const out = {
        id: record.id,
        type: t.id,
        name: shown.name,
        aliases: [...shown.aliases],
        image: shown.image,
        description: shown.description,
        introduction_snippet: record.introduction_snippet,
        related_entity_ids: [...record.related_entity_ids],
        related_memory_ids: [...record.related_memory_ids],
    };
    for (const field of t.fields) out[field.name] = structuredClone(shown[field.name]);
    Object.assign(out, {
        confirmed: record.confirmed,
        scope: found.scope,
        settingId: found.settingId,
        matches: Number.isFinite(entry?.matches) ? entry.matches : 0,
        // Per-chat, ephemeral state; null outside a chat.
        runtime: chatId ? runtimeView(chatId, t, record.id) : null,
        activeVariant: record.activeVariant,
        variants: Object.values(record.variants).map((v) => ({ id: v.id, name: v.name, overrides: structuredClone(v.overrides) })),
        base: baseFields(t, record),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    });
    if (t.hasPresence) out.present = entry?.present === true;
    return out;
}

export function getObject(chatId, id, settingId = null) {
    const found = locate(chatId, id, settingId);
    return found ? view(chatId, found) : null;
}

// The objects of a type in a chat: its own, then (world types) its
// setting's - sorted by name. Without a chat, `settingId`'s canonical ones.
export function listObjects(chatId, type, { settingId = null } = {}) {
    const t = mustType(type);
    const out = [];
    if (chatId && !settingId) {
        for (const record of Object.values(typeLayer(readChat(chatId), type).local)) out.push(view(chatId, { scope: 'chat', settingId: null, record }));
        if (t.scope === 'world') {
            const setting = effectiveSetting(chatId);
            for (const record of Object.values(setting.objects[type])) out.push(view(chatId, { scope: 'setting', settingId: setting.id, record }));
        }
    } else if (t.scope === 'world') {
        const setting = settingStore()[settingId ?? DEFAULT_SETTING_ID];
        if (setting) for (const record of Object.values(setting.objects[type])) out.push(view(chatId, { scope: 'setting', settingId: setting.id, record }));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The object of a type a name (or alias) means in a chat - its own first,
// then (world types) its setting's; the active variant's name and aliases
// count too. Null when none matches.
export function getObjectByAlias(chatId, type, name) {
    const t = mustType(type);
    const key = nameKey(name);
    if (!key || !chatId) return null;
    const matches = (record) => {
        const shown = applyVariant(normalizeObject(type, record));
        return [record.name, ...(record.aliases ?? []), shown.name, ...shown.aliases].some((n) => nameKey(n) === key);
    };
    for (const record of Object.values(typeLayer(readChat(chatId), type).local)) if (matches(record)) return view(chatId, { scope: 'chat', settingId: null, record });
    if (t.scope === 'world') {
        const setting = effectiveSetting(chatId);
        for (const record of Object.values(setting.objects[type])) if (matches(record)) return view(chatId, { scope: 'setting', settingId: setting.id, record });
    }
    return null;
}

// --------------------------------------------------------------- mutations

function newId(t) {
    return `${t.idPrefix}_${genId()}`;
}

// Writes a record where it lives. `found` from locate().
function saveRecord(chatId, found, record) {
    record.updatedAt = Date.now();
    if (found.scope === 'chat') {
        writeChat(chatId, (state) => { typeLayer(state, record.type).local[record.id] = record; });
    } else {
        settingStore()[found.settingId].objects[record.type][record.id] = record;
        persistSettings();
    }
}

function mustLocate(chatId, id, settingId) {
    const found = locate(chatId, id, settingId);
    if (!found) throw new Error(`object ${JSON.stringify(id)} does not exist`);
    return found;
}

// Applies a patch of editable fields onto a record (validated).
function applyPatch(t, record, patch) {
    if (patch.name !== undefined) {
        const name = text(patch.name, MAX_NAME);
        if (!name) throw new Error(`a ${t.noun} needs a name`);
        record.name = name;
    }
    record.aliases = cleanAliases(patch.aliases !== undefined ? patch.aliases : record.aliases, record.name);
    if (patch.image !== undefined) record.image = cleanImage(patch.image);
    if (patch.description !== undefined) record.description = text(patch.description, MAX_TEXT);
    if (patch.related_entity_ids !== undefined) record.related_entity_ids = cleanIds(patch.related_entity_ids);
    if (patch.related_memory_ids !== undefined) record.related_memory_ids = cleanIds(patch.related_memory_ids);
    for (const field of t.fields) if (patch[field.name] !== undefined) record[field.name] = cleanField(field, patch[field.name]);
}

// Creates an object in a chat: an unconfirmed world object (extraction, or
// the user assigning a new one) - confirmed, and so in the setting, at once
// when the chat's setting auto-confirms - or a story object (always the
// chat's). `data` may hold any editable field.
export function createChatObject(chatId, type, name, snippet = null, data = {}) {
    const t = mustType(type);
    if (!chatId) throw new Error('createChatObject needs a chat');
    if (!text(name, MAX_NAME)) throw new Error(`a ${t.noun} needs a name`);
    const record = normalizeObject(type, { ...data, name, introduction_snippet: snippet, confirmed: false, variants: {}, activeVariant: null }, newId(t));
    writeChat(chatId, (state) => {
        const layer = typeLayer(state, type);
        layer.local[record.id] = record;
        layer.entries[record.id] = { matches: 0, ...(layer.entries[record.id] ?? {}) };
    });
    if (t.scope === 'world' && effectiveSetting(chatId).autoConfirm) confirmObject(chatId, record.id);
    changed(chatId);
    return getObject(chatId, record.id);
}

// Creates a canonical (confirmed) world object directly in a setting.
export function createObject(settingId, type, data = {}) {
    const t = mustType(type);
    if (t.scope !== 'world') throw new Error(`${t.plural.toLowerCase()} belong to a chat - create them with createChatObject`);
    const setting = settingStore()[settingId];
    if (!setting) throw new Error(`setting ${JSON.stringify(settingId)} does not exist`);
    if (!text(data.name, MAX_NAME)) throw new Error(`a ${t.noun} needs a name`);
    const record = normalizeObject(type, { ...data, confirmed: true, variants: {}, activeVariant: null }, newId(t));
    setting.objects[type][record.id] = record;
    persistSettings();
    changed(null);
    return getObject(null, record.id, settingId);
}

// Edits an object's baseline fields where it lives - a canonical object for
// every chat on its setting. Saving an edit confirms a world object, which
// puts a chat object into the setting.
export function updateObject(chatId, id, patch = {}, { settingId = null } = {}) {
    const t = typeOfId(id);
    const found = mustLocate(chatId, id, settingId);
    const record = normalizeObject(t.id, found.record);
    applyPatch(t, record, patch);
    record.confirmed = true;
    saveRecord(chatId, found, record);
    if (found.scope === 'chat' && t.scope === 'world') moveToSetting(chatId, id);
    changed(found.scope === 'chat' ? chatId : null);
    return getObject(chatId, id, settingId);
}

export function addObjectAlias(chatId, id, alias, options = {}) {
    const t = typeOfId(id);
    const found = mustLocate(chatId, id, options.settingId);
    const record = normalizeObject(t.id, found.record);
    record.aliases = cleanAliases([...record.aliases, alias], record.name);
    saveRecord(chatId, found, record);
    changed(found.scope === 'chat' ? chatId : null);
    return getObject(chatId, id, options.settingId);
}

// Confirms a world object as it is - a chat object moves into the chat's
// setting (confirmed <=> in the setting). Story objects are always confirmed.
export function confirmObject(chatId, id, options = {}) {
    const t = typeOfId(id);
    const found = mustLocate(chatId, id, options.settingId);
    if (t.scope === 'story') return getObject(chatId, id, options.settingId);
    const record = normalizeObject(t.id, found.record);
    record.confirmed = true;
    saveRecord(chatId, found, record);
    if (found.scope === 'chat') moveToSetting(chatId, id);
    changed(found.scope === 'chat' ? chatId : null);
    return getObject(chatId, id, options.settingId);
}

function emptyRuntime() {
    return { values: {} };
}

function setPresence(chatId, type, ids, present) {
    if (!chatId || ids.length === 0) return;
    writeChat(chatId, (state) => {
        const layer = typeLayer(state, type);
        for (const id of ids) {
            layer.entries[id] = { matches: 0, ...(layer.entries[id] ?? {}), present };
            // Runtime state belongs to the scene: gone when they leave it.
            if (!present) layer.entries[id].runtime = emptyRuntime();
        }
    });
    changed(chatId);
}

export function markObjectPresent(chatId, id) {
    const t = typeOfId(id);
    if (!t.hasPresence) throw new Error(`${t.plural.toLowerCase()} have no presence`);
    mustLocate(chatId, id);
    setPresence(chatId, t.id, [id], true);
    return getObject(chatId, id);
}

export function markObjectAbsent(chatId, id) {
    const t = typeOfId(id);
    if (!t.hasPresence) throw new Error(`${t.plural.toLowerCase()} have no presence`);
    mustLocate(chatId, id);
    setPresence(chatId, t.id, [id], false);
    return getObject(chatId, id);
}

// Moves a (confirmed) chat world object into the chat's setting - same id,
// so every variable keeps pointing at it. Only confirmation does this.
function moveToSetting(chatId, id) {
    const t = typeOfId(id);
    const local = typeLayer(readChat(chatId), t.id).local[id];
    if (!local) return;
    effectiveSetting(chatId).objects[t.id][id] = normalizeObject(t.id, local);
    writeChat(chatId, (state) => { delete typeLayer(state, t.id).local[id]; });
    persistSettings();
}

// Merges `sourceId` into `targetId` (same type): the target keeps its own
// data and gains the source's name and aliases as aliases, its image /
// snippet / text and fields where the target has none, its related ids and
// its variants; presence and matches combine; every variable and reference
// that held the source now holds the target; the source is deleted.
export function mergeObjects(chatId, sourceId, targetId, { settingId = null } = {}) {
    if (sourceId === targetId) throw new Error('cannot merge an object into itself');
    const t = typeOfId(targetId);
    if (typeOfId(sourceId).id !== t.id) throw new Error('only objects of the same type can be merged');
    const source = mustLocate(chatId, sourceId, settingId);
    const target = mustLocate(chatId, targetId, settingId);
    const from = normalizeObject(t.id, source.record);
    const into = normalizeObject(t.id, target.record);
    into.aliases = cleanAliases([...into.aliases, from.name, ...from.aliases], into.name);
    into.image ??= from.image;
    into.introduction_snippet ??= from.introduction_snippet;
    if (!into.description) into.description = from.description;
    for (const field of t.fields) {
        const empty = Array.isArray(into[field.name]) ? into[field.name].length === 0 : !into[field.name];
        if (empty) into[field.name] = structuredClone(from[field.name]);
    }
    into.related_entity_ids = cleanIds([...into.related_entity_ids, ...from.related_entity_ids]);
    into.related_memory_ids = cleanIds([...into.related_memory_ids, ...from.related_memory_ids]);
    const names = new Set(Object.values(into.variants).map((v) => v.name.toLowerCase()));
    for (const variant of Object.values(from.variants)) {
        if (names.has(variant.name.toLowerCase())) continue;
        const vid = `var_${genId()}`;
        into.variants[vid] = { ...variant, id: vid };
    }
    into.confirmed = into.confirmed || from.confirmed;
    saveRecord(chatId, target, into);
    removeRecord(chatId, source);
    removeReferences(sourceId, targetId);
    if (into.confirmed && target.scope === 'chat' && t.scope === 'world') moveToSetting(chatId, targetId);
    changed(null);
    return getObject(chatId, targetId, settingId);
}

// A detection that is really something already known: `sourceId` (usually
// an unconfirmed object with the wrong name) is resolved to `targetId` - a
// merge (the detected name becomes the target's alias; variables follow)
// after which the target is confirmed, so it is in the setting.
export function resolveObject(chatId, sourceId, targetId, options = {}) {
    mergeObjects(chatId, sourceId, targetId, options);
    return confirmObject(chatId, targetId, options);
}

function removeRecord(chatId, found) {
    const type = found.record.type ?? typeOfId(found.record.id).id;
    if (found.scope === 'chat') writeChat(chatId, (state) => { delete typeLayer(state, type).local[found.record.id]; });
    else {
        delete settingStore()[found.settingId].objects[type][found.record.id];
        persistSettings();
    }
}

// Deletes an object (chat-local or canonical); it leaves every variable,
// every reference and every chat's state.
export function deleteObject(chatId, id, { settingId = null } = {}) {
    const found = locate(chatId, id, settingId);
    if (!found) return false;
    removeRecord(chatId, found);
    removeReferences(id, null);
    changed(null);
    return true;
}

// Rewrites references to `from` in one record (its ref fields of that type,
// and related_entity_ids) - to `to`, or removed. Returns whether it changed.
function rewriteRecordRefs(record, from, to) {
    const t = getObjectType(record?.type) ?? objectTypeOfId(record?.id);
    if (!t) return false;
    const fromType = objectTypeOfId(from)?.id;
    let dirty = false;
    for (const field of t.fields) {
        if (field.refType !== fromType) continue;
        if (field.kind === 'ref' && record[field.name] === from) { record[field.name] = to ?? ''; dirty = true; }
        if (field.kind === 'refs' && Array.isArray(record[field.name]) && record[field.name].includes(from)) {
            record[field.name] = [...new Set(record[field.name].map((v) => (v === from ? to : v)).filter(Boolean))];
            dirty = true;
        }
    }
    if (Array.isArray(record.related_entity_ids) && record.related_entity_ids.includes(from)) {
        record.related_entity_ids = [...new Set(record.related_entity_ids.map((v) => (v === from ? to : v)).filter(Boolean))];
        dirty = true;
    }
    return dirty;
}

// Everywhere: variables holding `from` now hold `to` (or lose it, `to`
// null), references in other objects follow, and its chat entry moves
// (presence OR-ed, matches summed).
function removeReferences(from, to) {
    const t = objectTypeOfId(from);
    if (!t) return;
    for (const setting of Object.values(settingStore())) {
        for (const records of Object.values(setting.objects)) {
            for (const record of Object.values(records)) rewriteRecordRefs(record, from, to);
        }
    }
    persistSettings();
    for (const [chatId, state] of Object.entries(getSettings().variableStore?.chats || {})) {
        let dirty = false;
        for (const entry of Object.values(state?.variables || {})) {
            if (objectTypeOf(entry?.def) !== t.id) continue;
            if (entry.def.type === 'object') {
                if (entry.value === from) { entry.value = to ?? ''; dirty = true; }
            } else if (Array.isArray(entry.value) && entry.value.includes(from)) {
                entry.value = [...new Set(entry.value.map((v) => (v === from ? to : v)).filter(Boolean))];
                dirty = true;
            }
        }
        for (const layer of Object.values(isObject(state?.objects) ? state.objects : {})) {
            for (const record of Object.values(layer?.local ?? {})) if (rewriteRecordRefs(record, from, to)) dirty = true;
        }
        const entries = state?.objects?.[t.id]?.entries;
        if (entries?.[from]) {
            if (to) {
                const a = entries[from];
                const b = entries[to] ?? { matches: 0 };
                entries[to] = { ...b, matches: (a.matches || 0) + (b.matches || 0) };
                if (t.hasPresence) entries[to].present = a.present === true || b.present === true;
            }
            delete entries[from];
            dirty = true;
        }
        if (dirty) saveChatState(chatId, state);
    }
}

// --------------------------------------------------------------- variants

export function addObjectVariant(chatId, id, { name, overrides = {} } = {}, options = {}) {
    const t = typeOfId(id);
    const found = mustLocate(chatId, id, options.settingId);
    const record = normalizeObject(t.id, found.record);
    const clean = text(name, MAX_NAME);
    if (!clean) throw new Error('a variant needs a name');
    if (Object.values(record.variants).some((v) => v.name.toLowerCase() === clean.toLowerCase())) throw new Error(`a variant named "${clean}" already exists`);
    const vid = `var_${genId()}`;
    record.variants[vid] = { id: vid, name: clean, overrides: cleanOverrides(t, overrides) };
    saveRecord(chatId, found, record);
    changed(found.scope === 'chat' ? chatId : null);
    return getObject(chatId, id, options.settingId);
}

export function updateObjectVariant(chatId, id, variantId, { name, overrides } = {}, options = {}) {
    const t = typeOfId(id);
    const found = mustLocate(chatId, id, options.settingId);
    const record = normalizeObject(t.id, found.record);
    const variant = record.variants[variantId];
    if (!variant) throw new Error(`variant ${JSON.stringify(variantId)} does not exist`);
    if (name !== undefined) {
        const clean = text(name, MAX_NAME);
        if (!clean) throw new Error('a variant needs a name');
        if (Object.values(record.variants).some((v) => v.id !== variantId && v.name.toLowerCase() === clean.toLowerCase())) throw new Error(`a variant named "${clean}" already exists`);
        variant.name = clean;
    }
    if (overrides !== undefined) variant.overrides = cleanOverrides(t, overrides);
    saveRecord(chatId, found, record);
    changed(found.scope === 'chat' ? chatId : null);
    return getObject(chatId, id, options.settingId);
}

export function deleteObjectVariant(chatId, id, variantId, options = {}) {
    const t = typeOfId(id);
    const found = mustLocate(chatId, id, options.settingId);
    const record = normalizeObject(t.id, found.record);
    if (!record.variants[variantId]) return getObject(chatId, id, options.settingId);
    delete record.variants[variantId];
    if (record.activeVariant === variantId) record.activeVariant = null;
    saveRecord(chatId, found, record);
    changed(found.scope === 'chat' ? chatId : null);
    return getObject(chatId, id, options.settingId);
}

// Which variant the object uses (null = its base) - one choice per object:
// for a canonical object, for every chat on its setting.
export function setObjectActiveVariant(chatId, id, variantId, options = {}) {
    const t = typeOfId(id);
    const found = mustLocate(chatId, id, options.settingId);
    const record = normalizeObject(t.id, found.record);
    if (variantId !== null && !record.variants[variantId]) throw new Error(`variant ${JSON.stringify(variantId)} does not exist`);
    record.activeVariant = variantId;
    saveRecord(chatId, found, record);
    changed(found.scope === 'chat' ? chatId : null);
    return getObject(chatId, id, options.settingId);
}

// ------------------------------------------------------------- extraction

// The sentence of `source` (a chat message) that mentions `name`, trimmed to
// MAX_SNIPPET characters, or null.
export function snippetFor(source, name) {
    if (typeof source !== 'string' || !source.trim() || !name) return null;
    const plain = source.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const at = plain.toLowerCase().indexOf(name.toLowerCase());
    if (at < 0) return null;
    const start = Math.max(plain.lastIndexOf('. ', at), plain.lastIndexOf('! ', at), plain.lastIndexOf('? ', at), plain.lastIndexOf('\n', at)) + 1;
    const stops = ['. ', '! ', '? '].map((s) => plain.indexOf(s, at + name.length)).filter((i) => i >= 0);
    const end = stops.length ? Math.min(...stops) + 1 : plain.length;
    let snippet = plain.slice(start, end).trim();
    if (snippet.length > MAX_SNIPPET) snippet = `${snippet.slice(0, MAX_SNIPPET - 1).trim()}…`;
    return snippet || null;
}

// Extraction: the ids of type `type` that `names` mean in `chatId`. Each
// name is alias-matched (the chat's objects, then its setting's); a match
// counts toward confirmation; an unknown name becomes a new chat object
// (unconfirmed, for a world type) with an introduction snippet from
// `source`. Returns { ids (deduplicated, in order), created: [views] }.
export function resolveObjectNames(chatId, type, names, { source = '' } = {}) {
    const t = mustType(type);
    const ids = [];
    const created = [];
    for (const raw of Array.isArray(names) ? names : [names]) {
        const name = text(typeof raw === 'string' ? raw : '', MAX_NAME);
        if (!nameKey(name)) continue;
        const match = getObjectByAlias(chatId, type, name);
        let id;
        if (match) {
            id = match.id;
            recordMatch(chatId, t, id);
        } else {
            const object = createChatObject(chatId, type, name, snippetFor(source, name));
            id = object.id;
            created.push(object);
        }
        if (!ids.includes(id)) ids.push(id);
    }
    if (created.length && t.scope === 'world') notifyNewObjects(t, created);
    return { ids, created };
}

// A match: counts toward confirming a chat world object (CONFIRM_AFTER_MATCHES).
function recordMatch(chatId, t, id) {
    let matches = 0;
    writeChat(chatId, (state) => {
        const layer = typeLayer(state, t.id);
        const entry = { matches: 0, ...(layer.entries[id] ?? {}) };
        entry.matches += 1;
        matches = entry.matches;
        layer.entries[id] = entry;
    });
    if (t.scope === 'world' && matches >= CONFIRM_AFTER_MATCHES && typeLayer(readChat(chatId), t.id).local[id]) confirmObject(chatId, id);
}

// Presence after an extraction (types with presence): `presentIds` are in
// the scene; `absentIds` (for a list variable: what it held before and no
// longer does) are not.
export function applyPresence(chatId, type, presentIds = [], absentIds = []) {
    const t = mustType(type);
    if (!chatId || !t.hasPresence) return;
    const present = new Set(presentIds);
    writeChat(chatId, (state) => {
        const layer = typeLayer(state, type);
        for (const id of present) layer.entries[id] = { matches: 0, ...(layer.entries[id] ?? {}), present: true };
        for (const id of absentIds) {
            if (present.has(id) || !layer.entries[id]) continue;
            layer.entries[id].present = false;
            layer.entries[id].runtime = emptyRuntime();
        }
    });
    changed(chatId);
}

// ------------------------------------------------------- prompt text

// An object as prompt-ready text: name, aliases, description and every set
// field, references shown as names. Empty for an unknown id.
export function describeObject(chatId, id) {
    const object = getObject(chatId, id);
    if (!object) return '';
    const t = getObjectType(object.type);
    const nameOf = (ref) => getObject(chatId, ref)?.name ?? '';
    const lines = [`${object.name}${object.aliases.length ? ` (also: ${object.aliases.join(', ')})` : ''} [${t.label}]`];
    if (object.description) lines.push(object.description);
    for (const field of t.fields) {
        const value = object[field.name];
        let shown = '';
        if (field.kind === 'ref') shown = nameOf(value);
        else if (field.kind === 'refs') shown = (value ?? []).map(nameOf).filter(Boolean).join(', ');
        else if (Array.isArray(value)) shown = value.join('; ');
        else shown = value ?? '';
        if (shown) lines.push(`${field.label}: ${shown}`);
    }
    const related = object.related_entity_ids.map(nameOf).filter(Boolean);
    if (related.length) lines.push(`Related: ${related.join(', ')}`);
    for (const [name, value] of Object.entries(object.runtime?.values ?? {})) {
        if (value !== null && value !== undefined && value !== '') lines.push(`${name.charAt(0).toUpperCase()}${name.slice(1).replace(/_/g, ' ')} (now): ${value}`);
    }
    return lines.join('\n');
}

// --------------------------------------------------------------- migration

function migrateRecord(type, record) {
    if (!isObject(record)) return record;
    // A character's biography is its description.
    if (record.biography !== undefined && record.description === undefined) record.description = record.biography;
    delete record.biography;
    record.type = type;
    return record;
}

// Old character runtime { thought, mood, intent, custom: {...} } -> { values }.
function migrateRuntime(runtime) {
    if (!isObject(runtime) || isObject(runtime.values)) return runtime;
    const values = { ...(isObject(runtime.custom) ? runtime.custom : {}) };
    for (const [key, value] of Object.entries(runtime)) if (key !== 'custom') values[key] = value;
    return { values };
}

// The variable type characters had before object variables existed (data
// from then only - nothing current uses it).
const LEGACY_CHARACTER_TYPE = 'character';

// One variable definition from before object variables: the legacy
// character type -> object/character; a schema'd object item type ->
// record. Returns whether it changed.
export function migrateVariableDefinition(def) {
    if (!isObject(def)) return false;
    let dirty = false;
    if (def.type === LEGACY_CHARACTER_TYPE) {
        def.type = 'object';
        def.objectType = LEGACY_CHARACTER_TYPE;
        dirty = true;
    }
    if (def.type === 'array' && def.itemType === LEGACY_CHARACTER_TYPE) {
        def.itemType = 'object';
        def.itemObjectType = LEGACY_CHARACTER_TYPE;
        dirty = true;
    }
    if (def.type === 'array' && def.itemType === 'object' && !isObjectType(def.itemObjectType)) {
        def.itemType = 'record';
        dirty = true;
    }
    return dirty;
}

// Data from before objects (and from before "confirmed <=> in the
// setting"): character settings become settings holding objects,
// state.characters becomes state.setting + state.objects.character,
// character variables become object variables, and confirmed world objects
// still living in a chat move into its setting. Idempotent; run on startup.
// Returns { settings, chats, variables, moved } (counts).
export function migrateObjectData() {
    const counts = { settings: 0, chats: 0, variables: 0, moved: 0 };
    const store = getSettings().variableStore;
    if (isObject(store.characterSettings)) {
        if (!isObject(store.settings)) store.settings = {};
        for (const [id, old] of Object.entries(store.characterSettings)) {
            if (store.settings[id]) continue;
            const setting = newSetting(id, old.name || 'Setting', old.autoConfirm === true || old.autoPromote === true);
            setting.createdAt = old.createdAt ?? setting.createdAt;
            for (const [cid, record] of Object.entries(isObject(old.characters) ? old.characters : {})) setting.objects.character[cid] = migrateRecord('character', record);
            if (isObject(old.runtimeFields)) setting.runtimeFields.character = old.runtimeFields;
            store.settings[id] = setting;
            counts.settings++;
        }
        delete store.characterSettings;
    }
    const settings = settingStore();

    for (const preset of Object.values(getSettings().presets || {})) {
        for (const def of Object.values(preset?.variables || {})) if (migrateVariableDefinition(def)) counts.variables++;
    }

    for (const [chatId, state] of Object.entries(store.chats || {})) {
        if (!isObject(state)) continue;
        let dirty = false;
        if (isObject(state.characters)) {
            const old = state.characters;
            if (state.setting === undefined && typeof old.setting === 'string') state.setting = old.setting;
            const layer = typeLayer(state, 'character');
            for (const [id, entry] of Object.entries(isObject(old.entries) ? old.entries : {})) {
                layer.entries[id] = { ...entry, runtime: migrateRuntime(entry?.runtime) };
            }
            for (const [id, record] of Object.entries(isObject(old.local) ? old.local : {})) layer.local[id] = migrateRecord('character', record);
            delete state.characters;
            counts.chats++;
            dirty = true;
        }
        for (const entry of Object.values(state.variables || {})) if (migrateVariableDefinition(entry?.def)) { counts.variables++; dirty = true; }
        // Confirmed world objects left in a chat move into its setting.
        for (const type of OBJECT_TYPE_IDS) {
            if (OBJECT_TYPES[type].scope !== 'world' || !isObject(state.objects?.[type]?.local)) continue;
            const local = state.objects[type].local;
            const setting = settings[state.setting] ?? settings[DEFAULT_SETTING_ID];
            for (const record of Object.values(local)) {
                if (record?.confirmed !== true) continue;
                setting.objects[type][record.id] = normalizeObject(type, record);
                delete local[record.id];
                counts.moved++;
                dirty = true;
            }
        }
        if (dirty) saveChatState(chatId, state);
    }
    if (counts.settings || counts.variables || counts.chats || counts.moved) persistSettings();
    return counts;
}

// ------------------------------------------------- the manager modal hook

// The object manager window lives in a UI extension (Pretty Panels); it
// registers its opener here. State Engine's drawer button and the "new
// objects detected" notifications call openObjectManager().
let manager = null;

export function setObjectManager(opener) {
    manager = typeof opener === 'function' ? opener : null;
}

export function hasObjectManager() {
    return manager !== null;
}

// Opens the registered object manager (options: { type?, objectId?, view?:
// 'chat' | 'setting', settingId?, filter?: 'unconfirmed' }). Returns false
// when none is registered.
export function openObjectManager(options = {}) {
    if (!manager) return false;
    try {
        manager(options);
        return true;
    } catch (err) {
        console.warn(LOG_PREFIX, 'the object manager failed to open (gracefully handled)', err);
        return false;
    }
}

// "New <objects> detected for review" - one State Engine notification per
// type, replaced on each detection; clicking it opens the manager on the
// chat's unconfirmed objects of that type.
//
// They are about the OPEN chat (unconfirmed world objects live only in the
// chat that met them), so they follow it: syncObjectReviewNotifications()
// runs on every chat change - and so after a reload too - dropping another
// chat's and bringing back this chat's still-unreviewed objects; and one is
// removed once nothing of its type is left to review (changed()).
const reviewNotificationId = (t) => notificationId(BUILTIN_NAMESPACE, `${t.id}-detected`);

function postReviewNotification(t, objects, lead) {
    try {
        const callbackId = `objects.review.${t.id}`;
        setCallback(BUILTIN_NAMESPACE, callbackId, () => openObjectManager({ type: t.id, view: 'chat', filter: 'unconfirmed' }));
        const names = objects.map((c) => c.name).slice(0, 5).join(', ');
        putNotification({
            id: reviewNotificationId(t),
            source: BUILTIN_NAMESPACE,
            severity: 'info',
            message: `${lead}: ${names}${objects.length > 5 ? ` and ${objects.length - 5} more` : ''}`,
            callbackId,
        });
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not post the new-objects notification (gracefully handled)', err);
    }
}

function notifyNewObjects(t, created) {
    postReviewNotification(t, created, `New ${t.plural.toLowerCase()} detected for review`);
}

// The chat's world objects of type `t` still waiting for review.
function unconfirmedIn(chatId, t) {
    if (!chatId) return [];
    try {
        return listObjects(chatId, t.id).filter((o) => o.scope === 'chat' && !o.confirmed);
    } catch {
        return [];
    }
}

// The review notifications for the chat now open (`chatId`, null: none):
// one per type with objects still to review, none for anything else.
export function syncObjectReviewNotifications(chatId) {
    for (const t of Object.values(OBJECT_TYPES).filter((type) => type.scope === 'world')) {
        try {
            const waiting = unconfirmedIn(chatId, t);
            if (waiting.length) postReviewNotification(t, waiting, `${t.plural} to review in this chat`);
            else if (getNotification(reviewNotificationId(t))) removeNotification(reviewNotificationId(t));
        } catch (err) {
            console.warn(LOG_PREFIX, 'could not update the review notifications (gracefully handled)', err);
        }
    }
}

// A notification whose objects have all been reviewed goes.
function dropReviewedNotifications(chatId) {
    for (const t of Object.values(OBJECT_TYPES).filter((type) => type.scope === 'world')) {
        if (getNotification(reviewNotificationId(t)) && unconfirmedIn(chatId, t).length === 0) removeNotification(reviewNotificationId(t));
    }
}

// --------------------------------------------------------------- plumbing

// Something about objects changed: displays re-read (variables-changed
// event), and the open chat's macros show the new names.
function changed(chatId) {
    notifyVariablesChanged(chatId);
    try {
        const current = SillyTavern.getContext()?.chatId;
        if (current) hydrateMacroStoreForChat(current);
        if (current) dropReviewedNotifications(current);
    } catch {
        // No SillyTavern context (tests): nothing to refresh.
    }
}

// Names for macros, the tracker and prompts, in the open chat.
setObjectNameResolver((id) => {
    let chatId = null;
    try {
        chatId = SillyTavern.getContext()?.chatId ?? null;
    } catch {
        chatId = null;
    }
    return getObject(chatId, id)?.name ?? null;
});
