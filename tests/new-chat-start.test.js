import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { loadChatState, setVar } from '../src/core/chat-state.js';
import { addPresetToChat, getPresetsForChat } from '../src/core/preset-manager.js';
import { recalculateAllForChat } from '../src/core/calculated-engine.js';
import {
    findPreviousChat, applyNewChatChoice, offerNewChatStart, offerCopyFromPreviousChat, looksLikeNewChat, NEW_CHAT_CHOICES,
} from '../src/core/initialization-engine.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

let counter = 0;
function makePreset(name, variables = {}) {
    const id = `nc-preset-${++counter}`;
    const vars = {};
    for (const [varId, def] of Object.entries(variables)) vars[varId] = { id: varId, type: 'number', defaultValue: 0, ...def };
    getSettings().presets[id] = { id, name, namespace: 'se', description: '', triggers: ['ai'], showInTracker: false, variables: vars };
    return id;
}

// An earlier chat of the same character: presets active + stored values.
function makeSourceChat(chatId, { avatar = 'a.png', presetIds = [], values = {}, lastUpdated = 1000, groupId = null } = {}) {
    const state = loadChatState(chatId);
    state.characterAvatar = groupId ? null : avatar;
    state.groupId = groupId;
    state.lastUpdated = lastUpdated;
    for (const [name, value] of Object.entries(values)) state.variables[name] = { value, def: { name, type: 'number' } };
    for (const id of presetIds) addPresetToChat(chatId, id);
    return state;
}
// The brand-new chat, already stamped with the same character.
function makeNewChat(chatId = NEW, avatar = 'a.png', groupId = null) {
    const state = loadChatState(chatId);
    state.characterAvatar = groupId ? null : avatar;
    state.groupId = groupId;
    return state;
}

let hp; let mood; let inert;
let NEW; let DLG; // a fresh chat id per test: "asked once per chat" is remembered for the session
beforeEach(() => {
    settings.reset();
    NEW = `chat-NEW-${++counter}`;
    DLG = `chat-DLG-${counter}`;
    hp = makePreset('Vitals', { 'v-hp': { name: 'se__hp' } });
    mood = makePreset('Mood', { 'v-mood': { name: 'se__mood' } });
    inert = makePreset('Empty');
    vi.clearAllMocks();
});

const ask = (choice) => vi.fn(async () => choice);

describe('finding the chat a new chat would continue from', () => {
    it('nothing when there is no earlier chat', () => {
        makeNewChat();
        expect(findPreviousChat(NEW)).toBeNull();
    });

    it('the most recent earlier chat of the same character, with its presets in load order and its variable count', () => {
        makeSourceChat('old-1', { presetIds: [mood], values: { se__mood: 1 }, lastUpdated: 100 });
        makeSourceChat('old-2', { presetIds: [hp, mood], values: { se__hp: 7, se__mood: 2 }, lastUpdated: 500 });
        makeNewChat();
        const source = findPreviousChat(NEW);
        expect(source).toMatchObject({ sourceChatId: 'old-2', presetIds: [hp, mood], variableCount: 2, isGroup: false });
    });

    it('ignores other characters, and the new chat itself', () => {
        makeSourceChat('other', { avatar: 'b.png', presetIds: [hp], values: { se__hp: 1 } });
        makeNewChat();
        expect(findPreviousChat(NEW)).toBeNull();
    });

    it('a chat with neither presets nor variables is not worth asking about', () => {
        makeSourceChat('empty');
        makeNewChat();
        expect(findPreviousChat(NEW)).toBeNull();
    });

    it('presets alone (no stored variables yet) are enough; deleted presets are ignored', () => {
        makeSourceChat('old', { presetIds: [inert, hp] });
        delete getSettings().presets[hp];
        makeNewChat();
        expect(findPreviousChat(NEW).presetIds).toEqual([inert]);
    });

    it('groups match by group, not by character', () => {
        makeSourceChat('g-old', { groupId: 'grp-1', presetIds: [hp], values: { se__hp: 3 } });
        makeSourceChat('c-old', { avatar: 'a.png', presetIds: [mood], values: { se__mood: 3 }, lastUpdated: 9999 });
        makeNewChat('g-new', null, 'grp-1');
        expect(findPreviousChat('g-new')).toMatchObject({ sourceChatId: 'g-old', isGroup: true });
    });

    it('is read-only', () => {
        makeSourceChat('old', { presetIds: [hp], values: { se__hp: 3 } });
        makeNewChat();
        findPreviousChat(NEW);
        expect(getPresetsForChat(NEW)).toEqual([]);
    });
});

describe('the three choices', () => {
    beforeEach(() => {
        makeSourceChat('old', { presetIds: [hp, mood], values: { se__hp: 7, se__mood: 4 } });
        makeNewChat();
    });
    const valuesOf = (chatId) => Object.fromEntries(Object.entries(loadChatState(chatId).variables).map(([k, v]) => [k, v.value]));

    it('3. CLEAN SLATE: no presets and no data', async () => {
        const result = await offerNewChatStart(NEW, ask(NEW_CHAT_CHOICES.CLEAN));
        expect(result).toMatchObject({ choice: 'clean', activated: [], copied: 0 });
        expect(getPresetsForChat(NEW)).toEqual([]);
        expect(setVar).not.toHaveBeenCalled();
        expect(valuesOf(NEW)).toEqual({});
    });

    it('1. SAME PRESETS, NO DATA: the presets are active (in order), no values are copied', async () => {
        const result = await offerNewChatStart(NEW, ask(NEW_CHAT_CHOICES.PRESETS));
        expect(result).toMatchObject({ choice: 'presets', activated: [hp, mood], copied: 0 });
        expect(getPresetsForChat(NEW)).toEqual([hp, mood]);
        // (activating a preset seeds its DEFAULTS through setVar; the earlier chat's values are never written)
        expect(setVar).not.toHaveBeenCalledWith(NEW, 'se__hp', 7, expect.anything());
        expect(setVar).not.toHaveBeenCalledWith(NEW, 'se__mood', 4, expect.anything());
        expect(valuesOf(NEW).se__hp).not.toBe(7);
        expect(valuesOf(NEW).se__mood).not.toBe(4);
    });

    it('2. SAME PRESETS AND DATA: presets active AND the earlier chat\'s values copied', async () => {
        const result = await offerNewChatStart(NEW, ask(NEW_CHAT_CHOICES.CONTINUE));
        expect(result).toMatchObject({ choice: 'continue', activated: [hp, mood], copied: 2 });
        expect(getPresetsForChat(NEW)).toEqual([hp, mood]);
        expect(valuesOf(NEW)).toMatchObject({ se__hp: 7, se__mood: 4 });
        // after the copy, calculated variables are recalculated once more
        const lastCopy = setVar.mock.invocationCallOrder.at(-1);
        expect(recalculateAllForChat.mock.invocationCallOrder.at(-1)).toBeGreaterThan(lastCopy);
    });

    it('continue copies only variables the copied presets define (no hidden values for variables nothing shows)', async () => {
        loadChatState('old').variables.se__orphan = { value: 99, def: { name: 'se__orphan', type: 'number' } };
        await offerNewChatStart(NEW, ask(NEW_CHAT_CHOICES.CONTINUE));
        expect(valuesOf(NEW)).not.toHaveProperty('se__orphan');
    });

    it('the earlier chat is never changed by any choice', async () => {
        const before = JSON.stringify([loadChatState('old'), getSettings().chatPresetBindings.old]);
        await offerNewChatStart(NEW, ask(NEW_CHAT_CHOICES.CONTINUE));
        expect(JSON.stringify([loadChatState('old'), getSettings().chatPresetBindings.old])).toBe(before);
    });

    it('the new chat keeps its own character stamp (state is copied variable by variable, not wholesale)', async () => {
        await offerNewChatStart(NEW, ask(NEW_CHAT_CHOICES.CONTINUE));
        expect(loadChatState(NEW).characterAvatar).toBe('a.png');
        expect(loadChatState(NEW).groupId).toBeNull();
    });

    it('a preset that is already active in the new chat (e.g. from a lorebook prompt) is not added twice', async () => {
        addPresetToChat(NEW, hp);
        const result = await offerNewChatStart(NEW, ask(NEW_CHAT_CHOICES.PRESETS));
        expect(result.activated).toEqual([mood]);
        expect(getPresetsForChat(NEW)).toEqual([hp, mood]);
    });

    it('the dialog is told which chat, which presets and how many variables', async () => {
        const spy = ask(NEW_CHAT_CHOICES.CLEAN);
        await offerNewChatStart(NEW, spy);
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sourceChatId: 'old', variableCount: 2 }), ['Vitals', 'Mood']);
    });

    it('anything but a clear choice - dismissed, garbage, an error - is a clean slate', async () => {
        for (const answer of [undefined, null, '', 'maybe', 0]) {
            const result = await offerNewChatStart(`chat-${String(answer)}-${Math.random()}`, ask(answer));
            expect(getPresetsForChat(NEW)).toEqual([]);
            expect(result.activated).toEqual([]);
        }
        makeNewChat('chat-boom');
        const boom = vi.fn(async () => { throw new Error('dialog failed'); });
        await expect(offerNewChatStart('chat-boom', boom)).resolves.toMatchObject({ choice: null, activated: [] });
        expect(getPresetsForChat('chat-boom')).toEqual([]);
    });

    it('applyNewChatChoice ignores an unknown choice', () => {
        const source = findPreviousChat(NEW);
        expect(applyNewChatChoice(NEW, 'bogus', source)).toEqual({ activated: [], copied: 0 });
        expect(getPresetsForChat(NEW)).toEqual([]);
    });
});

describe('when to ask', () => {
    it('does not ask when there is nothing to continue from', async () => {
        makeNewChat();
        const spy = ask(NEW_CHAT_CHOICES.PRESETS);
        expect(await offerNewChatStart(NEW, spy)).toEqual({ choice: null, activated: [], copied: 0 });
        expect(spy).not.toHaveBeenCalled();
    });

    it('asks once per chat, even if both created-events fire', async () => {
        makeSourceChat('old', { presetIds: [hp], values: { se__hp: 1 } });
        makeNewChat('chat-ONCE');
        const spy = ask(NEW_CHAT_CHOICES.CLEAN);
        await offerNewChatStart('chat-ONCE', spy);
        await offerNewChatStart('chat-ONCE', spy);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not ask without a chat id', async () => {
        const spy = ask(NEW_CHAT_CHOICES.PRESETS);
        await offerNewChatStart(undefined, spy);
        expect(spy).not.toHaveBeenCalled();
    });

    it('keeps its old name for anything that refers to it', () => {
        expect(offerCopyFromPreviousChat).toBe(offerNewChatStart);
    });
});

describe('the dialog', () => {
    let popups;
    beforeEach(() => {
        makeSourceChat('old <b>&</b>', { presetIds: [makePreset('Evil <img src=x>')], values: { a: 1 } });
        makeNewChat(DLG);
        popups = [];
    });
    afterEach(() => { delete context.Popup; delete context.POPUP_TYPE; });

    const installPopup = (result) => {
        context.POPUP_TYPE = { TEXT: 1 };
        context.Popup = class {
            constructor(html, type, value, options) { this.html = html; this.options = options; popups.push(this); }
            async show() { return result; }
        };
    };

    it.each([[101, 'presets'], [102, 'continue'], [103, 'clean'], [null, 'clean'], [0, 'clean'], [undefined, 'clean']])('SillyTavern popup result %s -> %s', async (result, expected) => {
        installPopup(result);
        const out = await offerNewChatStart(DLG);
        expect(out.choice).toBe(expected);
    });

    it('has exactly the three buttons and no OK / Cancel', async () => {
        installPopup(103);
        await offerNewChatStart(DLG);
        const { customButtons, okButton, cancelButton } = popups[0].options;
        expect(customButtons.map((b) => b.text)).toEqual(['Same presets, no data', 'Continue (presets + data)', 'Clean slate']);
        expect(customButtons.map((b) => b.result)).toEqual([101, 102, 103]);
        expect(okButton).toBe(false);
        expect(cancelButton).toBe(false);
    });

    it('tells the user what it found, with everything escaped', async () => {
        installPopup(103);
        await offerNewChatStart(DLG);
        const html = popups[0].html;
        expect(html).toContain('How should this new chat start?');
        expect(html).toContain('1 stored variable(s)');
        expect(html).not.toMatch(/<img|<b>/);
        expect(html).toContain('Evil &lt;img src=x&gt;');
    });

    it('without a Popup it asks two questions: same presets? then also the data?', async () => {
        const confirm = vi.fn();
        vi.stubGlobal('window', Object.assign(globalThis, { confirm }));
        globalThis.window.confirm = confirm;
        confirm.mockReturnValueOnce(true).mockReturnValueOnce(true);
        expect((await offerNewChatStart(DLG)).choice).toBe('continue');

        makeNewChat('chat-DLG2');
        confirm.mockReset().mockReturnValueOnce(true).mockReturnValueOnce(false);
        expect((await offerNewChatStart('chat-DLG2')).choice).toBe('presets');

        makeNewChat('chat-DLG3');
        confirm.mockReset().mockReturnValueOnce(false);
        expect((await offerNewChatStart('chat-DLG3')).choice).toBe('clean');
        expect(confirm).toHaveBeenCalledTimes(1);
    });
});

describe('wiring', () => {
    const src = read('src', 'events', 'event-engine.js');
    it('the handler is async, awaits the question, and serves normal and group chats', () => {
        expect(src).toMatch(/const onChatCreated = async \(\) => \{/);
        expect(src).toContain('await offerNewChatStart(chatId, undefined, previousChatId)');
        expect(src).toContain('eventSource.on(eventTypes.CHAT_CREATED, onChatCreated)');
        expect(src).toContain('eventSource.on(eventTypes.GROUP_CHAT_CREATED, onChatCreated)');
    });
});

describe('a character with no greeting never gets CHAT_CREATED: CHAT_CHANGED asks too', () => {
    it('looksLikeNewChat: empty or greeting-only chat, no presets, no variables, not asked', () => {
        makeNewChat();
        expect(looksLikeNewChat(NEW, { chat: [] })).toBe(true);
        expect(looksLikeNewChat(NEW, { chat: [{ mes: 'Hello', is_user: false }] })).toBe(true);
    });

    it('an old chat being opened is not new: user messages, several messages, presets or variables', () => {
        makeNewChat();
        expect(looksLikeNewChat(NEW, { chat: [{ is_user: true, mes: 'hi' }] })).toBe(false);
        expect(looksLikeNewChat(NEW, { chat: [{ mes: 'a' }, { mes: 'b' }] })).toBe(false);
        expect(looksLikeNewChat(undefined, { chat: [] })).toBe(false);
        addPresetToChat(NEW, hp);
        expect(looksLikeNewChat(NEW, { chat: [] })).toBe(false);
    });

    it('is asked once even though both events may fire, and the answer is remembered with the chat', async () => {
        makeSourceChat('chat-OLD-x', { presetIds: [hp, mood] });
        makeNewChat();
        const first = ask(NEW_CHAT_CHOICES.PRESETS);
        await offerNewChatStart(NEW, first);
        expect(first).toHaveBeenCalledTimes(1);
        expect(getPresetsForChat(NEW)).toEqual([hp, mood]);
        expect(loadChatState(NEW).newChatStartAsked).toBe(true);
        expect(looksLikeNewChat(NEW, { chat: [] })).toBe(false);
    });

    it('a chat already asked (an earlier session) is not asked again', async () => {
        makeSourceChat('chat-OLD-y', { presetIds: [hp] });
        const state = makeNewChat();
        state.newChatStartAsked = true;
        const fn = ask(NEW_CHAT_CHOICES.PRESETS);
        expect((await offerNewChatStart(NEW, fn)).choice).toBe(null);
        expect(fn).not.toHaveBeenCalled();
    });

    it('CHAT_CHANGED is wired to ask before the lorebook offer', () => {
        const src = read('src', 'events', 'event-engine.js');
        expect(src).toContain('eventSource.on(eventTypes.CHAT_CHANGED, async () => {');
        expect(src).toContain('if (looksLikeNewChat(chatId, context)) await offerNewChatStart(chatId, undefined, previousChatId);');
        expect(src.indexOf('looksLikeNewChat(chatId, context)')).toBeLessThan(src.lastIndexOf('offerLorebookPresets(chatId);'));
    });
});

describe('the chat the user started from wins over the most recently updated one', () => {
    it('findPreviousChat prefers the chat you were just in', () => {
        makeSourceChat('chat-real', { presetIds: [hp], values: { se__hp: 7 }, lastUpdated: 1000 });
        makeSourceChat('chat-defaults-only', { presetIds: [hp], values: { se__hp: 0 }, lastUpdated: 5000 });
        makeNewChat();
        expect(findPreviousChat(NEW).sourceChatId).toBe('chat-defaults-only');
        expect(findPreviousChat(NEW, 'chat-real').sourceChatId).toBe('chat-real');
    });

    it('a preferred chat of another character (or with nothing to continue from) is ignored', () => {
        makeSourceChat('chat-mine', { presetIds: [hp], lastUpdated: 1000 });
        makeSourceChat('chat-other-char', { avatar: 'b.png', presetIds: [hp], lastUpdated: 9000 });
        makeSourceChat('chat-empty', { lastUpdated: 8000 });
        makeNewChat();
        expect(findPreviousChat(NEW, 'chat-other-char').sourceChatId).toBe('chat-mine');
        expect(findPreviousChat(NEW, 'chat-empty').sourceChatId).toBe('chat-mine');
    });

    it('CONTINUE copies the preferred chat values, not the newest chat defaults', async () => {
        makeSourceChat('chat-real', { presetIds: [hp], values: { se__hp: 7 }, lastUpdated: 1000 });
        makeSourceChat('chat-defaults-only', { presetIds: [hp], values: { se__hp: 0 }, lastUpdated: 5000 });
        makeNewChat();
        await offerNewChatStart(NEW, ask(NEW_CHAT_CHOICES.CONTINUE), 'chat-real');
        expect(loadChatState(NEW).variables.se__hp.value).toBe(7);
    });
});
