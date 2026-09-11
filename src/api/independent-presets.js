// Independent Presets Dispatcher
//
// "Independent" presets run their prompted update on their own call
// (runIndependentPreset) instead of the standard per-message trigger flow
// in src/core/prompted-engine.js. This module deliberately does NOT modify
// prompted-engine.js — that file is the codebase's highest-priority,
// already-stabilized area, per standing project instructions to keep
// working behavior working. Instead it reuses everything from
// prompted-engine.js's flow that was already exported and safe to call
// from outside (callBackgroundLLM, stripHtml, extractJsonObject,
// describeConstraint, shouldSkipPromptedRefresh, setVar/applyIncrement,
// recalculateDependents), and re-implements the small (~15 line)
// transcript-building + prompted/increment classification logic locally
// rather than extracting it out of prompted-engine.js. That local
// duplication is deliberate, not an oversight — see this pass's
// implementation report (Part 8).
//
// Concurrency: independentRunInProgress below guards against two
// independent-preset runs overlapping each other. It does NOT guard
// against overlapping with a standard prompted-engine.js update, because
// prompted-engine.js has no exported "is a prompted update currently
// running" state to check, and adding one means modifying that file —
// which this pass deliberately avoids. Flagged as a real limitation, not
// silently glossed over.

import { LOG_PREFIX, DEFAULT_PROMPTED_HEADER, DEFAULT_UNIFIED_VARIABLE_RULES, getSettings, persistSettings } from '../core/settings-core.js';
import { validateNamespace } from './namespace-manager.js';
import { findPresetEntry } from './preset-api.js';
import { getVar, setVar, applyIncrement } from '../core/chat-state.js';
import { recalculateDependents } from '../core/calculated-engine.js';
import { callBackgroundLLM } from '../core/background-llm.js';
import { extractJsonObject, stripHtml, describeConstraint } from '../ui/formatting-utils.js';
import { shouldSkipPromptedRefresh } from '../core/prompted-engine.js';

// namespace.name's preset gets a merged config bag stored on
// preset.independentConfig. Expected (all optional) fields, mirroring the
// existing global stateEngineProfileId/stateEngineTemperature/
// stateEngineMaxTokens override mechanism (src/core/background-llm.js) but
// scoped per-preset: connectionProfileId, temperature, maxTokens,
// promptedHeader, promptedRules.
export function configureIndependentPreset(namespace, name, config) {
    try {
        if (!validateNamespace(namespace)) {
            console.warn(LOG_PREFIX, `configureIndependentPreset: namespace "${namespace}" is not registered`);
            return null;
        }
        const entry = findPresetEntry(namespace, name);
        if (!entry) {
            console.warn(LOG_PREFIX, `configureIndependentPreset: preset "${namespace}.${name}" not found`);
            return null;
        }
        const [, preset] = entry;
        preset.independentConfig = { ...(preset.independentConfig || {}), ...(config || {}) };
        persistSettings();
        return preset.independentConfig;
    } catch (err) {
        console.warn(LOG_PREFIX, 'configureIndependentPreset failed (gracefully handled)', err);
        return null;
    }
}

let independentRunInProgress = false;

// presetRef: { namespace, name }. Awaited (not fire-and-forget, unlike
// prompted-engine.js's runPromptedStateUpdate) so a future sequential
// dispatcher (Section 3, "Independent Presets") can run several of these
// one at a time in order.
export async function runIndependentPreset(chatId, presetRef) {
    try {
        if (!chatId || !presetRef || !presetRef.namespace || !presetRef.name) {
            console.warn(LOG_PREFIX, 'runIndependentPreset requires chatId and presetRef.{namespace, name}');
            return false;
        }
        if (!validateNamespace(presetRef.namespace)) {
            console.warn(LOG_PREFIX, `runIndependentPreset: namespace "${presetRef.namespace}" is not registered`);
            return false;
        }
        const entry = findPresetEntry(presetRef.namespace, presetRef.name);
        if (!entry) {
            console.warn(LOG_PREFIX, `runIndependentPreset: preset "${presetRef.namespace}.${presetRef.name}" not found`);
            return false;
        }
        const [, preset] = entry;

        if (independentRunInProgress) {
            console.warn(LOG_PREFIX, 'runIndependentPreset: another independent preset run is already in progress, skipping');
            return false;
        }

        const context = SillyTavern.getContext();
        if (!Array.isArray(context.chat)) return false;

        const variables = Object.values(preset.variables || {});
        const updateVars = [];
        const incrementVars = [];
        for (const def of variables) {
            if (!def?.name) continue;
            const isPromptedUpdate = def.behaviors?.prompted === true && def.behaviors?.increment !== true && !shouldSkipPromptedRefresh(def);
            const isPromptedIncrement = def.behaviors?.prompted === true && def.behaviors?.increment === true;
            if (isPromptedUpdate) updateVars.push(def);
            else if (isPromptedIncrement) incrementVars.push(def);
        }
        if (updateVars.length === 0 && incrementVars.length === 0) return false;

        const settings = getSettings();
        const config = preset.independentConfig || {};

        const userRequestedCount = Math.max(1, Number(settings.contextMessageCount) || 10);
        const historyCap = Math.max(1, Number(settings.maxPromptHistoryMessages) || userRequestedCount);
        const count = Math.min(historyCap, userRequestedCount);
        const recent = context.chat.slice(-count);
        const maxMessageLength = Number(settings.maxMessageLength) || 0;
        const transcript = recent
            .map((m) => {
                const speaker = m.is_user ? (context.name1 || 'User') : (m.name || context.name2 || 'Character');
                let text = stripHtml(m.mes);
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
                const instructions = (def.prompted?.instructions || def.description || '').trim();
                return `- "${def.name}"[true or false]: ${instructions}`;
            })
            .join('\n');

        const varLines = [updateVarLines, incrementVarLines].filter(Boolean).join('\n');
        if (!varLines.trim()) return false;

        const promptSections = [
            config.promptedHeader || settings.promptedHeader || DEFAULT_PROMPTED_HEADER,
            config.promptedRules || settings.promptedRules || DEFAULT_UNIFIED_VARIABLE_RULES,
            '',
            transcript ? `Recent conversation:\n${transcript}` : 'No conversation yet.',
        ];
        if (updateVarLines) promptSections.push('', 'Update variables:', updateVarLines);
        if (incrementVarLines) promptSections.push('', 'Boolean-conditional variables (include all in JSON output):', incrementVarLines);

        const messages = [
            { role: 'system', content: promptSections.join('\n') },
            { role: 'user', content: 'Output the JSON object now. JSON only, no other text.' },
        ];

        const maxTokens = Number(config.maxTokens ?? settings.responseLength) || 300;

        // Per-preset alternate-LLM support (Section 3, Independent Presets):
        // composed on top of callBackgroundLLM's own real connection-profile
        // override/fallback logic (src/core/background-llm.js) by passing it
        // a shallow-copied settings object — never by modifying that file
        // or the real persisted settings.
        const effectiveSettings = {
            ...settings,
            stateEngineProfileId: config.connectionProfileId ?? settings.stateEngineProfileId,
            stateEngineTemperature: config.temperature ?? settings.stateEngineTemperature,
            stateEngineMaxTokens: config.maxTokens ?? settings.stateEngineMaxTokens,
        };

        independentRunInProgress = true;
        try {
            const raw = await callBackgroundLLM(context, effectiveSettings, messages, maxTokens);
            const parsed = extractJsonObject(raw);
            if (!parsed) {
                console.warn(LOG_PREFIX, 'runIndependentPreset: could not parse a JSON object from the model response:', raw);
                return false;
            }

            let updatedCount = 0;
            for (const def of updateVars) {
                try {
                    if (!Object.prototype.hasOwnProperty.call(parsed, def.name)) continue;
                    const rawValue = parsed[def.name];
                    if (def.type === 'array' && !Array.isArray(rawValue)) continue;
                    setVar(chatId, def.name, rawValue, def);
                    recalculateDependents(chatId, def.name);
                    updatedCount++;
                } catch (err) {
                    console.warn(LOG_PREFIX, `runIndependentPreset: update failed for variable "${def.name}" (gracefully handled)`, err);
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
                    console.warn(LOG_PREFIX, `runIndependentPreset: increment failed for variable "${def.name}" (gracefully handled)`, err);
                }
            }

            return updatedCount > 0 || incrementedCount > 0;
        } finally {
            independentRunInProgress = false;
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'runIndependentPreset failed (gracefully handled)', err);
        independentRunInProgress = false;
        return false;
    }
}
