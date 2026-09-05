// State Engine — dynamic script/stylesheet loading, template registration,
// and the shared panel-refresh helper.

import { LOG_PREFIX, EXT_TEMPLATE_PATH } from '../core/settings-core.js';
import { renderVarTable } from './manager-modal-ui.js';
import { renderTrackerPanel } from './tracker-panel-ui.js';
import { updateManagerButtonState } from './wand-ui.js';

export function refreshPanelIfOpen() {
    if ($('#state_engine_settings').length) {
        renderVarTable();
    }
    if ($('#se_tracker_panel').length) {
        renderTrackerPanel();
    }
    updateManagerButtonState();
}

// ---------------------------------------------------------------------------
// Stylesheet loader
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dynamic script/stylesheet loader
// ---------------------------------------------------------------------------

export function loadManagerModalScript() {
    const scriptId = 'se-manager-modal-script';
    if (document.getElementById(scriptId)) return Promise.resolve(); // Already loaded

    const scriptPath = `scripts/extensions/${EXT_TEMPLATE_PATH}/manager-modal.js?v=${Date.now()}`;

    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.id = scriptId;
        script.src = scriptPath;
        script.onload = () => {
            console.log(LOG_PREFIX, 'manager modal script loaded');
            resolve();
        };
        script.onerror = () => {
            console.error(LOG_PREFIX, 'failed to load manager modal script');
            reject(new Error('Failed to load manager-modal.js'));
        };
        document.head.appendChild(script);
    });
}

export function loadManagerModalStyles() {
    const styleId = 'se-manager-modal-styles';
    if (document.getElementById(styleId)) return; // Already loaded

    const cssPath = `scripts/extensions/${EXT_TEMPLATE_PATH}/manager-modal.css`;
    const link = document.createElement('link');
    link.id = styleId;
    link.rel = 'stylesheet';
    link.href = cssPath;
    document.head.appendChild(link);
    console.log(LOG_PREFIX, 'manager modal styles loaded');
}

// ---------------------------------------------------------------------------
// Template registration
// ---------------------------------------------------------------------------

export async function registerTemplates() {
    const context = SillyTavern.getContext();
    try {
        if (context.registerExtensionTemplates) {
            await context.registerExtensionTemplates(EXT_TEMPLATE_PATH, 'settings.html');
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'template registration skipped or failed', err);
    }
}
