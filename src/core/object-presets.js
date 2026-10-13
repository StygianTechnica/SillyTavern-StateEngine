// State Engine — object presets and field roles (docs/DESIGN - OBJECT PRESETS.md)
//
// Each SETTING has, for each object type, one OBJECT PRESET: a real preset
// in settings.presets, tagged { objectType, settingId }, whose variables are
// that type's FIELDS in that setting. Every chat on the setting uses it -
// it is never bound to a chat, never shown in the chat preset picker or the
// tracker (isObjectPreset() is how other code leaves it out).
//
// A field is an ordinary variable definition with a LOCAL name ("mood" - the
// preset, owned by its setting, is its namespace), where `scope` says what
// kind of field it is:
//   global  BASELINE - one value per object, on the object's record (the
//           same in every chat on the setting): region, goals, members
//   chat    RUNTIME - one value per object per chat, in the chat's object
//           layer: mood, conditions, standing
// Field types: string, number, boolean, enum, array (of strings, enums or
// objects), object, image, imageList, imageMap. A string field may be
// `multiline` (long text). Any field may be prompted:
//   prompted: { instructions, newEachTurn, mode: 'fill' | 'update' }
//   fill    asked only while empty (default for baseline fields - shared by
//           every chat on the setting, so it captures what the story
//           establishes once and then stays)
//   update  asked every turn (default for runtime fields)
// `clearOnLeave` (runtime fields, types with presence): cleared when the
// object leaves the scene. `enumImages` ({ value: image }) is an enum's
// icon per value until imageMap fields replace it.
//
// FIELD ROLES are the contract with other code: what a field MEANS
// ("character.mood"), not what it is called. Each type declares its roles
// in the registry (object-types.js registryFieldRoles); a setting assigns each to one
// of its fields (setting.fieldRoles = { [roleId]: fieldName | null }). With
// no entry, a role is assigned to the field of its default name, if there is
// one. Renaming a field moves its roles and stored values with it; deleting
// one leaves its roles unassigned. Readers go through the role, so a user
// renaming or replacing a field breaks nothing.
//
// The registry's `fields` and `runtime` are only the DEFAULTS a setting's
// object presets start from.

import { BUILTIN_NAMESPACE, getSettings, persistSettings } from './settings-core.js';
import { blankDefinition, genId } from './variable-schema.js';
import { checkImageValue } from './image-variables.js';
import { OBJECT_TYPES, OBJECT_TYPE_IDS, getObjectType, objectTypeOfId, isObjectType, isObjectPreset, registryFieldRoles } from './object-types.js';

export const FIELD_TYPES = Object.freeze(['string', 'number', 'boolean', 'enum', 'array', 'object', 'image', 'imageList', 'imageMap']);
export const FIELD_SCOPES = Object.freeze(['global', 'chat']);
export const PROMPT_MODES = Object.freeze(['fill', 'update']);
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
// Names an object already has (objects.js) - never a field's.
const RESERVED = new Set([
    'id', 'type', 'name', 'aliases', 'image', 'description', 'introduction_snippet', 'related_entity_ids', 'related_memory_ids',
    'confirmed', 'variants', 'activeVariant', 'createdAt', 'updatedAt', 'present', 'runtime', 'base', 'scope', 'settingId', 'matches',
]);
const ITEM_TYPES = Object.freeze(['string', 'enum', 'object']);
const MAX_ENUM_VALUES = 30;
const MAX_SHORT = 300;
const MAX_LONG = 4000;
const MAX_LIST = 50;
const MAX_LIST_ITEM = 200;
const MAX_REFS = 200;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function mustType(type) {
    const t = getObjectType(type);
    if (!t) throw new Error(`unknown object type ${JSON.stringify(type)} (one of: ${OBJECT_TYPE_IDS.join(', ')})`);
    return t;
}

export { isObjectPreset };

// ------------------------------------------------------------ definitions

// A registry baseline field ({ name, label, kind, refType?, values? }) as a field definition.
function fromRegistryField(f) {
    const base = { name: f.name, label: f.label ?? '', scope: 'global' };
    switch (f.kind) {
        case 'longtext': return { ...base, type: 'string', multiline: true };
        case 'list': return { ...base, type: 'array', itemType: 'string' };
        case 'enum': return { ...base, type: 'enum', enumValues: [...(f.values ?? [])] };
        case 'ref': return { ...base, type: 'object', objectType: f.refType };
        case 'refs': return { ...base, type: 'array', itemType: 'object', itemObjectType: f.refType };
        default: return { ...base, type: 'string' };
    }
}

// A registry (or pre-object-preset setting) runtime field
// ({ name, type, prompted, description, values?, images?, min?, max?, fresh? }) as a field definition.
export function fromRuntimeField(f, t) {
    const prompted = f.prompted !== false;
    const def = {
        name: f.name,
        label: f.label ?? '',
        scope: 'chat',
        type: f.type === 'number' || f.type === 'enum' ? f.type : 'string',
        clearOnLeave: t.hasPresence,
        behaviors: { prompted, increment: false },
        prompted: { instructions: f.description ?? '', newEachTurn: f.fresh === true, mode: 'update' },
    };
    if (def.type === 'enum') {
        def.enumValues = [...(f.values ?? [])];
        if (isObject(f.images) && Object.keys(f.images).length) def.enumImages = { ...f.images };
    }
    if (def.type === 'number') {
        def.min = Number.isFinite(f.min) ? f.min : null;
        def.max = Number.isFinite(f.max) ? f.max : null;
    }
    return def;
}

// The fields a new setting's object preset for `type` starts with:
// baseline fields, then runtime fields.
export function defaultFieldDefs(type) {
    const t = mustType(type);
    return [...t.fields.map(fromRegistryField), ...t.runtime.map((f) => fromRuntimeField(f, t))].map((raw) => normalizeFieldDef(t, raw));
}

function cleanEnumValues(values, what) {
    const out = [];
    for (const v of Array.isArray(values) ? values : []) {
        const value = text(typeof v === 'string' ? v : String(v ?? ''), 60);
        if (!value) continue;
        if (out.some((x) => x.toLowerCase() === value.toLowerCase())) throw new Error(`${what} lists "${value}" twice`);
        out.push(value);
    }
    if (out.length === 0) throw new Error(`${what} is an enum but has no values`);
    if (out.length > MAX_ENUM_VALUES) throw new Error(`${what} has more than ${MAX_ENUM_VALUES} values`);
    return out;
}

// One field definition, validated and completed into a full variable
// definition. Throws with a reason.
export function normalizeFieldDef(t, raw, what = 'field') {
    if (!isObject(raw)) throw new Error(`${what} must be an object`);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!FIELD_NAME.test(name)) throw new Error(`${what} name ${JSON.stringify(raw.name)} is not valid - lowercase letters, digits and _, starting with a letter (max 40)`);
    if (name === 'present') throw new Error('"present" is not a field you define - it is the object\'s presence');
    if (RESERVED.has(name)) throw new Error(`"${name}" is not a field you define - every ${t.noun} already has it`);
    what = `field "${name}"`;
    const type = raw.type ?? 'string';
    if (!FIELD_TYPES.includes(type)) throw new Error(`${what} has type ${JSON.stringify(type)} - a field is one of: ${FIELD_TYPES.join(', ')}`);
    const scope = raw.scope ?? 'chat';
    if (!FIELD_SCOPES.includes(scope)) throw new Error(`${what} has scope ${JSON.stringify(scope)} (global: baseline, chat: runtime)`);
    const prompted = raw.behaviors?.prompted === true || (raw.behaviors?.prompted === undefined && raw.prompted === true);
    const promptedConfig = isObject(raw.prompted) ? raw.prompted : {};
    const mode = PROMPT_MODES.includes(promptedConfig.mode) ? promptedConfig.mode : (scope === 'global' ? 'fill' : 'update');
    const def = {
        ...blankDefinition(),
        id: typeof raw.id === 'string' && raw.id ? raw.id : genId(),
        name,
        label: text(raw.label, 100),
        description: text(raw.description, 500),
        scope,
        type,
        showInTracker: false,
        resetOnNewChat: false,
        behaviors: { prompted, increment: false },
        prompted: { instructions: text(promptedConfig.instructions, 1000), newEachTurn: promptedConfig.newEachTurn === true, mode },
        clearOnLeave: scope === 'chat' && raw.clearOnLeave === true,
        defaultValue: emptyFieldValue({ type }),
    };
    if (type === 'string') def.multiline = raw.multiline === true;
    if (type === 'enum') {
        def.enumValues = cleanEnumValues(raw.enumValues ?? raw.values, what);
        if (isObject(raw.enumImages)) {
            const images = {};
            for (const [key, ref] of Object.entries(raw.enumImages)) {
                const value = def.enumValues.find((v) => v.toLowerCase() === String(key).trim().toLowerCase());
                if (value && typeof ref === 'string' && ref.trim()) images[value] = ref.trim();
            }
            if (Object.keys(images).length) def.enumImages = images;
        }
    }
    if (type === 'number') {
        def.min = Number.isFinite(raw.min) ? raw.min : null;
        def.max = Number.isFinite(raw.max) ? raw.max : null;
        if (def.min !== null && def.max !== null && def.min >= def.max) throw new Error(`${what}: min must be below max`);
    }
    if (type === 'object') {
        if (!isObjectType(raw.objectType)) throw new Error(`${what} needs an objectType (one of: ${OBJECT_TYPE_IDS.join(', ')})`);
        def.objectType = raw.objectType;
    }
    if (type === 'array') {
        const itemType = raw.itemType ?? 'string';
        if (!ITEM_TYPES.includes(itemType)) throw new Error(`${what}: a list field holds ${ITEM_TYPES.join(', ')} items`);
        def.itemType = itemType;
        if (itemType === 'enum') def.itemEnumValues = cleanEnumValues(raw.itemEnumValues, what);
        if (itemType === 'object') {
            if (!isObjectType(raw.itemObjectType)) throw new Error(`${what} needs an itemObjectType (one of: ${OBJECT_TYPE_IDS.join(', ')})`);
            def.itemObjectType = raw.itemObjectType;
        }
    }
    if (type === 'imageMap') def.currentKeyVariable = typeof raw.currentKeyVariable === 'string' ? raw.currentKeyVariable.trim() : '';
    return def;
}

// ------------------------------------------------------------ values

// What an unset field holds.
export function emptyFieldValue(def) {
    switch (def?.type) {
        case 'array':
        case 'imageList': return [];
        case 'imageMap': return {};
        case 'number':
        case 'boolean': return null;
        default: return '';
    }
}

export function isEmptyFieldValue(value) {
    return value === null || value === undefined || value === ''
        || (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0);
}

const isIdOf = (type) => (v) => typeof v === 'string' && objectTypeOfId(v.trim())?.id === type;

// A value for field `def`, cleaned; emptyFieldValue(def) when it is not a
// valid one. Object fields keep only ids of their type - names are turned
// into ids by the caller (objects.js), which knows the chat.
export function coerceFieldValue(def, raw) {
    if (raw === null || raw === undefined) return emptyFieldValue(def);
    switch (def.type) {
        case 'number': {
            const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : NaN);
            if (!Number.isFinite(n)) return null;
            return Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, n));
        }
        case 'boolean': {
            if (typeof raw === 'boolean') return raw;
            const s = String(raw).trim().toLowerCase();
            if (['true', 'yes', '1', 'on'].includes(s)) return true;
            if (['false', 'no', '0', 'off'].includes(s)) return false;
            return null;
        }
        case 'enum': {
            const s = String(raw).trim().toLowerCase();
            return def.enumValues.find((v) => v.toLowerCase() === s) ?? '';
        }
        case 'object':
            return isIdOf(def.objectType)(raw) ? raw.trim() : '';
        case 'array': {
            const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw.trim() ? [raw] : []);
            if (def.itemType === 'object') return [...new Set(list.filter(isIdOf(def.itemObjectType)).map((v) => v.trim()))].slice(0, MAX_REFS);
            if (def.itemType === 'enum') {
                return [...new Set(list.map((v) => def.itemEnumValues.find((e) => e.toLowerCase() === String(v ?? '').trim().toLowerCase())).filter(Boolean))];
            }
            return list.map((v) => text(typeof v === 'string' ? v : String(v ?? ''), MAX_LIST_ITEM)).filter(Boolean).slice(0, MAX_LIST);
        }
        case 'image':
        case 'imageList':
        case 'imageMap': {
            const checked = checkImageValue(def.type, raw);
            return checked.ok ? checked.value : emptyFieldValue(def);
        }
        default: {
            const value = typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : (typeof raw === 'string' ? raw.trim() : '');
            const max = def.multiline ? MAX_LONG : MAX_SHORT;
            return value.length > max ? `${value.slice(0, max - 1).trim()}…` : value;
        }
    }
}

// The object type an object field holds, or null.
export function fieldObjectType(def) {
    if (def?.type === 'object') return def.objectType;
    if (def?.type === 'array' && def.itemType === 'object') return def.itemObjectType;
    return null;
}

// ------------------------------------------------------------ storage

function store() {
    const settings = getSettings();
    if (!isObject(settings.presets)) settings.presets = {};
    return settings.presets;
}

function settingRecord(settingId) {
    const settings = getSettings().variableStore?.settings;
    return isObject(settings) ? settings[settingId] ?? null : null;
}

function presetName(setting, t) {
    return `${setting?.name ?? 'Setting'} · ${t.plural}`;
}

// The object preset of `settingId` and `type` (the stored preset), created
// with the type's default fields when missing - or null for an unknown
// setting.
export function objectPresetFor(settingId, type) {
    const t = mustType(type);
    const setting = settingRecord(settingId);
    if (!setting) return null;
    const presets = store();
    const found = Object.values(presets).find((p) => isObjectPreset(p) && p.settingId === settingId && p.objectType === t.id);
    if (found) return found;
    return createObjectPreset(settingId, t.id, initialFieldDefs(setting, t));
}

// The fields a setting's object preset starts with: the type's defaults -
// or, for a setting from before object presets, its baseline defaults and
// the runtime fields it had (setting.runtimeFields[type]: built-ins first,
// in the registry's order, then its own; a missing built-in comes back).
function initialFieldDefs(setting, t) {
    const legacy = isObject(setting.runtimeFields?.[t.id]) ? Object.values(setting.runtimeFields[t.id]).filter(isObject) : null;
    if (!legacy) return defaultFieldDefs(t.id);
    const builtIns = t.runtime.map((f) => f.name);
    const order = (f) => (builtIns.includes(f.name) ? builtIns.indexOf(f.name) : builtIns.length);
    const runtime = [...t.runtime.filter((b) => !legacy.some((f) => f.name === b.name)), ...legacy]
        .sort((a, b) => order(a) - order(b))
        .map((f) => fromRuntimeField({ ...f, fresh: f.fresh === true || t.runtime.find((b) => b.name === f.name)?.fresh === true }, t));
    const defs = [];
    for (const raw of [...t.fields.map(fromRegistryField), ...runtime]) {
        try {
            const def = normalizeFieldDef(t, raw);
            if (!defs.some((d) => d.name === def.name)) defs.push(def);
        } catch (err) {
            console.warn('[State Engine]', `setting "${setting.name}": ${t.noun} field dropped - ${err.message}`);
        }
    }
    return defs;
}

// Creates (or replaces) the object preset with `defs` (validated).
export function createObjectPreset(settingId, type, defs) {
    const t = mustType(type);
    const setting = settingRecord(settingId);
    if (!setting) throw new Error(`setting ${JSON.stringify(settingId)} does not exist`);
    const presets = store();
    for (const [id, p] of Object.entries(presets)) if (isObjectPreset(p) && p.settingId === settingId && p.objectType === t.id) delete presets[id];
    const id = genId();
    presets[id] = {
        id,
        namespace: BUILTIN_NAMESPACE,
        name: presetName(setting, t),
        description: `The ${t.plural.toLowerCase()} of the setting "${setting.name}": their fields - baseline (global scope, the same in every chat) and runtime (chat scope, per chat).`,
        objectType: t.id,
        settingId,
        variables: Object.fromEntries(checkedDefs(t, defs).map((def) => [def.id, def])),
        triggers: [],
        showInTracker: false,
        independentPreset: false,
    };
    persistSettings();
    return presets[id];
}

function checkedDefs(t, defs) {
    if (!Array.isArray(defs)) throw new Error('fields must be an array');
    const out = [];
    defs.forEach((raw, i) => {
        const def = normalizeFieldDef(t, raw, `field #${i + 1}`);
        if (out.some((d) => d.name === def.name)) throw new Error(`field "${def.name}" is listed twice`);
        if (out.some((d) => d.id === def.id)) def.id = genId();
        out.push(def);
    });
    return out;
}

// A setting's fields for a type, in order (copies): baseline first, then runtime.
export function getFieldDefs(settingId, type) {
    const preset = objectPresetFor(settingId, type);
    if (!preset) return [];
    const defs = Object.values(preset.variables ?? {}).map((d) => structuredClone(d));
    return [...defs.filter((d) => d.scope === 'global'), ...defs.filter((d) => d.scope !== 'global')];
}

export function getFieldDef(settingId, type, name) {
    return getFieldDefs(settingId, type).find((d) => d.name === name) ?? null;
}

// Replaces a setting's fields for a type with `defs` (validated - throws).
// A def keeping the `id` of an existing field under a new name RENAMES it:
// its field roles follow, and `onRename(from, to)` lets the caller move its
// stored values. Returns { defs, renamed: [{ from, to }], removed: [names] }.
export function setFieldDefs(settingId, type, defs, { onRename = null } = {}) {
    const t = mustType(type);
    const preset = objectPresetFor(settingId, t.id);
    if (!preset) throw new Error(`setting ${JSON.stringify(settingId)} does not exist`);
    const next = checkedDefs(t, defs);
    const before = Object.values(preset.variables ?? {});
    const renamed = [];
    for (const def of next) {
        const old = before.find((d) => d.id === def.id);
        if (old && old.name !== def.name) renamed.push({ from: old.name, to: def.name });
    }
    const removed = before.filter((d) => !next.some((n) => n.id === d.id) && !next.some((n) => n.name === d.name)).map((d) => d.name);
    preset.variables = Object.fromEntries(next.map((def) => [def.id, def]));
    const setting = settingRecord(settingId);
    for (const { from, to } of renamed) {
        moveRoleAssignments(setting, t, from, to);
        onRename?.(from, to);
    }
    for (const name of removed) moveRoleAssignments(setting, t, name, null);
    persistSettings();
    return { defs: getFieldDefs(settingId, t.id), renamed, removed };
}

export function deleteObjectPresets(settingId) {
    const presets = store();
    for (const [id, p] of Object.entries(presets)) if (isObjectPreset(p) && p.settingId === settingId) delete presets[id];
}

// Keeps each object preset's name in step with its setting's.
export function renameObjectPresets(settingId) {
    const setting = settingRecord(settingId);
    for (const p of Object.values(store())) {
        if (isObjectPreset(p) && p.settingId === settingId) p.name = presetName(setting, OBJECT_TYPES[p.objectType]);
    }
}

// ------------------------------------------------------------ field roles

// A type's field roles: [{ id, publicName, type (a role type), objectType, label, field (its default field name) }].
export function builtInFieldRoles(type) {
    const t = mustType(type);
    return registryFieldRoles(t.id).map((r) => ({
        id: `${BUILTIN_NAMESPACE}__${r.publicName}`, publicName: r.publicName, type: r.type, objectType: t.id, label: r.label ?? '', field: r.field,
    }));
}

function roleMap(setting) {
    if (!isObject(setting.fieldRoles)) setting.fieldRoles = {};
    return setting.fieldRoles;
}

// Role assignments to field `from` move to `to` (null: unassigned).
function moveRoleAssignments(setting, t, from, to) {
    if (!setting) return;
    const map = roleMap(setting);
    for (const role of builtInFieldRoles(t.id)) {
        const current = role.id in map ? map[role.id] : role.field;
        if (current === from) map[role.id] = to;
    }
}

// The field a role means in a setting, or null (unassigned, or its field is gone).
export function fieldForRole(settingId, roleId) {
    const setting = settingRecord(settingId);
    const role = OBJECT_TYPE_IDS.flatMap(builtInFieldRoles).find((r) => r.id === roleId);
    if (!setting || !role) return null;
    const map = roleMap(setting);
    const name = roleId in map ? map[roleId] : role.field;
    return name && getFieldDef(settingId, role.objectType, name) ? name : null;
}

// A setting's field roles for a type: [{ ...role, assigned: fieldName | null }].
export function getFieldRoles(settingId, type) {
    return builtInFieldRoles(type).map((role) => ({ ...role, assigned: fieldForRole(settingId, role.id) }));
}

// Assigns a role to one of the setting's fields (null: unassigned). Throws
// for an unknown role or field.
export function assignFieldRole(settingId, roleId, fieldName) {
    const setting = settingRecord(settingId);
    if (!setting) throw new Error(`setting ${JSON.stringify(settingId)} does not exist`);
    const role = OBJECT_TYPE_IDS.flatMap(builtInFieldRoles).find((r) => r.id === roleId);
    if (!role) throw new Error(`${JSON.stringify(roleId)} is not a field role`);
    if (fieldName !== null && !getFieldDef(settingId, role.objectType, fieldName)) {
        throw new Error(`the setting has no ${role.objectType} field ${JSON.stringify(fieldName)}`);
    }
    roleMap(setting)[roleId] = fieldName;
    persistSettings();
    return getFieldRoles(settingId, role.objectType).find((r) => r.id === roleId);
}

// A field name, or a field role's id, as the setting's field name - null when none.
export function resolveFieldName(settingId, type, nameOrRole) {
    if (typeof nameOrRole !== 'string' || !nameOrRole) return null;
    if (nameOrRole.includes('__')) return fieldForRole(settingId, nameOrRole);
    return getFieldDef(settingId, type, nameOrRole) ? nameOrRole : null;
}
