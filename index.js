// State Engine — local, prompt-free state tracking for SillyTavern
//
// Keeps user-defined "state variables" locally (per chat or global), exposes
// them to World Info / prompts / character cards via the built-in {{getvar::name}}
// macro family, and can update them automatically:
//   - "manual"   variables: you (or a slash command) set them directly.
//   - "counter"  variables: increment/decrement by a fixed step on a trigger.
//   - "prompted" variables: a quiet, invisible background generation asks the
//                 AI to derive/update the value from recent chat context.
//
// Nothing this extension does is added to the visible chat log or the
// permanent context — prompted updates run as an isolated background
// generation, and the results are written straight into SillyTavern's
// native chat/global variable store.


import './src/ui/manager-api.js';

import { LOG_PREFIX, getSettings } from './src/core/settings-core.js';
import { applyDefaultsForMissing, runStartupOnce } from './src/core/initialization-engine.js';

import { initPanel } from './src/ui/settings-panel-ui.js';
import { addStateEngineWandUi, watchChatSelection, updateManagerButtonState } from './src/ui/wand-ui.js';
import { registerTemplates, loadManagerModalStyles } from './src/ui/ui-entrypoints.js';

import { registerEvents } from './src/events/event-engine.js';
import { registerSlashCommand } from './src/events/slash-command-engine.js';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

jQuery(async () => {
    try {
        getSettings(); // ensure defaults exist / migrate
        await registerTemplates();
        await initPanel();
        addStateEngineWandUi();
        registerEvents();
        registerSlashCommand();
        applyDefaultsForMissing();
        updateManagerButtonState();
        watchChatSelection();
        // Covers the case where APP_READY already fired before we got here.
        runStartupOnce();

        // Load manager modal styles
        loadManagerModalStyles();

        console.log(LOG_PREFIX, 'loaded');
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to initialize', err);
    }
});
