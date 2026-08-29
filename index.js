// State Engine — local, prompt-free state tracking for SillyTavern
//
// Keeps user-defined "state variables" locally (per chat or global), exposes
// them to World Info / prompts / character cards via the built-in {{getvar::name}}
// macro family, and can update them automatically:
//   - "manual"   variables: you (or a slash command) set them directly.
//   - "counter"  variables: increment/decrement by a fixed step on a trigger.
//   - "prompted" variables: a quiet, invisible background generation asks the
//                 AI to derive/update the value from recent chat context.
//
// Nothing this extension does is added to the visible chat log or the
// permanent context — prompted updates run as an isolated background
// generation, and the results are written straight into SillyTavern's
// native chat/global variable store.

const MODULE_NAME = 'state_engine';
const EXT_TEMPLATE_PATH = 'third-party/SillyTavern-StateEngine';
const LOG_PREFIX = '[State Engine]';

// Session state (not persisted)
let currentPresetId = null;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
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
});

// All the moments a "prompted" variable can be told to re-evaluate at —
// deliberately mirrors SillyTavern's Quick Reply automation trigger points.
const PROMPTED_TRIGGER_KEYS = ['startup', 'new_chat', 'chat_change', 'user', 'pre_generation', 'ai', 'group_draft'];

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function getSettings() {
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
    
    // Migrate old flat variables to presets
    migrateToPresets(settings);
    
    if (!settings.presets || typeof settings.presets !== 'object') settings.presets = {};
    if (!settings.chatPresetBindings || typeof settings.chatPresetBindings !== 'object') settings.chatPresetBindings = {};
    if (!settings.defaultPresetForNewChats) settings.defaultPresetForNewChats = '';
    
    // Normalize all presets and their variables
    for (const preset of Object.values(settings.presets)) {
        if (!preset.variables || typeof preset.variables !== 'object') preset.variables = {};
        for (const def of Object.values(preset.variables)) {
            normalizeDefinition(def);
        }
    }
    
    return settings;
}

function migrateToPresets(settings) {
    // If using old flat variables format and no presets yet, create default preset
    if (settings.variables && Object.keys(settings.variables).length > 0 && Object.keys(settings.presets || {}).length === 0) {
        const defaultPresetId = genId();
        const defaultPreset = {
            id: defaultPresetId,
            name: 'Default',
            variables: settings.variables,
            triggers: ['ai'],  // Default trigger for prompted variables
            showInTracker: false,  // Default tracker visibility
        };
        settings.presets = { [defaultPresetId]: defaultPreset };
        settings.defaultPresetForNewChats = defaultPresetId;
        settings.chatPresetBindings = {}; // Will be populated on chat switch
        delete settings.variables; // Remove old flat structure
        console.log(LOG_PREFIX, 'migrated old variables to default preset');
    }
    
    // Normalize existing presets
    for (const preset of Object.values(settings.presets || {})) {
        if (!Array.isArray(preset.triggers)) preset.triggers = ['ai'];
        if (preset.showInTracker === undefined) preset.showInTracker = false;
    }
}

// Fills in fields that may be missing from a definition created by an
// earlier version of this extension, and normalizes shapes (e.g. the old
// single `prompted.trigger` string became `prompted.triggers`, an array).
function normalizeDefinition(def) {
    if (!def.counter || typeof def.counter !== 'object') {
        def.counter = { trigger: 'ai', direction: 'increment', step: 1 };
    }
    if (!def.prompted || typeof def.prompted !== 'object') {
        def.prompted = { triggers: ['ai'], instructions: '' };
    }
    if (!Array.isArray(def.prompted.triggers)) {
        const legacy = def.prompted.trigger;
        if (legacy === 'both') def.prompted.triggers = ['ai', 'user'];
        else if (legacy === 'manual' || !legacy) def.prompted.triggers = legacy === 'manual' ? [] : ['ai'];
        else def.prompted.triggers = [legacy];
    }
    def.prompted.triggers = def.prompted.triggers.filter((t) => PROMPTED_TRIGGER_KEYS.includes(t));
    delete def.prompted.trigger;
    if (def.showInTracker === undefined) def.showInTracker = true;
    if (!Array.isArray(def.enumValues)) def.enumValues = [];
    return def;
}

function persistSettings() {
    try {
        SillyTavern.getContext().saveSettingsDebounced();
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to save settings', err);
    }
}

// ---------------------------------------------------------------------------
// Preset management
// ---------------------------------------------------------------------------

function createPreset(name) {
    const presetId = genId();
    const preset = {
        id: presetId,
        name: name || 'New Preset',
        variables: {},
        triggers: ['ai'],  // Preset-level: when to update prompted variables in this preset
        showInTracker: false,  // Whether this preset's variables appear in the floating tracker
    };
    const settings = getSettings();
    settings.presets[presetId] = preset;
    persistSettings();
    return presetId;
}

function renamePreset(presetId, newName) {
    const settings = getSettings();
    if (settings.presets[presetId]) {
        settings.presets[presetId].name = newName;
        persistSettings();
    }
}

function deletePreset(presetId) {
    const settings = getSettings();
    delete settings.presets[presetId];
    
    // Remove from all chat bindings
    for (const bindingList of Object.values(settings.chatPresetBindings)) {
        const idx = bindingList.indexOf(presetId);
        if (idx !== -1) bindingList.splice(idx, 1);
    }
    
    // Clear as default if it was
    if (settings.defaultPresetForNewChats === presetId) {
        settings.defaultPresetForNewChats = '';
    }
    
    persistSettings();
}

function getPresetsForChat(chatId) {
    const settings = getSettings();
    if (!settings.chatPresetBindings[chatId]) {
        settings.chatPresetBindings[chatId] = [];
    }
    return settings.chatPresetBindings[chatId];
}

function setPresetsForChat(chatId, presetIds) {
    const settings = getSettings();
    settings.chatPresetBindings[chatId] = presetIds;
    persistSettings();
}

function addPresetToChat(chatId, presetId) {
    const bindings = getPresetsForChat(chatId);
    if (!bindings.includes(presetId)) {
        bindings.push(presetId);
        setPresetsForChat(chatId, bindings);
    }
}

function removePresetFromChat(chatId, presetId) {
    const bindings = getPresetsForChat(chatId);
    const idx = bindings.indexOf(presetId);
    if (idx !== -1) {
        bindings.splice(idx, 1);
        setPresetsForChat(chatId, bindings);
    }
}

function getTrackerPresets() {
    const settings = getSettings();
    if (!settings.trackerPresets || !Array.isArray(settings.trackerPresets)) {
        settings.trackerPresets = [];
    }
    return settings.trackerPresets;
}

function setTrackerPresets(presetIds) {
    getSettings().trackerPresets = presetIds;
    persistSettings();
}

function addPresetToTracker(presetId) {
    const trackerPresets = getTrackerPresets();
    if (!trackerPresets.includes(presetId)) {
        trackerPresets.push(presetId);
        setTrackerPresets(trackerPresets);
    }
}

function removePresetFromTracker(presetId) {
    const trackerPresets = getTrackerPresets();
    const idx = trackerPresets.indexOf(presetId);
    if (idx !== -1) {
        trackerPresets.splice(idx, 1);
        setTrackerPresets(trackerPresets);
    }
}

function getAllVariablesFromPresets(presetIds) {
    const settings = getSettings();
    const allVars = {};
    for (const presetId of presetIds) {
        const preset = settings.presets[presetId];
        if (preset && preset.variables) {
            Object.assign(allVars, preset.variables);
        }
    }
    return allVars;
}

function structuredCloneSafe(obj) {
    if (typeof structuredClone === 'function') return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
}

function genId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `se-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Variable definition helpers
// ---------------------------------------------------------------------------

function blankDefinition() {
    return {
        id: genId(),
        name: '',
        label: '',
        category: 'manual', // manual | counter | prompted
        scope: 'chat', // chat | global
        type: 'number', // number | string | boolean | enum
        enumValues: [],
        default: '0',
        min: '',
        max: '',
        description: '',
        resetOnNewChat: false,
        showInTracker: true,
        counter: { trigger: 'ai', direction: 'increment', step: 1 },
        prompted: { triggers: ['ai'], instructions: '' },
    };
}

function getDefaultValue(def) {
    switch (def.type) {
        case 'number': {
            const n = Number(def.default);
            return Number.isFinite(n) ? n : 0;
        }
        case 'boolean':
            return String(def.default).trim().toLowerCase() === 'true';
        case 'enum':
            return def.enumValues.includes(def.default) ? def.default : (def.enumValues[0] ?? '');
        case 'array':
            if (Array.isArray(def.default)) return [...def.default];
            if (typeof def.default === 'string' && def.default.trim()) {
                try { return JSON.parse(def.default); }
                catch { return []; }
            }
            return [];
        default:
            return def.default ?? '';
    }
}

function clampNumber(def, n) {
    let result = n;
    if (def.min !== '' && def.min !== null && def.min !== undefined && !Number.isNaN(Number(def.min))) {
        result = Math.max(result, Number(def.min));
    }
    if (def.max !== '' && def.max !== null && def.max !== undefined && !Number.isNaN(Number(def.max))) {
        result = Math.min(result, Number(def.max));
    }
    return result;
}

// Validate a value against type constraints; return {valid: boolean, value: coerced, error?: string}
function validateValueStrict(def, raw) {
    if (raw === undefined || raw === null) {
        return { valid: true, value: getDefaultValue(def) };
    }

    const errors = [];
    let coerced = raw;

    try {
        switch (def.type) {
            case 'number': {
                if (typeof raw === 'number') {
                    coerced = raw;
                } else if (typeof raw === 'string' && raw.trim() !== '') {
                    coerced = Number(raw.trim());
                    if (Number.isNaN(coerced)) {
                        errors.push(`Cannot convert "${raw}" to number`);
                        coerced = getDefaultValue(def);
                        break;
                    }
                } else {
                    errors.push(`Expected number, got ${typeof raw}`);
                    coerced = getDefaultValue(def);
                    break;
                }
                
                if (!Number.isFinite(coerced)) {
                    errors.push(`Not a valid number (got ${raw})`);
                    coerced = getDefaultValue(def);
                } else {
                    coerced = clampNumber(def, coerced);
                }
                break;
            }

            case 'boolean': {
                if (typeof raw === 'boolean') {
                    coerced = raw;
                } else if (typeof raw === 'number') {
                    coerced = raw !== 0;
                } else if (typeof raw === 'string') {
                    const s = raw.trim().toLowerCase();
                    if (['true', 'yes', '1', 'on'].includes(s)) {
                        coerced = true;
                    } else if (['false', 'no', '0', 'off'].includes(s)) {
                        coerced = false;
                    } else {
                        errors.push(`"${raw}" is not a valid boolean`);
                        coerced = getDefaultValue(def);
                    }
                } else {
                    errors.push(`Expected boolean, got ${typeof raw}`);
                    coerced = getDefaultValue(def);
                }
                break;
            }

            case 'enum': {
                const s = String(raw);
                if (!def.enumValues.includes(s)) {
                    errors.push(`"${s}" not in allowed values: [${def.enumValues.join(', ')}]`);
                    coerced = getDefaultValue(def);
                } else {
                    coerced = s;
                }
                break;
            }

            case 'array': {
                if (Array.isArray(raw)) {
                    coerced = raw;
                } else if (typeof raw === 'string') {
                    try {
                        const parsed = JSON.parse(raw);
                        if (Array.isArray(parsed)) {
                            coerced = parsed;
                        } else {
                            errors.push(`Parsed JSON is not an array`);
                            coerced = getDefaultValue(def);
                        }
                    } catch (e) {
                        errors.push(`Invalid JSON for array: ${e.message}`);
                        coerced = getDefaultValue(def);
                    }
                } else {
                    errors.push(`Expected array, got ${typeof raw}`);
                    coerced = getDefaultValue(def);
                }
                break;
            }

            default: {
                // String type: accept anything, stringify it
                coerced = String(raw);
            }
        }
    } catch (err) {
        errors.push(`Validation error: ${err.message}`);
        coerced = getDefaultValue(def);
    }

    return {
        valid: errors.length === 0,
        value: coerced,
        error: errors.length > 0 ? errors.join('; ') : undefined,
    };
}

function coerceValue(def, raw) {
    if (raw === undefined || raw === null) return getDefaultValue(def);
    switch (def.type) {
        case 'number': {
            let n = typeof raw === 'number' ? raw : Number(raw);
            if (!Number.isFinite(n)) n = getDefaultValue(def);
            return clampNumber(def, n);
        }
        case 'boolean': {
            if (typeof raw === 'boolean') return raw;
            const s = String(raw).trim().toLowerCase();
            return ['true', 'yes', '1', 'on'].includes(s);
        }
        case 'enum': {
            const s = String(raw);
            return def.enumValues.includes(s) ? s : getDefaultValue(def);
        }
        case 'array': {
            if (Array.isArray(raw)) return raw;
            if (typeof raw === 'string') {
                try { return JSON.parse(raw); }
                catch { return getDefaultValue(def); }
            }
            return getDefaultValue(def);
        }
        default:
            return String(raw);
    }
}

function varStore(context, def) {
    return def.scope === 'global' ? context.variables.global : context.variables.local;
}

function getVarValue(context, def) {
    const store = varStore(context, def);
    try {
        if (store.has(def.name)) {
            return store.get(def.name);
        }
    } catch (err) {
        console.warn(LOG_PREFIX, `could not read variable "${def.name}"`, err);
    }
    return getDefaultValue(def);
}

function setVarValue(context, def, rawValue) {
    const store = varStore(context, def);
    const validation = validateValueStrict(def, rawValue);
    
    if (!validation.valid && validation.error) {
        console.warn(LOG_PREFIX, `Type validation for "${def.name}": ${validation.error}`);
    }
    
    try {
        store.set(def.name, validation.value);
    } catch (err) {
        console.error(LOG_PREFIX, `could not write variable "${def.name}"`, err);
    }
    return validation.value;
}

// ---------------------------------------------------------------------------
// Initialization / reset
// ---------------------------------------------------------------------------

function applyDefaultsForMissing() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    
    // If no presets bound to this chat, use default
    if (activePresetIds.length === 0 && getSettings().defaultPresetForNewChats) {
        activePresetIds.push(getSettings().defaultPresetForNewChats);
    }
    
    const variables = getAllVariablesFromPresets(activePresetIds);
    for (const def of Object.values(variables)) {
        if (!def.name) continue;
        const store = varStore(context, def);
        let exists = false;
        try {
            exists = store.has(def.name);
        } catch {
            exists = false;
        }
        if (!exists) {
            setVarValue(context, def, getDefaultValue(def));
        }
    }
}

function applyResetOnNewChat() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    const variables = getAllVariablesFromPresets(activePresetIds);
    
    for (const def of Object.values(variables)) {
        if (!def.name || !def.resetOnNewChat) continue;
        setVarValue(context, def, getDefaultValue(def));
    }
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

function runCounters(triggerType) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;

    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    const variables = getAllVariablesFromPresets(activePresetIds);

    let changed = false;
    for (const def of Object.values(variables)) {
        if (def.category !== 'counter' || !def.name) continue;
        const trigger = def.counter?.trigger || 'ai';
        if (trigger !== 'both' && trigger !== triggerType) continue;

        const current = Number(getVarValue(context, def)) || 0;
        const step = Number(def.counter?.step ?? 1) || 0;
        const direction = def.counter?.direction === 'decrement' ? -1 : 1;
        const next = clampNumber(def, current + direction * step);
        setVarValue(context, def, next);
        changed = true;
    }
    if (changed) refreshPanelIfOpen();
}

// ---------------------------------------------------------------------------
// Prompted (AI-derived) updates
// ---------------------------------------------------------------------------

function stripHtml(str) {
    return String(str ?? '').replace(/<[^>]*>/g, '').trim();
}

function extractJsonObject(text) {
    if (!text) return null;
    let s = String(text).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) return null;
    const candidate = s.slice(first, last + 1);
    try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        return null;
    } catch {
        return null;
    }
}

function describeConstraint(def) {
    if (def.type === 'number') {
        const parts = [];
        if (def.min !== '' && def.min !== null && def.min !== undefined) parts.push(`min ${def.min}`);
        if (def.max !== '' && def.max !== null && def.max !== undefined) parts.push(`max ${def.max}`);
        return `number${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    if (def.type === 'boolean') return 'true or false';
    if (def.type === 'enum') return `one of: ${def.enumValues.join(', ')}`;
    return 'text';
}

async function callBackgroundLLM(context, settings, messages, maxTokens) {
    const profileId = settings.connectionProfileId;
    if (profileId) {
        const svc = context.ConnectionManagerRequestService;
        if (svc && typeof svc.sendRequest === 'function') {
            try {
                const result = await svc.sendRequest(profileId, messages, maxTokens, { extractData: true, stream: false });
                const text = extractTextFromServiceResult(result);
                if (text) return text;
                console.warn(LOG_PREFIX, 'connection profile request returned no usable text, falling back to the active connection', result);
            } catch (err) {
                console.warn(LOG_PREFIX, 'connection profile request failed, falling back to the active connection', err);
            }
        } else {
            console.warn(LOG_PREFIX, 'ConnectionManagerRequestService.sendRequest unavailable, falling back to the active connection');
        }
    }
    return await context.generateRaw({ prompt: messages, responseLength: maxTokens });
}

function extractTextFromServiceResult(result) {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object') {
        if (typeof result.content === 'string') return result.content;
        if (typeof result.text === 'string') return result.text;
        if (Array.isArray(result.choices) && result.choices[0]) {
            const choice = result.choices[0];
            if (typeof choice.message?.content === 'string') return choice.message.content;
            if (typeof choice.text === 'string') return choice.text;
        }
    }
    return '';
}

async function runPromptedUpdates(triggerType) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;

    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    
    // Filter presets that have this trigger enabled
    let presetsToUpdate = [];
    if (triggerType === 'manual-all') {
        presetsToUpdate = activePresetIds;
    } else {
        presetsToUpdate = activePresetIds.filter(presetId => {
            const preset = settings.presets[presetId];
            return preset && Array.isArray(preset.triggers) && preset.triggers.includes(triggerType);
        });
    }
    
    // Collect all prompted variables from presets that should update
    const variables = getAllVariablesFromPresets(presetsToUpdate);
    const defs = Object.values(variables).filter((def) => def.category === 'prompted' && def.name);

    if (defs.length === 0) return;
    if (!Array.isArray(context.chat)) return;

    setStatus('Updating state…');

    try {
        const count = Math.max(1, Number(settings.contextMessageCount) || 10);
        const recent = context.chat.slice(-count);
        const transcript = recent
            .map((m) => {
                const speaker = m.is_user ? (context.name1 || 'User') : (m.name || context.name2 || 'Character');
                return `${speaker}: ${stripHtml(m.mes)}`;
            })
            .filter((line) => line.trim().length > 0)
            .join('\n');

        const varLines = defs
            .map((def) => {
                const current = getVarValue(context, def);
                const instructions = (def.prompted?.instructions || def.description || '').trim();
                return `- "${def.name}" [${describeConstraint(def)}] currently ${JSON.stringify(current)}.${instructions ? ` ${instructions}` : ''}`;
            })
            .join('\n');

        const systemPrompt = [
            'You are a silent background state-tracking process for a roleplay chat application.',
            'You are not a character in the roleplay and must not narrate, comment, or add anything besides the requested output.',
            'You will be given a short excerpt of recent conversation and a list of tracked state variables.',
            'Decide the updated value for each variable based on the conversation and the per-variable instructions.',
            '',
            'Output rules:',
            '- Reply with ONLY a single raw JSON object. No markdown code fences, no explanation, no extra text.',
            '- The object must have exactly one key per listed variable, using the exact variable name given.',
            '- If a variable should not change, repeat its current value unchanged.',
            '- Respect each variable\'s type and constraints exactly.',
            '',
            'Tracked variables:',
            varLines,
        ].join('\n');

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'system', content: transcript ? `Recent conversation:\n${transcript}` : 'No conversation yet.' },
            { role: 'user', content: 'Output the updated JSON object now. JSON only, no other text.' },
        ];

        const raw = await callBackgroundLLM(context, settings, messages, Number(settings.responseLength) || 300);

        const parsed = extractJsonObject(raw);
        if (!parsed) {
            console.warn(LOG_PREFIX, 'could not parse a JSON object from the model response:', raw);
            setStatus('Update failed — response was not valid JSON. See console.', true);
            return;
        }

        let updatedCount = 0;
        for (const def of defs) {
            if (Object.prototype.hasOwnProperty.call(parsed, def.name)) {
                setVarValue(context, def, parsed[def.name]);
                updatedCount++;
            }
        }
        setStatus(`State updated (${updatedCount}/${defs.length} variables).`);
    } catch (err) {
        console.error(LOG_PREFIX, 'prompted update failed', err);
        setStatus('Update failed — see browser console for details.', true);
    } finally {
        refreshPanelIfOpen();
    }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

let startupRan = false;

function runStartupOnce() {
    if (startupRan) return;
    startupRan = true;
    runPromptedUpdates('startup');
}

function registerEvents() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    // Covers the case where this extension finishes loading only after
    // APP_READY has already fired; runStartupOnce() guards against firing twice.
    eventSource.on(eventTypes.APP_READY, runStartupOnce);

    eventSource.on(eventTypes.CHAT_CREATED, () => {
        applyResetOnNewChat();
        applyDefaultsForMissing();
        runPromptedUpdates('new_chat');
        refreshPanelIfOpen();
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        applyDefaultsForMissing();
        runPromptedUpdates('chat_change');
        refreshPanelIfOpen();
    });

    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, () => {
        runCounters('user');
        runPromptedUpdates('user');
    });

    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => {
        runCounters('ai');
        runPromptedUpdates('ai');
    });

    eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, () => {
        runPromptedUpdates('pre_generation');
    });

    if (eventTypes.GROUP_MEMBER_DRAFTED) {
        eventSource.on(eventTypes.GROUP_MEMBER_DRAFTED, () => {
            runPromptedUpdates('group_draft');
        });
    }

    // Keep the connection-profile dropdown in sync if profiles are
    // created/renamed/deleted elsewhere while the panel is open.
    for (const key of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED', 'CONNECTION_PROFILE_LOADED']) {
        const evt = eventTypes[key];
        if (evt) {
            eventSource.on(evt, () => populateConnectionProfileDropdown());
        }
    }
}

function registerSlashCommand() {
    // Best-effort: slash command registration APIs vary a little between
    // SillyTavern versions, so this is wrapped defensively and never blocks
    // the rest of the extension from loading if it fails.
    try {
        const context = SillyTavern.getContext();
        if (!context.SlashCommandParser || !context.SlashCommand?.fromProps) return;
        context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
            name: 'state-run',
            callback: async () => {
                await runPromptedUpdates('manual-all');
                return '';
            },
            helpString: 'Force State Engine to run all prompted variable updates right now.',
        }));
    } catch (err) {
        console.warn(LOG_PREFIX, 'slash command registration skipped', err);
    }
}

// ---------------------------------------------------------------------------
// Connection profile selection
// ---------------------------------------------------------------------------

function populateConnectionProfileDropdown() {
    const $select = $('#se_connection_profile');
    if (!$select.length) return;

    const context = SillyTavern.getContext();
    const settings = getSettings();
    const current = settings.connectionProfileId || '';

    let profiles = [];
    try {
        const svc = context.ConnectionManagerRequestService;
        if (svc && typeof svc.getSupportedProfiles === 'function') {
            profiles = svc.getSupportedProfiles() || [];
        } else if (context.extensionSettings?.connectionManager?.profiles) {
            profiles = context.extensionSettings.connectionManager.profiles;
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not read connection profiles', err);
    }

    $select.empty();
    $select.append($('<option></option>').val('').text('Use currently active connection'));
    for (const profile of profiles) {
        if (!profile || !profile.id) continue;
        $select.append($('<option></option>').val(profile.id).text(profile.name || profile.id));
    }
    if (current && !profiles.some((p) => p.id === current)) {
        $select.append($('<option></option>').val(current).text(`(not found) ${current}`));
    }
    $select.val(current);
}

// ---------------------------------------------------------------------------
// Floating tracker panel
// ---------------------------------------------------------------------------

function renderTrackerPanel() {
    const $body = $('#se_tracker_body');
    if (!$body.length) return;

    const context = SillyTavern.getContext();
    const settings = getSettings();
    const showHidden = !!settings.trackerShowHidden;
    
    // Get presets that are marked to show in tracker (not based on active presets, but on tracker selection)
    const trackerPresetIds = getTrackerPresets();
    const variables = getAllVariablesFromPresets(trackerPresetIds);

    const defs = Object.values(variables)
        .filter((def) => def.name && (def.showInTracker !== false || showHidden))
        .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));

    $body.empty();
    if (defs.length === 0) {
        $body.append($('<div></div>').addClass('se-tracker-empty').text('No tracked variables to show.'));
        return;
    }

    for (const def of defs) {
        const value = getVarValue(context, def);
        const $row = $('<div></div>').addClass('se-tracker-row');
        if (def.showInTracker === false) $row.addClass('se-tracker-row-hidden');
        $row.append($('<span></span>').addClass('se-tracker-label').text(def.label || def.name));
        $row.append($('<span></span>').addClass(`se-badge se-badge-${def.category} se-tracker-badge`).text(categoryLabel(def.category)));
        $row.append($('<span></span>').addClass('se-tracker-value').text(formatValueForDisplay(value)));
        $body.append($row);
    }
}

function makeTrackerPanelDraggable($panel, $header) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startTop = 0;
    let startLeft = 0;

    $header.on('mousedown', (e) => {
        if ($(e.target).is('button, .se-tracker-btn')) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const offset = $panel.offset();
        startTop = offset.top;
        startLeft = offset.left;
        e.preventDefault();
    });

    $(document).on('mousemove.seTracker', (e) => {
        if (!dragging) return;
        const newLeft = Math.max(0, startLeft + (e.clientX - startX));
        const newTop = Math.max(0, startTop + (e.clientY - startY));
        $panel.css({ left: `${newLeft}px`, top: `${newTop}px`, right: 'auto', bottom: 'auto' });
    });

    $(document).on('mouseup.seTracker', () => {
        if (!dragging) return;
        dragging = false;
        const settings = getSettings();
        settings.trackerPanelPos = {
            top: parseInt($panel.css('top'), 10) || 0,
            left: parseInt($panel.css('left'), 10) || 0,
        };
        persistSettings();
    });
}

function buildTrackerPanel() {
    if ($('#se_tracker_panel').length) return;

    const settings = getSettings();
    const $panel = $(
        '<div id="se_tracker_panel">' +
        '<div id="se_tracker_header">' +
        '<span id="se_tracker_title">State Tracker</span>' +
        '<span class="se-tracker-header-actions">' +
        '<button id="se_tracker_debug_toggle" class="se-tracker-btn" title="Show hidden/debug variables">Debug</button>' +
        '<button id="se_tracker_collapse" class="se-tracker-btn" title="Collapse">–</button>' +
        '<button id="se_tracker_close" class="se-tracker-btn" title="Hide panel">×</button>' +
        '</span>' +
        '</div>' +
        '<div id="se_tracker_body"></div>' +
        '</div>',
    );
    $('body').append($panel);

    $panel.css({ top: `${settings.trackerPanelPos.top}px`, left: `${settings.trackerPanelPos.left}px` });
    $panel.toggleClass('se-tracker-collapsed', !!settings.trackerPanelCollapsed);
    $('#se_tracker_debug_toggle').toggleClass('se-tracker-btn-active', !!settings.trackerShowHidden);

    $('#se_tracker_collapse').on('click', () => {
        const s = getSettings();
        s.trackerPanelCollapsed = !s.trackerPanelCollapsed;
        persistSettings();
        $panel.toggleClass('se-tracker-collapsed', s.trackerPanelCollapsed);
    });

    $('#se_tracker_close').on('click', () => {
        getSettings().showTrackerPanel = false;
        persistSettings();
        $panel.hide();
        $('#se_show_tracker_panel').prop('checked', false);
    });

    $('#se_tracker_debug_toggle').on('click', function () {
        const s = getSettings();
        s.trackerShowHidden = !s.trackerShowHidden;
        persistSettings();
        $(this).toggleClass('se-tracker-btn-active', s.trackerShowHidden);
        renderTrackerPanel();
    });

    makeTrackerPanelDraggable($panel, $('#se_tracker_header'));
    renderTrackerPanel();
}

function setTrackerPanelVisible(visible) {
    if (visible) {
        buildTrackerPanel();
        $('#se_tracker_panel').show();
        renderTrackerPanel();
    } else {
        $('#se_tracker_panel').hide();
    }
}

// ---------------------------------------------------------------------------
// UI — settings panel
// ---------------------------------------------------------------------------

let statusTimer = null;

function setStatus(text, isError = false) {
    const $status = $('#se_status');
    if (!$status.length) return;
    $status.text(text).toggleClass('se-status-error', !!isError);
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => $status.text(''), 5000);
}

function categoryLabel(cat) {
    if (cat === 'counter') return 'Counter';
    if (cat === 'prompted') return 'Prompted';
    return 'Manual';
}

function typeLabel(type) {
    if (type === 'number') return 'Number';
    if (type === 'boolean') return 'True/False';
    if (type === 'enum') return 'Choice';
    if (type === 'array') return 'Array';
    return 'Text';
}

function formatValueForDisplay(value) {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return `[${value.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(', ')}]`;
    }
    if (value === '' || value === undefined || value === null) return '—';
    return String(value);
}

function renderVarTable() {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    
    // If no active presets, use default
    if (activePresetIds.length === 0 && settings.defaultPresetForNewChats) {
        activePresetIds.push(settings.defaultPresetForNewChats);
        setPresetsForChat(chatId, activePresetIds);
    }
    
    // Render tabs
    const $tabContainer = $('#se_preset_tabs');
    if (!$tabContainer.length) return;
    
    $tabContainer.empty();
    
    // If no presets at all, show a message
    if (Object.keys(settings.presets).length === 0) {
        $tabContainer.html('<div class="se-empty">No presets created. Click "New Preset" to get started.</div>');
        return;
    }
    
    // Create tab buttons
    for (const presetId of activePresetIds) {
        const preset = settings.presets[presetId];
        if (!preset) continue;
        
        const $tab = $('<button></button>')
            .addClass('se-tab-btn')
            .toggleClass('se-tab-active', presetId === currentPresetId)
            .text(preset.name)
            .on('click', () => {
                currentPresetId = presetId;
                renderVarTable();
            });
        $tabContainer.append($tab);
    }
    
    // Render variables for current preset
    const $tbody = $('#se_var_tbody');
    const $empty = $('#se_var_empty');
    if (!$tbody.length) return;
    
    $tbody.empty();
    
    // If no current preset, select the first active one
    if (!currentPresetId && activePresetIds.length > 0) {
        currentPresetId = activePresetIds[0];
    }
    
    const currentPreset = settings.presets[currentPresetId];
    if (!currentPreset) {
        $empty.show();
        return;
    }
    
    const defs = Object.values(currentPreset.variables).sort((a, b) => a.name.localeCompare(b.name));
    $empty.toggle(defs.length === 0);
    
    for (const def of defs) {
        const value = def.name ? getVarValue(context, def) : '';
        const $row = $('<tr></tr>').attr('data-id', def.id);
        $row.append($('<td></td>').append($('<code></code>').text(def.name || '(unnamed)')));
        $row.append($('<td></td>').append(
            $('<span></span>').addClass(`se-badge se-badge-${def.category}`).text(categoryLabel(def.category)),
        ));
        $row.append($('<td></td>').text(typeLabel(def.type)));
        $row.append($('<td></td>').text(def.scope === 'global' ? 'Global' : 'Chat'));
        $row.append($('<td></td>').addClass('se-col-value').text(formatValueForDisplay(value)));

        const $actions = $('<div></div>').addClass('se-row-actions');
        const $editBtn = $('<button></button>').addClass('menu_button se-edit-btn').text('Edit');
        const $delBtn = $('<button></button>').addClass('menu_button se-delete-btn').text('Delete');
        $actions.append($editBtn, $delBtn);
        $row.append($('<td></td>').append($actions));

        $tbody.append($row);
    }
}

function toggleEditorSections() {
    const type = $('#se_f_type').val();
    const category = $('#se_f_category').val();
    $('#se_f_enum_row').toggle(type === 'enum');
    $('#se_f_minmax_row').toggle(type === 'number');
    $('#se_f_array_row').toggle(type === 'array');
    $('.se-cat-counter').toggle(category === 'counter');
    $('.se-cat-prompted').toggle(category === 'prompted');
}

function openEditor(def) {
    const isNew = !def;
    const d = def || blankDefinition();

    $('#se_edit_id').val(d.id);
    $('#se_f_name').val(d.name).prop('disabled', !isNew);
    $('#se_f_label').val(d.label);
    $('#se_f_category').val(d.category);
    $('#se_f_scope').val(d.scope);
    $('#se_f_type').val(d.type);
    $('#se_f_default').val(d.default);
    $('#se_f_enum_values').val((d.enumValues || []).join(', '));
    $('#se_f_min').val(d.min);
    $('#se_f_max').val(d.max);
    $('#se_f_description').val(d.description);
    $('#se_f_reset_on_new_chat').prop('checked', !!d.resetOnNewChat);
    $('#se_f_show_in_tracker').prop('checked', d.showInTracker !== false);
    $('#se_f_counter_trigger').val(d.counter?.trigger || 'ai');
    $('#se_f_counter_direction').val(d.counter?.direction || 'increment');
    $('#se_f_counter_step').val(d.counter?.step ?? 1);
    const activeTriggers = Array.isArray(d.prompted?.triggers) ? d.prompted.triggers : [];
    $('.se-f-prompted-trigger').each(function () {
        $(this).prop('checked', activeTriggers.includes($(this).val()));
    });
    $('#se_f_prompted_instructions').val(d.prompted?.instructions || '');

    toggleEditorSections();
    $('#se_editor').data('is-new', isNew).show();
    $('html, body').stop();
    document.getElementById('se_editor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeEditor() {
    $('#se_editor').hide();
    $('#se_f_name').prop('disabled', false);
}

function readEditorForm() {
    const enumValues = String($('#se_f_enum_values').val() || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    return {
        id: $('#se_edit_id').val(),
        name: String($('#se_f_name').val() || '').trim(),
        label: String($('#se_f_label').val() || '').trim(),
        category: $('#se_f_category').val(),
        scope: $('#se_f_scope').val(),
        type: $('#se_f_type').val(),
        enumValues,
        default: $('#se_f_default').val(),
        min: $('#se_f_min').val(),
        max: $('#se_f_max').val(),
        description: String($('#se_f_description').val() || ''),
        resetOnNewChat: $('#se_f_reset_on_new_chat').is(':checked'),
        showInTracker: $('#se_f_show_in_tracker').is(':checked'),
        counter: {
            trigger: $('#se_f_counter_trigger').val(),
            direction: $('#se_f_counter_direction').val(),
            step: Number($('#se_f_counter_step').val()) || 1,
        },
        prompted: {
            triggers: $('.se-f-prompted-trigger:checked').map(function () { return $(this).val(); }).get(),
            instructions: String($('#se_f_prompted_instructions').val() || ''),
        },
    };
}

function saveVariableFromEditor() {
    const settings = getSettings();
    const def = readEditorForm();
    const presetId = currentPresetId;

    if (!presetId) {
        setStatus('No preset selected.', true);
        return;
    }
    
    const preset = settings.presets[presetId];
    if (!preset) {
        setStatus('Preset not found.', true);
        return;
    }

    if (!def.name) {
        setStatus('Variable name is required.', true);
        return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(def.name)) {
        setStatus('Variable name should only contain letters, numbers, and underscores, and not start with a number.', true);
        return;
    }
    const isNew = $('#se_editor').data('is-new');
    const nameTaken = Object.values(preset.variables).some((other) => other.id !== def.id && other.name === def.name);
    if (nameTaken) {
        setStatus(`A variable named "${def.name}" already exists in this preset.`, true);
        return;
    }
    if (def.type === 'enum' && def.enumValues.length === 0) {
        setStatus('Add at least one allowed value for a choice-list variable.', true);
        return;
    }

    preset.variables[def.id] = def;
    persistSettings();

    if (isNew) {
        const context = SillyTavern.getContext();
        setVarValue(context, def, getDefaultValue(def));
    }

    closeEditor();
    renderVarTable();
    setStatus(`Saved "${def.name}".`);
}

function deleteVariable(id) {
    const settings = getSettings();
    const presetId = currentPresetId;
    
    if (!presetId) return;
    
    const preset = settings.presets[presetId];
    if (!preset) return;
    
    const def = preset.variables[id];
    if (!def) return;
    
    if (!window.confirm(`Delete variable "${def.name}"? This only removes the definition; any value already stored for it is left in place.`)) {
        return;
    }
    delete preset.variables[id];
    persistSettings();
    renderVarTable();
    setStatus(`Deleted "${def.name}".`);
}

function loadGeneralSettingsIntoForm() {
    const settings = getSettings();
    $('#se_enabled').prop('checked', !!settings.enabled);
    $('#se_show_tracker_panel').prop('checked', !!settings.showTrackerPanel);
    $('#se_context_count').val(settings.contextMessageCount);
    $('#se_response_length').val(settings.responseLength);
    populateConnectionProfileDropdown();
}

function refreshPanelIfOpen() {
    if ($('#state_engine_settings').length) {
        renderVarTable();
    }
    if ($('#se_tracker_panel').length) {
        renderTrackerPanel();
    }
}

function bindPanelEvents() {
    $('#se_enabled').on('change', function () {
        getSettings().enabled = $(this).is(':checked');
        persistSettings();
    });
    $('#se_show_tracker_panel').on('change', function () {
        const checked = $(this).is(':checked');
        getSettings().showTrackerPanel = checked;
        persistSettings();
        setTrackerPanelVisible(checked);
    });
    $('#se_connection_profile').on('change', function () {
        getSettings().connectionProfileId = $(this).val() || '';
        persistSettings();
    });
    $('#se_context_count').on('change', function () {
        const n = Math.max(1, Math.min(50, Number($(this).val()) || 10));
        getSettings().contextMessageCount = n;
        $(this).val(n);
        persistSettings();
    });
    $('#se_response_length').on('change', function () {
        const n = Math.max(50, Math.min(2000, Number($(this).val()) || 300));
        getSettings().responseLength = n;
        $(this).val(n);
        persistSettings();
    });

    $('#se_run_now').on('click', () => runPromptedUpdates('manual-all'));

    $('#se_new_preset').on('click', () => {
       const name = prompt('Preset name:');
       if (name && name.trim()) {
           const presetId = createPreset(name.trim());
           currentPresetId = presetId;
           renderPresetList();
           renderVarTable();
           setStatus(`Created preset "${name}".`);
       }
    });

    $('#se_add_var').on('click', () => openEditor(null));
    $('#se_cancel_edit').on('click', closeEditor);
    $('#se_save_var').on('click', saveVariableFromEditor);

    $('#se_cancel_preset_edit').on('click', () => $('#se_preset_editor').hide());
    $('#se_save_preset').on('click', savePresetSettings);

    $('#se_f_type').on('change', toggleEditorSections);
    $('#se_f_category').on('change', toggleEditorSections);

    $('#se_var_tbody').on('click', '.se-edit-btn', function () {
       const id = $(this).closest('tr').attr('data-id');
       if (!currentPresetId) return;
       const preset = getSettings().presets[currentPresetId];
       if (preset) {
           const def = preset.variables[id];
           if (def) openEditor(def);
       }
    });
    $('#se_var_tbody').on('click', '.se-delete-btn', function () {
       const id = $(this).closest('tr').attr('data-id');
       deleteVariable(id);
    });

    renderPresetList();
    renderTrackerPresetList();
    renderVarTable();
}

function renderPresetList() {
    const settings = getSettings();
    const $list = $('#se_preset_list');
    if (!$list.length) return;

    $list.empty();

    if (Object.keys(settings.presets).length === 0) {
       $list.html('<div class="se-empty">No presets yet. Click the + button to create one.</div>');
       return;
    }

    for (const [presetId, preset] of Object.entries(settings.presets)) {
       const $item = $('<div></div>').addClass('se-preset-item');
       const $name = $('<span></span>').addClass('se-preset-name').text(preset.name);
       const $actions = $('<div></div>').addClass('se-preset-actions');

       // Edit/Settings button
       const $settingsBtn = $('<button></button>')
           .addClass('se-preset-btn')
           .html('<i class="fa-solid fa-cog"></i>')
           .attr('title', 'Edit triggers for this preset')
           .on('click', () => editPresetSettings(presetId));

       // Rename button
       const $renameBtn = $('<button></button>')
           .addClass('se-preset-btn')
           .html('<i class="fa-solid fa-pencil"></i>')
           .attr('title', 'Rename preset')
           .on('click', () => {
               const newName = prompt('New name:', preset.name);
               if (newName && newName.trim()) {
                   renamePreset(presetId, newName.trim());
                   renderPresetList();
                   renderVarTable();
                   setStatus(`Renamed to "${newName}".`);
               }
           });

       // Delete button
       const $deleteBtn = $('<button></button>')
           .addClass('se-preset-btn')
           .html('<i class="fa-solid fa-trash"></i>')
           .attr('title', 'Delete preset (variables stay)')
           .on('click', () => {
               if (window.confirm(`Delete preset "${preset.name}"? Variables in this preset won't be deleted.`)) {
                   deletePreset(presetId);
                   if (currentPresetId === presetId) currentPresetId = null;
                   renderPresetList();
                   renderVarTable();
                   setStatus(`Deleted "${preset.name}".`);
               }
           });

       $actions.append($settingsBtn, $renameBtn, $deleteBtn);
       $item.append($name, $actions);
       $list.append($item);
    }
}

function renderTrackerPresetList() {
    const settings = getSettings();
    const $list = $('#se_tracker_preset_list');
    if (!$list.length) return;

    $list.empty();

    const trackerPresets = getTrackerPresets();

    if (Object.keys(settings.presets).length === 0) {
       $list.html('<div class="se-empty">Create a preset first.</div>');
       return;
    }

    for (const [presetId, preset] of Object.entries(settings.presets)) {
       const isChecked = trackerPresets.includes(presetId);
       const $item = $('<label></label>').addClass('se-tracker-preset-item checkbox_label');
       const $checkbox = $('<input></input>')
           .attr('type', 'checkbox')
           .prop('checked', isChecked)
           .on('change', function () {
               if ($(this).is(':checked')) {
                   addPresetToTracker(presetId);
               } else {
                   removePresetFromTracker(presetId);
               }
               renderTrackerPanel();
               setStatus(`Tracker display updated.`);
           });
       const $label = $('<span></span>').text(preset.name);
       $item.append($checkbox, $label);
       $list.append($item);
    }
}

function editPresetSettings(presetId) {
    const settings = getSettings();
    const preset = settings.presets[presetId];
    if (!preset) return;

    const $editor = $('#se_preset_editor');
    const $title = $('#se_preset_edit_title');
    $title.text(`Edit "${preset.name}" - Update Triggers`);
    $('#se_preset_edit_id').val(presetId);

    // Clear checkboxes
    $('.se-preset-trigger').prop('checked', false);

    // Set which triggers are active
    if (preset.triggers && Array.isArray(preset.triggers)) {
        preset.triggers.forEach(trigger => {
            $(`.se-preset-trigger[value="${trigger}"]`).prop('checked', true);
        });
    }

    $editor.show();
    $('html, body').scrollTop($editor.offset().top - 100);
}

function savePresetSettings() {
    const presetId = $('#se_preset_edit_id').val();
    const settings = getSettings();
    const preset = settings.presets[presetId];
    if (!preset) return;

    const triggers = [];
    $('.se-preset-trigger:checked').each(function () {
        triggers.push($(this).val());
    });

    preset.triggers = triggers;
    persistSettings();
    
    $('#se_preset_editor').hide();
    setStatus(`Triggers updated for "${preset.name}".`);
    renderVarTable(); // Refresh in case prompt variables are shown
}

async function initPanel() {
    const context = SillyTavern.getContext();
    let html;
    try {
        html = await context.renderExtensionTemplateAsync(EXT_TEMPLATE_PATH, 'settings');
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to load settings.html template', err);
        return;
    }
    const $html = $(html);
    $html.find('#se_macro_example, #se_macro_example2').text('{{getvar::name}}');
    $('#extensions_settings2').append($html);

    bindPanelEvents();
    loadGeneralSettingsIntoForm();
    renderVarTable();

    if (getSettings().showTrackerPanel) {
        setTrackerPanelVisible(true);
    }
}

// ---------------------------------------------------------------------------
// Template registration
// ---------------------------------------------------------------------------

async function registerTemplates() {
    const context = SillyTavern.getContext();
    try {
        if (context.registerExtensionTemplates) {
            await context.registerExtensionTemplates(EXT_TEMPLATE_PATH, 'settings.html');
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'template registration skipped or failed', err);
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

jQuery(async () => {
    try {
        getSettings(); // ensure defaults exist / migrate
        await registerTemplates();
        await initPanel();
        registerEvents();
        registerSlashCommand();
        applyDefaultsForMissing();
        // Covers the case where APP_READY already fired before we got here.
        runStartupOnce();
        console.log(LOG_PREFIX, 'loaded');
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to initialize', err);
    }
});
