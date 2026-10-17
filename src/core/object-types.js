// State Engine — object types (the registry)
//
// An OBJECT is a story entity with a stable id: a character, a location, a
// faction... An object variable (`{ type: 'object', objectType }`) holds one
// object's id; an object list (`{ type: 'array', itemType: 'object',
// itemObjectType }`) holds several. This table is the only place a type is
// described - storage, validation, prompts, the manager UI and other
// extensions (through listObjectTypes()) all read it, so nothing elsewhere
// special-cases a type.
//
// Two scopes:
//   world  - canonical records live in a SETTING (a world shared by chats),
//            unconfirmed ones in the chat that met them (objects.js).
//   story  - things that happen in one story: they belong to their chat only.
//
// Every object has the COMMON fields (objects.js): name, aliases, image,
// description, introduction_snippet, related_entity_ids, related_memory_ids.
// `fields` lists a type's own baseline fields:
//   { name, label, kind, refType?, values? }
//   kind: 'text' (short) | 'longtext' | 'list' (of short strings)
//       | 'enum' (one of values) | 'timestamp' (free text, e.g. a story date)
//       | 'ref' (one object id of refType) | 'refs' (object ids of refType)
// `runtime` lists the built-in PER-CHAT fields (state rewritten by the
// prompted update): { name, type: string | number | enum | array (with
// itemType / itemObjectType), ... }. `fresh` runtime fields are asked new
// each turn and never shown back to the model; `keep` ones stay when an
// object with presence leaves the scene. A runtime field can have a
// STARTING VALUE per object, set in its setting, that every chat begins from
// (objects.js) - a character's factions, authored before the story starts.
//
// `fields` and `runtime` are only DEFAULTS: each setting has its own object
// preset per type (object-presets.js), starting from them, that the user can
// change freely. What other code depends on is a FIELD ROLE - every default
// field has one, "<type>.<field>" (registryFieldRoles() below) - which the
// setting assigns to one of its fields.

export const OBJECT_SCOPES = Object.freeze(['world', 'story']);

export const DEFAULT_MOODS = Object.freeze(['Neutral', 'Angry', 'Afraid', 'Curious', 'Confident', 'Sad', 'Suspicious', 'Determined']);

const freeze = (value) => Object.freeze(value);

export const OBJECT_TYPES = freeze({
    character: freeze({
        id: 'character', label: 'Character', plural: 'Characters', noun: 'character', scope: 'world',
        idPrefix: 'chr', color: '#e8973a', icon: 'fa-user',
        hasPresence: true,
        fields: freeze([
            { name: 'personality', label: 'Personality', kind: 'longtext' },
            { name: 'role', label: 'Role', kind: 'text' },
            { name: 'goals', label: 'Goals', kind: 'longtext' },
            { name: 'relationships', label: 'Relationships', kind: 'longtext' },
        ]),
        runtime: freeze([
            { name: 'thought', type: 'string', prompted: true, fresh: true, description: 'A short internal thought, in their voice (under 20 words).' },
            { name: 'mood', type: 'enum', prompted: true, values: [...DEFAULT_MOODS], description: 'Their mood right now - the closest listed value, never another word.' },
            // Fresh: shown back as "currently", it was repeated turn after turn.
            {
                name: 'intent', type: 'string', prompted: true, fresh: true,
                description: 'A short phrase: what they mean to do next, judging by the latest messages - their very next move, not a long-term goal. Once they have done it, or the situation has changed, give the new one.',
            },
            // Two faction fields: Factions is SETTABLE - what the character
            // belongs to, set by hand, by another extension (Scenario
            // Builder fills it from a faction's members) or from the story
            // through the second, Faction ties, which the prompted update
            // writes: the ties the story shows. A tie the story newly shows
            // is added to Factions (applyRuntimeUpdates); one it drops stays
            // there until removed by hand.
            {
                name: 'factions', label: 'Factions', type: 'array', itemType: 'object', itemObjectType: 'faction', prompted: false, keep: true,
                description: 'The factions, groups or organizations they belong to - set by hand or by an extension; ties the story shows (Faction ties) are added to it.',
            },
            {
                name: 'faction_ties', label: 'Faction ties (story)', type: 'array', itemType: 'object', itemObjectType: 'faction', prompted: true, keep: true,
                description: 'The factions, groups or organizations the story shows them belonging to, serving, leading or openly tied to - keep the current ones unless the story changes them; [] if none is shown.',
            },
        ]),
        prompt: freeze({
            single: 'a character\'s name, exactly as the story calls them (e.g. "Kael" or "the stranger"). Reply with the name only; "" if nobody fits',
            // Start from the current list (spec 1.43): small models otherwise
            // answer [] or only the newest arrival.
            list: 'list of the characters in the scene right now, each by name exactly as the story calls them. '
                + 'Start from the current list: keep everyone still present, add anyone who arrived, remove only those who left. '
                + 'Do NOT include groups, crowds, background extras, plural nouns, or generic roles (e.g. “patrons”, “guards”, '
                + '“reception staff”, “people”, “students”). Only include a person if the story treats them as a specific individual '
                + '(named or uniquely described). Someone singled out by a description but not named yet ("a tall man with thick eyebrows") '
                + 'counts: name them by a short description of that person (e.g. "the eyepatched man"), and keep using that same name. '
                + 'Reply with a full JSON array of names (e.g. ["Kael","the stranger"]); [] only if nobody at all is in the scene',
            runtimeNote: 'write a new thought for every character, never empty; never change who they are.',
        }),
    }),
    location: freeze({
        id: 'location', label: 'Location', plural: 'Locations', noun: 'location', scope: 'world',
        idPrefix: 'loc', color: '#4caf50', icon: 'fa-map-location-dot',
        hasPresence: false,
        fields: freeze([
            { name: 'region', label: 'Region', kind: 'text' },
        ]),
        runtime: freeze([
            { name: 'conditions', type: 'string', prompted: true, description: 'The weather, light and state of the place right now (short).' },
            {
                name: 'factions', label: 'Factions', type: 'array', itemType: 'object', itemObjectType: 'faction', prompted: true, keep: true,
                description: 'The factions or groups that hold, run or are tied to this place (its guards, a gang, "the citizens of Riverton") - keep the current ones unless the story changes them; [] if none.',
            },
        ]),
        prompt: freeze({
            single: 'a location\'s name, exactly as the story calls it, in ordinary words (e.g. "the Rusty Anchor" or "Brass Market") - never an id like "rusty_anchor". Reply with the name only; "" if no place fits',
            list: 'list of the locations in play right now, each by name exactly as the story calls it. '
                + 'Start from the current list: keep the ones still relevant, add new ones, remove only those no longer relevant. '
                + 'Only specific places (named or uniquely described), not generic ones ("a street", "somewhere"). '
                + 'Reply with a full JSON array of names (e.g. ["the Rusty Anchor","Brass Market"]); [] if none',
        }),
    }),
    faction: freeze({
        id: 'faction', label: 'Faction', plural: 'Factions', noun: 'faction', scope: 'world',
        idPrefix: 'fac', color: '#e05555', icon: 'fa-flag',
        hasPresence: false,
        fields: freeze([
            { name: 'goals', label: 'Goals', kind: 'longtext' },
            { name: 'tensions', label: 'Tensions', kind: 'longtext' },
            { name: 'relationships', label: 'Relationships', kind: 'longtext' },
            { name: 'members', label: 'Members', kind: 'refs', refType: 'character' },
        ]),
        runtime: freeze([
            { name: 'standing', type: 'string', prompted: true, description: 'Their stance toward the protagonists right now (short).' },
        ]),
        prompt: freeze({
            single: 'a faction\'s name, exactly as the story calls it (e.g. "the Brass Guild" or "the Ashguard"). Reply with the name only; "" if none fits',
            list: 'list of the factions involved right now, each by name exactly as the story calls it. '
                + 'Start from the current list: keep the ones still involved, add new ones, remove only those no longer involved. '
                + 'Reply with a full JSON array of names (e.g. ["the Brass Guild"]); [] if none',
        }),
    }),
    item: freeze({
        id: 'item', label: 'Item', plural: 'Items', noun: 'item', scope: 'world',
        idPrefix: 'itm', color: '#d4b03c', icon: 'fa-gem',
        hasPresence: false,
        fields: freeze([
            { name: 'owner', label: 'Owner', kind: 'ref', refType: 'character' },
            { name: 'location', label: 'Location', kind: 'ref', refType: 'location' },
        ]),
        runtime: freeze([
            { name: 'condition', type: 'string', prompted: true, description: 'Its state right now (short), e.g. "intact", "cracked".' },
        ]),
        prompt: freeze({
            single: 'an item\'s name, exactly as the story calls it (e.g. "the stolen ledger" or "Kael\'s sword"). Reply with the name only; "" if none fits',
            list: 'list of the notable items in play right now, each by name exactly as the story calls it. '
                + 'Start from the current list: keep the ones still in play, add new ones, remove only those no longer in play. '
                + 'Only specific, story-relevant items, not everyday objects ("a cup", "chairs"). '
                + 'Reply with a full JSON array of names (e.g. ["the stolen ledger"]); [] if none',
        }),
    }),
    creature: freeze({
        id: 'creature', label: 'Creature', plural: 'Creatures', noun: 'creature', scope: 'world',
        idPrefix: 'crt', color: '#a1745a', icon: 'fa-dragon',
        hasPresence: true,
        fields: freeze([
            { name: 'traits', label: 'Traits', kind: 'list' },
            { name: 'danger_level', label: 'Danger level', kind: 'enum', values: ['Harmless', 'Low', 'Moderate', 'High', 'Deadly'] },
            { name: 'location', label: 'Location', kind: 'ref', refType: 'location' },
        ]),
        runtime: freeze([
            { name: 'state', type: 'string', prompted: true, description: 'What it is doing or how it is right now (short).' },
        ]),
        prompt: freeze({
            single: 'a creature\'s name, exactly as the story calls it (e.g. "the grey wolf" or "Ashmaw"). Reply with the name only; "" if none fits',
            list: 'list of the creatures in the scene right now, each by name exactly as the story calls it. '
                + 'Start from the current list: keep the ones still present, add new arrivals, remove only those that left. '
                + 'Only specific creatures (named or uniquely described), not crowds or swarms in general. '
                + 'Reply with a full JSON array of names (e.g. ["the grey wolf"]); [] if none',
        }),
    }),
    lore: freeze({
        id: 'lore', label: 'Lore', plural: 'Lore', noun: 'lore entry', scope: 'world',
        idPrefix: 'lor', color: '#a070e0', icon: 'fa-book',
        hasPresence: false,
        fields: freeze([
            { name: 'category', label: 'Category', kind: 'text' },
        ]),
        runtime: freeze([]),
        prompt: freeze({
            single: 'the name of a piece of lore, exactly as the story calls it (e.g. "the Sundering" or "the Old Pact"). Reply with the name only; "" if none fits',
            list: 'list of the pieces of lore relevant right now, each by name exactly as the story calls it. '
                + 'Start from the current list: keep the ones still relevant, add new ones, remove only those no longer relevant. '
                + 'Reply with a full JSON array of names (e.g. ["the Sundering"]); [] if none',
        }),
    }),
    quest: freeze({
        id: 'quest', label: 'Quest', plural: 'Quests', noun: 'quest', scope: 'story',
        idPrefix: 'qst', color: '#4a90d9', icon: 'fa-scroll',
        hasPresence: false,
        fields: freeze([
            { name: 'objectives', label: 'Objectives', kind: 'list' },
        ]),
        runtime: freeze([
            { name: 'status', type: 'enum', prompted: true, values: ['Not started', 'Active', 'Completed', 'Failed'], description: 'Where the quest stands now.' },
        ]),
        prompt: freeze({
            single: 'a quest\'s name, as the story would title it (e.g. "Find the stolen ledger"). Reply with the name only; "" if none fits',
            list: 'list of the quests under way, each by a short title. '
                + 'Start from the current list: keep the ones still open, add new ones, remove only finished or abandoned ones. '
                + 'Reply with a full JSON array of titles (e.g. ["Find the stolen ledger"]); [] if none',
        }),
    }),
    scene: freeze({
        id: 'scene', label: 'Scene', plural: 'Scenes', noun: 'scene', scope: 'story',
        idPrefix: 'scn', color: '#4fb8b0', icon: 'fa-clapperboard',
        hasPresence: false,
        fields: freeze([
            { name: 'timestamp', label: 'Timestamp', kind: 'timestamp' },
            { name: 'location', label: 'Location', kind: 'ref', refType: 'location' },
            { name: 'characters', label: 'Characters present', kind: 'refs', refType: 'character' },
            { name: 'summary', label: 'Summary', kind: 'longtext' },
        ]),
        runtime: freeze([]),
        prompt: freeze({
            single: 'a short title for the current scene (e.g. "The ambush at the bridge"). Reply with the title only; "" if none fits',
            list: 'list of the scenes so far, each by a short title. Start from the current list and only add new ones. '
                + 'Reply with a full JSON array of titles; [] if none',
        }),
    }),
    event: freeze({
        id: 'event', label: 'Event', plural: 'Events', noun: 'event', scope: 'story',
        idPrefix: 'evt', color: '#5c6bc0', icon: 'fa-bolt',
        hasPresence: false,
        fields: freeze([
            { name: 'timestamp', label: 'Timestamp', kind: 'timestamp' },
            { name: 'summary', label: 'Summary', kind: 'longtext' },
        ]),
        runtime: freeze([]),
        prompt: freeze({
            single: 'a short title for the event that just happened (e.g. "The fire at the docks"). Reply with the title only; "" if nothing notable happened',
            list: 'list of the notable events so far, each by a short title. Start from the current list and only add new ones. '
                + 'Reply with a full JSON array of titles; [] if none',
        }),
    }),
});

export const OBJECT_TYPE_IDS = Object.freeze(Object.keys(OBJECT_TYPES));

const BY_PREFIX = new Map(Object.values(OBJECT_TYPES).map((t) => [t.idPrefix, t]));

export function isObjectType(type) {
    return typeof type === 'string' && Object.prototype.hasOwnProperty.call(OBJECT_TYPES, type);
}

export function getObjectType(type) {
    return isObjectType(type) ? OBJECT_TYPES[type] : null;
}

// The type of an object id, from its prefix ("loc_ab12" -> location), or null.
export function objectTypeOfId(id) {
    if (typeof id !== 'string') return null;
    const at = id.indexOf('_');
    return at > 0 ? (BY_PREFIX.get(id.slice(0, at)) ?? null) : null;
}

// An OBJECT PRESET (object-presets.js): a setting's fields for one object
// type - never bound to a chat, so left out of every list of presets a chat
// or the tracker uses.
export function isObjectPreset(preset) {
    return !!preset && isObjectType(preset.objectType) && typeof preset.settingId === 'string';
}

export function isWorldType(type) {
    return getObjectType(type)?.scope === 'world';
}

// A field role's type (roles.js ROLE_TYPES) for a registry field.
function roleTypeOf(field) {
    if (field.type === 'number') return 'number';
    if (field.type === 'array') return 'list';
    if (field.kind === 'ref') return 'object';
    if (field.kind === 'list' || field.kind === 'refs') return 'list';
    return 'text';
}

// A type's field roles: one per default field (baseline and runtime),
// "<type>.<field>": [{ publicName, type, label, field }].
export function registryFieldRoles(type) {
    const t = getObjectType(type);
    if (!t) return [];
    return [...t.fields, ...t.runtime].map((f) => ({ publicName: `${t.id}.${f.name}`, type: roleTypeOf(f), label: f.label ?? '', field: f.name }));
}

// The registry as plain data for other extensions (listObjectTypes()).
export function describeObjectTypes() {
    return OBJECT_TYPE_IDS.map((id) => {
        const t = OBJECT_TYPES[id];
        return {
            id: t.id, label: t.label, plural: t.plural, noun: t.noun, scope: t.scope, idPrefix: t.idPrefix,
            color: t.color, icon: t.icon, hasPresence: t.hasPresence,
            fields: t.fields.map((f) => ({ ...f, values: f.values ? [...f.values] : undefined })),
            runtime: t.runtime.map((f) => ({ ...f, values: f.values ? [...f.values] : undefined })),
            fieldRoles: registryFieldRoles(id),
        };
    });
}
