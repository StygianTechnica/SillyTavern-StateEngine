// State Engine — initialization / reset

import { LOG_PREFIX, getSettings, migrateAllSettings, persistSettings } from './settings-core.js';
import { getPresetsForChat, getAllVariablesFromPresets, addPresetToChat } from './preset-manager.js';
import { getActiveLorebookNames, getPresetsForLorebook, declineKey, pruneDeclinesForChat } from './lorebook-bindings.js';
import { setVar, loadChatState } from './chat-state.js';
import { getDefaultValue } from './variable-schema.js';
import { shouldSkipPromptedRefresh, runPromptedStateUpdate } from './prompted-engine.js';
import { recalculateDependents, recalculateAllForChat } from './calculated-engine.js';


export function applyResetOnNewChat() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    const activePresetIds = getPresetsForChat(chatId);
    const variables = getAllVariablesFromPresets(activePresetIds);

    for (const def of Object.values(variables)) {
        if (!def.name || !def.resetOnNewChat || shouldSkipPromptedRefresh(def)) continue;
        setVar(chatId, def.name, getDefaultValue(def));
        recalculateDependents(chatId, def.name);
    }
}

// ---------------------------------------------------------------------------
// A brand-new chat: how should it start? (requirements spec 1.14.1)
// ---------------------------------------------------------------------------
//
// State Engine never carries presets or variable values from one chat to another
// silently - a new chat starts with nothing. When there is an earlier chat with
// the same character (or group) that had presets or stored variables, the user is
// asked, BEFORE the new chat proceeds, how the new chat should start:
//
//   'presets'  - the same presets, no data: the earlier chat's active presets are
//                activated (their variables start at their defaults).
//   'continue' - the same presets AND the earlier chat's data: a continuation.
//   'clean'    - a clean slate: no presets, no data. (Also what closing the
//                dialog does.)
//
// SillyTavern awaits CHAT_CREATED listeners, so the question is asked and answered
// before the chat carries on.

export const NEW_CHAT_CHOICES = Object.freeze({ PRESETS: 'presets', CONTINUE: 'continue', CLEAN: 'clean' });

const escapeText = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]);

// The chat a new chat would continue from: the most recently updated stored chat
// of the same character / group that had active presets or stored variables.
// -> { sourceChatId, sourceState, presetIds, variableCount, isGroup } or null.
// Read-only: nothing is created or changed.
export function findPreviousChat(chatId) {
    const settings = getSettings();
    const store = settings.variableStore?.chats || {};
    const newChatState = loadChatState(chatId);
    const isGroup = !!newChatState.groupId;

    const presetsOf = (id) => {
        const binding = settings.chatPresetBindings?.[id];
        const list = Array.isArray(binding) ? binding : (binding?.presetLoadOrder?.length ? binding.presetLoadOrder : binding?.presetIds);
        return (Array.isArray(list) ? list : []).filter((presetId) => !!settings.presets?.[presetId]);
    };

    const candidates = Object.entries(store)
        .filter(([id]) => id !== chatId)
        .filter(([, state]) => isGroup
            ? state?.groupId === newChatState.groupId
            : state?.characterAvatar === newChatState.characterAvatar)
        .map(([id, state]) => ({
            sourceChatId: id,
            sourceState: state,
            presetIds: presetsOf(id),
            variableCount: Object.keys(state?.variables || {}).length,
            isGroup,
        }))
        .filter((c) => c.presetIds.length > 0 || c.variableCount > 0)
        .sort((a, b) => (b.sourceState?.lastUpdated || 0) - (a.sourceState?.lastUpdated || 0));

    return candidates[0] || null;
}

// Asks the user. Returns one of NEW_CHAT_CHOICES; anything other than a clear
// choice (closing the dialog, Escape, an error) is a clean slate.
// Uses SillyTavern's Popup with three buttons; without it, falls back to two
// confirm() questions.
async function askNewChatStart(source, presetNames) {
    const who = source.isGroup ? 'group' : 'character';
    const context = SillyTavern.getContext();

    if (context.Popup && context.POPUP_TYPE) {
        const list = presetNames.length
            ? `<ul style="text-align:left">${presetNames.map((n) => `<li>${escapeText(n)}</li>`).join('')}</ul>`
            : '<p><i>(no active presets)</i></p>';
        const html = `
            <h3>Start this new chat from your last one?</h3>
            <p>Your most recent chat with this ${who} ("${escapeText(source.sourceChatId)}") used these State Engine presets
               and has ${source.variableCount} stored variable(s):</p>
            ${list}
            <p>How should this new chat start?</p>`;
        const popup = new context.Popup(html, context.POPUP_TYPE.TEXT, '', {
            okButton: false,
            cancelButton: false,
            wide: false,
            customButtons: [
                { text: 'Same presets, no data', tooltip: 'Activate the same presets. Variables start at their defaults.', result: 101 },
                { text: 'Continue (presets + data)', tooltip: 'Activate the same presets and copy the variable values - a continuation of that chat.', result: 102 },
                { text: 'Clean slate', tooltip: 'No presets and no data.', result: 103 },
            ],
        });
        const result = await popup.show();
        if (result === 101) return NEW_CHAT_CHOICES.PRESETS;
        if (result === 102) return NEW_CHAT_CHOICES.CONTINUE;
        return NEW_CHAT_CHOICES.CLEAN;
    }

    // No Popup available: two questions.
    const names = presetNames.length ? presetNames.join(', ') : 'none';
    if (!window.confirm(`Use the same State Engine presets as your last chat with this ${who} ("${source.sourceChatId}": ${names})?\nCancel = a clean slate (no presets, no data).`)) {
        return NEW_CHAT_CHOICES.CLEAN;
    }
    return window.confirm('Also copy that chat\'s variable data into this new chat (a continuation)?\nCancel = same presets, no data.')
        ? NEW_CHAT_CHOICES.CONTINUE
        : NEW_CHAT_CHOICES.PRESETS;
}

// Carries out a choice. 'clean' does nothing. Otherwise the earlier chat's presets
// are activated in its load order (addPresetToChat seeds their defaults), and for
// 'continue' the earlier chat's values are then copied one variable at a time
// through setVar() - only for variables the newly active presets define, so no
// hidden values are stored for variables nothing shows. Never assigns the whole
// stored state object (that would overwrite the new chat's own
// characterAvatar/groupId stamps). Returns { activated, copied }.
export function applyNewChatChoice(chatId, choice, source) {
    const result = { activated: [], copied: 0 };
    if (choice !== NEW_CHAT_CHOICES.PRESETS && choice !== NEW_CHAT_CHOICES.CONTINUE) return result;

    for (const presetId of source.presetIds) {
        if (!getPresetsForChat(chatId).includes(presetId)) {
            addPresetToChat(chatId, presetId);
            result.activated.push(presetId);
        }
    }

    if (choice === NEW_CHAT_CHOICES.CONTINUE) {
        const definedHere = new Set(Object.values(getAllVariablesFromPresets(getPresetsForChat(chatId))).map((def) => def?.name).filter(Boolean));
        for (const [varName, entry] of Object.entries(source.sourceState.variables || {})) {
            if (!varName || !definedHere.has(varName)) continue;
            setVar(chatId, varName, entry?.value, entry?.def);
            result.copied++;
        }
        // One pass after all copied values are in place, so calculated variables
        // reflect the fully-copied state, not partial intermediate states.
        recalculateAllForChat(chatId);
    }
    return result;
}

const askedThisSession = new Set();

// CHAT_CREATED / GROUP_CHAT_CREATED handler body. Asks once per chat, applies the
// answer, returns { choice, activated, copied } (choice null when there was
// nothing to ask). Never throws. `ask` is replaceable for tests.
export async function offerNewChatStart(chatId, ask = askNewChatStart) {
    try {
        if (!chatId || askedThisSession.has(chatId)) return { choice: null, activated: [], copied: 0 };
        const source = findPreviousChat(chatId);
        if (!source) return { choice: null, activated: [], copied: 0 };
        askedThisSession.add(chatId);

        const settings = getSettings();
        const presetNames = source.presetIds.map((id) => settings.presets[id]?.name || id);
        const choice = await ask(source, presetNames);
        const applied = applyNewChatChoice(chatId, choice, source);
        return { choice, ...applied };
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        return { choice: null, activated: [], copied: 0 };
    }
}

// The old name, kept so nothing that refers to it breaks.
export const offerCopyFromPreviousChat = offerNewChatStart;

// When a chat loads: for every lorebook attached to it that has presets bound
// (lorebook-bindings.js) which are not active for this chat, ask once per
// lorebook whether to activate them.
//   Yes -> addPresetToChat() for each.
//   No  -> nothing is activated, and the choice is remembered for this chat
//          (settings.lorebookPresetDeclines) so the question is not repeated on
//          every chat load. Without the presets their variables do not exist,
//          and wi-filtering.js treats a WI condition on a missing variable as
//          met (fail-open), so the lorebook's entries are not hidden.
// Returns the preset ids it activated. Never throws.
export function offerLorebookPresets(chatId) {
    const activated = [];
    try {
        if (!chatId) return activated;
        const settings = getSettings();

        // A lorebook that is no longer attached to this chat takes its declines
        // with it, so re-attaching it later asks again.
        const attached = getActiveLorebookNames();
        pruneDeclinesForChat(chatId, attached);

        for (const book of attached) {
            const active = getPresetsForChat(chatId);
            const declined = settings.lorebookPresetDeclines[chatId] || [];
            const missing = getPresetsForLorebook(book, book)
                .filter((id) => !active.includes(id) && !declined.includes(declineKey(book, book, id)));
            if (missing.length === 0) continue;

            const names = missing.map((id) => settings.presets[id]?.name || id).join(', ');
            if (window.confirm(`This lorebook ("${book}") requires the presets ${names}. Activate them?`)) {
                for (const id of missing) {
                    addPresetToChat(chatId, id);
                    activated.push(id);
                }
            } else {
                settings.lorebookPresetDeclines[chatId] = [...declined, ...missing.map((id) => declineKey(book, book, id))];
                persistSettings();
            }
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
    return activated;
}

let startupRan = false;

export function runStartupOnce() {
    if (startupRan) return;
    startupRan = true;
    const settings = getSettings();
    migrateAllSettings(settings);
    runPromptedStateUpdate('startup');
}
