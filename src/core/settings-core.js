// State Engine — local, prompt-free state tracking for SillyTavern
//
// Core identity constants, schema migration, debug-mode toggles, and the
// settings object itself.

export const CURRENT_SCHEMA_VERSION = 1;

export const MODULE_NAME = 'state_engine';
export const EXT_TEMPLATE_PATH = 'third-party/SillyTavern-StateEngine';
export const LOG_PREFIX = '[State Engine]';
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

}


function migrateVariableDefinition(def) {
    const v = def.version || 0;

    if (v < CURRENT_SCHEMA_VERSION) {
        // Future migrations go here
        def.version = CURRENT_SCHEMA_VERSION;
    }

    return def;
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
    showTrackerPanel: false,
    trackerPanelPos: { top: 100, left: 100 },
    trackerPanelCollapsed: false,
    trackerShowHidden: false,
    presets: {},
    chatPresetBindings: {},
    defaultPresetForNewChats: '',
    trackerPresets: [],
    wiConditions: {}, // Maps "worldbook.uid" -> array of {variable, operator, value}
    promptedHeader: DEFAULT_PROMPTED_HEADER,
});

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

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
    if (settings.showTrackerPanel === undefined) settings.showTrackerPanel = false;
    if (!settings.trackerPanelPos || typeof settings.trackerPanelPos !== 'object') settings.trackerPanelPos = { top: 100, left: 100 };
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
