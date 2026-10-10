// State Engine — {{identifier}} macro registration
//
// SillyTavern exposes its macro engine on the context as
// context.macros (scripts/macros/macro-system.js). Registering a State
// Engine variable name there makes {{name}} resolve directly, with the
// handler read live at substitution time - no custom pre-macro
// interception needed, SillyTavern's own engine does the {{...}} matching.
//
// SillyTavern has two macro engines, chosen by the user's
// power_user.experimental_macro_engine setting (on by default since 1.19):
// - new engine: context.macros.register / registry.unregisterMacro.
// - legacy engine: context.registerMacro / unregisterMacro
//   (MacrosParser), deprecated - every call logs a [DEPRECATED] console
//   warning - but still the only path the legacy engine reads from.
// We use the new API whenever the new engine is active, and fall back to
// the legacy one only for users who switched it off, the same split
// SillyTavern's own built-in extensions use (e.g. extensions/memory).
//
// Scoped to whichever presets are active for the *current* chat, refreshed
// on chat change, engine enable/disable, and variable create/edit/delete/
// preset toggle - never a stale snapshot.

import { getSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { getMacroValue } from './macro-store.js';

// name -> which engine it was registered with ('new' | 'legacy'), so a
// user toggling the engine setting between refreshes still unregisters
// from the right one.
let registeredNames = new Map();

function useNewMacroEngine(context) {
    return context.powerUserSettings?.experimental_macro_engine !== false
        && typeof context.macros?.register === 'function';
}

function registerOne(context, name, handler, description) {
    if (useNewMacroEngine(context)) {
        context.macros.register(name, {
            category: context.macros.category?.VARIABLE ?? 'variable',
            description,
            handler,
        });
        return 'new';
    }
    if (typeof context.registerMacro === 'function') {
        context.registerMacro(name, handler, description);
        return 'legacy';
    }
    return null;
}

function unregisterOne(context, name, engine) {
    if (engine === 'new') context.macros?.registry?.unregisterMacro(name);
    else if (typeof context.unregisterMacro === 'function') context.unregisterMacro(name);
}

// Unregisters every macro this module previously registered. Used on
// engine disable, and internally before re-registering the current set so
// a renamed/deleted variable's old {{name}} macro never lingers.
export function unregisterAllVariableMacros() {
    try {
        const context = SillyTavern.getContext();
        for (const [name, engine] of registeredNames) {
            try {
                unregisterOne(context, name, engine);
            } catch { /* already gone - fine */ }
        }
        registeredNames = new Map();
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

        const chatId = context.chatId;
        if (!chatId) return;

        const activePresetIds = getPresetsForChat(chatId);
        const variables = getAllVariablesFromPresets(activePresetIds);

        const nextNames = new Map();
        for (const def of Object.values(variables)) {
            if (!def.name || nextNames.has(def.name)) continue;

            const engine = registerOne(
                context,
                def.name,
                () => {
                    try {
                        const value = getMacroValue(SillyTavern.getContext(), def);
                        return value === null || value === undefined ? '' : (typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : String(value));
                    } catch {
                        return '';
                    }
                },
                def.description || def.label || `State Engine variable "${def.name}"`,
            );
            if (engine) nextNames.set(def.name, engine);
        }

        registeredNames = nextNames;
    } catch (err) {
        console.warn('[State Engine] refreshVariableMacros failed (gracefully handled)', err);
    }
}
