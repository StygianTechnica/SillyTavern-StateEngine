// State Engine — preset and preset-scoped variable operations

import { LOG_PREFIX, BUILTIN_NAMESPACE, getSettings, persistSettings, debugLog } from './settings-core.js';
import { genId, blankDefinition } from './variable-schema.js';
import { seedVariablesForChat } from './chat-state.js';
import { recalculateAllForChat } from './calculated-engine.js';
import { refreshVariableMacros } from './macro-registration.js';

function getStarterPresetBlueprints() {
    const makeVar = (overrides) => {
        const base = blankDefinition();
        return {
            ...base,
            ...overrides,
        };
    };

    return [
        {
            name: 'Story Progression',
            description: 'Track narrative progression: chapters, story arcs, quests, and major plot points.',
            triggers: ['ai'],
            vars: [
                makeVar({
                    name: 'chapter',
                    label: 'Chapter',
                    type: 'number',
                    defaultValue: 1,
                    min: 1,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Increment when the story clearly moves to the next chapter.' },
                    description: 'Main narrative chapter progression.',
                }),

                makeVar({
                    name: 'arc_phase',
                    label: 'Arc Phase',
                    type: 'enum',
                    enumValues: ['setup', 'rising_action', 'climax', 'aftermath'],
                    defaultValue: 'setup',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Advance when the current arc phase has clearly resolved.' },
                    description: 'Current high-level story arc phase.',
                }),

                makeVar({
                    name: 'quest_active',
                    label: 'Quest Active',
                    type: 'boolean',
                    defaultValue: false,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Set true when a quest begins; set false when it ends.' },
                    description: 'Whether a main quest is currently active.',
                }),

                makeVar({
                    name: 'quest_name',
                    label: 'Quest Name',
                    type: 'string',
                    defaultValue: '',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Update when a new quest begins or the quest name changes.' },
                    description: 'Current quest title.',
                }),
            ],
        },

        {
            name: 'Location and Time',
            description: 'Manage scene settings: current location, time of day, weather, and environment state.',
            triggers: ['user', 'ai'],
            vars: [
                makeVar({
                    name: 'current_location',
                    label: 'Current Location',
                    type: 'string',
                    defaultValue: 'unknown',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Infer location from narrative context.' },
                    description: 'Current scene location.',
                }),

                makeVar({
                    name: 'time_of_day',
                    label: 'Time of Day',
                    type: 'enum',
                    enumValues: ['dawn', 'morning', 'noon', 'afternoon', 'evening', 'night'],
                    defaultValue: 'morning',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Advance when narration implies time has progressed.' },
                    description: 'Narrative time period.',
                }),

                makeVar({
                    name: 'weather',
                    label: 'Weather',
                    type: 'string',
                    defaultValue: 'unknown',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Infer weather from narrative context. Keep concise (1–3 words).' },
                    description: 'Current weather condition.',
                }),

                makeVar({
                    name: 'is_indoor',
                    label: 'Indoor Scene',
                    type: 'boolean',
                    defaultValue: true,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Set true when the scene moves indoors; false when outdoors.' },
                    description: 'Whether current scene is indoors.',
                }),
            ],
        },

        {
            name: 'Relationships',
            description: 'Track character dynamics: trust levels, affection, relationship status, and betrayals.',
            triggers: ['ai'],
            vars: [
                makeVar({
                    name: 'npc_trust',
                    label: 'NPC Trust',
                    type: 'number',
                    defaultValue: 25,
                    min: 0,
                    max: 100,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Estimate trust from recent interactions on a 0–100 scale.' },
                    description: 'General trust level with a focal NPC.',
                }),

                makeVar({
                    name: 'npc_affection',
                    label: 'NPC Affection',
                    type: 'number',
                    defaultValue: 20,
                    min: 0,
                    max: 100,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Estimate affection from recent interactions on a 0–100 scale.' },
                    description: 'General affection level with a focal NPC.',
                }),

                makeVar({
                    name: 'relationship_status',
                    label: 'Relationship Status',
                    type: 'enum',
                    enumValues: ['strangers', 'acquaintances', 'friends', 'allies', 'intimate'],
                    defaultValue: 'strangers',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Advance only when interactions justify relationship progression.' },
                    description: 'Current relationship state.',
                }),

                makeVar({
                    name: 'betrayal_flag',
                    label: 'Betrayal Flag',
                    type: 'boolean',
                    defaultValue: false,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Set true when betrayal occurs; false when resolved.' },
                    description: 'Set true if betrayal has occurred.',
                }),
            ],
        },

        {
            name: 'Combat and Encounter',
            description: 'Manage combat state: active/inactive status, round count, threat level, and encounter tags.',
            triggers: ['user', 'ai'],
            vars: [
                makeVar({
                    name: 'combat_active',
                    label: 'Combat Active',
                    type: 'boolean',
                    defaultValue: false,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Set true when combat begins; false when combat ends.' },
                    description: 'Whether combat is currently active.',
                }),

                makeVar({
                    name: 'rounds_elapsed',
                    label: 'Rounds Elapsed',
                    type: 'number',
                    defaultValue: 0,
                    behaviors: { increment: true, prompted: false },
                    increment: {
                        delta: 1,
                        triggers: ['both'],
                        tick_mode: 'per_message',
                        tick_on: 'both',
                        tick_every: 1,
                    },
                    description: 'Combat rounds elapsed.',
                }),

                makeVar({
                    name: 'threat_level',
                    label: 'Threat Level',
                    type: 'enum',
                    enumValues: ['low', 'medium', 'high', 'critical'],
                    defaultValue: 'low',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Infer threat level from narrative context.' },
                    description: 'Current encounter danger level.',
                }),

                makeVar({
                    name: 'encounter_tags',
                    label: 'Encounter Tags',
                    type: 'array',
                    defaultValue: [],
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Update tags when encounter descriptors change.' },
                    description: 'Array of current encounter tags.',
                }),
            ],
        },

        {
            name: 'Mixed Showcase',
            description: 'Example preset demonstrating all variable types.',
            triggers: ['ai'],
            vars: [
                makeVar({
                    name: 'mood',
                    label: 'Mood',
                    type: 'string',
                    defaultValue: 'neutral',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Infer room mood in one word: calm, tense, hopeful, ominous, etc.' },
                    description: 'Prompted text example.',
                }),

                makeVar({
                    name: 'danger_score',
                    label: 'Danger Score',
                    type: 'number',
                    defaultValue: 10,
                    min: 0,
                    max: 100,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Estimate danger from recent context from 0–100.' },
                    description: 'Prompted number with min/max.',
                }),

                makeVar({
                    name: 'story_flags',
                    label: 'Story Flags',
                    type: 'array',
                    defaultValue: [],
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Update flags when story conditions change.' },
                    description: 'Manual array.',
                }),

                makeVar({
                    name: 'event_stage',
                    label: 'Event Stage',
                    type: 'enum',
                    enumValues: ['seed', 'signal', 'portent', 'manifest'],
                    defaultValue: 'seed',
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Advance when narrative omens intensify.' },
                    description: 'Enum showcase.',
                }),

                makeVar({
                    name: 'heartbeat',
                    label: 'Heartbeat Counter',
                    type: 'number',
                    defaultValue: 0,
                    behaviors: { increment: true, prompted: false },
                    increment: {
                        delta: 1,
                        triggers: ['both'],
                        tick_mode: 'per_message',
                        tick_on: 'both',
                        tick_every: 1,
                    },
                    description: 'Simple per-message counter.',
                }),

                makeVar({
                    name: 'omens_unlocked',
                    label: 'Omens Unlocked',
                    type: 'boolean',
                    defaultValue: false,
                    behaviors: { prompted: true, increment: false },
                    prompted: { instructions: 'Set true when omens are discovered; false when reset.' },
                    description: 'Manual boolean toggle showcase.',
                }),
            ],
        },
    ];
}


function seedExamplePresets(settings, restoreMissing) {
    const blueprints = getStarterPresetBlueprints();
    const existingNames = new Map();
    for (const preset of Object.values(settings.presets || {})) {
        existingNames.set(String(preset.name || '').toLowerCase(), preset);
    }

    const createdPresetIds = [];
    for (const seed of blueprints) {
        const existing = existingNames.get(seed.name.toLowerCase());
        if (existing && !restoreMissing) {
            continue;
        }
        if (existing && restoreMissing) {
            continue;
        }
        const presetId = genId();
        const variables = {};
        // Starter-preset variables are namespaced the same way anything
        // created through src/api/variable-api.js is (see that module's
        // header comment for why the delimiter is "__", not ".") -
        // qualified here, at creation, rather than baked into the
        // blueprint literals above, so the blueprint stays readable as
        // plain local names.
        for (const def of seed.vars) {
            const qualifiedDef = { ...def, name: `${BUILTIN_NAMESPACE}__${def.name}` };
            variables[qualifiedDef.id] = qualifiedDef;
        }
        settings.presets[presetId] = {
            id: presetId,
            namespace: BUILTIN_NAMESPACE,
            name: seed.name,
            description: seed.description || '',
            variables,
            triggers: seed.triggers,
            showInTracker: true,
        };
        createdPresetIds.push(presetId);
    }

    if (!settings.defaultPresetForNewChats) {
        settings.defaultPresetForNewChats = createdPresetIds[0] || '';
    }
    if (createdPresetIds.length > 0 && !settings.trackerPresets?.length) {
        settings.trackerPresets = createdPresetIds.slice(0, 3);
    }
    if (createdPresetIds.length > 0) {
        console.log(`${LOG_PREFIX} seeded ${createdPresetIds.length} starter preset(s)`);
    }
}

export function restoreDefaultPresets() {
    const settings = getSettings();
    const blueprints = getStarterPresetBlueprints();
    // // Ensure all chat bindings are arrays
    // for (const chatId of Object.keys(settings.chatPresetBindings)) {
    //     const list = settings.chatPresetBindings[chatId];
    //     if (!Array.isArray(list)) {
    //         settings.chatPresetBindings[chatId] = [];
    //     }
    // }
    // Delete existing default presets by name so we can restore them
    for (const seed of blueprints) {
        for (const [presetId, preset] of Object.entries(settings.presets)) {
            if (preset.name === seed.name) {
                deletePreset(presetId);
                break;
            }
        }
    }

    // Re-seed the defaults
    seedExamplePresets(settings, false);
    persistSettings();
    console.log(`${LOG_PREFIX} restored default presets`);
}

// ---------------------------------------------------------------------------
// Preset management
// ---------------------------------------------------------------------------

export function createPreset(name) {
    const presetId = genId();
    const preset = {
        id: presetId,
        name: name || 'New Preset',
        description: '',  // User-provided explanation of what this preset does
        variables: {},
        triggers: ['ai'],  // Preset-level: when to update prompted variables in this preset
        showInTracker: false,  // Whether this preset's variables appear in the floating tracker
    };
    const settings = getSettings();
    settings.presets[presetId] = preset;
    persistSettings();
    return presetId;
}

export function renamePreset(presetId, newName) {
    const settings = getSettings();
    if (settings.presets[presetId]) {
        settings.presets[presetId].name = newName;
        persistSettings();
    }
}

export function deletePreset(presetId) {
    const settings = getSettings();
    delete settings.presets[presetId];

    // Remove from all chat bindings
    for (const bindingList of Object.values(settings.chatPresetBindings)) {
        if (!Array.isArray(bindingList)) continue;
        const idx = bindingList.indexOf(presetId);
        if (idx !== -1) bindingList.splice(idx, 1);
    }

    // Clear as default if it was
    if (settings.defaultPresetForNewChats === presetId) {
        settings.defaultPresetForNewChats = '';
    }

    persistSettings();
}

export function getPresetsForChat(chatId) {
    const settings = getSettings();

    // Guard against invalid chatId
    if (!chatId || chatId === 'undefined' || chatId === 'null') {
        return [];
    }

    // Support both old format (array) and new format (object with presetIds array)
    const binding = settings.chatPresetBindings[chatId];

    if (!binding) {
        settings.chatPresetBindings[chatId] = { presetIds: [], presetLoadOrder: [] };
        return [];
    }

    // Legacy format: plain array
    if (Array.isArray(binding)) {
        settings.chatPresetBindings[chatId] = { presetIds: binding, presetLoadOrder: binding };
        persistSettings();
        return binding;
    }

    // New format: object with presetIds and presetLoadOrder
    return binding.presetIds || [];
}

export function getPresetLoadOrder(chatId) {
    // Guard against invalid chatId
    if (!chatId || chatId === 'undefined' || chatId === 'null') {
        return [];
    }

    const settings = getSettings();
    const binding = settings.chatPresetBindings[chatId];

    if (!binding) return [];
    if (Array.isArray(binding)) return binding; // Legacy format
    return binding.presetLoadOrder || binding.presetIds || [];
}

export function setPresetsForChat(chatId, presetIds) {
    const settings = getSettings();
    settings.chatPresetBindings[chatId] = { presetIds, presetLoadOrder: presetIds };
    persistSettings();
}

export function addPresetToChat(chatId, presetId) {
    // Validate chatId to prevent storing under "undefined" or "null"
    if (!chatId || chatId === 'undefined' || chatId === 'null') {
        debugLog(`WARNING: addPresetToChat called with invalid chatId: "${chatId}"`);
        return;
    }

    const settings = getSettings();

    // Ensure binding structure exists
    if (!settings.chatPresetBindings[chatId]) {
        settings.chatPresetBindings[chatId] = { presetIds: [], presetLoadOrder: [] };
    }

    let binding = settings.chatPresetBindings[chatId];

    // Handle legacy array format
    if (Array.isArray(binding)) {
        binding = { presetIds: binding, presetLoadOrder: binding };
        settings.chatPresetBindings[chatId] = binding;
    }

    // Add to presetIds if not already there
    if (!binding.presetIds.includes(presetId)) {
        binding.presetIds.push(presetId);
    }

    // Add to load order if not already there (at the end)
    if (!binding.presetLoadOrder.includes(presetId)) {
        binding.presetLoadOrder.push(presetId);
    }

    persistSettings();
    seedVariablesForChat(chatId);
    recalculateAllForChat(chatId);
    refreshVariableMacros();
    debugLog(`Added preset ${presetId} to chat ${chatId}. Load order:`, binding.presetLoadOrder);
}

export function removePresetFromChat(chatId, presetId) {
    // Validate chatId to prevent issues with "undefined" or "null"
    if (!chatId || chatId === 'undefined' || chatId === 'null') {
        debugLog(`WARNING: removePresetFromChat called with invalid chatId: "${chatId}"`);
        return;
    }

    const settings = getSettings();

    if (!settings.chatPresetBindings[chatId]) return;

    let binding = settings.chatPresetBindings[chatId];

    // Handle legacy array format
    if (Array.isArray(binding)) {
        const idx = binding.indexOf(presetId);
        if (idx !== -1) {
            binding.splice(idx, 1);
            persistSettings();
            debugLog(`Removed preset ${presetId} from chat ${chatId}`);
        }
        return;
    }

    // Remove from both arrays
    binding.presetIds = binding.presetIds.filter(id => id !== presetId);
    binding.presetLoadOrder = binding.presetLoadOrder.filter(id => id !== presetId);

    persistSettings();
    seedVariablesForChat(chatId);
    recalculateAllForChat(chatId);
    refreshVariableMacros();

    debugLog(`Removed preset ${presetId} from chat ${chatId}. Load order:`, binding.presetLoadOrder);
    
}

export function getTrackerPresets() {
    const settings = getSettings();
    if (!settings.trackerPresets || !Array.isArray(settings.trackerPresets)) {
        settings.trackerPresets = [];
    }
    return settings.trackerPresets;
}

export function setTrackerPresets(presetIds) {
    getSettings().trackerPresets = presetIds;
    persistSettings();
}

export function addPresetToTracker(presetId) {
    const trackerPresets = getTrackerPresets();
    if (!trackerPresets.includes(presetId)) {
        trackerPresets.push(presetId);
        setTrackerPresets(trackerPresets);
    }
}

export function removePresetFromTracker(presetId) {
    const trackerPresets = getTrackerPresets();
    const idx = trackerPresets.indexOf(presetId);
    if (idx !== -1) {
        trackerPresets.splice(idx, 1);
        setTrackerPresets(trackerPresets);
    }
}

// Variable identity in a preset is by id (always a unique UUID - genId()/
// generateUUID() already guarantee that, nothing to validate there). But
// the isolated store (chat-state.js) and the macro-store mirror
// (macro-store.js) are both keyed by *name*, not id - state.variables[name]
// and context.variables.local/global both key on def.name. Two variables
// sharing a name, even in two different presets, silently collide in both
// stores: whichever one seeds/writes last overwrites the other's slot,
// which is indistinguishable from a random flip between their two default
// values. Root-caused 2026-09-09 against exactly this symptom (a variable
// named the same as one of the built-in starter presets' variables
// appeared to randomly show the starter preset's default instead of the
// user's own). Checked across every preset, active or not - a currently-
// inactive preset can still be activated later and collide.
export function isVariableNameTaken(name, excludeVarId) {
    const settings = getSettings();
    for (const preset of Object.values(settings.presets || {})) {
        for (const [varId, varDef] of Object.entries(preset.variables || {})) {
            if (varId === excludeVarId) continue;
            if (varDef?.name === name) return true;
        }
    }
    return false;
}

// Appends/increments a numeric suffix ("_2", "_3", ...) until the result is
// not taken anywhere (see isVariableNameTaken). Used to offer an
// auto-rename when a user insists on creating/renaming into a colliding
// name rather than editing it themselves.
export function generateUniqueVariableName(baseName, excludeVarId) {
    if (!isVariableNameTaken(baseName, excludeVarId)) return baseName;
    let n = 2;
    let candidate = `${baseName}_${n}`;
    while (isVariableNameTaken(candidate, excludeVarId)) {
        n++;
        candidate = `${baseName}_${n}`;
    }
    return candidate;
}

export function getAllVariablesFromPresets(presetIds, preserveOrder = true) {
    const settings = getSettings();
    const allVars = {};
    // If preserveOrder is true, iterate in given order to maintain preset load order
    // Variables are collected in order, so first preset's vars come first
    for (const presetId of presetIds) {
        const preset = settings.presets[presetId];
        if (preset && preset.variables) {
            // Only assign if not already present (earlier preset takes precedence)
            for (const [varId, varDef] of Object.entries(preset.variables)) {
                if (!allVars[varId]) {
                    allVars[varId] = varDef;
                }
            }
        }
    }
    return allVars;
}


