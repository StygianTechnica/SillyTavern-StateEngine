// State Engine — public World Info / lorebook API for other extensions,
// exposed as window.StateEngineWI.
//
// Every function takes (extensionId, instanceId, ...) first, exactly like the
// namespaced stateEngine.* API, and checks the caller the same way
// (src/api/identity.js resolveCallerRecord): the instanceId must match this
// install's, and the extension must already own a namespace. A rejected call
// throws the same error as stateEngine.* does, synchronously - also for the
// async functions, so a bad caller is never handed a promise. World Info data is
// not namespaced, so no further ownership is checked (the same as the calendar
// API).

import {
    getWIConditions, setWICondition, deleteWICondition, shouldDisplayWIEntry,
} from './wi-conditions.js';
import { getPresetsForLorebook, bindPresetToLorebook, unbindPresetFromLorebook } from '../core/lorebook-bindings.js';
import { exportPreset, importPreset } from '../core/preset-export.js';
import { exportLorebookBundle, importLorebookBundle } from '../core/lorebook-bundle.js';
import { resolveCallerRecord } from '../api/identity.js';

const guarded = (fn) => (extensionId, instanceId, ...args) => {
    resolveCallerRecord(extensionId, instanceId);
    return fn(...args);
};

export const StateEngineWI = Object.freeze({
    getWIConditions: guarded(getWIConditions),
    setWICondition: guarded(setWICondition),
    deleteWICondition: guarded(deleteWICondition),
    shouldDisplayWIEntry: guarded(shouldDisplayWIEntry),
    getPresetsForLorebook: guarded(getPresetsForLorebook),
    bindPresetToLorebook: guarded(bindPresetToLorebook),
    unbindPresetFromLorebook: guarded(unbindPresetFromLorebook),
    exportPreset: guarded(exportPreset),
    importPreset: guarded(importPreset),
    exportLorebookBundle: guarded(exportLorebookBundle),
    importLorebookBundle: guarded(importLorebookBundle),
});

export function exposeStateEngineWI() {
    window.StateEngineWI = StateEngineWI;
    return StateEngineWI;
}
