// State Engine — World Info entry filtering based on variable conditions

import { LOG_PREFIX } from '../core/settings-core.js';
import { makeWIEntryKey, shouldDisplayWIEntry, getWIConditions } from './wi-conditions.js';

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
            const entryKey = makeWIEntryKey(entry.world || entry.book || 'unknown', entry.uid);
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
                const entryKey = makeWIEntryKey(entry.world || entry.book || 'unknown', entry.uid);
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
