// State Engine — local, prompt-free state tracking for SillyTavern
//
// Core identity constants, schema migration, debug-mode toggles, and the
// settings object itself.

export const CURRENT_SCHEMA_VERSION = 1;

export const MODULE_NAME = 'state_engine';
export const EXT_TEMPLATE_PATH = 'third-party/SillyTavern-StateEngine';
export const LOG_PREFIX = '[State Engine]';
// The manager modal's own (non-third-party) presets/variables live under
// this reserved namespace in the API layer (src/api/*, see
// docs/STATE ENGINE API SPECIFICATION.md). Auto-registered and backfilled
// onto existing data by migrateToBuiltinNamespace() below - never something
// the user registers themselves.
export const BUILTIN_NAMESPACE = 'se';
export const DEFAULT_PROMPTED_HEADER = [
            'You are a silent background state‑tracking process for a roleplay chat application.',
            'You are not a character in the roleplay and must not narrate, comment, or add anything besides the requested output.',
            'You will be given a recent conversation excerpt and a list of state variables with conditions.',
            'Evaluate each variable according to its conditions and return the required JSON output.',
            ''
        ].join('\n');

export const DEFAULT_UNIFIED_VARIABLE_RULES = [
            '',
            'Output rules:',
            '- Reply with ONLY a single raw JSON object. No markdown code fences, no explanation, no extra text.',
            '- The object must contain exactly one key per listed variable.',
            '- For update variables: return the new value. If no change is needed, repeat the current value unchanged.',
            '- For boolean-condition variables: return true if the condition is met, otherwise false.',
            '- The JSON object MUST contain one key for every update variable AND every boolean-condition variable.'
        ].join('\n');

// Debug mode - session-only, not persisted
window.seDebugMode = false;

export function migrateAllSettings(settings) {
    if (!settings) return;
    for (const preset of Object.values(settings.presets || {})) {
        const vars = preset.variables || {};
        for (const def of Object.values(vars)) {
            migrateVariableDefinition(def);
        }
    }

    // Sanitize chatPresetBindings
    if (!settings.chatPresetBindings || typeof settings.chatPresetBindings !== 'object') {
        settings.chatPresetBindings = {};
    } else {
        for (const chatId of Object.keys(settings.chatPresetBindings)) {
            const binding = settings.chatPresetBindings[chatId];

            // If binding is null or not an object, reset it
            if (!binding || typeof binding !== 'object') {
                settings.chatPresetBindings[chatId] = {};
            }

            // Otherwise leave it EXACTLY as-is
        }
    }

    migrateToBuiltinNamespace(settings);
}


function migrateVariableDefinition(def) {
    const v = def.version || 0;

    if (v < CURRENT_SCHEMA_VERSION) {
        // Future migrations go here
        def.version = CURRENT_SCHEMA_VERSION;
    }

    return def;
}

// One-time historical migration (2026-09-10): stamps every pre-existing
// preset with the reserved BUILTIN_NAMESPACE and renames every one of its
// variables from a bare name ("mood") to the namespace-qualified name the
// API layer requires ("se__mood", delimiter "__" not "." - see
// src/api/variable-api.js's header comment: a dot breaks the calculated-
// variable expression DSL's tokenizer, which treats "." as property-access
// syntax) - src/api/variable-api.js stores every API-created variable this
// way already (see that module's header comment for why qualifying the
// real def.name, not just API-layer metadata, is what actually prevents a
// cross-namespace collision). This makes the manager modal's own content
// consistent with that scheme going forward, via
// src/ui/manager-modal/manager-api.js and src/core/preset-manager.js's
// restoreDefaultPresets(), both updated alongside this migration.
//
// Runs at most once, ever, per settings blob - gated on settings.extensions
// already having a BUILTIN_NAMESPACE entry, exactly like every other
// migration step in this function only ever needing to run forward. Never
// re-touches a preset that already has a `namespace` (created through the
// API layer, or already migrated).
//
// KNOWN, IRREVERSIBLE CONSEQUENCE (reported, not silently absorbed): any
// character card, World Info entry, or Author's Note that references one
// of these variables' OLD bare {{name}} macro will stop resolving after
// this runs - SillyTavern content outside this extension's own settings
// (chat metadata, character data) is never touched or scanned here (spec
// 1.3), so there is no way to migrate those references automatically. The
// full old-name -> new-name map is logged so they can be found and updated
// by hand.
function migrateToBuiltinNamespace(settings) {
    if (settings.extensions?.[BUILTIN_NAMESPACE]) return;

    if (!settings.extensions || typeof settings.extensions !== 'object') settings.extensions = {};
    settings.extensions[BUILTIN_NAMESPACE] = {
        id: BUILTIN_NAMESPACE,
        namespace: BUILTIN_NAMESPACE,
        name: 'State Engine (built-in)',
        registeredAt: Date.now(),
    };

    const renameMap = new Map(); // old bare name -> new qualified name
    const prefix = `${BUILTIN_NAMESPACE}__`;

    for (const preset of Object.values(settings.presets || {})) {
        if (preset.namespace) continue; // already namespaced - never re-touch
        preset.namespace = BUILTIN_NAMESPACE;
        for (const def of Object.values(preset.variables || {})) {
            if (!def?.name || def.name.startsWith(prefix)) continue;
            const oldName = def.name;
            const newName = `${prefix}${oldName}`;
            def.name = newName;
            renameMap.set(oldName, newName);
        }
    }

    if (renameMap.size === 0) return;

    // Calculated variables reference sibling variables by name in BOTH
    // def.dependencies (exact name strings) and def.expression (a Tiny
    // Expression DSL string using those same names as identifiers) -
    // renaming a variable's own def.name above does nothing to fix a
    // SIBLING calculated variable's references to that old name, so those
    // are rewritten here too. Runs over every preset, not just ones just
    // renamed above - an already-namespaced preset's expressions can never
    // contain one of these old bare names to begin with, so this is a
    // harmless no-op there.
    //
    // Word-boundary-safe (\b, matching this DSL's [A-Za-z0-9_] identifier
    // character class exactly), not a raw substring replace - renaming
    // "hp" must never also touch "hp_max". The one known remaining edge
    // case: an old variable name that also happens to appear, by
    // coincidence, inside a string literal within the expression -
    // expression-dsl.js's tokenizer/parser aren't exported for a proper
    // token-level rewrite, and this is a one-time best-effort migration
    // over the user's own data, not a live code path.
    for (const preset of Object.values(settings.presets || {})) {
        for (const def of Object.values(preset.variables || {})) {
            if (def?.type !== 'calculated') continue;
            if (Array.isArray(def.dependencies)) {
                def.dependencies = def.dependencies.map((depName) => renameMap.get(depName) ?? depName);
            }
            if (typeof def.expression === 'string' && def.expression) {
                for (const [oldName, newName] of renameMap) {
                    def.expression = def.expression.replace(
                        new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
                        newName,
                    );
                }
            }
        }
    }

    // Isolated store: move each chat's per-variable entry to its new key.
    // entry.def is frequently the SAME object reference as the preset-side
    // def already renamed above (preset-manager.js's
    // getAllVariablesFromPresets never clones) - forcing entry.def.name to
    // the new value here is a no-op in that case and a real fix for a
    // stale/divergent snapshot otherwise, so it's applied unconditionally
    // rather than gated on an equality check against the (possibly
    // already-mutated) old name.
    const chats = settings.variableStore?.chats || {};
    for (const state of Object.values(chats)) {
        if (!state?.variables) continue;
        for (const [oldName, newName] of renameMap) {
            if (!Object.prototype.hasOwnProperty.call(state.variables, oldName)) continue;
            const entry = state.variables[oldName];
            if (entry?.def) entry.def.name = newName;
            state.variables[newName] = entry;
            delete state.variables[oldName];
        }
    }

    // World Info conditions reference variable names too
    // ("worldbook.uid" -> [{variable, operator, value}]) - kept in sync even
    // though WI conditional filtering is currently inert (the
    // WORLD_INFO_ACTIVATED hook is commented out in event-engine.js), so
    // this stored data doesn't silently rot into referencing names that no
    // longer exist.
    for (const conditions of Object.values(settings.wiConditions || {})) {
        if (!Array.isArray(conditions)) continue;
        for (const cond of conditions) {
            if (cond && renameMap.has(cond.variable)) cond.variable = renameMap.get(cond.variable);
        }
    }

    console.warn(
        LOG_PREFIX,
        `One-time migration: ${renameMap.size} variable(s) renamed into the "${BUILTIN_NAMESPACE}" namespace. `
        + `Update any character card / World Info entry / Author's Note that references the OLD {{name}} macro to the new {{${BUILTIN_NAMESPACE}__name}} form:`,
        Object.fromEntries(renameMap),
    );
}

export function toggleDebugMode() {
    window.seDebugMode = !window.seDebugMode;
    console.log(`${LOG_PREFIX} Debug mode ${window.seDebugMode ? 'ENABLED' : 'DISABLED'}`);
    return window.seDebugMode;
}

export function debugLog(...args) {
    if (window.seDebugMode) {
        console.log(LOG_PREFIX, ...args);
    }
}

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    wandVisible: true,
    contextMessageCount: 10,
    responseLength: 300,
    connectionProfileId: '',
    stateEngineProfileId: null,
    stateEngineTemperature: null,
    stateEngineMaxTokens: null,
    // Hard cap on chat messages sent to the prompted-update LLM call. null
    // means "not yet computed" - getSettings() backfills it from SillyTavern's
    // configured context size (see computeDefaultMaxPromptHistoryMessages).
    maxPromptHistoryMessages: null,
    // Optional per-message character trim applied only to the prompt copy of
    // each message, never to the stored chat. null means no trimming.
    maxMessageLength: null,
    showTrackerPanel: false,
    trackerPanelPos: { top: 100, left: 100 },
    // null width/height means "use the CSS default" - only set once the
    // user actually drags the resize handle (2026-09-09).
    trackerPanelSize: { width: null, height: null },
    trackerPanelCollapsed: false,
    trackerShowHidden: false,
    presets: {},
    chatPresetBindings: {},
    defaultPresetForNewChats: '',
    trackerPresets: [],
    wiConditions: {}, // Maps "worldbook.uid" -> array of {variable, operator, value}
    promptedHeader: DEFAULT_PROMPTED_HEADER,
    chatVariables: {},
    // Isolated State Engine data store (src/core/chat-state.js). Never
    // read from or written to SillyTavern chat metadata - this is its own
    // key inside the extension's own settings blob.
    variableStore: { chats: {} },
    // API layer (src/api/*) - registered extensions/namespaces and
    // namespaced event-source declarations. Empty/unused until something
    // actually calls registerExtension()/registerEventSource().
    extensions: {},
    eventSources: {},
});

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

// context.maxContext is SillyTavern's own configured context size, in tokens
// (public/scripts/st-context.js: `maxContext: Number(max_context)`). There is
// no API for "tokens per message", so this converts it to a message count
// with a rough ~100-tokens/message heuristic, clamped to a sane range so a
// tiny or huge context size still yields a usable default.
export function computeDefaultMaxPromptHistoryMessages(context) {
    const maxContext = Number(context?.maxContext);
    if (!Number.isFinite(maxContext) || maxContext <= 0) return 50;
    return Math.max(20, Math.min(100, Math.round(maxContext / 100)));
}

export function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredCloneSafe(DEFAULT_SETTINGS);
    }
    const settings = context.extensionSettings[MODULE_NAME];
    if (settings.enabled === undefined) settings.enabled = true;
    if (settings.contextMessageCount === undefined) settings.contextMessageCount = 10;
    if (settings.responseLength === undefined) settings.responseLength = 300;
    if (settings.connectionProfileId === undefined) settings.connectionProfileId = '';
    if (settings.stateEngineProfileId === undefined) settings.stateEngineProfileId = null;
    if (settings.stateEngineTemperature === undefined) settings.stateEngineTemperature = null;
    if (settings.stateEngineMaxTokens === undefined) settings.stateEngineMaxTokens = null;
    if (settings.maxPromptHistoryMessages === undefined || settings.maxPromptHistoryMessages === null) {
        settings.maxPromptHistoryMessages = computeDefaultMaxPromptHistoryMessages(context);
    }
    if (settings.maxMessageLength === undefined) settings.maxMessageLength = null;
    if (!settings.variableStore || typeof settings.variableStore !== 'object') settings.variableStore = { chats: {} };
    if (!settings.variableStore.chats || typeof settings.variableStore.chats !== 'object') settings.variableStore.chats = {};
    if (settings.showTrackerPanel === undefined) settings.showTrackerPanel = false;
    if (!settings.trackerPanelPos || typeof settings.trackerPanelPos !== 'object') settings.trackerPanelPos = { top: 100, left: 100 };
    if (!settings.trackerPanelSize || typeof settings.trackerPanelSize !== 'object') settings.trackerPanelSize = { width: null, height: null };
    if (settings.trackerPanelCollapsed === undefined) settings.trackerPanelCollapsed = false;
    if (settings.trackerShowHidden === undefined) settings.trackerShowHidden = false;


    if (!settings.presets || typeof settings.presets !== 'object') settings.presets = {};
    if (!settings.chatPresetBindings || typeof settings.chatPresetBindings !== 'object') settings.chatPresetBindings = {};

    // Clean up any "undefined", "null", or other invalid chat ID keys
    const validKeys = Object.keys(settings.chatPresetBindings).filter(key => key && key !== 'undefined' && key !== 'null');
    if (validKeys.length !== Object.keys(settings.chatPresetBindings).length) {
        const cleaned = {};
        for (const key of validKeys) {
            cleaned[key] = settings.chatPresetBindings[key];
        }
        settings.chatPresetBindings = cleaned;
        debugLog('Cleaned up invalid chat ID keys from bindings');
    }

    if (!settings.defaultPresetForNewChats) settings.defaultPresetForNewChats = '';
    if (!settings.wiConditions || typeof settings.wiConditions !== 'object') settings.wiConditions = {};
    if (!settings.extensions || typeof settings.extensions !== 'object') settings.extensions = {};
    if (!settings.eventSources || typeof settings.eventSources !== 'object') settings.eventSources = {};


    return settings;
}

export function persistSettings() {
    try {
        SillyTavern.getContext().saveSettingsDebounced();
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to save settings', err);
    }
}

export function structuredCloneSafe(obj) {
    if (typeof structuredClone === 'function') return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
}
