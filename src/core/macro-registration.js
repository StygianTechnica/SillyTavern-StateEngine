// State Engine — {{identifier}} macro registration
//
// SillyTavern's macro engine already exposes context.registerMacro(key,
// valueOrFn, description) / context.unregisterMacro(key) - a public,
// documented extension point (SillyTavern-Launcher/public/scripts/
// st-context.js binds these to MacrosParser.registerMacro/unregisterMacro;
// MacrosParser.registerMacro accepts a function as the value, resolved live
// at substitution time, exactly like {{getvar::name}}'s own handler reads
// ctx.variables.local.get(name) live). Registering a State Engine variable
// name here makes {{name}} resolve directly, with no custom pre-macro
// interception needed - SillyTavern's own engine does the {{...}} matching.
//
// Scoped to whichever presets are active for the *current* chat, refreshed
// on chat change, engine enable/disable, and variable create/edit/delete/
// preset toggle - never a stale snapshot.

import { getSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { getMacroValue } from './macro-store.js';

let registeredNames = new Set();

// Unregisters every macro this module previously registered. Used on
// engine disable, and internally before re-registering the current set so
// a renamed/deleted variable's old {{name}} macro never lingers.
export function unregisterAllVariableMacros() {
    try {
        const context = SillyTavern.getContext();
        if (typeof context.unregisterMacro !== 'function') return;
        for (const name of registeredNames) {
            try {
                context.unregisterMacro(name);
            } catch { /* already gone - fine */ }
        }
        registeredNames = new Set();
    } catch { /* SillyTavern context unavailable - nothing to do */ }
}

// Re-registers {{name}} for every variable in a preset currently active for
// this chat. No-op (after clearing any previous registration) when the
// engine is disabled or no chat is selected - {{name}} should not silently
// keep resolving once the engine is off, matching clearMacroVarsForChat's
// existing on-disable behavior (spec 3.2).
export function refreshVariableMacros() {
    unregisterAllVariableMacros();

    try {
        const settings = getSettings();
        if (!settings.enabled) return;

        const context = SillyTavern.getContext();
        if (typeof context.registerMacro !== 'function') return;

        const chatId = context.chatId;
        if (!chatId) return;

        const activePresetIds = getPresetsForChat(chatId);
        const variables = getAllVariablesFromPresets(activePresetIds);

        const nextNames = new Set();
        for (const def of Object.values(variables)) {
            if (!def.name || nextNames.has(def.name)) continue;
            nextNames.add(def.name);

            context.registerMacro(
                def.name,
                () => {
                    try {
                        const value = getMacroValue(SillyTavern.getContext(), def);
                        return value === null || value === undefined ? '' : String(value);
                    } catch {
                        return '';
                    }
                },
                def.description || def.label || `State Engine variable "${def.name}"`,
            );
        }

        registeredNames = nextNames;
    } catch (err) {
        console.warn('[State Engine] refreshVariableMacros failed (gracefully handled)', err);
    }
}
