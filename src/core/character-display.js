// State Engine — character display hook (requirements spec 1.42)
//
// A character variable stores character ids; wherever a value becomes text
// (macros, the tracker, prompts) the NAMES are shown. This tiny module holds
// the name resolver so those modules need not import characters.js (which
// imports chat-state.js, which imports the macro store - a cycle).
// characters.js installs the resolver when it loads.

let resolver = null;

export function setCharacterNameResolver(fn) {
    resolver = typeof fn === 'function' ? fn : null;
}

// Whether a definition holds characters: a character variable, or an array
// of characters.
export function isCharacterDefinition(def) {
    return def?.type === 'character' || (def?.type === 'array' && def?.itemType === 'character');
}

// A character id's display name in the current chat ('' for none, the id
// itself when nothing resolves it).
export function characterName(id) {
    if (typeof id !== 'string' || !id) return '';
    try {
        return resolver?.(id) ?? id;
    } catch {
        return id;
    }
}

// A character variable's value as text: a name, or names joined with ", ".
export function characterValueText(def, value) {
    if (def?.type === 'character') return characterName(value);
    return (Array.isArray(value) ? value : []).map(characterName).filter(Boolean).join(', ');
}
