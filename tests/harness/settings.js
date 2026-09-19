// Settings persistence for tests. The REAL src/core/settings-core.js runs
// unmodified against the fake context's extensionSettings blob (its
// persistSettings() just calls the context's saveSettingsDebounced spy), so
// "persistence" is the real code path, not a re-implementation.

import { getSettings, migrateAllSettings, persistSettings } from '../../src/core/settings-core.js';
import context from './context.js';

const settings = {
    // Fresh settings blob with defaults filled in, and the built-in `se`
    // namespace registered by the real one-time migration.
    reset() {
        context.extensionSettings = {};
        const s = getSettings();
        migrateAllSettings(s);
        return s;
    },
    get: getSettings,
    persist: persistSettings,
    // What the real extension would have written to disk: the extension's
    // own settings blob, JSON round-tripped.
    snapshot() {
        return JSON.parse(JSON.stringify(getSettings()));
    },
};

export default settings;
