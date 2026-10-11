// State Engine — object display hook
//
// An object variable stores object ids; wherever a value becomes text
// (macros, the tracker, prompts) the NAMES are shown. This tiny module holds
// the name resolver so those modules need not import objects.js (which
// imports chat-state.js, which imports the macro store - a cycle).
// objects.js installs the resolver when it loads.

import { isObjectType } from './object-types.js';

let resolver = null;

export function setObjectNameResolver(fn) {
    resolver = typeof fn === 'function' ? fn : null;
}

// Whether a definition holds objects: an object variable, or a list of them.
export function isObjectDefinition(def) {
    return (def?.type === 'object' && isObjectType(def.objectType))
        || (def?.type === 'array' && def?.itemType === 'object' && isObjectType(def.itemObjectType));
}

// Whether it is an object LIST (an array of object ids).
export function isObjectList(def) {
    return def?.type === 'array' && def?.itemType === 'object' && isObjectType(def.itemObjectType);
}

// The object type a definition holds ('character', 'location'...), or null.
export function objectTypeOf(def) {
    if (def?.type === 'object' && isObjectType(def.objectType)) return def.objectType;
    if (isObjectList(def)) return def.itemObjectType;
    return null;
}

// An object id's display name in the current chat ('' for none, the id
// itself when nothing resolves it).
export function objectName(id) {
    if (typeof id !== 'string' || !id) return '';
    try {
        return resolver?.(id) ?? id;
    } catch {
        return id;
    }
}

// An object variable's value as text: a name, or names joined with ", ".
// A list already turned into text (the macro mirror's "Kael, Mira") is
// returned as it is.
export function objectValueText(def, value) {
    if (def?.type === 'object') return objectName(value);
    if (typeof value === 'string') return value;
    return (Array.isArray(value) ? value : []).map(objectName).filter(Boolean).join(', ');
}
