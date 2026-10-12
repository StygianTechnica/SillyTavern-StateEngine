// State Engine — "Choose a setting for this chat" (requirements spec 1.42)
//
// Asked when a chat first needs objects (characters, locations...) and has
// no setting (a new chat without an earlier one to inherit from, or a chat
// from before settings), and only when there is more than the Default
// setting to choose from - objects.js ensureChatSetting() decides when.
//
// One dropdown of the settings (Default first, and chosen to begin with)
// plus "New setting...", which shows a name box: the setting is created
// here and the chat uses it. Returns the chosen setting id, or null
// (closed / dismissed -> Default).

import { createSetting } from '../core/objects.js';

const NEW = '__new__';

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Default first, then the others by name.
function ordered(settings) {
    return [...settings].sort((a, b) => (b.isDefault === true) - (a.isDefault === true) || String(a.name).localeCompare(String(b.name)));
}

function optionLabel(setting) {
    const count = Number(setting.objectCount) || 0;
    return `${setting.name}${setting.isDefault ? ' (default)' : ''} - ${count} ${count === 1 ? 'object' : 'objects'}`;
}

// Why `name` can't be a new setting's name, or '' when it can.
export function newSettingProblem(name, settings) {
    const clean = String(name ?? '').trim();
    if (!clean) return 'Give the new setting a name.';
    if (settings.some((s) => String(s.name).toLowerCase() === clean.toLowerCase())) return `There is already a setting named "${clean}".`;
    return '';
}

// The setting id for what was picked: an existing setting's, or a new
// setting's (created now). Throws if the new one can't be created.
export function settingIdFor({ choice, newName }, settings) {
    if (choice !== NEW) return settings.some((s) => s.id === choice) ? choice : null;
    return createSetting({ name: String(newName).trim() })?.id ?? null;
}

function dialogHtml(settings, { choice, newName, problem }) {
    const options = ordered(settings)
        .map((s) => `<option value="${escapeHtml(s.id)}"${s.id === choice ? ' selected' : ''}>${escapeHtml(optionLabel(s))}</option>`)
        .join('');
    return `
        <h3>Choose a setting for this chat</h3>
        <p>The setting is the world this chat's characters, places and lore belong to - chats with the same setting share them.</p>
        <div class="flex-container flexFlowColumn" style="gap: 6px; text-align: left;">
            <select id="se_setting_choice" class="text_pole">
                ${options}
                <option value="${NEW}"${choice === NEW ? ' selected' : ''}>New setting...</option>
            </select>
            <input id="se_setting_new_name" class="text_pole" type="text" maxlength="80" placeholder="Name of the new setting"
                value="${escapeHtml(newName)}" ${choice === NEW ? '' : 'style="display: none;"'} />
            ${problem ? `<small style="color: var(--warning, #e0a040);">${escapeHtml(problem)}</small>` : ''}
        </div>`;
}

// Shows the dialog once; resolves to { choice, newName } or null (closed).
async function showDialog(context, settings, state) {
    const picked = { ...state };
    // The dialog's fields are followed while it is open (its DOM is
    // SillyTavern's Popup's, not ours to keep).
    const onChange = (e) => {
        if (e.target?.id === 'se_setting_choice') {
            picked.choice = e.target.value;
            const name = document.getElementById('se_setting_new_name');
            if (name) {
                name.style.display = picked.choice === NEW ? '' : 'none';
                if (picked.choice === NEW) name.focus();
            }
        } else if (e.target?.id === 'se_setting_new_name') {
            picked.newName = e.target.value;
        }
    };
    document.addEventListener('change', onChange, true);
    document.addEventListener('input', onChange, true);
    try {
        const popup = new context.Popup(dialogHtml(settings, state), context.POPUP_TYPE.TEXT, '', {
            okButton: 'Use this setting',
            cancelButton: false,
            wide: false,
        });
        const result = await popup.show();
        const ok = context.POPUP_RESULT ? result === context.POPUP_RESULT.AFFIRMATIVE : !!result;
        return ok ? picked : null;
    } finally {
        document.removeEventListener('change', onChange, true);
        document.removeEventListener('input', onChange, true);
    }
}

export async function askChatSetting(settings) {
    const context = SillyTavern.getContext();
    const list = Array.isArray(settings) ? settings : [];
    if (context.Popup && context.POPUP_TYPE) {
        let state = { choice: ordered(list)[0]?.id ?? null, newName: '', problem: '' };
        for (;;) {
            const picked = await showDialog(context, list, state);
            if (!picked) return null;
            const problem = picked.choice === NEW ? newSettingProblem(picked.newName, list) : '';
            if (problem) {
                state = { ...picked, problem };
                continue;
            }
            try {
                return settingIdFor(picked, list);
            } catch (err) {
                state = { ...picked, problem: err?.message ?? String(err) };
            }
        }
    }
    // No Popup: a prompt listing the settings by number, the last one "new".
    const choices = ordered(list);
    const lines = [...choices.map((s, i) => `${i + 1}. ${s.name}`), `${choices.length + 1}. New setting...`].join('\n');
    const answer = window.prompt(`Choose a setting for this chat:\n${lines}\n(Cancel = Default)`, '1');
    const index = Number.parseInt(answer, 10) - 1;
    if (index === choices.length) {
        const name = window.prompt('Name of the new setting:', '');
        if (newSettingProblem(name, list)) return null;
        try {
            return settingIdFor({ choice: NEW, newName: name }, list);
        } catch {
            return null;
        }
    }
    return choices[index]?.id ?? null;
}
