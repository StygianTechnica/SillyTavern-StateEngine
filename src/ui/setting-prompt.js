// State Engine — "Which setting does this chat use?" (requirements spec 1.42)
//
// Asked when a chat first needs characters and has no setting (a new chat
// without an earlier one to inherit from, or a chat from before settings),
// and only when there is more than the Default setting to choose from -
// characters.js ensureChatSetting() decides when. Returns the chosen setting
// id, or null (closed / dismissed -> Default).

export async function askChatSetting(settings) {
    const context = SillyTavern.getContext();
    const list = Array.isArray(settings) ? settings : [];
    if (context.Popup && context.POPUP_TYPE) {
        const html = `
            <h3>Which setting does this chat use?</h3>
            <p>A setting holds the characters a story's chats share. Characters this chat meets are kept in it.</p>`;
        const popup = new context.Popup(html, context.POPUP_TYPE.TEXT, '', {
            okButton: false,
            cancelButton: 'Use Default',
            wide: false,
            customButtons: list.map((setting, i) => ({
                text: setting.isDefault ? `${setting.name} (everything)` : setting.name,
                tooltip: `${setting.characterCount} character(s)`,
                result: 200 + i,
            })),
        });
        const result = await popup.show();
        return Number.isInteger(result) && result >= 200 ? list[result - 200]?.id ?? null : null;
    }
    // No Popup: a prompt listing the settings by number.
    const lines = list.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
    const answer = window.prompt(`Which setting does this chat use?\n${lines}\n(Cancel = Default)`, '1');
    const index = Number.parseInt(answer, 10) - 1;
    return list[index]?.id ?? null;
}

