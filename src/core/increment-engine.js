// State Engine — deterministic (non-LLM) variable increments

import { LOG_PREFIX, getSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { getVarValue, setVarValue } from './variable-storage.js';
import { refreshPanelIfOpen } from '../ui/ui-entrypoints.js';

export function applyIncrement(context, def, delta) {
    const current = getVarValue(context, def);
    let next;
    console.log(LOG_PREFIX, "Incrementing Variable: ", def.name, " by ", delta);
    switch (def.type) {
        case 'number':
            next = current + delta;
            break;

        case 'boolean':
            next = !current;
            break;

        case 'enum':
            next = cycleEnum(def, current);
            break;

    }

    //enforceConstraints is the future place where you’ll clamp values, validate enums, enforce min/max, and guarantee type correctness.
    //next = enforceConstraints(def, next);

    setVarValue(context, def, next);

    //triggerHooks would be It’s the future place where you fire side‑effects when a variable changes.
    //triggerHooks(def, current, next);

    refreshPanelIfOpen();
}

export function cycleEnum(def, current) {
    const values = def.enumValues || [];
    if (!values.length) return current;

    const idx = values.indexOf(current);
    return values[(idx + 1) % values.length];
}

export function runDeterministicIncrements(triggerType) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;

    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    const variables = getAllVariablesFromPresets(activePresetIds);

    for (const def of Object.values(variables)) {
        if (!def.name) continue;

        // Only deterministic increment variables
        if(def.behaviors?.prompted) continue;
        if (!def.behaviors?.increment) continue;
        console.log(LOG_PREFIX, "Checking to increment variable", def);
        if(!def.increment) continue;
        if(def.increment?.triggers != triggerType ||
            (def.increment?.triggers == "both" && (triggerType != "ai" && triggerType != "user" )))continue;

        // Increment internal counter
        const counter = Number(def._counter || 0) + 1;
        def._counter = counter;

        if (counter < (def.tick_every || 1)) continue;

        // Reset counter
        def._counter = 0;

        applyIncrement(context, def, def.increment.delta);

    }

    refreshPanelIfOpen();
}
