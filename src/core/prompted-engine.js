// State Engine — background "prompted" variable updates (LLM-driven)

import { LOG_PREFIX, DEFAULT_PROMPTED_HEADER, DEFAULT_UNIFIED_VARIABLE_RULES, getSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { getVar, setVar, applyIncrement, loadChatState, applyArrayOperation } from './chat-state.js';
import { callBackgroundLLM } from './background-llm.js';
import { extractJsonObject, stripHtml, describeConstraint } from '../ui/formatting-utils.js';
import { setStatus } from '../ui/settings-panel-ui.js';
import { refreshPanelIfOpen } from '../ui/ui-entrypoints.js';

export function shouldSkipPromptedRefresh(def) {
    return !!(def && def.skipPromptedRefresh);
}

const ARRAY_PROMPTED_OPS = new Set(['push', 'pop', 'shift', 'unshift', 'rotate', 'clear', 'toggle']);

// Detects the {"op": ..., "value": ...} operation-object shape prompted
// array updates use, as distinct from a full-array replacement. Returns
// null for anything else, including a malformed/unrecognized op, so the
// caller can skip the write rather than writing garbage.
function parseArrayOperationObject(rawValue) {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return null;
    const op = rawValue.op;
    if (typeof op !== 'string' || !ARRAY_PROMPTED_OPS.has(op)) return null;
    return { op, value: rawValue.value };
}

// Fires the background "prompted variable" LLM update and returns``
// immediately without awaiting it. Nothing in this function may block or``
// throw into whatever caller (event handler, slash command, startup) invoked
// it — every failure is logged and swallowed here so the chat LLM pipeline
// is never affected by a State Engine problem.
export async function runPromptedStateUpdate(triggerType) {
    try {
        const context = SillyTavern.getContext();
        const settings = getSettings();
        if (!settings.enabled) return;

        const chatId = context.chatId;
        loadChatState(chatId); // ensure this chat's state exists before anything else runs
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
            if (!def?.name) continue;

            const isPromptedUpdate = 
                def.behaviors?.prompted === true &&
                def.behaviors?.increment !== true &&
                !shouldSkipPromptedRefresh(def);

            const isPromptedIncrement =
                def.behaviors?.prompted === true &&
                def.behaviors?.increment === true;

            const isDeterministicIncrement =
                def.behaviors?.increment === true &&
                def.behaviors?.prompted !== true;

            if (isPromptedUpdate) {
                // Normal prompted update variable
                updateVars.push(def);
                continue;
            }

            if (isPromptedIncrement) {
                // Prompted increment variable (LLM returns boolean)
                incrementVars.push(def);
                continue;
            }

            if (isDeterministicIncrement) {
                // Deterministic increments are NOT part of prompted updates.
                // They are handled exclusively by deterministic-engine.js.
                continue;
            }

            // All other variable types are ignored by prompted updates
        }


        if (updateVars.length === 0 && incrementVars.length === 0) return;
        if (!Array.isArray(context.chat)) return;

        setStatus('Updating state…');

        try {
            const userRequestedCount = Math.max(1, Number(settings.contextMessageCount) || 10);
            // Hard cap: never send more messages than maxPromptHistoryMessages,
            // regardless of what contextMessageCount asks for.
            const historyCap = Math.max(1, Number(settings.maxPromptHistoryMessages) || userRequestedCount);
            const count = Math.min(historyCap, userRequestedCount);
            const recent = context.chat.slice(-count);
            const maxMessageLength = Number(settings.maxMessageLength) || 0;
            const transcript = recent
                .map((m) => {
                    const speaker = m.is_user ? (context.name1 || 'User') : (m.name || context.name2 || 'Character');
                    let text = stripHtml(m.mes);
                    // Trims only this local prompt copy - m.mes (the stored message) is never touched.
                    if (maxMessageLength > 0 && text.length > maxMessageLength) {
                        text = text.slice(0, maxMessageLength) + '…';
                    }
                    return `${speaker}: ${text}`;
                })
                .filter((line) => line.trim().length > 0)
                .join('\n');

            const updateVarLines = updateVars
                .map((def) => {
                    const current = getVar(chatId, def.name)?.value ?? def.defaultValue;
                    const instructions = (def.prompted?.instructions || def.description || '').trim();
                    return `- "${def.name}" [${describeConstraint(def)}] currently ${JSON.stringify(current)}.${instructions ? ` ${instructions}` : ''}`;
                })
                .join('\n');

            const incrementVarLines = incrementVars
                .map((def) => {
                    const current = getVar(chatId, def.name)?.value ?? def.defaultValue;
                    const instructions = (def.prompted?.instructions || def.description || '').trim();
                    //return `- "${def.name}" (${def.type}, current: ${current}): ${instructions}`;
                    return `- "${def.name}"[true or false]: ${instructions}`;
                })
                .join('\n');

            const varLines = [updateVarLines, incrementVarLines].filter(Boolean).join('\n');
            if (!varLines.trim()) {
                refreshPanelIfOpen();
                return;
            }

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
                promptSections.push('', 'Boolean-conditional variables (include all in JSON output):', incrementVarLines);
            }

            const systemPrompt = promptSections.join('\n');

            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: 'Output the JSON object now. JSON only, no other text.' },
            ];

            const maxTokens = Number(settings.responseLength) || 300;

            // Fire-and-forget: do NOT await callBackgroundLLM. The chat LLM
            // pipeline must never wait on this. All follow-up work (parsing
            // the response, writing variables) happens in the .then/.catch
            // below, on its own time, after this function has already
            // returned to its caller.
            callBackgroundLLM(context, settings, messages, maxTokens)
                .then((raw) => {
                    try {
                        const parsed = extractJsonObject(raw);
                        if (!parsed) {
                            console.warn(LOG_PREFIX, 'could not parse a JSON object from the model response:', raw);
                            setStatus('Update failed — response was not valid JSON. See console.', true);
                            return;
                        }

                        let updatedCount = 0;
                        for (const def of updateVars) {
                            if (!Object.prototype.hasOwnProperty.call(parsed, def.name)) continue;

                            const rawValue = parsed[def.name];

                            if (def.type === 'array') {
                                if (Array.isArray(rawValue)) {
                                    // Full array replacement - setVar() validates/sanitizes it.
                                    setVar(chatId, def.name, rawValue, def);
                                    updatedCount++;
                                    continue;
                                }

                                const operation = parseArrayOperationObject(rawValue);
                                if (operation) {
                                    const current = getVar(chatId, def.name)?.value;
                                    const currentArr = Array.isArray(current) ? current : [];
                                    const nextArr = applyArrayOperation(currentArr, operation.op, operation.value, def);
                                    setVar(chatId, def.name, nextArr, def);
                                    updatedCount++;
                                }
                                // Neither a full array nor a recognized operation object -
                                // the model didn't follow the required shape; skip rather
                                // than write garbage.
                                continue;
                            }

                            setVar(chatId, def.name, rawValue, def);
                            updatedCount++;
                        }

                        let incrementedCount = 0;
                        for (const def of incrementVars) {
                            if (parsed[def.name] === true) {
                                applyIncrement(chatId, def.name, def.increment.delta, def);
                                incrementedCount++;
                            }
                        }

                        setStatus(`State updated (${updatedCount}/${updateVars.length} variables, ${incrementedCount}/${incrementVars.length} incremented).`);
                    } catch (err) {
                        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
                        setStatus('Update failed — see browser console for details.', true);
                    }
                })
                .catch((err) => {
                    console.warn(LOG_PREFIX, 'State Engine background LLM failed gracefully', err);
                    setStatus('Update failed — see browser console for details.', true);
                })
                .finally(() => {
                    refreshPanelIfOpen();
                });
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine threw synchronously', err);
            setStatus('Update failed — see browser console for details.', true);
            refreshPanelIfOpen();
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}
