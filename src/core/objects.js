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
//   record } }, fieldRoles }. What fields each type has in a setting is its
//   OBJECT PRESET (object-presets.js). Editing a
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
//     related_entity_ids: [], related_memory_ids: [], ...its baseline fields
//     (the object preset's global-scope fields, by name),
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
// RUNTIME STATE: per chat. Each object in a chat has runtime = { present?
// (types with presence), values: { [field]: value }, images }: the object
// preset's chat-scope fields. Prompted ones (and prompted baseline fields)
// are written by the prompted update; a field with clearOnLeave is cleared
// when an object with presence leaves the scene. A runtime field may have a
// STARTING VALUE on the object's record (record.startValues[field] - set in
// the setting, e.g. by a scenario author): every chat begins from it, until
// that chat has its own value (an empty answer is a value too).

import { LOG_PREFIX, BUILTIN_NAMESPACE, getSettings, persistSettings } from './settings-core.js';
import { loadChatState, saveChatState, hydrateMacroStoreForChat } from './chat-state.js';
import { notifyVariablesChanged } from './variable-change-signal.js';
import { putNotification, removeNotification, getNotification, notificationId, setCallback } from './notification-core.js';
import { genId } from './variable-schema.js';
import { setObjectNameResolver, objectTypeOf } from './object-display.js';
import { safeImageSrc } from './image-variables.js';
import { OBJECT_TYPES, OBJECT_TYPE_IDS, getObjectType, objectTypeOfId, isObjectType } from './object-types.js';
import {
    getFieldDefs, setFieldDefs, deleteObjectPresets, renameObjectPresets, resolveFieldName, getFieldRoles, assignFieldRole,
    coerceFieldValue, emptyFieldValue, isEmptyFieldValue, fieldObjectType, fromRuntimeField,
} from './object-presets.js';

export const DEFAULT_SETTING_ID = 'default';
export const CONFIRM_AFTER_MATCHES = 10;
const MAX_NAME = 100;
const MAX_ALIAS = 100;
const MAX_ALIASES = 50;
const MAX_TEXT = 4000;
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

// The fields of a COMMON object record - everything else on a record is a
// baseline field.
const COMMON = new Set(['id', 'type', 'name', 'aliases', 'image', 'description', 'introduction_snippet', 'related_entity_ids',
    'related_memory_ids', 'confirmed', 'variants', 'activeVariant', 'createdAt', 'updatedAt', 'startValues']);

// A setting's baseline (global-scope) field definitions for a type.
function baselineDefs(settingId, type) {
    return getFieldDefs(settingId ?? DEFAULT_SETTING_ID, type).filter((d) => d.scope === 'global');
}

// Its runtime (chat-scope) ones.
function runtimeDefs(settingId, type) {
    return getFieldDefs(settingId ?? DEFAULT_SETTING_ID, type).filter((d) => d.scope !== 'global');
}

// Baseline fields a variant may override: not its references.
const overridable = (defs) => defs.filter((d) => !fieldObjectType(d));

// A variant's overrides, cleaned. Without `defs` (no setting known), its
// baseline overrides are kept as they are.
function cleanOverrides(defs, raw) {
    const out = {};
    if (!isObject(raw)) return out;
    if (typeof raw.name === 'string' && raw.name.trim()) out.name = text(raw.name, MAX_NAME);
    if (Array.isArray(raw.aliases)) out.aliases = cleanAliases(raw.aliases);
    if ('image' in raw) out.image = cleanImage(raw.image);
    if (typeof raw.description === 'string') out.description = text(raw.description, MAX_TEXT);
    if (!defs) {
        for (const [key, value] of Object.entries(raw)) if (!COMMON.has(key)) out[key] = structuredClone(value);
        return out;
    }
    for (const def of overridable(defs)) if (def.name in raw) out[def.name] = coerceFieldValue(def, raw[def.name]);
    return out;
}

function cleanVariants(defs, raw) {
    const out = {};
    for (const variant of Object.values(isObject(raw) ? raw : {})) {
        if (!isObject(variant) || typeof variant.id !== 'string' || !variant.id) continue;
        out[variant.id] = { id: variant.id, name: text(variant.name, MAX_NAME) || 'Variant', overrides: cleanOverrides(defs, variant.overrides) };
    }
    return out;
}

// An object record of `type`, validated (any missing field gets its
// default). `defs`: its setting's baseline field definitions, which clean
// its baseline fields - without them (no setting known) they are kept as
// they are.
export function normalizeObject(type, raw, id = raw?.id, defs = null) {
    const t = mustType(type);
    const name = text(raw?.name, MAX_NAME) || 'Unnamed';
    const variants = cleanVariants(defs, raw?.variants);
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
        // Runtime fields' starting values (cleaned when written - applyPatch).
        startValues: isObject(raw?.startValues) ? structuredClone(raw.startValues) : {},
        createdAt: Number.isFinite(raw?.createdAt) ? raw.createdAt : Date.now(),
        updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : Date.now(),
    };
    if (defs) {
        for (const def of defs) out[def.name] = coerceFieldValue(def, raw?.[def.name]);
    } else {
        for (const [key, value] of Object.entries(isObject(raw) ? raw : {})) if (!COMMON.has(key)) out[key] = structuredClone(value);
    }
    return out;
}

// ------------------------------------------------------- object fields

// The runtime-field view of a chat-scope field definition - the shape the
// runtime-field API has always returned (getRuntimeFields): { name, type
// ('string' | 'number' | 'enum', or the field's own type for one this view
// cannot describe - a list of factions is 'array'), prompted, description,
// values?, images?, min?, max?, fresh?, builtIn }. builtIn: a field role of
// the type is assigned to it.
const VIEW_TYPES = ['string', 'number', 'enum'];
function runtimeFieldView(def, roleFields) {
    const out = {
        name: def.name,
        type: VIEW_TYPES.includes(def.type) ? def.type : (def.type === 'boolean' ? 'string' : def.type),
        prompted: def.behaviors?.prompted === true,
        description: def.prompted?.instructions || def.description || '',
        builtIn: roleFields.has(def.name),
    };
    if (def.type === 'enum') {
        out.values = [...def.enumValues];
        if (def.enumImages) out.images = { ...def.enumImages };
    }
    if (def.type === 'number') {
        out.min = def.min ?? null;
        out.max = def.max ?? null;
    }
    if (def.prompted?.newEachTurn) out.fresh = true;
    return out;
}

// A setting's runtime fields for a type, as runtime-field views (above):
// its object preset's chat-scope fields, in order.
export function getRuntimeFields(settingId, type) {
    mustType(type);
    if (!settingStore()[settingId]) return [];
    const roleFields = new Set(getFieldRoles(settingId, type).map((r) => r.assigned).filter(Boolean));
    return runtimeDefs(settingId, type).map((def) => runtimeFieldView(def, roleFields));
}

// Replaces a setting's runtime fields for a type with `fields` (runtime-field
// views - validated, throws); its baseline fields stay. A field keeps what
// its definition had beyond the view (label, clearOnLeave...). As this API
// always has, a built-in field (one a field role is assigned to) left out
// is kept - setObjectFields() removes anything. Returns the new list.
export function setRuntimeFields(settingId, type, fields) {
    const t = mustType(type);
    if (!settingStore()[settingId]) throw new Error(`setting ${JSON.stringify(settingId)} does not exist`);
    if (!Array.isArray(fields)) throw new Error('runtime fields must be an array');
    const current = getFieldDefs(settingId, type);
    const runtime = fields.map((raw, i) => {
        if (!isObject(raw)) throw new Error(`runtime field #${i + 1} must be an object`);
        const old = current.find((d) => d.scope !== 'global' && d.name === raw.name);
        // A field this view cannot describe (a list of factions) comes back
        // with its own type: it keeps its definition, only its prompting changes.
        if (old && raw.type === old.type && !VIEW_TYPES.includes(old.type)) {
            return { ...old, behaviors: { ...old.behaviors, prompted: raw.prompted !== false }, prompted: { ...old.prompted, instructions: typeof raw.description === 'string' ? raw.description : old.prompted.instructions } };
        }
        if (raw.type !== undefined && !VIEW_TYPES.includes(raw.type)) {
            throw new Error(`runtime field "${raw.name}" has unknown type ${JSON.stringify(raw.type)} (string, number or enum)`);
        }
        if (raw.images !== undefined && raw.images !== null && !isObject(raw.images)) throw new Error(`runtime field "${raw.name}": images must be an object of value -> image`);
        for (const [value, ref] of Object.entries(raw.images ?? {})) {
            if (typeof ref !== 'string') throw new Error(`runtime field "${raw.name}": the image for "${value}" must be a string`);
        }
        const view = fromRuntimeField({ ...raw, type: raw.type ?? 'string' }, t);
        if (!old) return view;
        return {
            ...old, ...view, id: old.id, label: old.label, clearOnLeave: old.clearOnLeave, enumImages: view.enumImages, prompted: { ...old.prompted, ...view.prompted },
        };
    });
    const roleFields = new Set(getFieldRoles(settingId, type).map((r) => r.assigned).filter(Boolean));
    const keptBuiltIns = current.filter((d) => d.scope !== 'global' && roleFields.has(d.name) && !runtime.some((r) => r.name === d.name));
    // Built-ins keep their places; new fields follow, in the order given.
    const place = (def) => {
        const at = current.findIndex((d) => d.scope !== 'global' && d.name === def.name && roleFields.has(d.name));
        return at >= 0 ? at : current.length + runtime.indexOf(def);
    };
    const nextRuntime = [...keptBuiltIns, ...runtime].sort((a, b) => place(a) - place(b));
    setFieldDefs(settingId, type, [...current.filter((d) => d.scope === 'global'), ...nextRuntime]);
    changed(null);
    return getRuntimeFields(settingId, type);
}

// A setting's field definitions for a type (baseline, then runtime) - copies.
export function getObjectFields(settingId, type) {
    mustType(type);
    return settingStore()[settingId] ? getFieldDefs(settingId, type) : [];
}

// Replaces them (validated - throws). A definition keeping an existing
// field's `id` under a new name renames it: its stored values and field
// roles follow. Returns the new definitions.
export function setObjectFields(settingId, type, defs) {
    mustType(type);
    if (!settingStore()[settingId]) throw new Error(`setting ${JSON.stringify(settingId)} does not exist`);
    const scopes = new Map(getFieldDefs(settingId, type).map((d) => [d.name, d.scope]));
    const result = setFieldDefs(settingId, type, defs, { onRename: (from, to) => renameFieldValues(settingId, type, scopes.get(from), from, to) });
    changed(null);
    return result.defs;
}

// A setting's field roles for a type: [{ id, publicName, type, objectType,
// label, field (its default field), assigned (the field it means here, or null) }].
export function getObjectFieldRoles(settingId, type) {
    mustType(type);
    return settingStore()[settingId] ? getFieldRoles(settingId, type) : [];
}

// Assigns a field role to one of the setting's fields (null: unassigned).
export function assignObjectFieldRole(settingId, roleId, fieldName) {
    const role = assignFieldRole(settingId, roleId, fieldName);
    changed(null);
    return role;
}

// A renamed field's stored values move to its new name: baseline values on
// the setting's records and its chats' own records, runtime values in its
// chats' object layers.
function renameFieldValues(settingId, type, scope, from, to) {
    const move = (holder) => {
        if (!isObject(holder) || !(from in holder)) return false;
        holder[to] = holder[from];
        delete holder[from];
        return true;
    };
    // A runtime field's starting values live on the records too.
    const holderOf = (record) => (scope === 'global' ? record : record?.startValues);
    for (const record of Object.values(settingStore()[settingId]?.objects?.[type] ?? {})) move(holderOf(record));
    for (const [chatId, state] of Object.entries(getSettings().variableStore?.chats || {})) {
        if ((state?.setting ?? DEFAULT_SETTING_ID) !== settingId || !isObject(state?.objects?.[type])) continue;
        let dirty = false;
        const layer = state.objects[type];
        for (const record of Object.values(layer.local ?? {})) dirty = move(holderOf(record)) || dirty;
        if (scope !== 'global') for (const entry of Object.values(layer.entries ?? {})) dirty = move(entry?.runtime?.values) || dirty;
        if (dirty) saveChatState(chatId, state);
    }
    persistSettings();
}

// A runtime value for `field` (a field definition, or a runtime-field view),
// or null when it is not a valid one.
export function coerceRuntimeValue(field, raw) {
    const def = field.type === 'enum' && !field.enumValues ? { ...field, enumValues: field.values ?? [] } : field;
    const value = coerceFieldValue(def, raw);
    return isEmptyFieldValue(value) ? null : value;
}

// The image an enum field shows for `value`, ready for <img src>, or null.
export function runtimeImageSrc(field, value) {
    const images = field?.enumImages ?? field?.images;
    if (field?.type !== 'enum' || typeof value !== 'string' || !isObject(images)) return null;
    return safeImageSrc(images[value] ?? null);
}

// An object's runtime in a chat, by the chat's setting's fields for its type:
// { present? , values: { [field]: value }, images: { [field]: src } } -
// fields the setting no longer defines are left out; images holds each enum
// field whose current value has an image, already checked with safeImageSrc.
// A field the chat has no value for yet shows the object's starting value
// (`record`: its stored record).
function runtimeView(chatId, t, id, record = locate(chatId, id)?.record) {
    const entry = typeLayer(readChat(chatId), t.id).entries[id];
    const stored = isObject(entry?.runtime?.values) ? entry.runtime.values : {};
    const start = isObject(record?.startValues) ? record.startValues : {};
    const out = { values: {}, images: {} };
    if (t.hasPresence) out.present = entry?.present === true;
    for (const def of runtimeDefs(effectiveSetting(chatId).id, t.id)) {
        const raw = def.name in stored ? stored[def.name] : start[def.name];
        const clean = raw === undefined ? null : coerceRuntimeValue(def, raw);
        out.values[def.name] = clean;
        const src = runtimeImageSrc(def, clean);
        if (src) out.images[def.name] = src;
    }
    return out;
}

// An object field's answer or input as ids: an id of the field's type is
// kept; a name is matched to an object of that type (the chat's, then its
// setting's) or recorded as a new one - an unconfirmed chat object, or with
// no chat a canonical object in `settingId`.
function refIds(chatId, settingId, def, raw) {
    const type = fieldObjectType(def);
    const list = (Array.isArray(raw) ? raw : [raw]).filter((v) => typeof v === 'string' && v.trim());
    const ids = [];
    for (const value of list) {
        let id = objectTypeOfId(value.trim())?.id === type ? value.trim() : null;
        if (!id && chatId) id = resolveObjectNames(chatId, type, [value]).ids[0] ?? null;
        if (!id && !chatId) {
            const key = nameKey(value);
            const known = Object.values(settingStore()[settingId]?.objects?.[type] ?? {})
                .find((r) => [r.name, ...(r.aliases ?? [])].some((n) => nameKey(n) === key));
            id = known?.id ?? createObject(settingId, type, { name: value }).id;
        }
        if (id && !ids.includes(id)) ids.push(id);
    }
    return def.type === 'object' ? (ids[0] ?? '') : ids;
}

// A field's value from outside (an API caller, a prompted answer), cleaned:
// object fields take names as well as ids.
function inputValue(chatId, settingId, def, raw) {
    return coerceFieldValue(def, fieldObjectType(def) ? refIds(chatId, settingId, def, raw) : raw);
}

// The prompted update's answer for objects of one type in play this turn:
// `updates` = { [objectId]: { [field]: rawValue } }. Only PROMPTED fields
// are written, each validated: runtime fields in the chat; baseline fields
// on the object's record - a 'fill' one only while it is empty. An enum
// answer off the list keeps the previous value; an empty answer to a
// newEachTurn field keeps the last one.
export function applyRuntimeUpdates(chatId, type, updates) {
    const t = mustType(type);
    if (!chatId || !isObject(updates)) return;
    const settingId = effectiveSetting(chatId).id;
    const defs = getFieldDefs(settingId, type).filter((d) => d.behaviors?.prompted);
    const runtime = defs.filter((d) => d.scope !== 'global');
    const baseline = defs.filter((d) => d.scope === 'global');
    // undefined: leave the field as it is.
    const accept = (def, raw) => {
        if (raw === undefined) return undefined;
        const value = inputValue(chatId, settingId, def, raw);
        if (!isEmptyFieldValue(value)) return value;
        if (def.type === 'enum' && String(raw ?? '').trim() !== '') {
            console.warn(LOG_PREFIX, `field "${def.name}": ${JSON.stringify(raw)} is not one of its values - kept the previous value`);
            return undefined;
        }
        return def.prompted?.newEachTurn ? undefined : emptyFieldValue(def);
    };
    // Every answer is read (names matched, new objects recorded - which
    // writes the chat) before the chat's state is read for writing.
    const answers = [];
    for (const [id, raw] of Object.entries(updates)) {
        if (!isObject(raw)) continue;
        const found = locate(chatId, id);
        if (!found) continue;
        const runtimeValues = {};
        for (const def of runtime) {
            const value = accept(def, raw[def.name]);
            if (value !== undefined) runtimeValues[def.name] = value;
        }
        const baselineValues = {};
        for (const def of baseline) {
            const current = found.record[def.name];
            if (def.prompted?.mode !== 'update' && !isEmptyFieldValue(current)) continue;
            const value = accept(def, raw[def.name]);
            if (value !== undefined && !(isEmptyFieldValue(value) && isEmptyFieldValue(current))) baselineValues[def.name] = value;
        }
        answers.push({ id, runtimeValues, baselineValues });
    }
    writeChat(chatId, (state) => {
        const layer = typeLayer(state, type);
        for (const { id, runtimeValues } of answers) {
            const entry = { matches: 0, ...(layer.entries[id] ?? {}) };
            entry.runtime = { values: { ...(isObject(entry.runtime?.values) ? entry.runtime.values : {}), ...runtimeValues } };
            layer.entries[id] = entry;
        }
    });
    for (const { id, baselineValues } of answers) {
        if (!Object.keys(baselineValues).length) continue;
        const found = locate(chatId, id);
        if (!found) continue;
        const record = normalizeObject(t.id, found.record, id, baselineDefs(found.settingId ?? settingId, t.id));
        Object.assign(record, baselineValues);
        saveRecord(chatId, found, record);
    }
    changed(chatId);
}

// Where an object's fields are defined: the setting it lives in, or the
// chat's for a chat object.
function ownerSetting(chatId, found) {
    return found.settingId ?? effectiveSetting(chatId).id;
}

// One field of an object (a field name or a field role id), by the setting
// it belongs to: a baseline field from its record (its active variant's
// override, if any), a runtime field from the chat. undefined when the
// setting has no such field.
export function getObjectFieldValue(chatId, id, nameOrRole, { settingId = null } = {}) {
    const t = typeOfId(id);
    const found = locate(chatId, id, settingId);
    if (!found) return undefined;
    const owner = ownerSetting(chatId, found);
    const name = resolveFieldName(owner, t.id, nameOrRole);
    const def = name ? getFieldDefs(owner, t.id).find((d) => d.name === name) : null;
    if (!def) return undefined;
    if (def.scope === 'global') return structuredClone(applyVariant(normalizeObject(t.id, found.record, id, baselineDefs(owner, t.id)))[name]);
    // Outside a chat, a runtime field is its starting value.
    if (!chatId) return structuredClone(found.record.startValues?.[name] ?? emptyFieldValue(def));
    return structuredClone(runtimeView(chatId, t, id, found.record).values[name]);
}

// Sets one field of an object (a field name or a field role id): a baseline
// field on its record (for a canonical object, every chat on its setting
// sees it; it does not confirm the object), a runtime field in the chat -
// or, with no chat, a runtime field's STARTING VALUE (on the record: what
// every chat begins from - a scenario author's). In a chat, a prompted
// runtime field is the prompted update's - refused. Object fields take
// names or ids. Throws with the reason; returns the object.
export function setObjectFieldValue(chatId, id, nameOrRole, value, { settingId = null } = {}) {
    const t = typeOfId(id);
    const owner = ownerSetting(chatId, mustLocate(chatId, id, settingId));
    const name = resolveFieldName(owner, t.id, nameOrRole);
    const def = name ? getFieldDefs(owner, t.id).find((d) => d.name === name) : null;
    if (!def) throw new Error(`${JSON.stringify(nameOrRole)} is not a ${t.noun} field (or an assigned field role) in this setting`);
    if (chatId && def.scope !== 'global' && def.behaviors?.prompted) throw new Error(`field "${name}" is prompted - the prompted update writes it`);
    const given = !(value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0));
    const clean = inputValue(chatId, owner, def, value);
    if (given && isEmptyFieldValue(clean)) throw new Error(`${JSON.stringify(value)} is not a valid ${def.type} for "${name}"`);
    if (def.scope === 'global' || !chatId) {
        // Located again: matching a name may have written the chat.
        const found = mustLocate(chatId, id, settingId);
        const record = normalizeObject(t.id, found.record, id, baselineDefs(owner, t.id));
        if (def.scope === 'global') record[name] = clean;
        else record.startValues[name] = clean;
        saveRecord(chatId, found, record);
        changed(found.scope === 'chat' ? chatId : null);
        return getObject(chatId, id, settingId);
    }
    writeChat(chatId, (state) => {
        const layer = typeLayer(state, t.id);
        const entry = { matches: 0, ...(layer.entries[id] ?? {}) };
        entry.runtime = { values: { ...(isObject(entry.runtime?.values) ? entry.runtime.values : {}), [name]: clean } };
        layer.entries[id] = entry;
    });
    changed(chatId);
    return getObject(chatId, id);
}

// Sets one NON-prompted runtime field (the runtime-field API).
export function setRuntimeValue(chatId, id, fieldName, value) {
    if (!chatId) throw new Error('setRuntimeValue needs a chat');
    const t = typeOfId(id);
    mustLocate(chatId, id);
    const def = runtimeDefs(effectiveSetting(chatId).id, t.id).find((d) => d.name === fieldName);
    if (!def) throw new Error(`runtime field ${JSON.stringify(fieldName)} is not defined for ${t.plural.toLowerCase()} in this chat's setting`);
    return setObjectFieldValue(chatId, id, fieldName, value);
}

// ----------------------------------------------------------------- settings

function newSetting(id, name, autoConfirm) {
    return { id, name, autoConfirm, createdAt: Date.now(), objects: Object.fromEntries(OBJECT_TYPE_IDS.map((type) => [type, {}])), fieldRoles: {} };
}

function settingStore() {
    const store = getSettings().variableStore;
    if (!isObject(store.settings)) store.settings = {};
    const settings = store.settings;
    if (!isObject(settings[DEFAULT_SETTING_ID])) settings[DEFAULT_SETTING_ID] = newSetting(DEFAULT_SETTING_ID, 'Default', true);
    for (const setting of Object.values(settings)) {
        if (!isObject(setting.objects)) setting.objects = {};
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
        renameObjectPresets(settingId);
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
    deleteObjectPresets(settingId);
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

function baseFields(defs, record) {
    const out = { name: record.name, aliases: [...record.aliases], image: record.image, description: record.description };
    for (const def of defs) out[def.name] = structuredClone(record[def.name]);
    return out;
}

function view(chatId, found) {
    const t = typeOfId(found.record.id);
    const defs = baselineDefs(ownerSetting(chatId, found), t.id);
    const record = normalizeObject(t.id, found.record, found.record.id, defs);
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
    for (const def of defs) out[def.name] = structuredClone(shown[def.name]);
    Object.assign(out, {
        confirmed: record.confirmed,
        scope: found.scope,
        settingId: found.settingId,
        matches: Number.isFinite(entry?.matches) ? entry.matches : 0,
        // Per-chat state; null outside a chat.
        runtime: chatId ? runtimeView(chatId, t, record.id, found.record) : null,
        // What every chat's runtime fields begin from.
        startValues: structuredClone(record.startValues),
        activeVariant: record.activeVariant,
        variants: Object.values(record.variants).map((v) => ({ id: v.id, name: v.name, overrides: structuredClone(v.overrides) })),
        base: baseFields(defs, record),
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

// Applies a patch of editable fields onto a record (validated); its
// baseline fields by `defs`, object fields taking names or ids (resolved in
// `chatId`, or with none in `settingId`).
function applyPatch(t, record, patch, defs, chatId, settingId) {
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
    for (const def of defs) if (patch[def.name] !== undefined) record[def.name] = inputValue(chatId, settingId, def, patch[def.name]);
    // Runtime fields' starting values: { [field]: value } (empty: none).
    if (isObject(patch.startValues)) {
        for (const def of runtimeDefs(settingId, t.id)) {
            if (!(def.name in patch.startValues)) continue;
            const value = inputValue(chatId, settingId, def, patch.startValues[def.name]);
            if (isEmptyFieldValue(value)) delete record.startValues[def.name];
            else record.startValues[def.name] = value;
        }
    }
}

// Creates an object in a chat: an unconfirmed world object (extraction, or
// the user assigning a new one) - confirmed, and so in the setting, at once
// when the chat's setting auto-confirms - or a story object (always the
// chat's). `data` may hold any editable field.
export function createChatObject(chatId, type, name, snippet = null, data = {}) {
    const t = mustType(type);
    if (!chatId) throw new Error('createChatObject needs a chat');
    if (!text(name, MAX_NAME)) throw new Error(`a ${t.noun} needs a name`);
    const settingId = effectiveSetting(chatId).id;
    const defs = baselineDefs(settingId, type);
    const record = normalizeObject(type, { name, introduction_snippet: snippet, confirmed: false, variants: {}, activeVariant: null }, newId(t), defs);
    applyPatch(t, record, { ...data, name }, defs, chatId, settingId);
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
    const defs = baselineDefs(settingId, type);
    const record = normalizeObject(type, { name: data.name, confirmed: true, variants: {}, activeVariant: null }, newId(t), defs);
    applyPatch(t, record, data, defs, null, settingId);
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
    const owner = ownerSetting(chatId, mustLocate(chatId, id, settingId));
    const defs = baselineDefs(owner, t.id);
    const record = normalizeObject(t.id, mustLocate(chatId, id, settingId).record, id, defs);
    applyPatch(t, record, patch, defs, chatId, owner);
    record.confirmed = true;
    // Located again: matching a name in an object field may have written the chat.
    const found = mustLocate(chatId, id, settingId);
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

// An object's runtime once it leaves the scene: its clearOnLeave fields
// cleared, the others kept.
function runtimeAfterLeaving(chatId, type, runtime) {
    const values = isObject(runtime?.values) ? runtime.values : {};
    const kept = {};
    for (const def of runtimeDefs(effectiveSetting(chatId).id, type)) if (!def.clearOnLeave && def.name in values) kept[def.name] = values[def.name];
    return { values: kept };
}

function setPresence(chatId, type, ids, present) {
    if (!chatId || ids.length === 0) return;
    const leaving = (runtime) => runtimeAfterLeaving(chatId, type, runtime);
    writeChat(chatId, (state) => {
        const layer = typeLayer(state, type);
        for (const id of ids) {
            layer.entries[id] = { matches: 0, ...(layer.entries[id] ?? {}), present };
            // Scene state is gone when they leave the scene.
            if (!present) layer.entries[id].runtime = leaving(layer.entries[id].runtime);
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
    const defs = baselineDefs(ownerSetting(chatId, target), t.id);
    const from = normalizeObject(t.id, source.record, sourceId, defs);
    const into = normalizeObject(t.id, target.record, targetId, defs);
    into.aliases = cleanAliases([...into.aliases, from.name, ...from.aliases], into.name);
    into.image ??= from.image;
    into.introduction_snippet ??= from.introduction_snippet;
    if (!into.description) into.description = from.description;
    for (const def of defs) {
        if (isEmptyFieldValue(into[def.name])) into[def.name] = structuredClone(from[def.name]);
    }
    for (const [field, value] of Object.entries(from.startValues)) {
        if (isEmptyFieldValue(into.startValues[field])) into.startValues[field] = structuredClone(value);
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

// Rewrites references to `from` in one record - any baseline field holding
// it (object ids are unique, prefixed strings, so a field holding one is a
// reference to it), and related_entity_ids - to `to`, or removed. Returns
// whether it changed.
function rewriteRecordRefs(record, from, to) {
    if (!isObject(record)) return false;
    let dirty = false;
    const rewrite = (holder, key) => {
        const value = holder[key];
        if (value === from) {
            holder[key] = to ?? '';
            dirty = true;
        } else if (Array.isArray(value) && value.includes(from)) {
            holder[key] = [...new Set(value.map((v) => (v === from ? to : v)).filter(Boolean))];
            dirty = true;
        }
    };
    for (const key of Object.keys(record)) {
        if (COMMON.has(key) && key !== 'related_entity_ids') continue;
        rewrite(record, key);
    }
    if (isObject(record.startValues)) for (const key of Object.keys(record.startValues)) rewrite(record.startValues, key);
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
    record.variants[vid] = { id: vid, name: clean, overrides: cleanOverrides(baselineDefs(ownerSetting(chatId, found), t.id), overrides) };
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
    if (overrides !== undefined) variant.overrides = cleanOverrides(baselineDefs(ownerSetting(chatId, found), t.id), overrides);
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
    const leaving = (runtime) => runtimeAfterLeaving(chatId, type, runtime);
    writeChat(chatId, (state) => {
        const layer = typeLayer(state, type);
        for (const id of present) layer.entries[id] = { matches: 0, ...(layer.entries[id] ?? {}), present: true };
        for (const id of absentIds) {
            if (present.has(id) || !layer.entries[id]) continue;
            layer.entries[id].present = false;
            layer.entries[id].runtime = leaving(layer.entries[id].runtime);
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
    const defs = getFieldDefs(object.settingId ?? effectiveSetting(chatId).id, t.id);
    const labelOf = (def) => def.label || `${def.name.charAt(0).toUpperCase()}${def.name.slice(1).replace(/_/g, ' ')}`;
    const shownValue = (def, value) => {
        if (fieldObjectType(def)) return (Array.isArray(value) ? value : [value]).filter(Boolean).map(nameOf).filter(Boolean).join(', ');
        if (Array.isArray(value)) return value.join('; ');
        if (isObject(value)) return '';
        return value === null || value === undefined ? '' : String(value);
    };
    const lines = [`${object.name}${object.aliases.length ? ` (also: ${object.aliases.join(', ')})` : ''} [${t.label}]`];
    if (object.description) lines.push(object.description);
    for (const def of defs.filter((d) => d.scope === 'global')) {
        const shown = shownValue(def, object[def.name]);
        if (shown) lines.push(`${labelOf(def)}: ${shown}`);
    }
    const related = object.related_entity_ids.map(nameOf).filter(Boolean);
    if (related.length) lines.push(`Related: ${related.join(', ')}`);
    for (const def of defs.filter((d) => d.scope !== 'global')) {
        const shown = shownValue(def, object.runtime?.values?.[def.name]);
        if (shown) lines.push(`${labelOf(def)} (now): ${shown}`);
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
            // Read when the setting's object presets are made (object-presets.js).
            if (isObject(old.runtimeFields)) setting.runtimeFields = { character: old.runtimeFields };
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

// Names in an object field from before it held objects ("the Guild" in a
// character's faction, text until 2026-10-13) -> the ids they mean: an
// object of the field's type matched by name or alias - the chat's, then
// the setting's - or a new one (unconfirmed in a chat, canonical in a
// setting). No review notifications: this runs on startup, for every chat.
function migratedRefs(chatId, settingId, def, value) {
    const type = fieldObjectType(def);
    const isId = (v) => objectTypeOfId(v)?.id === type;
    const items = (Array.isArray(value) ? value : [value]).filter((v) => typeof v === 'string' && v.trim());
    const names = items.flatMap((v) => (isId(v.trim()) ? [v.trim()] : v.split(/[,;]/).map((n) => n.trim()).filter(Boolean)));
    const ids = [];
    for (const name of names) {
        let id = isId(name) ? name : null;
        if (!id && chatId) id = getObjectByAlias(chatId, type, name)?.id ?? createChatObject(chatId, type, name).id;
        if (!id) {
            const key = nameKey(name);
            id = Object.values(settingStore()[settingId].objects[type]).find((r) => [r.name, ...(r.aliases ?? [])].some((n) => nameKey(n) === key))?.id
                ?? createObject(settingId, type, { name }).id;
        }
        if (!ids.includes(id)) ids.push(id);
    }
    return def.type === 'object' ? (ids[0] ?? '') : ids;
}

// Whether a stored object-field value still holds names, not only ids.
function holdsNames(def, value) {
    const type = fieldObjectType(def);
    return (Array.isArray(value) ? value : [value]).some((v) => typeof v === 'string' && v.trim() && objectTypeOfId(v.trim())?.id !== type);
}

// Factions as runtime fields (2026-10-13): characters and locations carry a
// `factions` runtime field (the factions they belong to or are tied to,
// tracked as the story goes, with a starting value per object). In a
// setting's object presets: a character's baseline `faction` becomes the
// runtime `factions`, and a character or location preset without one gets
// it - once (settings.migrations.factionsField), so a field the user later
// removes stays removed. The records' `faction` values move in convert()
// below.
// The types whose defaults carry `factions` (character, location).
const FACTION_TYPES = OBJECT_TYPE_IDS.filter((type) => OBJECT_TYPES[type].runtime.some((f) => f.name === 'factions'));

function migrateFactionFields(settings) {
    const flags = getSettings().migrations ?? (getSettings().migrations = {});
    for (const setting of Object.values(settings)) {
        for (const type of FACTION_TYPES) {
            const defs = getFieldDefs(setting.id, type);
            if (defs.some((d) => d.name === 'factions')) continue;
            const old = defs.find((d) => d.name === 'faction' && fieldObjectType(d) === 'faction');
            if (!old && flags.factionsField) continue;
            const factions = fromRuntimeField(OBJECT_TYPES[type].runtime.find((f) => f.name === 'factions'), OBJECT_TYPES[type]);
            const next = old
                ? defs.map((d) => (d === old ? { ...factions, id: old.id } : d))
                : [...defs, factions];
            // A rename (same id): its field role and baseline values follow;
            // the values are moved to starting values in convert().
            setFieldDefs(setting.id, type, [...next.filter((d) => d.scope === 'global'), ...next.filter((d) => d.scope !== 'global')]);
        }
    }
    flags.factionsField = true;
}

// Object presets (2026-10-13): every setting gets its object preset per
// type - from its old runtime fields where it had them (object-presets.js
// reads setting.runtimeFields once, then it goes) - and object fields still
// holding names get the objects they mean; a character's `faction` becomes
// the starting value of its `factions` (migrateFactionFields). Idempotent;
// run on startup after migrateObjectData(). Returns { settings, references }
// (counts).
export function migrateObjectFields() {
    const counts = { settings: 0, references: 0 };
    const settings = settingStore();
    for (const setting of Object.values(settings)) {
        for (const type of OBJECT_TYPE_IDS) getFieldDefs(setting.id, type);
        if ('runtimeFields' in setting) {
            delete setting.runtimeFields;
            counts.settings++;
        }
    }
    migrateFactionFields(settings);
    const convert = (chatId, settingId, type, record) => {
        let dirty = false;
        // A character's faction (text before 2026-10-13, then faction ids) ->
        // the starting value of its factions.
        const factions = runtimeDefs(settingId, type).find((d) => d.name === 'factions' && fieldObjectType(d) === 'faction');
        if (factions && 'faction' in record) {
            if (!isObject(record.startValues)) record.startValues = {};
            const moved = migratedRefs(chatId, settingId, factions, record.faction);
            if (isEmptyFieldValue(record.startValues.factions) && !isEmptyFieldValue(moved)) {
                record.startValues.factions = moved;
                counts.references++;
            }
            delete record.faction;
            for (const variant of Object.values(isObject(record.variants) ? record.variants : {})) if (isObject(variant?.overrides)) delete variant.overrides.faction;
            dirty = true;
        }
        // Runtime object fields' starting values holding names.
        for (const def of runtimeDefs(settingId, type).filter(fieldObjectType)) {
            if (isObject(record.startValues) && holdsNames(def, record.startValues[def.name])) {
                record.startValues[def.name] = migratedRefs(chatId, settingId, def, record.startValues[def.name]);
                counts.references++;
                dirty = true;
            }
        }
        for (const def of baselineDefs(settingId, type).filter(fieldObjectType)) {
            if (holdsNames(def, record[def.name])) {
                record[def.name] = migratedRefs(chatId, settingId, def, record[def.name]);
                counts.references++;
                dirty = true;
            }
            // References are not overridden by variants.
            for (const variant of Object.values(isObject(record.variants) ? record.variants : {})) {
                if (isObject(variant?.overrides) && def.name in variant.overrides) {
                    delete variant.overrides[def.name];
                    dirty = true;
                }
            }
        }
        return dirty;
    };
    for (const setting of Object.values(settings)) {
        for (const type of OBJECT_TYPE_IDS) for (const record of Object.values(setting.objects[type])) convert(null, setting.id, type, record);
    }
    for (const chatId of Object.keys(getSettings().variableStore?.chats || {})) {
        const settingId = effectiveSetting(chatId).id;
        for (const type of OBJECT_TYPE_IDS) {
            for (const id of Object.keys(loadChatState(chatId)?.objects?.[type]?.local ?? {})) {
                // Read fresh each time: creating an object writes the chat.
                const record = structuredClone(loadChatState(chatId).objects[type].local[id]);
                if (convert(chatId, settingId, type, record)) writeChat(chatId, (state) => { typeLayer(state, type).local[id] = record; });
            }
        }
    }
    if (counts.settings || counts.references) persistSettings();
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
