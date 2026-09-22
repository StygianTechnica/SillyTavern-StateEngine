// State Engine — wires the manager-modal.js API bag to the split modules
//
// Preset CRUD (createPreset/renamePreset/deletePreset/addPresetToChat/
// removePresetFromChat) routes through src/api/* (stateEngine.*) instead of
// calling src/core/preset-manager.js directly, per docs/STATE ENGINE API
// SPECIFICATION.md. The API layer addresses presets by (namespace, name),
// while every UI call site (ui-events.js, ui-render.js) still addresses
// them by presetId - the small adapters below translate between the two,
// resolving each presetId's preset.namespace/preset.name and calling
// through stateEngine.*, so nothing above this file had to change.
//
// Everything else in this bag (getPresetsForChat, restoreDefaultPresets,
// isVariableNameTaken, generateUniqueVariableName, blankDefinition, plain
// settings/debug/render helpers) has no namespaced equivalent in the API
// layer and stays a direct import - see this pass's implementation report
// for why (Part 8: no API surface was specified for these).

import { setManagerApi } from './manager-modal.js';
import { getSettings, persistSettings, toggleDebugMode, debugLog, BUILTIN_NAMESPACE } from '../../core/settings-core.js';
import { getPresetsForChat, restoreDefaultPresets, isVariableNameTaken, generateUniqueVariableName } from '../../core/preset-manager.js';
import { stateEngine } from '../../api/index.js';
import { ensureInstanceId } from '../../api/identity.js';
import { getDebugInfo } from '../../core/debug-engine.js';
import { blankDefinition } from '../../core/variable-schema.js';
import { isReservedVariable } from '../../core/validation-utils.js';
import { renderVarTable } from '../manager-modal-ui.js';
import { renderTrackerPanel } from '../tracker-panel-ui.js';
import { setStatus } from '../settings-panel-ui.js';
import { getCurrentChatId } from '../wand-ui.js';
import { previewCalendarDefinition, validateCalendarDefinition } from '../../core/calendar-engine.js';
import { listConnectionProfiles as connectionProfiles } from '../connection-profile-ui.js';

function findPresetById(presetId) {
    return getSettings().presets[presetId] || null;
}

// Every stateEngine.* call below is made AS the built-in extension:
// extensionId = BUILTIN_NAMESPACE ('se'), instanceId =
// settings.extensions.se.instanceId (ensureInstanceId() returns exactly
// that field, creating it on first use). The UI's click handlers have no
// error handling of their own, so an identity rejection thrown by the API
// layer is caught here and reported through setStatus instead of silently
// aborting the handler. Known consequence: this adapter always identifies
// as 'se', so a preset belonging to another registered namespace can no
// longer be renamed/deleted/toggled from the manager modal - the API layer
// correctly rejects it as not owned by 'se'.
function callAsBuiltin(fn) {
    try {
        return fn(BUILTIN_NAMESPACE, ensureInstanceId());
    } catch (err) {
        console.warn('[State Engine]', err);
        setStatus(err?.message || String(err), true);
        return undefined;
    }
}

// preset-manager.js's own createPreset()/renamePreset() never enforced
// name uniqueness (only presetId is unique there) - callers (ui-events.js)
// expect "create/rename always succeeds," silently allowing duplicate
// display names. stateEngine.createPreset()/updatePreset() DO require
// (namespace, name) to be unique, since that pair is how a preset is
// addressed. Auto-uniquifying here (rather than letting a collision
// silently no-op) preserves the "always succeeds" behavior without
// loosening the API layer's own addressing invariant.
function uniquePresetName(namespace, desiredName, excludePresetId) {
    const isTaken = (candidate) => Object.entries(getSettings().presets || {}).some(
        ([id, preset]) => id !== excludePresetId && preset?.namespace === namespace && preset?.name === candidate,
    );
    if (!isTaken(desiredName)) return desiredName;
    let n = 2;
    let candidate = `${desiredName} (${n})`;
    while (isTaken(candidate)) {
        n++;
        candidate = `${desiredName} (${n})`;
    }
    return candidate;
}

export function createPresetAdapter(name) {
    const desired = (name || 'New Preset').trim() || 'New Preset';
    const finalName = uniquePresetName(BUILTIN_NAMESPACE, desired, null);
    const created = callAsBuiltin((extId, instId) => stateEngine.createPreset(extId, instId, { namespace: BUILTIN_NAMESPACE, name: finalName }));
    return created ? created.id : null;
}

export function renamePresetAdapter(presetId, newName) {
    const preset = findPresetById(presetId);
    if (!preset) return;
    const namespace = preset.namespace || BUILTIN_NAMESPACE;
    const finalName = uniquePresetName(namespace, newName, presetId);
    callAsBuiltin((extId, instId) => stateEngine.updatePreset(extId, instId, namespace, preset.name, { name: finalName }));
}

export function deletePresetAdapter(presetId) {
    const preset = findPresetById(presetId);
    if (!preset) return;
    callAsBuiltin((extId, instId) => stateEngine.deletePreset(extId, instId, preset.namespace || BUILTIN_NAMESPACE, preset.name));
}

export function addPresetToChatAdapter(chatId, presetId) {
    const preset = findPresetById(presetId);
    if (!preset) return;
    callAsBuiltin((extId, instId) => stateEngine.activatePreset(extId, instId, chatId, preset.namespace || BUILTIN_NAMESPACE, preset.name));
}

export function removePresetFromChatAdapter(chatId, presetId) {
    const preset = findPresetById(presetId);
    if (!preset) return;
    callAsBuiltin((extId, instId) => stateEngine.deactivatePreset(extId, instId, chatId, preset.namespace || BUILTIN_NAMESPACE, preset.name));
}

// Independent preset operations for the Presets tab's "Independent Presets"
// subtab (requirements spec 1.29), made AS the built-in extension exactly
// like the regular-preset adapters above - same presetId<->(namespace,name)
// translation, same callAsBuiltin() error-to-status-bar convention (these
// functions already warn+return null/false on their own failures, and throw
// only on an identity problem that can never actually happen here since the
// caller is always 'se').
export function createIndependentPresetAdapter(name) {
    const desired = (name || 'New Independent Preset').trim() || 'New Independent Preset';
    const finalName = uniquePresetName(BUILTIN_NAMESPACE, desired, null);
    const created = callAsBuiltin((extId, instId) => stateEngine.createIndependentPreset(extId, instId, { namespace: BUILTIN_NAMESPACE, name: finalName }));
    return created ? created.id : null;
}

// patch: { name?, description?, connectionProfileId?, temperature?, maxTokens?,
// historyLimit?, promptedHeader?, enabled? } - anything not present is
// left untouched (updateIndependentPreset/configureIndependentPreset both merge).
export function updateIndependentPresetAdapter(presetId, patch) {
    const preset = findPresetById(presetId);
    if (!preset) return null;
    const namespace = preset.namespace || BUILTIN_NAMESPACE;
    const safePatch = { ...patch };
    if (typeof safePatch.name === 'string') safePatch.name = uniquePresetName(namespace, safePatch.name, presetId);
    return callAsBuiltin((extId, instId) => stateEngine.updateIndependentPreset(extId, instId, namespace, preset.name, safePatch));
}

export function deleteIndependentPresetAdapter(presetId) {
    const preset = findPresetById(presetId);
    if (!preset) return false;
    return !!callAsBuiltin((extId, instId) => stateEngine.deleteIndependentPreset(extId, instId, preset.namespace || BUILTIN_NAMESPACE, preset.name));
}

export function toggleIndependentPresetAdapter(presetId, enabled) {
    const preset = findPresetById(presetId);
    if (!preset) return null;
    return callAsBuiltin((extId, instId) => stateEngine.toggleIndependentPreset(extId, instId, preset.namespace || BUILTIN_NAMESPACE, preset.name, enabled));
}

// Scheduling (requirements spec 1.32): schedule: { enabled?, mode?, value?,
// calendar?, repeat? } - merges into the stored schedule exactly like
// updateIndependentPresetAdapter's patch does for the rest of the config
// (updateIndependentPresetSchedule itself owns the merge/validation/nextRun
// computation - this is a thin identity-translation wrapper, same as every
// other adapter here). Returns the stored schedule (with nextRun) or null
// on a validation failure - the editor (ui-events.js) is expected to show
// console.warn's message via setStatus, the same pattern every other
// rejected save in this modal already uses.
export function updateIndependentPresetScheduleAdapter(presetId, schedule) {
    const preset = findPresetById(presetId);
    if (!preset) return null;
    return callAsBuiltin((extId, instId) => stateEngine.updateIndependentPresetSchedule(extId, instId, preset.namespace || BUILTIN_NAMESPACE, preset.name, schedule));
}

// Fire-and-forget from the click handler's point of view (ui-events.js awaits
// it to re-render the row with the fresh status once it settles) - chatId is
// the chat currently open in SillyTavern, never a chat the row was drawn for.
export function runIndependentPresetAdapter(presetId, chatId) {
    const preset = findPresetById(presetId);
    if (!preset) return Promise.resolve(false);
    if (!chatId) {
        setStatus('Open a chat before running an independent preset.', true);
        return Promise.resolve(false);
    }
    return callAsBuiltin((extId, instId) => stateEngine.runIndependentPreset(extId, instId, chatId, { namespace: preset.namespace || BUILTIN_NAMESPACE, name: preset.name }))
        ?? Promise.resolve(false);
}

// Open read (no identity) - see getIndependentPresetStatus's own doc comment.
export function getIndependentPresetStatusAdapter(presetId) {
    const preset = findPresetById(presetId);
    if (!preset) return null;
    return stateEngine.getIndependentPresetStatus(preset.namespace || BUILTIN_NAMESPACE, preset.name);
}

export const independentPresetAdapters = {
    createIndependentPreset: createIndependentPresetAdapter,
    updateIndependentPreset: updateIndependentPresetAdapter,
    deleteIndependentPreset: deleteIndependentPresetAdapter,
    toggleIndependentPreset: toggleIndependentPresetAdapter,
    runIndependentPreset: runIndependentPresetAdapter,
    getIndependentPresetStatus: getIndependentPresetStatusAdapter,
    updateIndependentPresetSchedule: updateIndependentPresetScheduleAdapter,
    connectionProfiles,
};

// Calendar operations for the Calendars tab, made AS the built-in extension
// through stateEngine.* like the preset adapters above. Unlike callAsBuiltin(),
// these let the API's errors propagate: the editor needs the reason (an
// invalid definition, an id in use, a calendar still used by a variable) to
// show next to the form, not a status-bar line.
function asBuiltin(fn) {
    return fn(BUILTIN_NAMESPACE, ensureInstanceId());
}

export const calendarAdapters = {
    listCalendars: () => getSettings().calendars || {},
    createCalendar: (def) => asBuiltin((e, i) => stateEngine.createCalendarDefinition(e, i, def)),
    updateCalendar: (id, patch) => asBuiltin((e, i) => stateEngine.updateCalendarDefinition(e, i, id, patch)),
    deleteCalendar: (id) => asBuiltin((e, i) => stateEngine.deleteCalendarDefinition(e, i, id)),
    generateRandomCalendar: (options) => asBuiltin((e, i) => stateEngine.generateRandomCalendarDefinition(e, i, options)),
    validateCalendar: validateCalendarDefinition,
    previewCalendar: previewCalendarDefinition,
};

setManagerApi({
    getSettings,
    persistSettings,
    getCurrentChatId,
    createPreset: createPresetAdapter,
    renamePreset: renamePresetAdapter,
    deletePreset: deletePresetAdapter,
    getPresetsForChat,
    addPresetToChat: addPresetToChatAdapter,
    removePresetFromChat: removePresetFromChatAdapter,
    setStatus,
    renderVarTable,
    renderTrackerPanel,
    restoreDefaultPresets,
    toggleDebugMode,
    debugLog,
    getDebugInfo,
    isReservedVariable,
    blankDefinition,
    isVariableNameTaken,
    generateUniqueVariableName,
    ...calendarAdapters,
    ...independentPresetAdapters,
});
