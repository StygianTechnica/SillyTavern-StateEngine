// @vitest-environment jsdom
//
// "Choose a setting for this chat" (src/ui/setting-prompt.js): a dropdown of
// the settings, Default first and chosen, plus "New setting..." with a name
// box - against a stand-in for SillyTavern's Popup that plays the user.

import context from './harness/context.js';
import * as O from '../src/core/objects.js';
import { askChatSetting, newSettingProblem } from '../src/ui/setting-prompt.js';

const AFFIRMATIVE = 1;

// Each show() renders the dialog, runs the next user action on it, and
// closes it with that action's result.
function fakePopup(actions) {
    const shown = [];
    class Popup {
        constructor(html, type, value, options) {
            this.html = html;
            this.options = options;
        }

        async show() {
            const box = document.createElement('div');
            box.innerHTML = this.html;
            document.body.append(box);
            shown.push({ html: this.html, options: this.options, text: box.textContent });
            const act = actions.shift();
            const result = act ? act(box) : null;
            box.remove();
            return result;
        }
    }
    Object.assign(context, { Popup, POPUP_TYPE: { TEXT: 1 }, POPUP_RESULT: { AFFIRMATIVE } });
    return shown;
}

const pick = (value) => (box) => {
    const select = box.querySelector('#se_setting_choice');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return AFFIRMATIVE;
};
const name = (value) => (box) => {
    pick('__new__')(box);
    const input = box.querySelector('#se_setting_new_name');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return AFFIRMATIVE;
};

let test;

beforeEach(() => {
    document.body.innerHTML = '';
    test = O.createSetting({ name: 'Test' });
});

describe('the setting dialog', () => {
    it('offers one dropdown, Default first and chosen, plus New setting - and one button', async () => {
        const shown = fakePopup([() => AFFIRMATIVE]);
        expect(await askChatSetting(O.listSettings())).toBe('default');
        const box = document.createElement('div');
        box.innerHTML = shown[0].html;
        const options = [...box.querySelectorAll('option')];
        expect(options.map((o) => o.value)).toEqual(['default', test.id, '__new__']);
        expect(options[0].selected).toBe(true);
        expect(options[0].textContent).toMatch(/^Default \(default\) - \d+ objects?$/);
        expect(shown[0].text).toContain('Choose a setting for this chat');
        expect(shown[0].options).toMatchObject({ okButton: 'Use this setting', cancelButton: false });
        expect(shown[0].options.customButtons).toBeUndefined();
    });

    it('uses the setting picked', async () => {
        fakePopup([pick(test.id)]);
        expect(await askChatSetting(O.listSettings())).toBe(test.id);
    });

    it('creates a new setting by name and uses it', async () => {
        fakePopup([name('  Maple Heights  ')]);
        const id = await askChatSetting(O.listSettings());
        expect(O.getSetting(id)).toMatchObject({ name: 'Maple Heights' });
    });

    it('asks again, saying why, for an empty or taken name', async () => {
        const shown = fakePopup([name(''), name('test'), name('Fresh')]);
        const id = await askChatSetting(O.listSettings());
        expect(shown[1].text).toContain('Give the new setting a name.');
        expect(shown[2].text).toContain('There is already a setting named "test".');
        expect(shown[2].html).toContain('value="test"');
        expect(O.getSetting(id).name).toBe('Fresh');
    });

    it('means Default when closed', async () => {
        fakePopup([() => null]);
        expect(await askChatSetting(O.listSettings())).toBeNull();
    });

    it('checks new names', () => {
        expect(newSettingProblem(' ', [])).toBe('Give the new setting a name.');
        expect(newSettingProblem('Story', [{ name: 'story' }])).toMatch(/already/);
        expect(newSettingProblem('Story', [])).toBe('');
    });
});
