// Requirements spec 1.45: built-in prompt texts follow updates. A saved copy
// of any built-in version becomes null ("use the built-in"); the user's own
// text is kept and asked about once per built-in change.

import { createHash } from 'node:crypto';
import settings from './harness/settings.js';
import context from './harness/context.js';
import { stateEngine } from '../src/api/index.js';
import { resetNotificationRuntimeForTests } from '../src/core/notification-core.js';
import { DEFAULT_SETTINGS, DEFAULT_PROMPTED_HEADER } from '../src/core/settings-core.js';
import {
    PROMPT_DEFAULTS, isBuiltinPromptText, storedPromptValue, effectivePrompt, reconcilePromptDefaults, acknowledgePromptDefault,
} from '../src/core/prompt-defaults.js';
import { initPromptDefaultUpdates, reviewPromptDefaults, PROMPT_UPDATE_NOTIFICATION_KEY } from '../src/events/prompt-default-updates.js';

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const OLD_HEADER = PROMPT_DEFAULTS.promptedHeader.past[2]; // the header from before "Most recent roleplay message"
const MINE = 'My own header.';

beforeEach(() => resetNotificationRuntimeForTests());

describe('built-in versions', () => {
    // Changing a built-in prompt: add the OLD text to its `past` list
    // (src/core/prompt-defaults.js) and add the new text's hash here. Editing
    // a text in place fails this test - users holding it would not be upgraded.
    it('every version of each built-in prompt is pinned', () => {
        const all = (key) => [...PROMPT_DEFAULTS[key].past, PROMPT_DEFAULTS[key].current].map(hash);
        expect(all('promptedHeader')).toEqual(['b6dc61643f38', 'e09cc8061100', 'ef6a4374fd3c', 'a1228e075ff9', 'b635ad96bc38']);
        expect(all('promptedRules')).toEqual(['717104ea31f0', 'bb9fad04b900']);
        expect(PROMPT_DEFAULTS.promptedHeader.version).toBe(5);
        expect(PROMPT_DEFAULTS.promptedRules.version).toBe(2);
    });

    it('a fresh install stores no prompt text', () => {
        expect(DEFAULT_SETTINGS.promptedHeader).toBeNull();
        expect(settings.get().promptedHeader).toBeNull();
        expect(effectivePrompt(settings.get(), 'promptedHeader')).toBe(DEFAULT_PROMPTED_HEADER);
    });

    it('any built-in version matches, ignoring whitespace and the non-breaking hyphen', () => {
        expect(isBuiltinPromptText('promptedHeader', OLD_HEADER)).toBe(true);
        expect(isBuiltinPromptText('promptedHeader', `  ${OLD_HEADER.replace(/\n/g, '\r\n')}  `)).toBe(true);
        expect(isBuiltinPromptText('promptedHeader', OLD_HEADER.replace(/‑/g, '-'))).toBe(true);
        expect(isBuiltinPromptText('promptedHeader', `${OLD_HEADER} extra`)).toBe(false);
        expect(isBuiltinPromptText('promptedRules', OLD_HEADER)).toBe(false);
    });

    it('what the settings box stores: null for blank or built-in text, otherwise the text', () => {
        expect(storedPromptValue('promptedHeader', '')).toBeNull();
        expect(storedPromptValue('promptedHeader', DEFAULT_PROMPTED_HEADER)).toBeNull();
        expect(storedPromptValue('promptedHeader', OLD_HEADER)).toBeNull();
        expect(storedPromptValue('promptedHeader', MINE)).toBe(MINE);
    });
});

describe('reconcilePromptDefaults (startup)', () => {
    it('a saved copy of an old built-in becomes null and follows the current one', () => {
        const s = settings.get();
        s.promptedHeader = OLD_HEADER;
        expect(reconcilePromptDefaults(s)).toEqual({ changed: true, outdated: [] });
        expect(s.promptedHeader).toBeNull();
        expect(s.promptDefaultsSeen.promptedHeader).toBe(PROMPT_DEFAULTS.promptedHeader.version);
        expect(effectivePrompt(s, 'promptedHeader')).toBe(DEFAULT_PROMPTED_HEADER);
    });

    it('the user\'s own text is kept, and outdated until its current built-in is seen', () => {
        const s = settings.get();
        s.promptedHeader = MINE;
        expect(reconcilePromptDefaults(s).outdated).toEqual(['promptedHeader']);
        expect(s.promptedHeader).toBe(MINE);
        acknowledgePromptDefault(s, 'promptedHeader');
        expect(reconcilePromptDefaults(s).outdated).toEqual([]);
        s.promptDefaultsSeen.promptedHeader = PROMPT_DEFAULTS.promptedHeader.version - 1; // a later built-in change
        expect(reconcilePromptDefaults(s).outdated).toEqual(['promptedHeader']);
    });

    it('a second run changes nothing', () => {
        const s = settings.get();
        s.promptedRules = PROMPT_DEFAULTS.promptedRules.past[0];
        reconcilePromptDefaults(s);
        expect(reconcilePromptDefaults(s)).toEqual({ changed: false, outdated: [] });
    });
});

describe('the notification', () => {
    const ours = () => stateEngine.getNotifications().filter((n) => n.id === `se::${PROMPT_UPDATE_NOTIFICATION_KEY}`);

    it('is posted once at startup only when the user\'s own text is behind', () => {
        initPromptDefaultUpdates();
        expect(ours()).toHaveLength(0);
        settings.get().promptedHeader = OLD_HEADER;
        initPromptDefaultUpdates();
        expect(ours()).toHaveLength(0);
        expect(settings.get().promptedHeader).toBeNull();
        // Own text written while the current built-in was in use: already seen.
        settings.get().promptedHeader = MINE;
        initPromptDefaultUpdates();
        expect(ours()).toHaveLength(0);
        // Own text saved before versions were recorded: asked about, once.
        settings.get().promptDefaultsSeen = {};
        initPromptDefaultUpdates();
        initPromptDefaultUpdates();
        expect(ours()).toHaveLength(1);
    });

    it('"Use the new built-in" clears the text; "Keep mine" keeps it; either is not asked again', async () => {
        const s = settings.get();
        s.promptedHeader = MINE;
        s.promptedRules = 'My rules.';
        await reviewPromptDefaults(async (key) => (key === 'promptedHeader' ? 'builtin' : 'mine'));
        expect(s.promptedHeader).toBeNull();
        expect(s.promptedRules).toBe('My rules.');
        expect(reconcilePromptDefaults(s).outdated).toEqual([]);
    });

    it('closing the dialog asks again', async () => {
        vi.useFakeTimers();
        try {
            // SillyTavern's Popup, closed without choosing.
            context.Popup = class { show() { return Promise.resolve(0); } };
            context.POPUP_TYPE = { TEXT: 1 };
            settings.get().promptedHeader = MINE;
            initPromptDefaultUpdates();
            const ask = vi.fn(async () => null);
            await stateEngine.invokeNotificationCallback(`se::${PROMPT_UPDATE_NOTIFICATION_KEY}`);
            expect(ours()).toHaveLength(0); // removed after its action...
            vi.runAllTimers();
            expect(ours()).toHaveLength(1); // ...and posted again, still unanswered
            expect(settings.get().promptedHeader).toBe(MINE);
            await reviewPromptDefaults(ask);
            expect(ask).toHaveBeenCalledWith('promptedHeader', MINE);
        } finally {
            vi.useRealTimers();
            delete context.Popup;
            delete context.POPUP_TYPE;
        }
    });
});
