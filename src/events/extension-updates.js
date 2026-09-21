// State Engine — "extension updates available" notification.
//
// Checks whether any installed third-party extension is behind its remote and,
// if so, posts ONE notification through the Notification Core (never one per
// extension) whose click opens SillyTavern's extension manager. If nothing is
// outdated, nothing is posted - and a notification left over from an earlier
// check is cleared.
//
// Data source: the same one the extension manager uses (verified against
// SillyTavern 1.18, public/scripts/extensions.js + src/endpoints/extensions.js):
//   GET  /api/extensions/discover  -> [{ type: 'system'|'local'|'global', name }]
//   POST /api/extensions/version   { extensionName, global }
//        -> { currentBranchName, currentCommitHash, isUpToDate, remoteUrl }
// (the manager marks an extension outdated when isUpToDate === false; the
// endpoint runs `git fetch origin` itself, so this module never touches git).
//
// WHEN it runs - never on a timer, never per message:
//   - once at startup                              (checkForExtensionUpdates('startup'), index.js)
//   - when the extension manager shows its list    (watchForExtensionManager, below). SillyTavern
//     re-renders the manager after every extension update and emits no event for it, so the
//     popup opening is watched for.
//   - after State Engine itself is updated         (onStateEngineUpdate, the `hooks.update`
//     entry in manifest.json, which SillyTavern calls after updating this extension)
//
// This module only READS update state. It updates nothing.

import { LOG_PREFIX } from '../core/settings-core.js';
import { ensureInstanceId } from '../api/identity.js';
import { stateEngine } from '../api/state-engine-api.js';

export const UPDATE_NOTIFICATION_MESSAGE = 'One or more extensions have updates available.';
// The notification's own key (stored id "se::extension-updates"): posting again
// with it REPLACES the notification, so there is never a duplicate.
export const UPDATE_NOTIFICATION_KEY = 'extension-updates';
export const OPEN_MANAGER_CALLBACK_ID = 'open-extension-manager';
// State Engine acts as its built-in namespace, like the manager modal's adapters.
const SELF = 'se';

const CONCURRENCY = 5;             // what SillyTavern itself uses for these checks
const MANAGER_DEBOUNCE_MS = 1000;  // the manager draws its whole list at once

let inFlight = null;

function requestHeaders() {
    try {
        return SillyTavern.getContext().getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
    } catch {
        return { 'Content-Type': 'application/json' };
    }
}

// ---- the check -----------------------------------------------------------------

// The extensions the user has switched off, as SillyTavern records them:
// extension_settings.disabledExtensions holds ids like "third-party/Name" - the
// same names /api/extensions/discover returns. An unreadable list counts as none
// (every extension is checked rather than none).
function disabledExtensionIds() {
    try {
        const list = SillyTavern.getContext().extensionSettings?.disabledExtensions;
        return new Set(Array.isArray(list) ? list : []);
    } catch {
        return new Set();
    }
}

// Every installed, ENABLED third-party extension as { folder, global }. A
// disabled extension is skipped, as SillyTavern's own startup check skips it: it
// is not running, so an update to it is not something to nag about (and it saves
// a `git fetch` per disabled extension). Enabling it makes the next check include
// it. Returns null when the list could not be read (so "unknown" is not mistaken
// for "nothing installed").
async function listThirdPartyExtensions(fetchImpl, disabled) {
    try {
        const response = await fetchImpl('/api/extensions/discover');
        if (!response.ok) return null;
        const list = await response.json();
        if (!Array.isArray(list)) return null;
        return list
            .filter((e) => e && typeof e.name === 'string' && e.name.startsWith('third-party/'))
            .filter((e) => !disabled.has(e.name))
            .map((e) => ({ folder: e.name.slice('third-party/'.length), global: e.type === 'global' }))
            .filter((e) => e.folder);
    } catch (err) {
        console.warn(LOG_PREFIX, 'extension update check: could not list extensions', err);
        return null;
    }
}

// true = outdated, false = up to date, null = could not tell (errors, non-JSON).
async function isOutdated(extension, fetchImpl) {
    try {
        const response = await fetchImpl('/api/extensions/version', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ extensionName: extension.folder, global: extension.global }),
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (!data || typeof data.isUpToDate !== 'boolean') return null;
        return data.isUpToDate === false;
    } catch {
        return null;
    }
}

// Runs `task(item)` over `items`, at most `limit` at a time; returns the results in order.
async function mapLimited(items, limit, task) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const at = next++;
            results[at] = await task(items[at]);
        }
    });
    await Promise.all(workers);
    return results;
}

// ---- the notification ------------------------------------------------------------

export function postUpdateNotification() {
    return stateEngine.notify(SELF, ensureInstanceId(), {
        id: UPDATE_NOTIFICATION_KEY,
        message: UPDATE_NOTIFICATION_MESSAGE,
        severity: 'warning',
        callbackId: OPEN_MANAGER_CALLBACK_ID,
    });
}

export function clearUpdateNotification() {
    return stateEngine.clearNotification(SELF, ensureInstanceId(), `${SELF}::${UPDATE_NOTIFICATION_KEY}`);
}

// What the notification does when clicked: opens SillyTavern's extension
// manager (the button that opens it is #extensions_details). The manager then
// checks every extension itself and shows an Update button on each outdated one.
// Throws if the button is not there, so the notification stays and says why.
export function openExtensionManager() {
    const button = document.getElementById('extensions_details');
    if (!button) throw new Error('SillyTavern\'s extension manager button (#extensions_details) was not found');
    button.click();
}

// Registers the callback the notification names. Call once at load (functions
// are not saved, so this is needed on every page load).
export function registerUpdateNotificationCallback() {
    return stateEngine.registerNotificationCallback(SELF, ensureInstanceId(), OPEN_MANAGER_CALLBACK_ID, openExtensionManager);
}

// ---- entry point -----------------------------------------------------------------

// Checks every enabled third-party extension and updates the notification to match:
//   at least one outdated                      -> ONE notification (replaced if present)
//   none outdated (and the check could answer) -> none (a stale one is cleared)
//   the check could not answer at all          -> left exactly as it was
// A single failing extension is ignored; it does not count as outdated.
// Never throws. Concurrent calls share one run. Resolves to
// { checked, outdated, notified } (checked = extensions that answered).
// `fetchImpl` is replaceable for tests.
export function checkForExtensionUpdates(reason = 'manual', fetchImpl = (...args) => fetch(...args)) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
        const result = { checked: 0, outdated: 0, notified: false };
        try {
            const extensions = await listThirdPartyExtensions(fetchImpl, disabledExtensionIds());
            if (!extensions) return result;

            const answers = await mapLimited(extensions, CONCURRENCY, (e) => isOutdated(e, fetchImpl));
            result.checked = answers.filter((a) => a !== null).length;
            result.outdated = answers.filter((a) => a === true).length;

            if (result.outdated > 0) {
                postUpdateNotification();
                result.notified = true;
            } else if (result.checked > 0 || extensions.length === 0) {
                clearUpdateNotification();
            }
            console.debug(LOG_PREFIX, `extension update check (${reason}):`, result);
        } catch (err) {
            console.warn(LOG_PREFIX, 'extension update check failed (gracefully handled)', err);
        } finally {
            inFlight = null;
        }
        return result;
    })();
    return inFlight;
}

// ---- the manager refreshing its list ------------------------------------------------

// SillyTavern draws the manager as a popup (<dialog>) containing
// `.extensions_info`, and draws it again after every extension update. There is
// no event for that, so watch for the popup being added and check once the
// list has settled. Cheap on purpose: it only looks at added <dialog> nodes.
// Returns a function that stops watching.
export function watchForExtensionManager(onList = () => checkForExtensionUpdates('manager')) {
    let timer = null;
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node.nodeName !== 'DIALOG' || !node.querySelector?.('.extensions_info')) continue;
                clearTimeout(timer);
                timer = setTimeout(onList, MANAGER_DEBOUNCE_MS);
                return;
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
        clearTimeout(timer);
        observer.disconnect();
    };
}

// Registers the click callback and starts watching for the manager. Call once at load.
export function initExtensionUpdateNotifier() {
    registerUpdateNotificationCallback();
    watchForExtensionManager();
}

// SillyTavern calls this (manifest.json `hooks.update`) after it updates State
// Engine. It does not wait for the check: SillyTavern gives hooks 5 seconds.
export function onStateEngineUpdate() {
    void checkForExtensionUpdates('state-engine-update');
}
