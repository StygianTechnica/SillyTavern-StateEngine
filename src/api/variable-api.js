// Variable API
//
// Delegates variable value/lifecycle logic to src/core/chat-state.js
// (seedVariablesForChat, resetValueIfTypeChanged, deleteVariableValueEverywhere)
// and src/core/calculated-engine.js (recalculateAllForChat) — this module
// only owns namespaced addressing and the preset.variables insertion
// itself.
//
// Namespaced storage key (why): chat-state.js/macro-store.js key every
// variable by its bare def.name — preset-manager.js's isVariableNameTaken()
// comment documents a real, already-fixed bug where two variables sharing
// a name (even across different presets) silently collide in both stores.
// A namespace tag that lived only in API-layer metadata (not in def.name
// itself) would not prevent that same collision between two namespaces —
// it would just add a permission check in front of the exact bug that was
// already root-caused once. So every variable created through this module
// is stored under the fully-qualified name `${namespace}__${localName}`
// (e.g. "pp__mood") — collision-proof against the existing global-by-name
// store with zero changes to chat-state.js/macro-store.js.
//
// Delimiter is "__", not "." (2026-09-10 fix): a calculated variable's
// dependencies/expression reference other variables by their literal
// def.name (calculated-engine.js, expression-dsl.js). The DSL's tokenizer
// treats "." as property-access syntax ("arr.length", "s.upper()") — a
// dotted identifier like "se.mood" tokenizes as ident("se") + op(".") +
// ident("mood"), not one identifier, so evaluateExpression() rejects it
// ("Identifier "se" is not in this variable's dependencies") every time.
// "__" is a normal identifier character with no such collision, and needed
// no changes to expression-dsl.js (deliberately pure/self-contained per its
// own header comment) to work correctly. Root-caused by actually evaluating
// an expression through the real engine, not just checking the stored
// dependency string matched - see this pass's implementation report.

import { LOG_PREFIX, persistSettings } from '../core/settings-core.js';
import { validateNamespace } from './namespace-manager.js';
import { validateCallerIdentity, resolveCallerRecord } from './identity.js';
import { normalizeBatchName } from './batch-rules.js';
import { findPresetEntry } from './preset-api.js';
import { blankDefinition, TIME_BATCH } from '../core/variable-schema.js';
import * as calendarEngine from '../core/calendar-engine.js';
import { getCalendar, toScalar } from '../core/calendar-engine.js';
import { isVariableNameTaken } from '../core/preset-manager.js';
import { seedVariablesForChat, resetValueIfTypeChanged, deleteVariableValueEverywhere } from '../core/chat-state.js';
import { recalculateAllForChat, evaluateCalculatedVariable, recalculateDependents } from '../core/calculated-engine.js';
import { extractIdentifiers } from '../core/expression-dsl.js';
import { refreshVariableMacros } from '../core/macro-registration.js';

function qualifiedName(namespace, localName) {
    return `${namespace}__${localName}`;
}

// Returns [varId, def] for the variable stored under namespace.localName
// inside `preset`, or null if not found.
function findVariableEntry(preset, namespace, localName) {
    const target = qualifiedName(namespace, localName);
    for (const [varId, def] of Object.entries(preset?.variables || {})) {
        if (def?.name === target) return [varId, def];
    }
    return null;
}

// A `batch` carried by a definition or patch goes through the same rule as
// assignBatch() (batch-rules.js), so no entry point can store a batch name
// the others would refuse. Follows this module's convention for a bad
// payload: warn and signal failure (ok: false), never throw.
function checkedBatch(value, fnName) {
    try {
        return { ok: true, batch: normalizeBatchName(value, (reason) => { throw new Error(reason); }) };
    } catch (err) {
        console.warn(LOG_PREFIX, `${fnName}: ${err.message}`);
        return { ok: false };
    }
}

// Datetime rules (requirements spec 1.21) shared by createVariable() and
// updateVariable(), checked on the fully-merged definition: the calendar it
// names must exist, its unit must be the one this engine stores ("seconds"),
// and its defaultValue must be convertible to scalar time. On success the
// defaultValue is rewritten as that scalar, the canonical stored form, so an
// ISO string given by a caller is converted once, here. Returns { ok: true }
// or { ok: false, error } - never throws.
function checkedDatetime(def, fnName) {
    const calendarId = def.calendar ?? 'gregorian';
    if (!getCalendar(calendarId)) {
        return { ok: false, error: `${fnName}: calendar "${calendarId}" does not exist` };
    }
    if (def.unit !== undefined && def.unit !== 'seconds') {
        return { ok: false, error: `${fnName}: datetime unit must be "seconds" (got "${def.unit}")` };
    }
    const scalar = toScalar(calendarId, def.defaultValue);
    if (scalar === null) {
        return { ok: false, error: `${fnName}: defaultValue ${JSON.stringify(def.defaultValue)} is not a number of seconds or an ISO date such as "2026-09-18 22:00"` };
    }
    def.calendar = calendarId;
    def.defaultValue = scalar;
    return { ok: true };
}

function currentChatId() {
    try {
        return SillyTavern.getContext().chatId;
    } catch {
        return null;
    }
}

// Validates a calculated-variable definition and derives its real
// dependency set directly from def.expression via expression-dsl.js's
// extractIdentifiers() - the same tokenizer/parser evaluateExpression()
// itself uses, so "is this syntactically valid" and "what does it depend
// on" are answered from one source of truth, never a separately-supplied
// dependencies array that could drift out of sync with the expression (a
// real gap in the manager-modal UI's own hand-picked-checkbox flow, which
// this validates against but does not change).
//
// Preset-local dependency rule: every identifier the expression
// references must exist as a variable's name in the SAME preset. This is
// enforced HERE, at the API boundary, not inside calculated-engine.js
// itself - the core engine's own dependency resolution
// (calculated-engine.js's buildCalculatedGraph/getVar) is global-by-name
// per chat, not preset-scoped, and nothing there currently enforces
// preset-locality (verified by reading it fresh, not assumed - blankDefinition()'s
// "in the same preset" comment states the design intent, but no code
// actually checks it today). Enforcing it only at this new, stricter API
// entry point - never touching calculated-engine.js's existing, more
// permissive runtime behavior - keeps this additive rather than a
// backwards-incompatible change to what the manager-modal UI already
// allows.
//
// def: { type, expression, namespace, presetName, ... }. Returns
// { ok: true, deps } or { ok: false, error } - never throws.
function validateCalculatedDefinitionInternal(def) {
    try {
        if (def?.type !== 'calculated') {
            return { ok: false, error: 'validateCalculatedDefinition: def.type must be "calculated"' };
        }
        if (!def.namespace || !def.presetName) {
            return { ok: false, error: 'validateCalculatedDefinition requires def.namespace and def.presetName' };
        }
        const presetEntry = findPresetEntry(def.namespace, def.presetName);
        if (!presetEntry) {
            return { ok: false, error: `preset "${def.namespace}.${def.presetName}" not found` };
        }
        const [, preset] = presetEntry;

        const parsed = extractIdentifiers(def.expression);
        if (!parsed.ok) {
            return { ok: false, error: `invalid expression: ${parsed.error}` };
        }

        const presetVarNames = new Set(Object.values(preset.variables || {}).map((v) => v?.name).filter(Boolean));
        const missing = parsed.identifiers.find((name) => !presetVarNames.has(name));
        if (missing) {
            return { ok: false, error: `dependency "${missing}" does not exist in preset "${def.presetName}"` };
        }

        return { ok: true, deps: parsed.identifiers };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

// Applies an already-validated calculated definition: stores the derived
// dependencies onto `def`, evaluates it for the current chat, cascades
// recalculation to whatever already depends on it, and refreshes macro
// registration - the same lifecycle steps every other write path in this
// codebase already performs (chat-state.js/calculated-engine.js/
// macro-registration.js), centralized here so createVariable()/
// updateVariable() share one implementation instead of two copies. `ref`
// is accepted (not otherwise needed by this function's own logic) so a
// caller/log line can always identify which variable this run was for -
// see createVariable()/updateVariable()'s call sites.
function applyCalculatedDefinitionInternal(ref, def, deps) {
    try {
        def.dependencies = deps;

        const chatId = currentChatId();
        if (chatId) {
            // seedVariablesForChat() first, so this variable (and any
            // dependency that isn't seeded yet either) has a real stored
            // entry for evaluateCalculatedVariable()'s getVar() calls to
            // read - never resets an existing value (1.12).
            seedVariablesForChat(chatId);
            evaluateCalculatedVariable(chatId, def);
            recalculateDependents(chatId, def.name);
        }
        refreshVariableMacros();
    } catch (err) {
        console.warn(LOG_PREFIX, `applyCalculatedDefinition failed for "${ref?.namespace}.${ref?.presetName}.${ref?.variableName}" (gracefully handled)`, err);
    }
}

// Identity-checked public wrappers. createVariable()/updateVariable() call
// the unchecked *Internal versions directly - they already validated the
// caller's identity once at their own entry point.
export function validateCalculatedDefinition(extensionId, instanceId, def) {
    validateCallerIdentity(extensionId, instanceId, def?.namespace);
    return validateCalculatedDefinitionInternal(def);
}

export function applyCalculatedDefinition(extensionId, instanceId, ref, def, deps) {
    validateCallerIdentity(extensionId, instanceId, ref?.namespace);
    return applyCalculatedDefinitionInternal(ref, def, deps);
}

export function createVariable(extensionId, instanceId, def) {
    validateCallerIdentity(extensionId, instanceId, def?.namespace);
    try {
        if (!def || !def.namespace || !def.presetName || !def.name) {
            console.warn(LOG_PREFIX, 'createVariable requires def.namespace, def.presetName, and def.name');
            return null;
        }
        // A variable's value is never set through its definition - it lives
        // exclusively in chat-state.js's isolated store, written only
        // through setVar()/applyIncrement() (spec 1.1/1.6), and for a
        // calculated variable specifically, only ever through
        // calculated-engine.js's own expression evaluation (spec 1.17).
        // Rejecting def.value outright (not silently stripping it) makes
        // that invariant a definition-time error instead of a silent no-op.
        if (def.value !== undefined) {
            console.warn(LOG_PREFIX, 'createVariable: def.value is not allowed - a variable\'s value is never set through its definition');
            return null;
        }
        if (!validateNamespace(def.namespace)) {
            console.warn(LOG_PREFIX, `createVariable: namespace "${def.namespace}" is not registered`);
            return null;
        }
        const presetEntry = findPresetEntry(def.namespace, def.presetName);
        if (!presetEntry) {
            console.warn(LOG_PREFIX, `createVariable: preset "${def.namespace}.${def.presetName}" not found`);
            return null;
        }
        const [, preset] = presetEntry;

        const target = qualifiedName(def.namespace, def.name);
        if (isVariableNameTaken(target)) {
            console.warn(LOG_PREFIX, `createVariable: variable name "${target}" is already in use`);
            return null;
        }

        let validation = null;
        if (def.type === 'calculated') {
            validation = validateCalculatedDefinitionInternal(def);
            if (!validation.ok) {
                console.warn(LOG_PREFIX, `createVariable: invalid calculated definition - ${validation.error}`);
                return null;
            }
        }

        const { namespace: _ns, presetName: _presetName, name: _localName, id: _ignoredId, ...rest } = def;
        const fullDef = { ...blankDefinition(), ...rest, name: target };
        if (def.batch !== undefined) {
            const checked = checkedBatch(def.batch, 'createVariable');
            if (!checked.ok) return null;
            fullDef.batch = checked.batch;
        }
        if (fullDef.type === 'datetime') {
            const datetime = checkedDatetime(fullDef, 'createVariable');
            if (!datetime.ok) {
                console.warn(LOG_PREFIX, datetime.error);
                return null;
            }
            // Datetime variables live in batch "time" unless the caller
            // chose another (a batch given in `def` was applied above).
            if (def.batch === undefined) fullDef.batch = TIME_BATCH;
        }

        // Nothing is written to settings.presets until validation (above)
        // has already passed - a rejected calculated definition never
        // touches stored state at all.
        preset.variables[fullDef.id] = fullDef;
        persistSettings();

        if (validation) {
            // Calculated: dependency registration + initial evaluation +
            // dependents recalculation + macro refresh, all synchronous -
            // see applyCalculatedDefinition()'s own header comment.
            applyCalculatedDefinitionInternal(
                { namespace: def.namespace, presetName: def.presetName, variableName: def.name },
                fullDef,
                validation.deps,
            );
            return fullDef;
        }

        const chatId = currentChatId();
        if (chatId) {
            seedVariablesForChat(chatId);
            recalculateAllForChat(chatId);
        }
        refreshVariableMacros();

        return fullDef;
    } catch (err) {
        console.warn(LOG_PREFIX, 'createVariable failed (gracefully handled)', err);
        return null;
    }
}

export function updateVariable(extensionId, instanceId, ref, patch) {
    validateCallerIdentity(extensionId, instanceId, ref?.namespace);
    try {
        if (!ref || !ref.namespace || !ref.presetName || !ref.variableName) {
            console.warn(LOG_PREFIX, 'updateVariable requires ref.namespace, ref.presetName, and ref.variableName');
            return null;
        }
        // See createVariable()'s matching check - a variable's value is
        // never set through its definition, calculated or otherwise.
        if (patch && patch.value !== undefined) {
            console.warn(LOG_PREFIX, 'updateVariable: patch.value is not allowed - a variable\'s value is never set through its definition');
            return null;
        }
        if (!validateNamespace(ref.namespace)) {
            console.warn(LOG_PREFIX, `updateVariable: namespace "${ref.namespace}" is not registered`);
            return null;
        }
        const presetEntry = findPresetEntry(ref.namespace, ref.presetName);
        if (!presetEntry) {
            console.warn(LOG_PREFIX, `updateVariable: preset "${ref.namespace}.${ref.presetName}" not found`);
            return null;
        }
        const [, preset] = presetEntry;
        const varEntry = findVariableEntry(preset, ref.namespace, ref.variableName);
        if (!varEntry) {
            console.warn(LOG_PREFIX, `updateVariable: variable "${ref.namespace}.${ref.variableName}" not found`);
            return null;
        }
        const [varId, def] = varEntry;

        const safePatch = { ...(patch || {}) };
        delete safePatch.id;

        // A renamed local name is re-qualified into the same namespace — an
        // extension may not move a variable to a different namespace via
        // patch, matching updatePreset()'s same rule.
        if (typeof safePatch.name === 'string') {
            const newTarget = qualifiedName(ref.namespace, safePatch.name);
            if (newTarget !== def.name) {
                if (isVariableNameTaken(newTarget, def.id)) {
                    console.warn(LOG_PREFIX, `updateVariable: variable name "${newTarget}" is already in use`);
                    return null;
                }
                // Renaming leaves any already-stored per-chat value behind
                // under the old key — chat-state.js has no rename-migration
                // path, and neither does the manager-modal inline editor
                // this mirrors; out of scope for this pass.
                safePatch.name = newTarget;
            } else {
                delete safePatch.name;
            }
        }

        // A fresh object, not Object.assign(def, safePatch): chat-state.js's
        // isolated-store snapshot (entry.def, see chat-state.js's setVar)
        // is the *same object reference* as this preset.variables[varId]
        // entry — preset-manager.js's getAllVariablesFromPresets() never
        // clones. Mutating def in place would mutate entry.def out from
        // under resetValueIfTypeChanged() before it runs, so it could never
        // see the old type to compare against. The manager-modal inline
        // editor (ui-events.js) avoids exactly this by building a new
        // object and replacing preset.variables[id] wholesale — mirrored
        // here, root-caused against this module's own functional smoke
        // test rather than assumed.
        if (safePatch.batch !== undefined) {
            const checked = checkedBatch(safePatch.batch, 'updateVariable');
            if (!checked.ok) return null;
            safePatch.batch = checked.batch;
        }

        const newDef = { ...def, ...safePatch };

        if (newDef.type === 'datetime') {
            // Same rules as createVariable(), on the merged definition - so a
            // patch that changes only `calendar`, or only `defaultValue`, is
            // checked against the other's stored value too.
            const datetime = checkedDatetime(newDef, 'updateVariable');
            if (!datetime.ok) {
                console.warn(LOG_PREFIX, datetime.error);
                return null;
            }
            // A variable that just BECAME a datetime moves into batch "time"
            // unless the patch names a batch itself.
            if (def.type !== 'datetime' && safePatch.batch === undefined) newDef.batch = TIME_BATCH;
        }

        // Re-validate and re-derive dependencies only when the expression
        // is actually changing (including "just became calculated") - an
        // unrelated patch (label, description, showInTracker, ...) to an
        // already-calculated variable falls through to the generic path
        // below, which is already correct for it (resetValueIfTypeChanged
        // is a no-op when the type hasn't changed, recalculateAllForChat
        // harmlessly re-evaluates everything as it always has).
        const becameOrStaysCalculated = newDef.type === 'calculated';
        const expressionChanged = becameOrStaysCalculated
            && (def.type !== 'calculated' || safePatch.expression !== undefined);

        if (becameOrStaysCalculated && expressionChanged) {
            const validation = validateCalculatedDefinitionInternal({
                type: 'calculated',
                expression: newDef.expression,
                namespace: ref.namespace,
                presetName: ref.presetName,
            });
            if (!validation.ok) {
                console.warn(LOG_PREFIX, `updateVariable: invalid calculated definition - ${validation.error}`);
                return null;
            }

            preset.variables[varId] = newDef;
            persistSettings();
            applyCalculatedDefinitionInternal(ref, newDef, validation.deps);
            return newDef;
        }

        preset.variables[varId] = newDef;
        persistSettings();

        const chatId = currentChatId();
        if (chatId) {
            resetValueIfTypeChanged(chatId, newDef);
            recalculateAllForChat(chatId);
        }
        refreshVariableMacros();

        return newDef;
    } catch (err) {
        console.warn(LOG_PREFIX, 'updateVariable failed (gracefully handled)', err);
        return null;
    }
}

export function deleteVariable(extensionId, instanceId, ref) {
    validateCallerIdentity(extensionId, instanceId, ref?.namespace);
    try {
        if (!ref || !ref.namespace || !ref.presetName || !ref.variableName) {
            console.warn(LOG_PREFIX, 'deleteVariable requires ref.namespace, ref.presetName, and ref.variableName');
            return false;
        }
        if (!validateNamespace(ref.namespace)) {
            console.warn(LOG_PREFIX, `deleteVariable: namespace "${ref.namespace}" is not registered`);
            return false;
        }
        const presetEntry = findPresetEntry(ref.namespace, ref.presetName);
        if (!presetEntry) {
            console.warn(LOG_PREFIX, `deleteVariable: preset "${ref.namespace}.${ref.presetName}" not found`);
            return false;
        }
        const [, preset] = presetEntry;
        const varEntry = findVariableEntry(preset, ref.namespace, ref.variableName);
        if (!varEntry) {
            console.warn(LOG_PREFIX, `deleteVariable: variable "${ref.namespace}.${ref.variableName}" not found`);
            return false;
        }
        const [varId, def] = varEntry;

        delete preset.variables[varId];
        persistSettings();
        deleteVariableValueEverywhere(def.name);
        refreshVariableMacros();
        return true;
    } catch (err) {
        console.warn(LOG_PREFIX, 'deleteVariable failed (gracefully handled)', err);
        return false;
    }
}

export function getVariable(extensionId, instanceId, ref) {
    validateCallerIdentity(extensionId, instanceId, ref?.namespace);
    try {
        if (!ref || !ref.namespace || !ref.presetName || !ref.variableName) return undefined;
        const presetEntry = findPresetEntry(ref.namespace, ref.presetName);
        if (!presetEntry) return undefined;
        const [, preset] = presetEntry;
        const varEntry = findVariableEntry(preset, ref.namespace, ref.variableName);
        return varEntry ? varEntry[1] : undefined;
    } catch (err) {
        console.warn(LOG_PREFIX, 'getVariable failed (gracefully handled)', err);
        return undefined;
    }
}

export function listVariables(extensionId, instanceId, namespace, presetName) {
    validateCallerIdentity(extensionId, instanceId, namespace);
    try {
        const entry = findPresetEntry(namespace, presetName);
        if (!entry) return [];
        const [, preset] = entry;
        return Object.values(preset.variables || {});
    } catch (err) {
        console.warn(LOG_PREFIX, 'listVariables failed (gracefully handled)', err);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Calendar formatting API (requirements spec 1.21.5)
// ---------------------------------------------------------------------------
//
// None of these signatures carries a namespace, and validateCallerIdentity()
// needs one - so, like assignBatch()/declareCapabilities(), the caller is
// identified through resolveCallerRecord(): the instance id must match and the
// extension must already own a namespace. Calendar data is not namespaced, so
// nothing further is checked. Identity failures throw; so do formatting
// failures (unlike this module's warn-and-null CRUD) - a caller asking for a
// string should never be handed a silent null in its place.

export function getCalendarDefinitions(extensionId, instanceId) {
    resolveCallerRecord(extensionId, instanceId);
    return calendarEngine.listCalendars();
}

export function getCalendarDefinition(extensionId, instanceId, calendarId) {
    resolveCallerRecord(extensionId, instanceId);
    return calendarEngine.getCalendarDefinition(calendarId);
}

export function formatDateTime(extensionId, instanceId, calendarId, scalarTime, options) {
    resolveCallerRecord(extensionId, instanceId);
    return calendarEngine.format(calendarId, scalarTime, options);
}

export function formatDateTimePartial(extensionId, instanceId, calendarId, scalarTime, fields) {
    resolveCallerRecord(extensionId, instanceId);
    return calendarEngine.formatPartial(calendarId, scalarTime, fields);
}
