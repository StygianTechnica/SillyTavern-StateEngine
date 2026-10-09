// State Engine — "the built-in prompts changed" (requirements spec 1.45).
//
// At startup, saved copies of a built-in prompt are turned back into "use the
// built-in" (prompt-defaults.js reconcilePromptDefaults). When the user has
// their OWN text for a prompt whose built-in has changed since they last saw
// it, ONE notification is posted. Its action shows, for each such prompt, the
// user's text and the new built-in side by side: "Use the new built-in"
// clears theirs, "Keep mine" keeps it; either records the version as seen, so
// each change is asked about once. Closing the dialog without choosing asks
// again next time.

import { LOG_PREFIX, getSettings, persistSettings } from '../core/settings-core.js';
import { PROMPT_DEFAULTS, reconcilePromptDefaults, acknowledgePromptDefault } from '../core/prompt-defaults.js';
import { ensureInstanceId } from '../api/identity.js';
import { stateEngine } from '../api/state-engine-api.js';

export const PROMPT_UPDATE_NOTIFICATION_KEY = 'prompt-defaults-updated';
export const REVIEW_PROMPTS_CALLBACK_ID = 'review-prompt-defaults';
export const PROMPT_UPDATE_MESSAGE = 'The built-in prompts changed in this update, and you use your own. Click to compare.';
const SELF = 'se';
const USE_BUILTIN = 201;
const KEEP_MINE = 202;

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

// The user's answer for one prompt: 'builtin' | 'mine' | null (closed).
async function askOne(key, mine) {
    const entry = PROMPT_DEFAULTS[key];
    const context = SillyTavern.getContext();
    if (context.Popup && context.POPUP_TYPE) {
        const html = `
            <h3>${escapeHtml(entry.label)}: the built-in changed</h3>
            <p>You use your own text. Keep it, or switch to the new built-in (it then follows future updates).</p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;text-align:left">
                <label>Yours<textarea class="text_pole" rows="12" readonly>${escapeHtml(mine)}</textarea></label>
                <label>New built-in<textarea class="text_pole" rows="12" readonly>${escapeHtml(entry.current)}</textarea></label>
            </div>`;
        const popup = new context.Popup(html, context.POPUP_TYPE.TEXT, '', {
            okButton: false,
            cancelButton: 'Ask me later',
            wide: true,
            customButtons: [
                { text: 'Use the new built-in', result: USE_BUILTIN },
                { text: 'Keep mine', result: KEEP_MINE },
            ],
        });
        const result = await popup.show();
        return result === USE_BUILTIN ? 'builtin' : result === KEEP_MINE ? 'mine' : null;
    }
    const answer = window.confirm(`${entry.label}: the built-in changed and you use your own.\nOK = use the new built-in, Cancel = keep mine.`);
    return answer ? 'builtin' : 'mine';
}

export function postPromptUpdateNotification() {
    return stateEngine.notify(SELF, ensureInstanceId(), {
        id: PROMPT_UPDATE_NOTIFICATION_KEY,
        message: PROMPT_UPDATE_MESSAGE,
        severity: 'info',
        callbackId: REVIEW_PROMPTS_CALLBACK_ID,
    });
}

// The notification's action. Asks about every outdated prompt; re-posts the
// notification when one was left unanswered.
export async function reviewPromptDefaults(ask = askOne) {
    const settings = getSettings();
    const { outdated } = reconcilePromptDefaults(settings);
    let unanswered = false;
    for (const key of outdated) {
        const answer = await ask(key, settings[key]);
        if (answer === 'builtin') settings[key] = null;
        if (answer) acknowledgePromptDefault(settings, key);
        else unanswered = true;
    }
    persistSettings();
    refreshPromptSettingsUi();
    // The notification is removed after this action returns; queue the re-post after that.
    if (unanswered) setTimeout(() => postPromptUpdateNotification(), 0);
}

function refreshPromptSettingsUi() {
    try {
        const settings = getSettings();
        const header = document.getElementById('se_prompted_header');
        const rules = document.getElementById('se_prompted_variable_rules');
        if (header) header.value = settings.promptedHeader || PROMPT_DEFAULTS.promptedHeader.current;
        if (rules) rules.value = settings.promptedRules || PROMPT_DEFAULTS.promptedRules.current;
    } catch { /* the settings panel is not drawn */ }
}

// Startup: brings saved built-in copies up to date, and posts the notification
// when the user's own text is behind a changed built-in. Never throws.
export function initPromptDefaultUpdates() {
    try {
        stateEngine.registerNotificationCallback(SELF, ensureInstanceId(), REVIEW_PROMPTS_CALLBACK_ID, () => reviewPromptDefaults());
        const settings = getSettings();
        const { changed, outdated } = reconcilePromptDefaults(settings);
        if (changed) persistSettings();
        if (outdated.length) postPromptUpdateNotification();
        else stateEngine.clearNotification(SELF, ensureInstanceId(), `${SELF}::${PROMPT_UPDATE_NOTIFICATION_KEY}`);
    } catch (err) {
        console.warn(LOG_PREFIX, 'prompt default check failed (gracefully handled)', err);
    }
}
