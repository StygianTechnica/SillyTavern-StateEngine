// State Engine — background "prompted" variable updates (LLM-driven)

import { LOG_PREFIX, DEFAULT_CALENDAR_ID, DEFAULT_PROMPTED_HEADER, DEFAULT_UNIFIED_VARIABLE_RULES, getSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { DEFAULT_BATCH, TIME_BATCH, batchOf, getDefaultValue } from './variable-schema.js';
import { isImageType } from './image-variables.js';
import { format, resolveInstruction, toScalar } from './calendar-engine.js';
import { getVar, setVar, applyIncrement, loadChatState } from './chat-state.js';
import { recalculateDependents } from './calculated-engine.js';
import { callBackgroundLLM } from './background-llm.js';
import { extractJsonObject, stripHtml, describeConstraint } from '../ui/formatting-utils.js';
import { setStatus } from '../ui/settings-panel-ui.js';
import { refreshPanelIfOpen } from '../ui/ui-entrypoints.js';

export function shouldSkipPromptedRefresh(def) {
    return !!(def && def.skipPromptedRefresh);
}

// A flag-mode boolean (1.28) that has already fired: nothing prompted can change
// it (setVar/applyIncrement already refuse to reset it), so asking about it again
// wastes tokens and can read as an invitation to "turn it back off" - it is simply
// left out of every prompted category once true.
export function isDoneFlag(chatId, def) {
    return def?.type === 'boolean' && def?.flagMode === true && getVar(chatId, def.name)?.value === true;
}

// Variable batching (requirements spec 1.20): the definitions, out of
// `variables` (the { id: def } map getAllVariablesFromPresets() returns),
// that belong to `batchName`. The main prompted update below only ever asks
// the model about batch "core" (plus "time", where datetime variables live -
// spec 1.21); a variable assigned to any other batch is kept out of this
// prompt, which is what stops a large preset from bloating it. A definition
// with no `batch` field counts as "core", so every pre-batching variable is
// included exactly as before. `batchName` is one batch name or an array of
// them.
export function selectBatchVariables(variables, batchName = DEFAULT_BATCH) {
    const wanted = Array.isArray(batchName) ? batchName : [batchName];
    return Object.values(variables || {}).filter((def) => wanted.includes(batchOf(def)));
}

// A datetime variable's value as the model should see it: calendarEngine.format()
// in the variable's own calendar (spec 1.22.2) - "2026-09-18 22:55:00" for
// Gregorian, the calendar's own month name and pattern for a fantasy one -
// never raw scalar seconds. Every other type is shown as stored. A value the
// calendar cannot format is shown as stored.
function valueForPrompt(def, value) {
    if (def.type !== 'datetime') return value;
    try {
        return format(def.calendar || DEFAULT_CALENDAR_ID, Number(value), { style: 'full' });
    } catch {
        return value;
    }
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

        for (const def of selectBatchVariables(variables, [DEFAULT_BATCH, TIME_BATCH])) {
            if (!def?.name) continue;

            // Arrays follow the exact same classification every other type
            // does - the LLM is never asked to perform an increment-style
            // operation directly. A prompted array with increment ALSO
            // checked is isPromptedIncrement: the model only ever answers
            // true/false (below), and a true answer runs the CONFIGURED
            // increment.operation/operand through applyIncrement, exactly
            // like every other incrementable type already works. Arrays
            // never see or produce an operation object themselves.
            // An image variable's VALUE is never asked of the LLM (image.md rules:
            // references are for UI and extensions, not narrative logic - the model
            // would only invent URLs). A prompted INCREMENT on an image list (a
            // true/false "rotate now?") is still allowed: it is explicit rotation.
            const isPromptedUpdate =
                def.behaviors?.prompted === true &&
                def.behaviors?.increment !== true &&
                !isImageType(def) &&
                !isDoneFlag(chatId, def) &&
                !shouldSkipPromptedRefresh(def);

            const isPromptedIncrement =
                def.behaviors?.prompted === true &&
                def.behaviors?.increment === true &&
                !isDoneFlag(chatId, def);

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
                    const current = valueForPrompt(def, getVar(chatId, def.name)?.value ?? (def.type === 'datetime' ? getDefaultValue(def) : def.defaultValue));
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
                            // Each variable's write is isolated - one variable
                            // throwing (a malformed def, an unexpected value
                            // shape, anything) must never prevent every other
                            // variable in this same response from being
                            // written. Previously this whole loop shared one
                            // try/catch (around the entire .then() body), so a
                            // single bad entry silently dropped every update
                            // that would have been processed after it.
                            try {
                                if (!Object.prototype.hasOwnProperty.call(parsed, def.name)) continue;

                                const rawValue = parsed[def.name];

                                if (def.type === 'array' && !Array.isArray(rawValue)) {
                                    // Prompted arrays only ever accept a full array
                                    // replacement. Operation-style updates
                                    // (push/pop/toggle/etc) are never something the
                                    // model is asked to perform - that's
                                    // applyIncrement's job exclusively, triggered
                                    // either deterministically or via the boolean
                                    // incrementVars path below. Anything else here
                                    // means the model didn't follow the required
                                    // shape; skip rather than write garbage.
                                    continue;
                                }

                                if (def.type === 'datetime') {
                                    // The model answers a datetime variable in
                                    // words ("advance 3 hours") or with a date
                                    // ("2026-09-18 22:00"), never raw seconds
                                    // - calendar-engine turns either into the
                                    // new scalar (incrementScalar/fromStructured
                                    // underneath). resolveInstruction() dispatches
                                    // to the variable's own calendar, so its
                                    // nlRules ("advance 1 season", "next cycle",
                                    // "move to Stormfall 17") apply here without
                                    // any calendar-specific code in this file. An
                                    // answer it can't understand is skipped, not
                                    // written.
                                    const calendarId = def.calendar || DEFAULT_CALENDAR_ID;
                                    const stored = getVar(chatId, def.name)?.value ?? getDefaultValue(def);
                                    const next = resolveInstruction(calendarId, toScalar(calendarId, stored) ?? 0, rawValue);
                                    if (next === null) {
                                        console.warn(LOG_PREFIX, `prompted datetime update skipped for "${def.name}": could not understand ${JSON.stringify(rawValue)}`);
                                        continue;
                                    }
                                    setVar(chatId, def.name, next, def);
                                    recalculateDependents(chatId, def.name);
                                    updatedCount++;
                                    continue;
                                }

                                setVar(chatId, def.name, rawValue, def);
                                recalculateDependents(chatId, def.name);
                                updatedCount++;
                            } catch (err) {
                                console.warn(LOG_PREFIX, `prompted update failed for variable "${def.name}" (gracefully handled)`, err);
                            }
                        }

                        let incrementedCount = 0;
                        for (const def of incrementVars) {
                            try {
                                if (parsed[def.name] === true) {
                                    applyIncrement(chatId, def.name, def.increment.delta, def);
                                    recalculateDependents(chatId, def.name);
                                    incrementedCount++;
                                }
                            } catch (err) {
                                console.warn(LOG_PREFIX, `prompted increment failed for variable "${def.name}" (gracefully handled)`, err);
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
