// State Engine — background "prompted" variable updates (LLM-driven)

import { LOG_PREFIX, DEFAULT_CALENDAR_ID, DEFAULT_PROMPTED_HEADER, DEFAULT_UNIFIED_VARIABLE_RULES, getSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';
import { getDefaultValue } from './variable-schema.js';
import { isImageType } from './image-variables.js';
import { format, resolveInstruction, toScalar } from './calendar-engine.js';
import { getVar, setVar, applyIncrement, loadChatState } from './chat-state.js';
import { recalculateDependents } from './calculated-engine.js';
import { callBackgroundLLM } from './background-llm.js';
import { extractJsonObject, describeConstraint, buildRecentMessagesSection } from '../ui/formatting-utils.js';
import { setStatus } from '../ui/settings-panel-ui.js';
import { refreshPanelIfOpen } from '../ui/ui-entrypoints.js';
import { chunkPromptUnits } from './prompt-chunking.js';

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

// Classifies every prompted/incrementable variable out of `variables` (the
// { id: def } map getAllVariablesFromPresets() returns) into updateVars
// (the model writes a value directly) and incrementVars (the model answers
// true/false, and a true answer runs the configured increment). Deterministic
// increments (behaviors.increment with behaviors.prompted !== true) are
// deliberately excluded - deterministic-engine.js owns those exclusively.
//
// Requirements spec 1.20 (rewritten 2026-09-22): this used to also filter by
// a manually-assigned "batch" name, which the request behind that field's
// removal called out as never having matched what was actually asked for -
// automatic chunking BY SIZE (below), not manual per-variable scoping. Every
// prompted/incrementable variable across the given presets is classified
// here; chunkPromptedVariables() is what keeps an oversized set from
// overflowing a single LLM call, with no per-variable configuration needed.
export function classifyPromptedVariables(chatId, variables) {
    const updateVars = [];
    const incrementVars = [];

    for (const def of Object.values(variables || {})) {
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

        if (isPromptedUpdate) {
            updateVars.push(def);
        } else if (isPromptedIncrement) {
            incrementVars.push(def);
        }
        // Deterministic increments and everything else are ignored here.
    }

    return { updateVars, incrementVars };
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

function updateVarLine(chatId, def) {
    const current = valueForPrompt(def, getVar(chatId, def.name)?.value ?? (def.type === 'datetime' ? getDefaultValue(def) : def.defaultValue));
    const instructions = (def.prompted?.instructions || def.description || '').trim();
    return `- "${def.name}" [${describeConstraint(def)}] currently ${JSON.stringify(current)}.${instructions ? ` ${instructions}` : ''}`;
}

function incrementVarLine(chatId, def) {
    const instructions = (def.prompted?.instructions || def.description || '').trim();
    return `- "${def.name}"[true or false]: ${instructions}`;
}

// Automatic prompt chunking (requirements spec 1.20, rewritten 2026-09-22):
// turns a classified updateVars/incrementVars set into one or more size-
// bounded chunks (src/core/prompt-chunking.js), each still an
// { updateVars, incrementVars } pair in the SAME shape the rest of this file
// already works with - a caller with everything fitting in one chunk gets
// exactly ONE chunk back, containing every variable, unchanged from before
// chunking existed.
export function chunkPromptedVariables(chatId, updateVars, incrementVars, maxChars) {
    const units = [
        ...updateVars.map((def) => { const line = updateVarLine(chatId, def); return { def, kind: 'update', line, size: line.length }; }),
        ...incrementVars.map((def) => { const line = incrementVarLine(chatId, def); return { def, kind: 'increment', line, size: line.length }; }),
    ];
    const chunks = chunkPromptUnits(units, maxChars);
    return chunks.map((chunk) => ({
        updateVars: chunk.filter((u) => u.kind === 'update').map((u) => u.def),
        updateVarLines: chunk.filter((u) => u.kind === 'update').map((u) => u.line).join('\n'),
        incrementVars: chunk.filter((u) => u.kind === 'increment').map((u) => u.def),
        incrementVarLines: chunk.filter((u) => u.kind === 'increment').map((u) => u.line).join('\n'),
    }));
}

// Applies one parsed LLM response against one chunk's updateVars/incrementVars,
// writing through setVar()/applyIncrement() exactly as a single, unchunked
// update always has. Returns { updatedCount, incrementedCount }. Never throws -
// every variable's write is isolated (a malformed def, an unexpected value
// shape, anything) so one bad entry can never prevent every other variable in
// this same response from being written.
function applyPromptedResponse(chatId, updateVars, incrementVars, parsed) {
    let updatedCount = 0;
    for (const def of updateVars) {
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
                // Semantic time of day (requirements spec 1.35): when
                // this variable opts in (timeSemanticMode ===
                // 'semanticTimeOfDay'), the model's own answer here
                // ("the next morning") is interpreted into a precise
                // target time ahead of the ordinary duration/verb
                // grammar. The model is never told about this in the
                // prompt - describeConstraint() (formatting-utils.js)
                // is unchanged - the request behind this feature is
                // explicit that the engine alone does the
                // interpretation, so a semantic phrase works simply
                // because it happens to also read as natural language,
                // the same way "advance 3 hours" already does.
                // Datetime mode (requirements spec 1.36): a
                // dateOnly variable "ignores semantic time of
                // day phrases" outright - checkedDatetime()
                // (variable-api.js) already forces
                // timeSemanticMode to 'none' for it at save
                // time, but that path is bypassed by the
                // manager-modal's own inline editor (same
                // reason deltaSource is re-checked there too),
                // so it is re-gated here as well, the one
                // place that actually turns semantic parsing
                // on. The resulting scalar - from ANY path
                // (semantic, duration, absolute date) - is
                // then normalized for dateOnly/timeOnly by
                // setVar() below, the single choke point
                // every write already goes through.
                const calendarId = def.calendar || DEFAULT_CALENDAR_ID;
                const stored = getVar(chatId, def.name)?.value ?? getDefaultValue(def);
                const semanticTimeOfDay = def.datetimeMode !== 'dateOnly' && def.timeSemanticMode === 'semanticTimeOfDay';
                const next = resolveInstruction(calendarId, toScalar(calendarId, stored) ?? 0, rawValue, { semanticTimeOfDay });
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

    return { updatedCount, incrementedCount };
}

// Builds and sends ONE chunk's LLM call, applies its response, and returns
// { updatedCount, incrementedCount }. Throws on a background-LLM rejection or
// a response that doesn't parse as JSON (both are logged and turned into a
// status message by the caller - this function's own job is just the one
// call/parse/apply cycle, so it can be awaited per-chunk in a sequential
// loop without duplicating that error handling at every call site).
async function runPromptedChunk(context, settings, contextSection, chunk) {
    const chatId = context.chatId;
    const { updateVars, updateVarLines, incrementVars, incrementVarLines } = chunk;

    const promptSections = [
        settings.promptedHeader || DEFAULT_PROMPTED_HEADER,
        settings.promptedRules || DEFAULT_UNIFIED_VARIABLE_RULES,
        '',
        contextSection,
    ];
    if (updateVarLines) promptSections.push('', 'Update variables:', updateVarLines);
    if (incrementVarLines) promptSections.push('', 'Boolean-conditional variables (include all in JSON output):', incrementVarLines);

    const messages = [
        { role: 'system', content: promptSections.join('\n') },
        { role: 'user', content: 'Output the JSON object now. JSON only, no other text.' },
    ];
    const maxTokens = Number(settings.responseLength) || 300;

    const raw = await callBackgroundLLM(context, settings, messages, maxTokens);
    const parsed = extractJsonObject(raw);
    if (!parsed) {
        console.warn(LOG_PREFIX, 'could not parse a JSON object from the model response:', raw);
        throw new Error('response was not valid JSON');
    }
    return applyPromptedResponse(chatId, updateVars, incrementVars, parsed);
}

// Runs every chunk SEQUENTIALLY (never in parallel - one chunk's LLM call is
// awaited before the next one starts, avoiding several concurrent background
// calls per message and keeping a predictable order), each chunk isolated
// from the others: a chunk that fails (a network error, an unparseable
// response) is logged and simply contributes nothing to the totals - it
// never stops the remaining chunks from still running. Sets one combined
// final status message covering every chunk's variables, and an interim
// "part N of M" status between chunks only when there actually IS more than
// one (a single-chunk run - the overwhelming common case - shows exactly the
// same status text it always has).
async function runPromptedChunksSequentially(context, settings, contextSection, chunks) {
    let totalUpdated = 0;
    let totalIncremented = 0;
    let totalUpdateVars = 0;
    let totalIncrementVars = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        totalUpdateVars += chunk.updateVars.length;
        totalIncrementVars += chunk.incrementVars.length;
        if (chunks.length > 1) setStatus(`Updating state (part ${i + 1} of ${chunks.length})…`);

        try {
            const { updatedCount, incrementedCount } = await runPromptedChunk(context, settings, contextSection, chunk);
            totalUpdated += updatedCount;
            totalIncremented += incrementedCount;
        } catch (err) {
            console.warn(LOG_PREFIX, 'State Engine background LLM failed gracefully', err);
            if (chunks.length === 1) {
                // Preserve the exact single-chunk status text from before
                // chunking existed - a parse failure or LLM rejection here
                // is ALL that happened, so this is the only status message
                // for the whole run, not a "0 of N" summary.
                setStatus(
                    err?.message === 'response was not valid JSON'
                        ? 'Update failed — response was not valid JSON. See console.'
                        : 'Update failed — see browser console for details.',
                    true,
                );
                return;
            }
        }
    }

    setStatus(`State updated (${totalUpdated}/${totalUpdateVars} variables, ${totalIncremented}/${totalIncrementVars} incremented).`);
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

        // Collect variables from presets that should update, and classify them.
        const variables = getAllVariablesFromPresets(presetsToUpdate);
        const { updateVars, incrementVars } = classifyPromptedVariables(chatId, variables);

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
            // formatting-utils.js's buildRecentMessagesSection() - shared with
            // independent-presets.js's identical need - explicitly labels the
            // actual last chat message "Most recent roleplay message",
            // distinct from "Recent conversation" (everything before it): see
            // its own header comment for why (a variable's own prompted
            // instructions saying "look at the latest message" had no
            // reliable term to mean this rather than the synthetic "Output
            // the JSON object now" turn that comes after the whole system
            // prompt).
            const contextSection = buildRecentMessagesSection(recent, { name1: context.name1, name2: context.name2, maxMessageLength });

            const maxChars = Number(settings.maxPromptedVariableChars) || Infinity;
            const chunks = chunkPromptedVariables(chatId, updateVars, incrementVars, maxChars);

            // Fire-and-forget: do NOT await this. The chat LLM pipeline must
            // never wait on this. Every chunk's LLM call, parsing, and
            // variable writes happen inside runPromptedChunksSequentially(),
            // on its own time, after this function has already returned to
            // its caller.
            runPromptedChunksSequentially(context, settings, contextSection, chunks)
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
