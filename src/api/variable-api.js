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
import { findPresetEntry } from './preset-api.js';
import { blankDefinition } from '../core/variable-schema.js';
import { isImageType, checkImageValue, emptyImageValue } from '../core/image-variables.js';
import * as calendarEngine from '../core/calendar-engine.js';
import { getCalendar, toScalar, normalizeForDatetimeMode } from '../core/calendar-engine.js';
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

// Datetime rules (requirements spec 1.21) shared by createVariable() and
// updateVariable(), checked on the fully-merged definition: the calendar it
// names must exist, its unit must be the one this engine stores ("seconds"),
// and its defaultValue must be convertible to scalar time. On success the
// defaultValue is rewritten as that scalar, the canonical stored form, so an
// ISO string given by a caller is converted once, here. Returns { ok: true }
// or { ok: false, error } - never throws.
// `preset` (optional - the same preset object createVariable()/
// updateVariable() already have in scope) lets deltaSource be checked
// against the preset's own variables, the same same-preset scoping
// validateCalculatedDefinitionInternal() already uses for a calculated
// variable's dependencies. Omitted only by callers that don't have a preset
// on hand, in which case deltaSource's existence/type is left unchecked.
function checkedDatetime(def, fnName, preset) {
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

    // Datetime mode (requirements spec 1.36): validated the same way
    // timeSemanticMode is (a fixed choice, not free text). The default
    // itself is normalized here too, not just at runtime writes (chat-
    // state.js's setVar/applyIncrement) - so a timeOnly variable never even
    // STARTS with an inconsistent stored default (a defaultValue typed as
    // "2026-09-18 22:00" becomes "1970-01-01 22:00" on save). dateOnly is
    // display-only and keeps the default as typed.
    if (def.datetimeMode !== undefined && def.datetimeMode !== 'full' && def.datetimeMode !== 'dateOnly' && def.datetimeMode !== 'timeOnly') {
        return { ok: false, error: `${fnName}: datetimeMode must be "full", "dateOnly" or "timeOnly" (got ${JSON.stringify(def.datetimeMode)})` };
    }
    def.datetimeMode = ['dateOnly', 'timeOnly'].includes(def.datetimeMode) ? def.datetimeMode : 'full';
    def.defaultValue = normalizeForDatetimeMode(calendarId, scalar, def.datetimeMode);

    // Calculated-datetime extension (requirements spec 1.31): deltaSource.
    // Caught here, at save time, rather than left to silently do nothing
    // forever at runtime - a deltaSource that can never resolve would
    // otherwise fail invisibly on every engine pass. (An earlier version of
    // this feature also validated a separate tickUnit field here; removed
    // 2026-09-22 along with fixedIncrement/accumulate - a datetime's
    // automatic tick is now the same behaviors.increment/increment.delta
    // every other type already has, validated nowhere at save time either,
    // consistent with how that path has always worked.)
    if (typeof def.deltaSource === 'string' && def.deltaSource.trim()) {
        const sourceName = def.deltaSource.trim();
        // No separate "cannot reference itself" check: on createVariable()
        // the variable being created is not yet in preset.variables (that
        // write happens after this validation), so self-reference already
        // fails "does not exist"; on updateVariable() the variable already
        // in preset.variables is never type 'string' at this point (it is
        // the datetime being validated), so self-reference already fails
        // the type check below. A dedicated check here would be untestable
        // dead code - confirmed by mutation testing, not assumed.
        if (preset) {
            const sourceDef = Object.values(preset.variables || {}).find((v) => v?.name === sourceName);
            if (!sourceDef) {
                return { ok: false, error: `${fnName}: deltaSource "${sourceName}" does not exist in this preset` };
            }
            if (sourceDef.type !== 'string') {
                return { ok: false, error: `${fnName}: deltaSource "${sourceName}" must be a string variable (got "${sourceDef.type}")` };
            }
        }
        def.deltaSource = sourceName;
    } else {
        def.deltaSource = '';
    }

    // Semantic time of day (requirements spec 1.35): a fixed-choice field, not
    // free text, so this is really just "did a caller send garbage" - the
    // manager-modal editor only ever offers the two real values via a
    // <select>, same as deltaSource's dropdown.
    if (def.timeSemanticMode !== undefined && def.timeSemanticMode !== 'none' && def.timeSemanticMode !== 'semanticTimeOfDay') {
        return { ok: false, error: `${fnName}: timeSemanticMode must be "none" or "semanticTimeOfDay" (got ${JSON.stringify(def.timeSemanticMode)})` };
    }
    def.timeSemanticMode = def.timeSemanticMode === 'semanticTimeOfDay' ? 'semanticTimeOfDay' : 'none';

    // Semantic time of day works in every datetime mode: a dateOnly
    // variable still stores (and accumulates) its time-of-day, it just
    // doesn't show it, so "the next morning" moves it to the next day.

    return { ok: true };
}

// Image variables (image, imageList, imageMap - core/image-variables.js) through the
// same create/update calls as every other type. `def` is the FULL definition. Rules:
//   - defaultValue must be a string / an array of strings / an object of strings
//     (a JSON string is parsed); it is rewritten in that normalized form. The
//     blank definition's numeric default is replaced by the empty value ('' / [] / {})
//     when the caller gave none (`hadDefault` false). No URL is looked at or fetched.
//   - an image map's currentKeyVariable, when given, is a string (a variable name)
//   - an image or an image map cannot rotate: increment behavior is refused
// Returns { ok: true } or { ok: false, error }; never throws.
function checkedImage(def, fnName, hadDefault) {
    if (!isImageType(def.type)) return { ok: true };
    if (!hadDefault) def.defaultValue = emptyImageValue(def.type);
    const checked = checkImageValue(def.type, def.defaultValue);
    if (!checked.ok) return { ok: false, error: `${fnName}: defaultValue - ${checked.error}` };
    def.defaultValue = checked.value;
    if (def.currentKeyVariable !== undefined && typeof def.currentKeyVariable !== 'string') {
        return { ok: false, error: `${fnName}: currentKeyVariable must be a variable name (a string)` };
    }
    if ((def.type === 'image' || def.type === 'imageMap') && def.behaviors?.increment === true) {
        return { ok: false, error: `${fnName}: an ${def.type} cannot rotate - only an imageList can be incremented` };
    }
    return { ok: true };
}

// A flag-mode boolean (1.28): flagMode, if given, must be a real boolean, and
// defaultValue is ALWAYS forced to false when type is boolean and flagMode is
// true - "the variable starts false" is absolute, not just "when no default was
// given" (getDefaultValue() already ignores defaultValue unconditionally for a
// flag; forcing it here too keeps the stored definition honest about what it
// actually does, rather than showing a caller-supplied "true" default that is
// silently never used). Never rejects flagMode on a non-boolean type: like
// itemType on a non-array definition, it is simply inert there (every runtime
// check gates on type === 'boolean' too).
function checkedFlagMode(def, fnName) {
    if (def.flagMode !== undefined && typeof def.flagMode !== 'boolean') {
        return { ok: false, error: `${fnName}: flagMode must be true or false` };
    }
    if (def.type === 'boolean' && def.flagMode === true) {
        def.defaultValue = false;
    }
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
        const imageCheck = checkedImage(fullDef, 'createVariable', def.defaultValue !== undefined);
        if (!imageCheck.ok) {
            console.warn(LOG_PREFIX, imageCheck.error);
            return null;
        }
        const flagCheck = checkedFlagMode(fullDef, 'createVariable');
        if (!flagCheck.ok) {
            console.warn(LOG_PREFIX, flagCheck.error);
            return null;
        }
        if (fullDef.type === 'datetime') {
            const datetime = checkedDatetime(fullDef, 'createVariable', preset);
            if (!datetime.ok) {
                console.warn(LOG_PREFIX, datetime.error);
                return null;
            }
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
        const newDef = { ...def, ...safePatch };

        // A variable that just BECAME an image type without a new default starts
        // empty (the old type's default - a number, say - is not a valid one).
        const becameImage = isImageType(newDef.type) && def.type !== newDef.type;
        const imageCheck = checkedImage(newDef, 'updateVariable', !becameImage || safePatch.defaultValue !== undefined);
        if (!imageCheck.ok) {
            console.warn(LOG_PREFIX, imageCheck.error);
            return null;
        }

        const flagCheck = checkedFlagMode(newDef, 'updateVariable');
        if (!flagCheck.ok) {
            console.warn(LOG_PREFIX, flagCheck.error);
            return null;
        }

        if (newDef.type === 'datetime') {
            // Same rules as createVariable(), on the merged definition - so a
            // patch that changes only `calendar`, or only `defaultValue`, is
            // checked against the other's stored value too.
            const datetime = checkedDatetime(newDef, 'updateVariable', preset);
            if (!datetime.ok) {
                console.warn(LOG_PREFIX, datetime.error);
                return null;
            }
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
// needs one - so, like declareCapabilities()/notify(), the caller is
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

// ---------------------------------------------------------------------------
// Calendar definition API (requirements spec 1.22.1)
// ---------------------------------------------------------------------------
//
// Same identity rule as the formatting API above (resolveCallerRecord). Like
// it, these THROW on failure - identity, an invalid definition, an id already
// in use, an unknown calendar, the built-in calendar, a calendar still used by
// a variable - because the caller needs the reason, not a silent null.
// getCalendarDefinition() (above) is the read that returns null when missing.

export function createCalendarDefinition(extensionId, instanceId, def) {
    resolveCallerRecord(extensionId, instanceId);
    return calendarEngine.createCalendar(def);
}

export function updateCalendarDefinition(extensionId, instanceId, calendarId, patch) {
    resolveCallerRecord(extensionId, instanceId);
    return calendarEngine.updateCalendar(calendarId, patch);
}

export function deleteCalendarDefinition(extensionId, instanceId, calendarId) {
    resolveCallerRecord(extensionId, instanceId);
    return calendarEngine.deleteCalendar(calendarId);
}

// Every calendar definition as an array (getCalendarDefinitions() above gives
// the same data keyed by id).
export function listCalendarDefinitions(extensionId, instanceId) {
    resolveCallerRecord(extensionId, instanceId);
    return Object.values(calendarEngine.listCalendars());
}

// A random, valid calendar definition. It is NOT stored - pass it to
// createCalendarDefinition() to keep it.
export function generateRandomCalendarDefinition(extensionId, instanceId, options) {
    resolveCallerRecord(extensionId, instanceId);
    return calendarEngine.generateRandomCalendarDefinition(options);
}

// Points a datetime variable at another calendar. `ref` is the same
// { namespace, presetName, variableName } updateVariable() takes, and the
// caller must own the namespace. Returns the updated definition; throws when
// the variable is not a datetime or the calendar does not exist. The
// variable's stored values are scalar seconds and are NOT converted - they are
// simply read through the new calendar from now on.
export function assignCalendarToVariable(extensionId, instanceId, ref, calendarId) {
    validateCallerIdentity(extensionId, instanceId, ref?.namespace);
    if (!getCalendar(calendarId)) throw new Error(`assignCalendarToVariable: calendar "${calendarId}" does not exist`);
    const current = getVariable(extensionId, instanceId, ref);
    if (!current) throw new Error(`assignCalendarToVariable: variable "${ref?.namespace}.${ref?.variableName}" not found`);
    if (current.type !== 'datetime') throw new Error(`assignCalendarToVariable: "${ref.variableName}" is a ${current.type} variable, not a datetime`);
    const updated = updateVariable(extensionId, instanceId, ref, { calendar: calendarId });
    if (!updated) throw new Error(`assignCalendarToVariable: could not update "${ref.variableName}"`);
    return updated;
}
