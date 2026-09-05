// State Engine — background "prompted" variable updates (LLM-driven)

import { LOG_PREFIX, DEFAULT_PROMPTED_HEADER, DEFAULT_UNIFIED_VARIABLE_RULES, getSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { getVarValue, setVarValue } from './variable-storage.js';
import { applyIncrement } from './increment-engine.js';
import { callBackgroundLLM } from './background-llm.js';
import { extractJsonObject, stripHtml, describeConstraint } from '../ui/formatting-utils.js';
import { setStatus } from '../ui/settings-panel-ui.js';
import { refreshPanelIfOpen } from '../ui/ui-entrypoints.js';

export function shouldSkipPromptedRefresh(def) {
    return !!(def && def.skipPromptedRefresh);
}

export async function runPromptedStateUpdate(triggerType) {
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

    // Collect variables from presets that should update, and classify them
    const variables = getAllVariablesFromPresets(presetsToUpdate);
    const updateVars = [];
    const incrementVars = [];
    for (const def of Object.values(variables)) {
        if (!def.name) continue;
        if (def.category === 'prompted' && !shouldSkipPromptedRefresh(def)) {
            updateVars.push(def);
        } else if (def.behaviors?.prompted === true && def.behaviors?.increment === true) {
            incrementVars.push(def);
        }
    }

    if (updateVars.length === 0 && incrementVars.length === 0) return;
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

        const updateVarLines = updateVars
            .map((def) => {
                const current = getVarValue(context, def);
                const instructions = (def.prompted?.instructions || def.description || '').trim();
                return `- "${def.name}" [${describeConstraint(def)}] currently ${JSON.stringify(current)}.${instructions ? ` ${instructions}` : ''}`;
            })
            .join('\n');

        const incrementVarLines = incrementVars
            .map((def) => {
                const current = getVarValue(context, def);
                const instructions = (def.prompted?.instructions || def.description || '').trim();
                return `- "${def.name}" (${def.type}, current: ${current}): ${instructions}`;
            })
            .join('\n');

        const varLines = [updateVarLines, incrementVarLines].filter(Boolean).join('\n');
        if (!varLines.trim()) return;

        const promptSections = [
            settings.promptedHeader || DEFAULT_PROMPTED_HEADER,
            settings.promptedRules || DEFAULT_UNIFIED_VARIABLE_RULES,
            '',
            transcript ? `Recent conversation:\n${transcript}` : 'No conversation yet.',
        ];

        if (updateVarLines) {
            promptSections.push('', 'Update variables:', updateVarLines);
        }
        if (incrementVarLines) {
            promptSections.push('', 'Boolean-condition variables:', incrementVarLines);
        }

        const systemPrompt = promptSections.join('\n');

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Output the JSON object now. JSON only, no other text.' },
        ];

        const raw = await callBackgroundLLM(context, settings, messages, Number(settings.responseLength) || 300);

        const parsed = extractJsonObject(raw);
        if (!parsed) {
            console.warn(LOG_PREFIX, 'could not parse a JSON object from the model response:', raw);
            setStatus('Update failed — response was not valid JSON. See console.', true);
            return;
        }

        let updatedCount = 0;
        for (const def of updateVars) {
            if (Object.prototype.hasOwnProperty.call(parsed, def.name)) {
                setVarValue(context, def, parsed[def.name]);
                updatedCount++;
            }
        }

        let incrementedCount = 0;
        for (const def of incrementVars) {
            if (parsed[def.name] === true) {
                applyIncrement(context, def, def.increment.delta);
                incrementedCount++;
            }
        }

        setStatus(`State updated (${updatedCount}/${updateVars.length} variables, ${incrementedCount}/${incrementVars.length} incremented).`);
    } catch (err) {
        console.error(LOG_PREFIX, 'prompted state update failed', err);
        setStatus('Update failed — see browser console for details.', true);
    } finally {
        refreshPanelIfOpen();
    }
}
