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
// describeConstraint, shouldSkipPromptedRefresh, selectBatchVariables,
// isDoneFlag, setVar/applyIncrement, recalculateDependents), and
// re-implements the small (~15 line) transcript-building + prompted/
// increment classification logic locally rather than extracting it out of
// prompted-engine.js. That local duplication is deliberate, not an
// oversight — see this pass's implementation report (Part 8).
//
// Concurrency: independentRunInProgress below guards against two
// independent-preset runs overlapping each other. It does NOT guard
// against overlapping with a standard prompted-engine.js update, because
// prompted-engine.js has no exported "is a prompted update currently
// running" state to check, and adding one means modifying that file —
// which this pass deliberately avoids. Flagged as a real limitation, not
// silently glossed over.
//
// 2026-09-21 (requirements spec 1.29): "independent preset" is formalized
// with a first-class CRUD surface (create/update/delete/list/toggle),
// per-preset enabled/disabled, per-preset variable BATCH selection, the
// three independent-CONTEXT modes (extension-provided / chat-history
// default / explicit-empty), and per-preset run status. All of it lives on
// the SAME preset object as plain fields (preset.independentPreset,
// preset.independentConfig, preset.independentStatus) - not a parallel
// storage system - because a preset already has everything (variables,
// namespace, name, export/import) an "independent preset" also needs; see
// docs/STATE ENGINE API SPECIFICATION.md Section 13 for the full design
// and the deviations from the literal request.

import { LOG_PREFIX, DEFAULT_PROMPTED_HEADER, DEFAULT_UNIFIED_VARIABLE_RULES, getSettings, persistSettings } from '../core/settings-core.js';
import { validateNamespace } from './namespace-manager.js';
import { validateCallerIdentity } from './identity.js';
import { findPresetEntry, createPreset, updatePreset, deletePreset, listPresets } from './preset-api.js';
import { DEFAULT_BATCH } from '../core/variable-schema.js';
import { getVar, setVar, applyIncrement } from '../core/chat-state.js';
import { recalculateDependents } from '../core/calculated-engine.js';
import { callBackgroundLLM } from '../core/background-llm.js';
import { extractJsonObject, stripHtml, describeConstraint } from '../ui/formatting-utils.js';
import { shouldSkipPromptedRefresh, isDoneFlag, selectBatchVariables } from '../core/prompted-engine.js';

// Config fields configureIndependentPreset()/createIndependentPreset()/
// updateIndependentPreset() accept. `context` is deliberately NOT among them
// - see updateIndependentPresetContext() below for why it needs its own,
// narrower entry point.
const CONFIG_FIELDS = ['connectionProfileId', 'temperature', 'maxTokens', 'promptedHeader', 'promptedRules', 'batch', 'enabled', 'historyLimit'];

function pickConfigFields(source) {
    const out = {};
    if (!source || typeof source !== 'object') return out;
    for (const field of CONFIG_FIELDS) if (source[field] !== undefined) out[field] = source[field];
    return out;
}

// namespace.name's preset gets a merged config bag stored on
// preset.independentConfig. Expected (all optional) fields, mirroring the
// existing global stateEngineProfileId/stateEngineTemperature/
// stateEngineMaxTokens override mechanism (src/core/background-llm.js) but
// scoped per-preset: connectionProfileId, temperature, maxTokens,
// promptedHeader, promptedRules, batch (1.29: which variable batch this
// preset's independent run operates on, DEFAULT_BATCH "core" if unset),
// enabled (1.29: false suspends every execution path - see runIndependentPreset).
// `context` is never accepted here - only updateIndependentPresetContext()
// may set it. Kept as the one low-level primitive every higher-level
// function below (create/update) composes on top of, unchanged from before
// this pass, so nothing that already calls it directly breaks.
export function configureIndependentPreset(extensionId, instanceId, namespace, name, config) {
    validateCallerIdentity(extensionId, instanceId, namespace);
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
        preset.independentConfig = { ...(preset.independentConfig || {}), ...pickConfigFields(config) };
        persistSettings();
        return preset.independentConfig;
    } catch (err) {
        console.warn(LOG_PREFIX, 'configureIndependentPreset failed (gracefully handled)', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// CRUD (1.29 item 8: create / update / delete / list / toggle)
//
// None of these reimplement preset storage - they compose preset-api.js's
// already-identity-checked, already-tested CRUD (the SAME functions the
// Presets tab itself uses) with the independentPreset flag and
// configureIndependentPreset's config merge. A regular preset is never
// silently upgraded into, or reached through, these functions: update/
// delete/toggle all require preset.independentPreset === true first -
// "cannot modify other presets" (the request's own wording) is read here as
// "these independent-preset-scoped operations only ever touch a preset that
// IS one." runIndependentPreset() itself is deliberately NOT gated this way
// - see its own comment for why (preserving already-tested behavior).
// ---------------------------------------------------------------------------

function requireIndependentPreset(namespace, name, fnName) {
    const entry = findPresetEntry(namespace, name);
    if (!entry) {
        console.warn(LOG_PREFIX, `${fnName}: preset "${namespace}.${name}" not found`);
        return null;
    }
    const [, preset] = entry;
    if (preset.independentPreset !== true) {
        console.warn(LOG_PREFIX, `${fnName}: "${namespace}.${name}" is not an independent preset`);
        return null;
    }
    return entry;
}

// def: { namespace, name, description?, connectionProfileId?, temperature?,
// maxTokens?, promptedHeader?, promptedRules?, batch?, enabled? }. One atomic
// operation from the caller's view: if the underlying createPreset() call
// fails (bad namespace, name already taken, ...) nothing else runs. Returns
// the created preset (with its id and independentPreset/independentConfig
// fields) or null.
export function createIndependentPreset(extensionId, instanceId, def) {
    validateCallerIdentity(extensionId, instanceId, def?.namespace);
    try {
        const created = createPreset(extensionId, instanceId, {
            namespace: def?.namespace, name: def?.name, description: def?.description,
        });
        if (!created) return null;
        const entry = findPresetEntry(def.namespace, def.name);
        const [, preset] = entry;
        preset.independentPreset = true;
        preset.independentConfig = pickConfigFields(def);
        persistSettings();
        return { ...preset, id: created.id };
    } catch (err) {
        console.warn(LOG_PREFIX, 'createIndependentPreset failed (gracefully handled)', err);
        return null;
    }
}

// patch: { name? (rename), description?, ...the same config fields as
// createIndependentPreset }. Renaming/description go through preset-api.js's
// updatePreset (the one place that logic lives); everything else merges into
// independentConfig exactly like configureIndependentPreset. Returns the
// updated preset, or null (including when namespace.name is not an
// independent preset - see requireIndependentPreset).
export function updateIndependentPreset(extensionId, instanceId, namespace, name, patch) {
    validateCallerIdentity(extensionId, instanceId, namespace);
    try {
        if (!requireIndependentPreset(namespace, name, 'updateIndependentPreset')) return null;
        const configFields = pickConfigFields(patch);
        const presetPatch = {};
        if (typeof patch?.name === 'string') presetPatch.name = patch.name;
        if (patch?.description !== undefined) presetPatch.description = patch.description;

        const updated = Object.keys(presetPatch).length > 0
            ? updatePreset(extensionId, instanceId, namespace, name, presetPatch)
            : findPresetEntry(namespace, name)?.[1];
        if (!updated) return null;

        const finalName = typeof patch?.name === 'string' ? patch.name : name;
        if (Object.keys(configFields).length > 0) {
            configureIndependentPreset(extensionId, instanceId, namespace, finalName, configFields);
        }
        return findPresetEntry(namespace, finalName)?.[1] ?? null;
    } catch (err) {
        console.warn(LOG_PREFIX, 'updateIndependentPreset failed (gracefully handled)', err);
        return null;
    }
}

// Refuses (returns false) when namespace.name is not an independent preset -
// use the plain deletePreset() (preset-api.js) for a regular one.
export function deleteIndependentPreset(extensionId, instanceId, namespace, name) {
    validateCallerIdentity(extensionId, instanceId, namespace);
    try {
        if (!requireIndependentPreset(namespace, name, 'deleteIndependentPreset')) return false;
        return deletePreset(extensionId, instanceId, namespace, name);
    } catch (err) {
        console.warn(LOG_PREFIX, 'deleteIndependentPreset failed (gracefully handled)', err);
        return false;
    }
}

// listPresets() (preset-api.js) filtered to independentPreset === true - same
// shape as every entry listPresets() already returns, so nothing new to learn.
export function listIndependentPresets(extensionId, instanceId, namespace) {
    validateCallerIdentity(extensionId, instanceId, namespace);
    try {
        return listPresets(extensionId, instanceId, namespace).filter((p) => p.independentPreset === true);
    } catch (err) {
        console.warn(LOG_PREFIX, 'listIndependentPresets failed (gracefully handled)', err);
        return [];
    }
}

// Sets independentConfig.enabled. false suspends every execution path
// (runIndependentPreset refuses immediately, before the concurrency lock or
// any LLM call) until toggled back on. Returns the new enabled value, or
// null when namespace.name is not an independent preset.
export function toggleIndependentPreset(extensionId, instanceId, namespace, name, enabled) {
    validateCallerIdentity(extensionId, instanceId, namespace);
    try {
        if (!requireIndependentPreset(namespace, name, 'toggleIndependentPreset')) return null;
        const config = configureIndependentPreset(extensionId, instanceId, namespace, name, { enabled: !!enabled });
        return config ? config.enabled : null;
    } catch (err) {
        console.warn(LOG_PREFIX, 'toggleIndependentPreset failed (gracefully handled)', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Independent context (1.29 / request Section 3) - its own entry point,
// deliberately separate from configureIndependentPreset's generic merge, so
// a blind config spread can never accidentally set or clear it: "context is
// always extension-owned" (request Section 8's closing line).
//
// Whether a context was ever supplied is tracked by the PRESENCE of the
// "context" key on independentConfig, not by its value - so:
//   never called                                -> key absent    -> mode B (chat history)
//   called with null / undefined / {} (no keys) -> key present   -> mode C (empty)
//   called with anything else                   -> key present   -> mode A (pass through, untouched)
// This means calling this function AT ALL commits the preset to modes A/C
// from then on; there is no way back to "as if never called" (mode B) short
// of recreating the preset. That reading matches the request's own three
// rules literally (they describe "supplied" vs "not supplied," not "supplied,
// then un-supplied") - flagged as a deliberate interpretation, not an
// oversight, in the API spec.
// ---------------------------------------------------------------------------

export function isEmptyIndependentContext(context) {
    if (context === null || context === undefined) return true;
    return typeof context === 'object' && !Array.isArray(context) && Object.keys(context).length === 0;
}

// Returns { mode, context } - mode is 'extension' | 'chat-history' | 'empty';
// context is the raw stored value for 'extension' mode, else undefined.
export function independentContextMode(config) {
    if (!config || !Object.prototype.hasOwnProperty.call(config, 'context')) return { mode: 'chat-history' };
    return isEmptyIndependentContext(config.context) ? { mode: 'empty' } : { mode: 'extension', context: config.context };
}

// context: any | undefined - never interpreted, validated or mutated (request
// Section 3.A). Returns true, or false when namespace.name is not an
// independent preset.
export function updateIndependentPresetContext(extensionId, instanceId, namespace, name, context) {
    validateCallerIdentity(extensionId, instanceId, namespace);
    try {
        const entry = requireIndependentPreset(namespace, name, 'updateIndependentPresetContext');
        if (!entry) return false;
        const [, preset] = entry;
        preset.independentConfig = { ...(preset.independentConfig || {}), context };
        persistSettings();
        return true;
    } catch (err) {
        console.warn(LOG_PREFIX, 'updateIndependentPresetContext failed (gracefully handled)', err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Status (1.29 / request Section 7's "last run time / last output summary /
// variable changes from last run", Section 8's "get independent preset
// status"). Open read, no identity - same convention as getVariable()/
// getDependents(): this is about a preset the caller can already see via
// listIndependentPresets(), not a privileged write.
// ---------------------------------------------------------------------------

function recordStatus(preset, patch) {
    preset.independentStatus = { ...(preset.independentStatus || {}), lastRunAt: Date.now(), ...patch };
    persistSettings();
}

// -> { enabled, batch, contextMode, lastRunAt, lastOutcome, lastError,
// changedVariables } or null when namespace.name is not an independent
// preset. lastRunAt is null and lastOutcome is 'never-run' before the first run.
export function getIndependentPresetStatus(namespace, name) {
    try {
        const entry = findPresetEntry(namespace, name);
        if (!entry || entry[1].independentPreset !== true) return null;
        const [, preset] = entry;
        const config = preset.independentConfig || {};
        const status = preset.independentStatus || {};
        return {
            enabled: config.enabled !== false,
            batch: config.batch || DEFAULT_BATCH,
            contextMode: independentContextMode(config).mode,
            lastRunAt: status.lastRunAt ?? null,
            lastOutcome: status.lastOutcome ?? 'never-run',
            lastError: status.lastError ?? null,
            changedVariables: Array.isArray(status.changedVariables) ? [...status.changedVariables] : [],
        };
    } catch (err) {
        console.warn(LOG_PREFIX, 'getIndependentPresetStatus failed (gracefully handled)', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

let independentRunInProgress = false;

// An `any`-typed extension context turned into prompt text without ever
// interpreting its shape: a string is used as-is, anything else is
// JSON.stringify'd (falling back to String() for anything that cannot be -
// a function, a circular structure, a DOM node...). Never throws.
function describeIndependentContext(context) {
    if (typeof context === 'string') return context;
    try {
        return JSON.stringify(context, null, 2);
    } catch {
        return String(context);
    }
}

// presetRef: { namespace, name }. Awaited (not fire-and-forget, unlike
// prompted-engine.js's runPromptedStateUpdate) so a future sequential
// dispatcher (Section 3, "Independent Presets") can run several of these
// one at a time in order.
//
// Deliberately NOT gated on preset.independentPreset === true (unlike every
// CRUD/status function above): this is the same dispatcher extensions have
// been calling on ANY preset since 2026-09-10, and gating it now would
// silently break that already-tested, already-documented behavior for no
// benefit — "cannot modify other presets" is about SCOPE (it only ever
// touches ITS OWN preset's variables), not about which presets may be run
// this way. Flagged as a deliberate deviation from a literal "independent
// preset = a distinct type only these functions operate on" reading; see
// the API spec.
export function runIndependentPreset(extensionId, instanceId, chatId, presetRef) {
    // Deliberately NOT an `async function` itself: an async function turns a
    // thrown identity error into a rejected Promise instead of a synchronous
    // throw. The check runs synchronously here, then hands off to the
    // (unchanged) async pipeline below - callers still get a Promise back.
    validateCallerIdentity(extensionId, instanceId, presetRef?.namespace);
    return runIndependentPresetInternal(chatId, presetRef);
}

async function runIndependentPresetInternal(chatId, presetRef) {
    let preset = null;
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
        preset = entry[1];

        const config = preset.independentConfig || {};

        // 1.29: the enabled/disabled toggle is checked BEFORE the concurrency
        // lock and before anything else - a disabled preset never queues,
        // never blocks another run, never calls the LLM.
        if (config.enabled === false) {
            console.warn(LOG_PREFIX, `runIndependentPreset: "${presetRef.namespace}.${presetRef.name}" is disabled`);
            recordStatus(preset, { lastOutcome: 'skipped-disabled' });
            return false;
        }

        if (independentRunInProgress) {
            console.warn(LOG_PREFIX, 'runIndependentPreset: another independent preset run is already in progress, skipping');
            recordStatus(preset, { lastOutcome: 'skipped-in-progress' });
            return false;
        }

        const context = SillyTavern.getContext();

        // 1.29: which variable batch this preset operates on (request Section 5;
        // DEFAULT_BATCH "core" when unset, same default every other variable
        // gets). Previously this used EVERY prompted/incrementable variable in
        // the preset with no batch filtering at all - a real gap against the
        // spec, fixed here using the exact same selectBatchVariables()
        // prompted-engine.js's own main loop uses.
        const batch = config.batch || DEFAULT_BATCH;
        const variables = selectBatchVariables(preset.variables || {}, batch);
        const updateVars = [];
        const incrementVars = [];
        for (const def of variables) {
            if (!def?.name) continue;
            // 1.28: a flag-mode boolean that already fired is left out here too - the
            // same rule as the main prompted engine (prompted-engine.js), and for the
            // same reason (nothing prompted can reset it, so asking wastes tokens).
            const isPromptedUpdate = def.behaviors?.prompted === true && def.behaviors?.increment !== true && !isDoneFlag(chatId, def) && !shouldSkipPromptedRefresh(def);
            const isPromptedIncrement = def.behaviors?.prompted === true && def.behaviors?.increment === true && !isDoneFlag(chatId, def);
            if (isPromptedUpdate) updateVars.push(def);
            else if (isPromptedIncrement) incrementVars.push(def);
        }
        if (updateVars.length === 0 && incrementVars.length === 0) {
            recordStatus(preset, { lastOutcome: 'skipped-nothing-to-update', changedVariables: [] });
            return false;
        }

        const settings = getSettings();

        // 1.29: the independent context (request Section 3/6). Chat history is
        // only built - and context.chat only required to exist - in mode
        // 'chat-history': an extension-provided or explicitly-empty context
        // means this preset does not depend on the chat at all.
        const { mode: contextMode, context: independentContext } = independentContextMode(config);
        let contextSection;
        if (contextMode === 'chat-history') {
            if (!Array.isArray(context.chat)) return false;
            // 1.29: request Section 7's per-preset "history limit" - overrides the
            // global contextMessageCount when set, still capped by
            // maxPromptHistoryMessages exactly like the global one always was.
            const userRequestedCount = Math.max(1, Number(config.historyLimit) || Number(settings.contextMessageCount) || 10);
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
            contextSection = transcript ? `Recent conversation:\n${transcript}` : 'No conversation yet.';
        } else if (contextMode === 'extension') {
            contextSection = `Independent context:\n${describeIndependentContext(independentContext)}`;
        } else {
            contextSection = ''; // empty mode: purely variables, no context section at all
        }

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
        if (!varLines.trim()) {
            recordStatus(preset, { lastOutcome: 'skipped-nothing-to-update', changedVariables: [] });
            return false;
        }

        // 1.29: no WI, fantasy-calendar/image-variable metadata, other presets,
        // or SillyTavern's own chat system messages are ever added here (request
        // Section 6) - the prompt is built ONLY from the header/rules text, the
        // context section above, and this preset's own variable lines.
        const promptSections = [
            config.promptedHeader || settings.promptedHeader || DEFAULT_PROMPTED_HEADER,
            config.promptedRules || settings.promptedRules || DEFAULT_UNIFIED_VARIABLE_RULES,
            '',
            contextSection,
        ];
        if (updateVarLines) promptSections.push('', 'Update variables:', updateVarLines);
        if (incrementVarLines) promptSections.push('', 'Boolean-conditional variables (include all in JSON output):', incrementVarLines);

        const messages = [
            { role: 'system', content: promptSections.filter((s) => s !== '').join('\n') },
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
                recordStatus(preset, { lastOutcome: 'skipped-parse-error', lastError: 'response was not valid JSON', changedVariables: [] });
                return false;
            }

            const changed = [];
            let updatedCount = 0;
            for (const def of updateVars) {
                try {
                    if (!Object.prototype.hasOwnProperty.call(parsed, def.name)) continue;
                    const rawValue = parsed[def.name];
                    if (def.type === 'array' && !Array.isArray(rawValue)) continue;
                    setVar(chatId, def.name, rawValue, def);
                    recalculateDependents(chatId, def.name);
                    updatedCount++;
                    changed.push(def.name);
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
                        changed.push(def.name);
                    }
                } catch (err) {
                    console.warn(LOG_PREFIX, `runIndependentPreset: increment failed for variable "${def.name}" (gracefully handled)`, err);
                }
            }

            const didWrite = updatedCount > 0 || incrementedCount > 0;
            recordStatus(preset, { lastOutcome: didWrite ? 'updated' : 'no-op', lastError: null, changedVariables: changed });
            return didWrite;
        } finally {
            independentRunInProgress = false;
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'runIndependentPreset failed (gracefully handled)', err);
        independentRunInProgress = false;
        if (preset) recordStatus(preset, { lastOutcome: 'error', lastError: err?.message || String(err), changedVariables: [] });
        return false;
    }
}
