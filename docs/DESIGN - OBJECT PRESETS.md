# Design: Object Presets and Field Roles

Status: **agreed**, revision 3 (2026-10-13). Phase 1 built (see 9); phase 2 next.

Decided so far:
- One object preset per **setting** per type.
- Fields are reached through **roles**, not hard-coded names.
- Baseline and runtime fields merge into one preset.
- Calculated fields come later.
- Faction inference belongs to Archivist.
- Object presets are real presets, hidden from the chat preset picker and the tracker.
- Baseline fields can be prompted, filled when empty by default (2.3).
- **Structure belongs to the setting, values to the chat.** A chat never overrides a setting's
  fields or field roles.

Principle: things are configured **per setting** wherever possible, not per chat. Users
usually have one setting per story, and a setting change is undone by starting a chat on
another setting. Per-chat configuration is busywork. Scenario Builder is expected to author most
of a setting (objects and their baseline fields); State Engine and Archivist keep it current.

## 1. The problem

An object's data is split between two hard-coded mechanisms, and neither is a variable:

| | Baseline fields | Runtime fields | Variables |
|---|---|---|---|
| Example | a location's `region`, a character's `faction` | a character's `mood`, a location's `conditions` | `se__scene_weather` |
| Defined in | the type registry (code) | each setting, per type (Pretty Panels' Runtime fields tab) | presets (State Engine manager) |
| User can change | no | partly (built-ins can't be removed) | yes |
| Types | text, longtext, list, enum, ref(s), timestamp | string, number, enum | every variable type |
| Images | - | an `images` map on enums | image / imageList / imageMap |
| Read by others as | `object.region` | `object.runtime.values.mood` | macros, roles, Value API |

Other extensions depend on those names (Pretty Panels' mood icon, Archivist's faction
members), which is why they're hard-coded. There's also a gap: a non-presence type's runtime
state is only asked for objects held by a prompted object **list**, so Scene Context's single
location never gets its `conditions` updated.

## 2. The model

### 2.1 One object preset per setting per type

Each setting has, for each object type, one **object preset**: a real preset (edited in the
manager, exported and imported like any preset) tagged with `{ objectType, settingId }`. It's
hidden from the chat preset picker and never shown in the tracker: its fields only mean something
on an object. Its
variables are that type's fields in that setting. Every chat on the setting uses it, with
nothing to activate per chat.

A variable's existing `scope` decides what kind of field it is:

| `scope` | Field kind | Value lives | Example |
|---|---|---|---|
| `global` | **baseline**: the same in every chat on the setting | on the object record in the setting | `region`, `goals`, `members` |
| `chat` | **runtime**: per chat, per object | in the chat's object layer | `mood`, `conditions`, `standing` |

Each object keeps a few intrinsic fields outside the preset: `name`, `aliases`, `image`,
`description`, `introduction_snippet`, related ids, variants. Those are identity, not
configuration.

Field types allowed: string, number, boolean, enum, array, image, imageList, imageMap, object,
object list. Calculated and datetime are not allowed (calculated may come later).

### 2.2 Field roles: the contract with other extensions

Each object type declares **field roles**: meanings other code depends on. A field role is a
role (Role API) with an `objectType`. Instead of a chat assigning a variable, a **setting**
assigns one of its object preset's fields.

| Type | Field roles (State Engine's, namespace `se`) |
|---|---|
| character | `character.mood`, `character.mood_icon`, `character.thought`, `character.intent`, `character.faction`, `character.role`, `character.goals`, `character.personality` |
| location | `location.conditions`, `location.region`, `location.parent`, `location.faction_influence` |
| faction | `faction.members`, `faction.standing`, `faction.goals`, `faction.tensions` |
| item | `item.condition`, `item.owner`, `item.location` |
| creature | `creature.state`, `creature.danger_level`, `creature.location` |
| quest | `quest.status`, `quest.objectives` |

- **A new setting** gets a default object preset per type: today's built-in fields, each
  assigned to its role. That's the out-of-the-box behaviour, nothing to configure.
- **You can change anything:** rename `mood` to `emotion` with your own values and the role
  follows it; point `character.mood` at a different field; delete a field (its role is then
  unassigned and readers treat it as absent).
- **Extensions read by role:** `getObjectField(chatId, objectId, 'se__character.mood')`.
  Pretty Panels' mood card, Archivist's faction logic and Curator's object descriptions all
  survive your changes.
- **Extensions can define their own field roles** in their namespace (e.g.
  `archivist__character.loyalty`) and request them (`requestRoles`). The setting's role list
  shows them as unassigned until you map or add a field for them. Extensions never add fields
  to your preset themselves.

### 2.3 Who writes a field

Any field can be **prompted** (the per-message update fills it for objects in play) or not
(the user, Scenario Builder, Archivist and other extensions write it, through the Object API or by
field role). A baseline field is shared by every chat on the setting, so a prompted one has a
mode:

| `prompted.mode` | Behaviour | Default for |
|---|---|---|
| `fill` | asked only while the field is empty, so it captures what the story establishes once and then stays (e.g. a new location's `region`) | baseline fields |
| `update` | asked every turn, like a runtime field | runtime fields |

A baseline write on an unconfirmed (chat-only) object stays in that chat until the object is
confirmed, as with any edit today.

### 2.4 Addressing

- Macros: `{{se__scene_location.conditions}}` gives the conditions of whatever location
  `se__scene_location` holds; `{{se__scene_location.@location.conditions}}` does the same by
  role, so it survives a rename.
- Roles chain into objects: Pretty Panels binds `role:se__scene.location` → `@location.conditions`,
  "the current place's conditions", whatever field that is in this setting.
- Field names are local to the preset (`mood`, not `se__mood`): the preset, owned by its
  setting, is the namespace.

## 3. Storage

```
settings.presets[id] = { ..., namespace: 'se', objectType: 'location', settingId, variables }
setting.objects[type][id][fieldName]                          // baseline (scope: global) values
chat state.objects[type].entries[id].runtime.values[fieldName] // runtime (scope: chat) values
setting.fieldRoles = { [roleId]: fieldName }                  // the setting's role assignments
```

Values stay where they are today, under the same local names. Runtime fields get a
`clearOnLeave` flag, replacing the hard-coded "cleared when a character leaves". It's on by
default for types with presence.

## 4. Prompting

- **Runtime fields** (`scope: chat`, prompted): asked for every object **in play**. For types
  with presence, that's the present ones. Otherwise it's the objects held by any prompted object
  variable in the chunk, **single or list**, which fixes the Scene Context location gap. The
  answer shape is the same flat key per type (`"__locations"`), keyed by name. `newEachTurn`
  replaces `fresh`.
- **Baseline fields** (`scope: global`) can be prompted too (2.3).
- Writes go through the variable checks: clamping, enum matching, off-list answers keep the
  previous value.

## 5. Images and image sets

- Mood icons become an **imageMap** field `mood_icon` with `currentKeyVariable: mood`, assigned
  to `character.mood_icon`. Enum `images` go away.
- **Image set export and import move into State Engine and work for any imageMap**, an object
  field or a regular variable:
  - `exportImageMap(ref)` / `importImageSet(ref, set, { addMissingKeys })`, with images embedded
    on export and uploaded through the Image API on import.
  - The manager's imageMap editor gets Export / Import / Built-in sets.
  - The built-in sets move to State Engine's `assets/image-sets/`.
  - Files Pretty Panels exported (`pretty-panels-image-set`) still import.

## 6. Factions: inferred by Archivist

Faction presence is rarely stated outright. It shows through members acting, a faction's
ground, symbols. So there's **no scene faction list**. Instead:

- **State Engine** holds the faction objects and their fields (members, goals, standing...):
  the shared record.
- **Archivist's world compiler** infers faction involvement from patterns across memories: who
  acts for whom, which places a faction holds, recurring symbols and allegiances. It writes the
  conclusions back through field roles: `faction.members`, `faction.standing`,
  `location.faction_influence`, `character.faction`. Every extension sees one consistent
  answer.
- For this to work, `character.faction` should hold a **faction object** (or objects), not text
  as it does today. The migration converts the text by matching faction names.
- **Default:** `faction.standing` is **not prompted** in the per-message update. Archivist owns
  it, so the two never fight over it. You can switch it to prompted if you don't use Archivist.

## 7. What changes for each extension

| | Change |
|---|---|
| **State Engine** | object presets per setting; field roles (setting-level assignment); storage keyed as today; prompting from object presets including single object variables; `getObjectField` by role; macro/role chaining; imageMap set export/import; manager UI (a setting's object presets and its field-role mapping) |
| **Pretty Panels** | Runtime fields tab removed (links to the manager); the character editor's fields come from the object preset instead of a hard-coded list; card fields and icons bind by field role |
| **Archivist** | reads the location and characters in play through roles; the world compiler gets known locations/factions and writes faction findings back through field roles |
| **Curator** | none: `describeObject` shows a preset's fields by label |

## 8. Migration (once, on startup)

For each setting and type:

1. Build the object preset: the registry's baseline fields (`scope: global`) and the setting's
   runtime fields (`scope: chat`, custom ones included), in that order.
2. Assign each default field to its field role.
3. Turn enum `images` into a `<field>_icon` imageMap assigned to the matching icon role.
4. Values need no moving: baseline values are already on the records, and runtime values are
   already keyed by the same names.
5. Convert `character.faction` text to faction object refs (matching existing factions, or
   creating unconfirmed ones).

Pretty Panels card templates bound to `runtime.mood` are re-pointed to the field role.

## 9. Phases

1. **Engine:** object presets per setting, field roles, migration, the single-object
   prompting fix, `getObjectField`. Tests. **Built 2026-10-13**, with these interim
   choices:
   - Field roles are State Engine's built-in ones only (one per default field). Extension
     field roles (`requestRoles`, the Roles tab) come with phase 2.
   - Enum fields keep their icons as `enumImages` until phase 3 turns them into imageMap
     fields.
   - The runtime-field API (`get/setObjectRuntimeFields`) stays as a view of the chat-scope
     fields. As before, it keeps built-in fields that are left out of a save, so Pretty
     Panels' Runtime fields tab keeps working until phase 4.
   - Pretty Panels shows and edits a character's faction as names.
2. **Addressing:** macros and role chaining into fields; `describeObject`.
3. **Images:** imageMap fields, image set export/import in State Engine, manager buttons.
4. **UI:** manager editing of object presets and field-role mapping; Pretty Panels' character
   editor and cards read the preset and roles; Runtime tab removed.
5. **Archivist:** scene snapshot on memories; known locations/factions given to the world
   compiler; faction findings written back through field roles.

## 10. Decisions on the open questions

- **A. Real presets:** yes, hidden from the chat preset picker and the tracker.
- **B. Prompted baseline fields:** yes, `fill` mode by default (2.3).
- **C. Per-chat overrides:** none. The setting owns the structure, the chat owns the values.
