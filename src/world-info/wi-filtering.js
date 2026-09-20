// State Engine — World Info entry filtering based on variable conditions

import { LOG_PREFIX, getSettings } from '../core/settings-core.js';
import { makeWIEntryKeyForEntry, shouldDisplayWIEntry, getWIConditions, entryConditionsMet, knownVariablesForChat } from './wi-conditions.js';

export function applyWorldInfoConditionalFiltering() {
    // Hook into world info activation to filter entries based on variable conditions
    // This runs when world info is being prepared for the LLM context

    try {
        const context = SillyTavern.getContext();

        // getWorldInfoPrompt is exported on the context API
        if (!context.getWorldInfoPrompt) {
            console.debug(`${LOG_PREFIX} getWorldInfoPrompt not available, skipping conditional filtering`);
            return;
        }

        // Call getWorldInfoPrompt to get the current world info state
        const wiPrompt = context.getWorldInfoPrompt();
        if (!wiPrompt || !wiPrompt.outletEntries) {
            console.debug(`${LOG_PREFIX} No world info outlets to filter`);
            return;
        }

        // Before filtering, get the original count for logging
        const originalCount = wiPrompt.outletEntries.length;

        // Filter entries based on our conditions
        const filteredEntries = [];
        const filteredOutEntries = [];

        for (const entry of wiPrompt.outletEntries) {
            const entryKey = makeWIEntryKeyForEntry(entry);
            if (shouldDisplayWIEntry(entryKey)) {
                filteredEntries.push(entry);
            } else {
                filteredOutEntries.push(entry);
            }
        }

        // Log filtering results for debugging
        if (filteredOutEntries.length > 0) {
            console.log(`${LOG_PREFIX} Filtered out ${filteredOutEntries.length}/${originalCount} world info entries based on conditions`);
            for (const entry of filteredOutEntries) {
                const entryKey = makeWIEntryKeyForEntry(entry);
                const conditions = getWIConditions(entryKey);
                console.log(`  - "${entry.comment || entry.name || 'unnamed'}" (${entryKey}): ${conditions.map(c => `${c.variable}${c.operator}${c.value}`).join(', ')}`);
            }
        }

        // Replace the outlet entries with the filtered version
        wiPrompt.outletEntries = filteredEntries;

    } catch (e) {
        console.error(`${LOG_PREFIX} Error applying world info conditional filtering:`, e);
        // Fail open - don't break world info if filtering fails
    }
}

export function getWorldInfoEntries() {
    // Get all available world info entries from the current context
    const context = SillyTavern.getContext();

    try {
        if (!context.getWorldInfoPrompt) return [];

        const wiPrompt = context.getWorldInfoPrompt();
        if (!wiPrompt || !wiPrompt.outletEntries) return [];

        return wiPrompt.outletEntries || [];
    } catch (e) {
        console.error(`${LOG_PREFIX} Error getting world info entries:`, e);
        return [];
    }
}

// ---------------------------------------------------------------------------
// The filter that actually runs (registered in event-engine.js)
// ---------------------------------------------------------------------------
//
// applyWorldInfoConditionalFiltering() above can never filter anything and is
// no longer registered: SillyTavern's getWorldInfoPrompt() is async (it returns
// a Promise, so `.outletEntries` was always undefined), it is a full activation
// scan that emits WORLD_INFO_ACTIVATED again when not a dry run, and
// WORLD_INFO_ACTIVATED itself fires AFTER activation with a copy of the
// activated entries. The event that can filter is WORLDINFO_ENTRIES_LOADED: it
// fires before the scan with { globalLore, characterLore, chatLore,
// personaLore } - arrays of entries ({ uid, world, ... }) that SillyTavern then
// reads, so removing entries from them in place keeps them out of the scan.

const LORE_LISTS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];

// WORLDINFO_ENTRIES_LOADED handler. Mutates the payload's arrays in place and
// returns how many entries were removed. Never throws.
//   - When "Enable State Engine" is off it does nothing: every entry passes
//     through untouched.
//   - The decision per entry is entryConditionsMet() (wi-conditions.js), the same
//     rule shouldDisplayWIEntry() uses. It never throws, so a malformed condition
//     list only affects its own entry (logged, entry kept) and filtering carries on.
export function filterLoadedWorldInfo(payload) {
    try {
        if (!getSettings().enabled) return 0;
        if (!payload || typeof payload !== 'object') return 0;
        const known = knownVariablesForChat(SillyTavern.getContext().chatId);
        let removed = 0;

        for (const listName of LORE_LISTS) {
            const list = payload[listName];
            if (!Array.isArray(list)) continue;
            for (let i = list.length - 1; i >= 0; i--) {
                try {
                    const entryKey = makeWIEntryKeyForEntry(list[i]);
                    if (!entryConditionsMet(entryKey, known)) {
                        console.debug(`${LOG_PREFIX} World info entry ${entryKey} filtered out by its conditions`);
                        list.splice(i, 1);
                        removed++;
                    }
                } catch (err) {
                    console.warn(`${LOG_PREFIX} Could not check a world info entry (entry kept)`, err);
                }
            }
        }
        return removed;
    } catch (e) {
        console.error(`${LOG_PREFIX} Error filtering loaded world info (entries left as they were):`, e);
        return 0;
    }
}
