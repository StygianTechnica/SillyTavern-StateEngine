// State Engine — characters and settings (requirements spec 1.42)
//
// Two layers:
//
//   SETTINGS (global, settings.variableStore.characterSettings) - containers
//   of CANONICAL characters, like presets or world folders, not tied to any
//   chat. A character's baseline lives here: name, aliases, image,
//   introduction snippet, biography, personality, faction, role - and its
//   named VARIANTS (alternate versions, each overriding baseline fields),
//   with the one variant the setting currently uses (activeVariant, null =
//   the base). Editing a canonical character edits the baseline, for every
//   chat using the setting. One setting, "default", always exists; with
//   autoConfirm on, it collects every character chats on it meet.
//
//   CHAT (per chat, on the chat's state as state.characters) - which setting
//   the chat uses, per-character chat state (present, match count), and the
//   chat's OWN characters: the UNCONFIRMED ones extraction or the user
//   created, not yet reviewed. Canonical characters are never copied into a
//   chat.
//
//   state.characters = { setting: id | null, entries: { [id]: { present, matches } },
//                        local: { [id]: character } }
//
// A character (canonical or chat-local):
//   { id, name, aliases: [], image: string | null, introduction_snippet: string | null,
//     biography, personality, faction, role, confirmed,
//     variants: { [variantId]: { id, name, overrides: { name?, aliases?, image?,
//                 biography?, personality?, faction?, role? } } },
//     activeVariant: variantId | null, createdAt, updatedAt }
//
// THE RULE (user requirement, 2026-10-08): confirmed <=> in the setting.
// A character extraction creates is unconfirmed and lives only in its chat.
// Confirming it - the user saving an edit (canonicalization) or confirming
// it as it is - moves it into the chat's setting (same id, so every
// variable keeps pointing at it). Automatic confirmation: a chat character
// matched CONFIRM_AFTER_MATCHES times, or every new character when its
// setting has autoConfirm on. There is no separate "add to setting". A
// detection that is really someone already known is RESOLVED to them
// (resolveCharacter): its name becomes their alias, and they are confirmed.
//
// Variable values hold character ids (a character variable one id, an array
// of item type character a list); character-display.js shows names.
//
// RUNTIME STATE (spec 1.43): per chat, ephemeral - never in a setting. Each
// character in a chat has runtime = { present, thought, mood, intent,
// custom: { [field]: value } }, overwritten each turn by the prompted update
// (for the characters named in a prompted character list) and cleared when
// the character is not present. WHICH fields exist is per setting
// (setting.runtimeFields): the built-in thought, mood and intent, plus the
// user's own; each is a string, number or enum, prompted or not (a
// non-prompted field is set by hand in the Character Manager, or through
// the API). Stored on the chat's entry: entries[id].runtime = { thought,
// mood, intent, custom } (present stays entries[id].present).

import { LOG_PREFIX, BUILTIN_NAMESPACE, getSettings, persistSettings } from './settings-core.js';
import { loadChatState, saveChatState, hydrateMacroStoreForChat } from './chat-state.js';
import { notifyVariablesChanged } from './variable-change-signal.js';
import { putNotification, notificationId, setCallback } from './notification-core.js';
import { genId } from './variable-schema.js';
import { setCharacterNameResolver, isCharacterDefinition } from './character-display.js';
import { safeImageSrc } from './image-variables.js';

export const DEFAULT_SETTING_ID = 'default';
export const CONFIRM_AFTER_MATCHES = 10;
const BASELINE_TEXT_FIELDS = ['biography', 'personality', 'faction', 'role'];
// Fields a variant may override.
const VARIANT_FIELDS = ['name', 'aliases', 'image', ...BASELINE_TEXT_FIELDS];
const MAX_NAME = 100;
const MAX_ALIAS = 100;
const MAX_ALIASES = 50;
const MAX_TEXT = 4000;
const MAX_SNIPPET = 300;
const REVIEW_CALLBACK = 'characters.review';

function text(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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

function cleanOverrides(raw) {
    const out = {};
    if (!isObject(raw)) return out;
    if (typeof raw.name === 'string' && raw.name.trim()) out.name = text(raw.name, MAX_NAME);
    if (Array.isArray(raw.aliases)) out.aliases = cleanAliases(raw.aliases);
    if ('image' in raw) out.image = cleanImage(raw.image);
    for (const field of BASELINE_TEXT_FIELDS) if (typeof raw[field] === 'string') out[field] = text(raw[field], MAX_TEXT);
    return out;
}

function cleanVariants(raw) {
    const out = {};
    for (const variant of Object.values(isObject(raw) ? raw : {})) {
        if (!isObject(variant) || typeof variant.id !== 'string' || !variant.id) continue;
        out[variant.id] = { id: variant.id, name: text(variant.name, MAX_NAME) || 'Variant', overrides: cleanOverrides(variant.overrides) };
    }
    return out;
}

// A character record, validated (any missing field gets its default).
export function normalizeCharacter(raw, id = raw?.id) {
    const name = text(raw?.name, MAX_NAME) || 'Unnamed';
    const variants = cleanVariants(raw?.variants);
    const out = {
        id,
        name,
        aliases: cleanAliases(raw?.aliases, name),
        image: cleanImage(raw?.image),
        introduction_snippet: typeof raw?.introduction_snippet === 'string' && raw.introduction_snippet.trim() ? raw.introduction_snippet.trim().slice(0, MAX_SNIPPET) : null,
        confirmed: raw?.confirmed === true,
        variants,
        activeVariant: typeof raw?.activeVariant === 'string' && variants[raw.activeVariant] ? raw.activeVariant : null,
        createdAt: Number.isFinite(raw?.createdAt) ? raw.createdAt : Date.now(),
        updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : Date.now(),
    };
    for (const field of BASELINE_TEXT_FIELDS) out[field] = text(raw?.[field], MAX_TEXT);
    return out;
}

// ------------------------------------------------------- runtime fields

export const RUNTIME_FIELD_TYPES = Object.freeze(['string', 'number', 'enum']);
export const BUILT_IN_RUNTIME_FIELDS = Object.freeze(['thought', 'mood', 'intent']);
export const DEFAULT_MOODS = Object.freeze(['Neutral', 'Angry', 'Afraid', 'Curious', 'Confident', 'Sad', 'Suspicious', 'Determined']);
const RUNTIME_FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_RUNTIME_TEXT = 200;
const MAX_ENUM_VALUES = 30;

export function defaultRuntimeFields() {
    return {
        thought: { name: 'thought', type: 'string', prompted: true, description: 'A short internal thought, in their voice (under 20 words).' },
        mood: { name: 'mood', type: 'enum', prompted: true, values: [...DEFAULT_MOODS], description: 'Their mood right now - the closest listed value, never another word.' },
        intent: { name: 'intent', type: 'string', prompted: true, description: 'A short phrase: what they mean to do next.' },
    };
}

// One runtime field definition, validated. Throws with a reason.
function normalizeRuntimeField(raw, what = 'runtime field') {
    if (!isObject(raw)) throw new Error(`${what} must be an object`);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!RUNTIME_FIELD_NAME.test(name)) throw new Error(`${what} name ${JSON.stringify(raw.name)} is not valid - lowercase letters, digits and _, starting with a letter (max 40)`);
    if (name === 'present') throw new Error('"present" is not a runtime field you define - it is the character\'s presence');
    const type = raw.type ?? 'string';
    if (!RUNTIME_FIELD_TYPES.includes(type)) throw new Error(`runtime field "${name}" has unknown type ${JSON.stringify(type)} (string, number or enum)`);
    const out = { name, type, prompted: raw.prompted !== false, description: text(raw.description, 300) };
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
        // An image per value (spec 1.46): { [value]: reference } - shown in
        // place of the word. Keys match values case-insensitively and are
        // stored as the value is spelled; an image for a value no longer
        // listed is dropped; an empty reference means none.
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

// A setting's runtime fields, built-ins first then the user's, in order:
// [{ name, type, prompted, description, values?, min?, max?, builtIn }].
export function getRuntimeFields(settingId) {
    const setting = settingStore()[settingId];
    if (!setting) return [];
    const fields = Object.values(setting.runtimeFields);
    const order = (f) => (BUILT_IN_RUNTIME_FIELDS.includes(f.name) ? BUILT_IN_RUNTIME_FIELDS.indexOf(f.name) : 100);
    return fields
        .map((f, i) => ({ ...structuredClone(f), builtIn: BUILT_IN_RUNTIME_FIELDS.includes(f.name), _i: i }))
        .sort((a, b) => order(a) - order(b) || a._i - b._i)
        .map(({ _i, ...f }) => f);
}

// Replaces a setting's runtime fields with `fields` (validated - throws).
// The built-in thought, mood and intent cannot be removed (a missing one
// keeps its current definition); their type, values, description and
// prompted switch can change. Returns the new list.
export function setRuntimeFields(settingId, fields) {
    const setting = settingStore()[settingId];
    if (!setting) throw new Error(`setting ${JSON.stringify(settingId)} does not exist`);
    if (!Array.isArray(fields)) throw new Error('runtime fields must be an array');
    const next = {};
    fields.forEach((raw, i) => {
        const field = normalizeRuntimeField(raw, `runtime field #${i + 1}`);
        if (next[field.name]) throw new Error(`runtime field "${field.name}" is listed twice`);
        next[field.name] = field;
    });
    for (const name of BUILT_IN_RUNTIME_FIELDS) {
        if (!next[name]) next[name] = setting.runtimeFields[name] ?? defaultRuntimeFields()[name];
    }
    setting.runtimeFields = next;
    persistSettings();
    changed(null);
    return getRuntimeFields(settingId);
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

function emptyRuntime() {
    return { thought: null, mood: null, intent: null, custom: {} };
}

// A character's runtime in a chat, by the chat's setting's fields:
// { present, thought, mood, intent, custom: { [field]: value }, images } -
// fields the setting no longer defines are left out. images (spec 1.46):
// { [field name]: src } for each enum field whose current value has an
// image, already checked with safeImageSrc (a reference that may not be
// loaded is left out).
function runtimeView(chatId, id) {
    const entry = readChat(chatId).entries[id];
    const stored = isObject(entry?.runtime) ? entry.runtime : emptyRuntime();
    const out = { present: entry?.present === true, thought: null, mood: null, intent: null, custom: {}, images: {} };
    for (const field of getRuntimeFields(effectiveSetting(chatId).id)) {
        const value = BUILT_IN_RUNTIME_FIELDS.includes(field.name) ? stored[field.name] : stored.custom?.[field.name];
        const clean = value === undefined ? null : coerceRuntimeValue(field, value);
        if (BUILT_IN_RUNTIME_FIELDS.includes(field.name)) out[field.name] = clean;
        else out.custom[field.name] = clean;
        const src = runtimeImageSrc(field, clean);
        if (src) out.images[field.name] = src;
    }
    return out;
}

// The image an enum field shows for `value`, ready for <img src>, or null.
export function runtimeImageSrc(field, value) {
    if (field?.type !== 'enum' || typeof value !== 'string' || !isObject(field.images)) return null;
    return safeImageSrc(field.images[value] ?? null);
}

// The prompted update's runtime answer for the characters present this turn:
// `updates` = { [characterId]: { [field]: rawValue } }. Only PROMPTED
// fields are written (each validated; an invalid value clears it).
export function applyRuntimeUpdates(chatId, updates) {
    if (!chatId || !isObject(updates)) return;
    const fields = getRuntimeFields(effectiveSetting(chatId).id).filter((f) => f.prompted);
    writeChat(chatId, (layer) => {
        for (const [id, raw] of Object.entries(updates)) {
            if (!isObject(raw)) continue;
            const entry = { present: false, matches: 0, ...(layer.entries[id] ?? {}) };
            const runtime = isObject(entry.runtime) ? { ...entry.runtime, custom: { ...(entry.runtime.custom ?? {}) } } : emptyRuntime();
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
                // The thought is answered fresh each turn; an empty answer
                // (a small model skipping it) keeps the last one rather than
                // blanking the card.
                if (value === null && field.name === 'thought') continue;
                if (BUILT_IN_RUNTIME_FIELDS.includes(field.name)) runtime[field.name] = value;
                else runtime.custom[field.name] = value;
            }
            entry.runtime = runtime;
            layer.entries[id] = entry;
        }
    });
    changed(chatId);
}

// Sets one NON-prompted runtime field by hand (the Character Manager, or an
// extension). Prompted fields are the prompted update's. Throws with the
// reason; returns the character.
export function setRuntimeValue(chatId, id, fieldName, value) {
    if (!chatId) throw new Error('setRuntimeValue needs a chat');
    mustLocate(chatId, id);
    const field = getRuntimeFields(effectiveSetting(chatId).id).find((f) => f.name === fieldName);
    if (!field) throw new Error(`runtime field ${JSON.stringify(fieldName)} is not defined in this chat's setting`);
    if (field.prompted) throw new Error(`runtime field "${fieldName}" is prompted - the prompted update writes it`);
    const clean = coerceRuntimeValue(field, value);
    if (clean === null && value !== null && value !== undefined && value !== '') throw new Error(`${JSON.stringify(value)} is not a valid ${field.type} for "${fieldName}"`);
    writeChat(chatId, (layer) => {
        const entry = { present: false, matches: 0, ...(layer.entries[id] ?? {}) };
        const runtime = isObject(entry.runtime) ? { ...entry.runtime, custom: { ...(entry.runtime.custom ?? {}) } } : emptyRuntime();
        if (BUILT_IN_RUNTIME_FIELDS.includes(fieldName)) runtime[fieldName] = clean;
        else runtime.custom[fieldName] = clean;
        entry.runtime = runtime;
        layer.entries[id] = entry;
    });
    changed(chatId);
    return getCharacter(chatId, id);
}

// ----------------------------------------------------------------- settings

function settingStore() {
    const store = getSettings().variableStore;
    if (!isObject(store.characterSettings)) store.characterSettings = {};
    const settings = store.characterSettings;
    if (!isObject(settings[DEFAULT_SETTING_ID])) {
        settings[DEFAULT_SETTING_ID] = { id: DEFAULT_SETTING_ID, name: 'Default', autoConfirm: true, createdAt: Date.now(), characters: {}, runtimeFields: defaultRuntimeFields() };
    }
    for (const setting of Object.values(settings)) {
        if (!isObject(setting.characters)) setting.characters = {};
        if (!isObject(setting.runtimeFields)) setting.runtimeFields = defaultRuntimeFields();
        // autoPromote was this option's name before confirmation and
        // promotion became one thing.
        if ('autoPromote' in setting) {
            if (setting.autoConfirm === undefined) setting.autoConfirm = setting.autoPromote === true;
            delete setting.autoPromote;
        }
    }
    return settings;
}

function settingSummary(setting) {
    return {
        id: setting.id, name: setting.name, autoConfirm: setting.autoConfirm === true, isDefault: setting.id === DEFAULT_SETTING_ID,
        characterCount: Object.keys(setting.characters).length, createdAt: setting.createdAt,
    };
}

// Every setting (Default first, then by name): [{ id, name, autoConfirm, isDefault, characterCount, createdAt }].
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
    settingStore()[id] = { id, name: clean, autoConfirm: autoConfirm === true, createdAt: Date.now(), characters: {}, runtimeFields: defaultRuntimeFields() };
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

// Deletes a setting and its canonical characters (they leave every chat's
// variables). Chats that used it have no setting again (asked on next use).
// The Default setting cannot be deleted.
export function deleteSetting(settingId) {
    if (settingId === DEFAULT_SETTING_ID) throw new Error('the Default setting cannot be deleted');
    const settings = settingStore();
    const setting = settings[settingId];
    if (!setting) return false;
    for (const id of Object.keys(setting.characters)) removeReferences(id, null);
    delete settings[settingId];
    for (const [chatId, state] of Object.entries(getSettings().variableStore?.chats || {})) {
        if (state?.characters?.setting === settingId) {
            state.characters.setting = null;
            saveChatState(chatId, state);
        }
    }
    persistSettings();
    changed(null);
    return true;
}

// -------------------------------------------------------------- chat layer

function chatLayer(state) {
    const layer = isObject(state.characters) ? state.characters : {};
    return {
        setting: typeof layer.setting === 'string' && settingStore()[layer.setting] ? layer.setting : null,
        entries: isObject(layer.entries) ? layer.entries : {},
        local: isObject(layer.local) ? layer.local : {},
    };
}

function readChat(chatId) {
    return chatLayer(loadChatState(chatId));
}

function writeChat(chatId, mutate) {
    const state = loadChatState(chatId);
    const layer = chatLayer(state);
    mutate(layer);
    state.characters = layer;
    saveChatState(chatId, state);
}

// The setting a chat uses, or null when it has not chosen one.
export function getChatSetting(chatId) {
    return chatId ? readChat(chatId).setting : null;
}

export function setChatSetting(chatId, settingId) {
    if (!chatId) throw new Error('setChatSetting needs a chat');
    if (!settingStore()[settingId]) throw new Error(`setting ${JSON.stringify(settingId)} does not exist`);
    writeChat(chatId, (layer) => { layer.setting = settingId; });
    changed(chatId);
    return settingId;
}

// The setting a chat effectively uses right now (Default until it chooses).
function effectiveSetting(chatId) {
    return settingStore()[getChatSetting(chatId) ?? DEFAULT_SETTING_ID];
}

// "Ask on first use": the chat's setting, choosing one if it has none. With
// only the Default setting there is nothing to ask - it is chosen. Otherwise
// `ask(settings)` (a UI prompt - initialization-engine.js) picks one; asked
// once per chat per session; a dismissed question means Default.
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

// Where character `id` lives for a chat: { scope: 'chat' | 'setting', settingId, record } or null.
function locate(chatId, id, settingId = null) {
    if (chatId) {
        const local = readChat(chatId).local[id];
        if (local) return { scope: 'chat', settingId: null, record: local };
    }
    const setting = settingId ? settingStore()[settingId] : (chatId ? effectiveSetting(chatId) : null);
    if (setting?.characters[id]) return { scope: 'setting', settingId: setting.id, record: setting.characters[id] };
    // Any setting (a chat showing a character of another setting).
    if (!settingId) {
        for (const other of Object.values(settingStore())) {
            if (other.characters[id]) return { scope: 'setting', settingId: other.id, record: other.characters[id] };
        }
    }
    return null;
}

// A character as displayed: its active variant's overrides applied.
function applyVariant(record) {
    const variant = record.activeVariant ? record.variants?.[record.activeVariant] : null;
    return variant ? { ...record, ...variant.overrides } : record;
}

function view(chatId, found) {
    const record = normalizeCharacter(found.record);
    const shown = applyVariant(record);
    const entry = chatId ? readChat(chatId).entries[record.id] : null;
    return {
        id: record.id,
        name: shown.name,
        aliases: [...shown.aliases],
        image: shown.image,
        introduction_snippet: record.introduction_snippet,
        biography: shown.biography, personality: shown.personality, faction: shown.faction, role: shown.role,
        confirmed: record.confirmed,
        scope: found.scope,
        settingId: found.settingId,
        present: entry?.present === true,
        matches: Number.isFinite(entry?.matches) ? entry.matches : 0,
        // Per-chat, ephemeral state (spec 1.43); null outside a chat.
        runtime: chatId ? runtimeView(chatId, record.id) : null,
        activeVariant: record.activeVariant,
        variants: Object.values(record.variants).map((v) => ({ id: v.id, name: v.name, overrides: structuredClone(v.overrides) })),
        base: {
            name: record.name, aliases: [...record.aliases], image: record.image,
            biography: record.biography, personality: record.personality, faction: record.faction, role: record.role,
        },
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    };
}

export function getCharacter(chatId, id, settingId = null) {
    const found = locate(chatId, id, settingId);
    return found ? view(chatId, found) : null;
}

// The characters of a chat: its own, then its setting's - sorted by name.
// Without a chat, `settingId`'s canonical characters (no presence).
export function listCharacters(chatId, { settingId = null } = {}) {
    const out = [];
    if (chatId && !settingId) {
        const layer = readChat(chatId);
        for (const record of Object.values(layer.local)) out.push(view(chatId, { scope: 'chat', settingId: null, record }));
        const setting = effectiveSetting(chatId);
        for (const record of Object.values(setting.characters)) out.push(view(chatId, { scope: 'setting', settingId: setting.id, record }));
    } else {
        const setting = settingStore()[settingId ?? DEFAULT_SETTING_ID];
        if (setting) for (const record of Object.values(setting.characters)) out.push(view(chatId, { scope: 'setting', settingId: setting.id, record }));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The character a name (or alias) means in a chat - its own characters
// first, then its setting's; the active variant's name and aliases count
// too. Null when none matches.
export function getCharacterByAlias(chatId, name) {
    const key = nameKey(name);
    if (!key || !chatId) return null;
    const matches = (record) => {
        const shown = applyVariant(normalizeCharacter(record));
        return [record.name, ...(record.aliases ?? []), shown.name, ...shown.aliases].some((n) => nameKey(n) === key);
    };
    const layer = readChat(chatId);
    for (const record of Object.values(layer.local)) if (matches(record)) return view(chatId, { scope: 'chat', settingId: null, record });
    const setting = effectiveSetting(chatId);
    for (const record of Object.values(setting.characters)) if (matches(record)) return view(chatId, { scope: 'setting', settingId: setting.id, record });
    return null;
}

// --------------------------------------------------------------- mutations

function newId() {
    return `chr_${genId()}`;
}

// Writes a record where it lives. `found` from locate().
function saveRecord(chatId, found, record) {
    record.updatedAt = Date.now();
    if (found.scope === 'chat') {
        writeChat(chatId, (layer) => { layer.local[record.id] = record; });
    } else {
        settingStore()[found.settingId].characters[record.id] = record;
        persistSettings();
    }
}

function mustLocate(chatId, id, settingId) {
    const found = locate(chatId, id, settingId);
    if (!found) throw new Error(`character ${JSON.stringify(id)} does not exist`);
    return found;
}

// Creates an unconfirmed chat character (extraction, or the user assigning a
// new one). Confirmed - and so in the setting - at once when the chat's
// setting auto-confirms.
export function createUnconfirmedCharacter(chatId, name, snippet = null) {
    if (!chatId) throw new Error('createUnconfirmedCharacter needs a chat');
    if (!text(name, MAX_NAME)) throw new Error('a character needs a name');
    const record = normalizeCharacter({ name, introduction_snippet: snippet, confirmed: false }, newId());
    writeChat(chatId, (layer) => {
        layer.local[record.id] = record;
        layer.entries[record.id] = { present: false, matches: 0, ...(layer.entries[record.id] ?? {}) };
    });
    if (effectiveSetting(chatId).autoConfirm) confirmCharacter(chatId, record.id);
    changed(chatId);
    return getCharacter(chatId, record.id);
}

// Creates a canonical (confirmed) character directly in a setting.
export function createCharacter(settingId, data = {}) {
    const setting = settingStore()[settingId];
    if (!setting) throw new Error(`setting ${JSON.stringify(settingId)} does not exist`);
    if (!text(data.name, MAX_NAME)) throw new Error('a character needs a name');
    const record = normalizeCharacter({ ...data, confirmed: true, variants: {}, activeVariant: null }, newId());
    setting.characters[record.id] = record;
    persistSettings();
    changed(null);
    return getCharacter(null, record.id, settingId);
}

// Edits a character's baseline fields (name, aliases, image, biography,
// personality, faction, role) where it lives - a canonical character for
// every chat on its setting. Saving an edit confirms it (canonicalization),
// which puts a chat character into the setting.
export function updateCharacter(chatId, id, patch = {}, { settingId = null } = {}) {
    const found = mustLocate(chatId, id, settingId);
    const record = normalizeCharacter(found.record);
    if (patch.name !== undefined) {
        const name = text(patch.name, MAX_NAME);
        if (!name) throw new Error('a character needs a name');
        record.name = name;
    }
    if (patch.aliases !== undefined) record.aliases = cleanAliases(patch.aliases, record.name);
    else record.aliases = cleanAliases(record.aliases, record.name);
    if (patch.image !== undefined) record.image = cleanImage(patch.image);
    for (const field of BASELINE_TEXT_FIELDS) if (patch[field] !== undefined) record[field] = text(patch[field], MAX_TEXT);
    record.confirmed = true;
    saveRecord(chatId, found, record);
    if (found.scope === 'chat') moveToSetting(chatId, id);
    changed(found.scope === 'chat' ? chatId : null);
    return getCharacter(chatId, id, settingId);
}

export function updateCharacterAliases(chatId, id, alias, options = {}) {
    const found = mustLocate(chatId, id, options.settingId);
    const record = normalizeCharacter(found.record);
    record.aliases = cleanAliases([...record.aliases, alias], record.name);
    saveRecord(chatId, found, record);
    changed(found.scope === 'chat' ? chatId : null);
    return getCharacter(chatId, id, options.settingId);
}

export function updateCharacterImage(chatId, id, imageUrl, options = {}) {
    return updateCharacter(chatId, id, { image: imageUrl }, options);
}

// Confirms a character as it is - a chat character moves into the chat's
// setting (confirmed <=> in the setting).
export function confirmCharacter(chatId, id, options = {}) {
    const found = mustLocate(chatId, id, options.settingId);
    const record = normalizeCharacter(found.record);
    record.confirmed = true;
    saveRecord(chatId, found, record);
    if (found.scope === 'chat') moveToSetting(chatId, id);
    changed(found.scope === 'chat' ? chatId : null);
    return getCharacter(chatId, id, options.settingId);
}

function setPresence(chatId, ids, present) {
    if (!chatId || ids.length === 0) return;
    writeChat(chatId, (layer) => {
        for (const id of ids) {
            layer.entries[id] = { matches: 0, ...(layer.entries[id] ?? {}), present };
            // Runtime state belongs to the scene: gone when they leave it.
            if (!present) layer.entries[id].runtime = emptyRuntime();
        }
    });
    changed(chatId);
}

export function markCharacterPresent(chatId, id) {
    mustLocate(chatId, id);
    setPresence(chatId, [id], true);
    return getCharacter(chatId, id);
}

export function markCharacterAbsent(chatId, id) {
    mustLocate(chatId, id);
    setPresence(chatId, [id], false);
    return getCharacter(chatId, id);
}

// Moves a (confirmed) chat character into the chat's setting - same id, so
// every variable keeps pointing at it. Only confirmation does this.
function moveToSetting(chatId, id) {
    const local = readChat(chatId).local[id];
    if (!local) return;
    effectiveSetting(chatId).characters[id] = normalizeCharacter(local);
    writeChat(chatId, (layer) => { delete layer.local[id]; });
    persistSettings();
}

// Merges `sourceId` into `targetId`: the target keeps its own data and gains
// the source's name and aliases as aliases, its image / snippet / baseline
// text where the target has none, and its variants; presence and matches
// combine; every variable in every chat that held the source now holds the
// target; the source is deleted.
export function mergeCharacters(chatId, sourceId, targetId, { settingId = null } = {}) {
    if (sourceId === targetId) throw new Error('cannot merge a character into itself');
    const source = mustLocate(chatId, sourceId, settingId);
    const target = mustLocate(chatId, targetId, settingId);
    const from = normalizeCharacter(source.record);
    const into = normalizeCharacter(target.record);
    into.aliases = cleanAliases([...into.aliases, from.name, ...from.aliases], into.name);
    into.image ??= from.image;
    into.introduction_snippet ??= from.introduction_snippet;
    for (const field of BASELINE_TEXT_FIELDS) if (!into[field]) into[field] = from[field];
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
    if (into.confirmed && target.scope === 'chat') moveToSetting(chatId, targetId);
    changed(null);
    return getCharacter(chatId, targetId, settingId);
}

// A detection that is really someone already known: `sourceId` (usually an
// unconfirmed character with the wrong name) is resolved to `targetId` - a
// merge (the detected name becomes the target's alias; variables follow)
// after which the target is confirmed, so it is in the setting.
export function resolveCharacter(chatId, sourceId, targetId, options = {}) {
    mergeCharacters(chatId, sourceId, targetId, options);
    return confirmCharacter(chatId, targetId, options);
}

function removeRecord(chatId, found) {
    if (found.scope === 'chat') writeChat(chatId, (layer) => { delete layer.local[found.record.id]; });
    else {
        delete settingStore()[found.settingId].characters[found.record.id];
        persistSettings();
    }
}

// Deletes a character (chat-local or canonical); it leaves every variable
// and every chat's presence.
export function deleteCharacter(chatId, id, { settingId = null } = {}) {
    const found = locate(chatId, id, settingId);
    if (!found) return false;
    removeRecord(chatId, found);
    removeReferences(id, null);
    changed(null);
    return true;
}

// Every chat: variables holding `from` now hold `to` (or lose it, `to`
// null), and its chat entry moves (presence OR-ed, matches summed).
function removeReferences(from, to) {
    for (const [chatId, state] of Object.entries(getSettings().variableStore?.chats || {})) {
        let dirty = false;
        for (const entry of Object.values(state?.variables || {})) {
            if (!isCharacterDefinition(entry?.def)) continue;
            if (entry.def.type === 'character') {
                if (entry.value === from) { entry.value = to ?? ''; dirty = true; }
            } else if (Array.isArray(entry.value) && entry.value.includes(from)) {
                entry.value = [...new Set(entry.value.map((v) => (v === from ? to : v)).filter(Boolean))];
                dirty = true;
            }
        }
        const entries = state?.characters?.entries;
        if (entries?.[from]) {
            if (to) {
                const a = entries[from];
                const b = entries[to] ?? { present: false, matches: 0 };
                entries[to] = { present: a.present === true || b.present === true, matches: (a.matches || 0) + (b.matches || 0) };
            }
            delete entries[from];
            dirty = true;
        }
        if (dirty) saveChatState(chatId, state);
    }
}

// --------------------------------------------------------------- variants

export function addCharacterVariant(chatId, id, { name, overrides = {} } = {}, options = {}) {
    const found = mustLocate(chatId, id, options.settingId);
    const record = normalizeCharacter(found.record);
    const clean = text(name, MAX_NAME);
    if (!clean) throw new Error('a variant needs a name');
    if (Object.values(record.variants).some((v) => v.name.toLowerCase() === clean.toLowerCase())) throw new Error(`a variant named "${clean}" already exists`);
    const vid = `var_${genId()}`;
    record.variants[vid] = { id: vid, name: clean, overrides: cleanOverrides(overrides) };
    saveRecord(chatId, found, record);
    changed(found.scope === 'chat' ? chatId : null);
    return getCharacter(chatId, id, options.settingId);
}

export function updateCharacterVariant(chatId, id, variantId, { name, overrides } = {}, options = {}) {
    const found = mustLocate(chatId, id, options.settingId);
    const record = normalizeCharacter(found.record);
    const variant = record.variants[variantId];
    if (!variant) throw new Error(`variant ${JSON.stringify(variantId)} does not exist`);
    if (name !== undefined) {
        const clean = text(name, MAX_NAME);
        if (!clean) throw new Error('a variant needs a name');
        if (Object.values(record.variants).some((v) => v.id !== variantId && v.name.toLowerCase() === clean.toLowerCase())) throw new Error(`a variant named "${clean}" already exists`);
        variant.name = clean;
    }
    if (overrides !== undefined) variant.overrides = cleanOverrides(overrides);
    saveRecord(chatId, found, record);
    changed(found.scope === 'chat' ? chatId : null);
    return getCharacter(chatId, id, options.settingId);
}

export function deleteCharacterVariant(chatId, id, variantId, options = {}) {
    const found = mustLocate(chatId, id, options.settingId);
    const record = normalizeCharacter(found.record);
    if (!record.variants[variantId]) return getCharacter(chatId, id, options.settingId);
    delete record.variants[variantId];
    if (record.activeVariant === variantId) record.activeVariant = null;
    saveRecord(chatId, found, record);
    changed(found.scope === 'chat' ? chatId : null);
    return getCharacter(chatId, id, options.settingId);
}

// Which variant the character uses (null = its base) - one choice per
// character: for a canonical character, for every chat on its setting.
export function setActiveVariant(chatId, id, variantId, options = {}) {
    const found = mustLocate(chatId, id, options.settingId);
    const record = normalizeCharacter(found.record);
    if (variantId !== null && !record.variants[variantId]) throw new Error(`variant ${JSON.stringify(variantId)} does not exist`);
    record.activeVariant = variantId;
    saveRecord(chatId, found, record);
    changed(found.scope === 'chat' ? chatId : null);
    return getCharacter(chatId, id, options.settingId);
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

// Extraction: the character ids `names` mean in `chatId`. Each name is
// alias-matched (the chat's characters, then its setting's); a match counts
// toward auto-promotion; an unknown name becomes an unconfirmed chat
// character with an introduction snippet from `source`. Returns
// { ids (deduplicated, in order), created: [character views] }.
export function resolveCharacterNames(chatId, names, { source = '' } = {}) {
    const ids = [];
    const created = [];
    for (const raw of Array.isArray(names) ? names : [names]) {
        const name = text(typeof raw === 'string' ? raw : '', MAX_NAME);
        if (!nameKey(name)) continue;
        const match = getCharacterByAlias(chatId, name);
        let id;
        if (match) {
            id = match.id;
            recordMatch(chatId, id);
        } else {
            const character = createUnconfirmedCharacter(chatId, name, snippetFor(source, name));
            id = character.id;
            created.push(character);
        }
        if (!ids.includes(id)) ids.push(id);
    }
    if (created.length) notifyNewCharacters(created);
    return { ids, created };
}

// A match: counts toward confirming a chat character (CONFIRM_AFTER_MATCHES).
function recordMatch(chatId, id) {
    let matches = 0;
    writeChat(chatId, (layer) => {
        const entry = { present: false, matches: 0, ...(layer.entries[id] ?? {}) };
        entry.matches += 1;
        matches = entry.matches;
        layer.entries[id] = entry;
    });
    if (matches >= CONFIRM_AFTER_MATCHES && readChat(chatId).local[id]) confirmCharacter(chatId, id);
}

// Presence after an extraction: `presentIds` are in the scene; `absentIds`
// (for a list variable: who it held before and no longer does) are not.
export function applyPresence(chatId, presentIds = [], absentIds = []) {
    if (!chatId) return;
    const present = new Set(presentIds);
    writeChat(chatId, (layer) => {
        for (const id of present) layer.entries[id] = { matches: 0, ...(layer.entries[id] ?? {}), present: true };
        for (const id of absentIds) {
            if (present.has(id) || !layer.entries[id]) continue;
            layer.entries[id].present = false;
            layer.entries[id].runtime = emptyRuntime();
        }
    });
    changed(chatId);
}

// --------------------------------------------------------------- migration

// Data from before "confirmed <=> in the setting": confirmed characters still
// living in a chat move into its setting (Default when it has none).
// Unconfirmed characters already in a setting stay there (nothing is moved
// out of a setting); confirming them only sets the flag. Idempotent; run on
// startup. Returns the number moved.
export function migrateCharacterData() {
    let moved = 0;
    settingStore(); // also renames autoPromote -> autoConfirm
    for (const [chatId, state] of Object.entries(getSettings().variableStore?.chats || {})) {
        const local = state?.characters?.local;
        if (!isObject(local)) continue;
        const confirmed = Object.values(local).filter((c) => c?.confirmed === true);
        if (!confirmed.length) continue;
        const setting = settingStore()[state.characters.setting] ?? settingStore()[DEFAULT_SETTING_ID];
        for (const record of confirmed) {
            setting.characters[record.id] = normalizeCharacter(record);
            delete local[record.id];
            moved++;
        }
        saveChatState(chatId, state);
    }
    if (moved) persistSettings();
    return moved;
}

// ------------------------------------------------- the manager modal hook

// The Character Manager modal lives in a UI extension (Pretty Panels); it
// registers its opener here. State Engine's drawer button and the "new
// characters" notification call openCharacterManager().
let manager = null;

export function setCharacterManager(opener) {
    manager = typeof opener === 'function' ? opener : null;
}

export function hasCharacterManager() {
    return manager !== null;
}

// Opens the registered Character Manager (options: { characterId?, view?:
// 'chat' | 'setting', settingId?, filter?: 'unconfirmed' }). Returns false when none is
// registered.
export function openCharacterManager(options = {}) {
    if (!manager) return false;
    try {
        manager(options);
        return true;
    } catch (err) {
        console.warn(LOG_PREFIX, 'the Character Manager failed to open (gracefully handled)', err);
        return false;
    }
}

// "New characters detected for review" - one State Engine notification,
// replaced on each detection; clicking it opens the manager on the chat's
// unconfirmed characters.
function notifyNewCharacters(created) {
    try {
        setCallback(BUILTIN_NAMESPACE, REVIEW_CALLBACK, () => openCharacterManager({ view: 'chat', filter: 'unconfirmed' }));
        const names = created.map((c) => c.name).slice(0, 5).join(', ');
        putNotification({
            id: notificationId(BUILTIN_NAMESPACE, 'characters-detected'),
            source: BUILTIN_NAMESPACE,
            severity: 'info',
            message: `New characters detected for review: ${names}${created.length > 5 ? ` and ${created.length - 5} more` : ''}`,
            callbackId: REVIEW_CALLBACK,
        });
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not post the new-characters notification (gracefully handled)', err);
    }
}

// --------------------------------------------------------------- plumbing

// Something about characters changed: displays re-read (variables-changed
// event), and the open chat's macros show the new names.
function changed(chatId) {
    notifyVariablesChanged(chatId);
    try {
        const current = SillyTavern.getContext()?.chatId;
        if (current) hydrateMacroStoreForChat(current);
    } catch {
        // No SillyTavern context (tests): nothing to refresh.
    }
}

// Names for macros, the tracker and prompts, in the open chat.
setCharacterNameResolver((id) => {
    let chatId = null;
    try {
        chatId = SillyTavern.getContext()?.chatId ?? null;
    } catch {
        chatId = null;
    }
    return getCharacter(chatId, id)?.name ?? null;
});
