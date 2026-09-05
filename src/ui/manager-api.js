// State Engine — wires the manager-modal.js API bag to the split modules

import { setManagerApi } from '../../manager-modal.js';
import { getSettings, persistSettings, toggleDebugMode, debugLog } from '../core/settings-core.js';
import { createPreset, renamePreset, deletePreset, getPresetsForChat, addPresetToChat, removePresetFromChat, restoreDefaultPresets } from '../core/preset-manager.js';
import { getDebugInfo } from '../core/debug-engine.js';
import { blankDefinition } from '../core/variable-definition.js';
import { isReservedVariable } from '../core/validation-utils.js';
import { renderVarTable } from './manager-modal-ui.js';
import { renderTrackerPanel } from './tracker-panel-ui.js';
import { setStatus } from './settings-panel-ui.js';
import { getCurrentChatId } from './wand-ui.js';

setManagerApi({
    getSettings,
    persistSettings,
    getCurrentChatId,
    createPreset,
    renamePreset,
    deletePreset,
    getPresetsForChat,
    addPresetToChat,
    removePresetFromChat,
    setStatus,
    renderVarTable,
    renderTrackerPanel,
    restoreDefaultPresets,
    toggleDebugMode,
    debugLog,
    getDebugInfo,
    isReservedVariable,
    blankDefinition
});
