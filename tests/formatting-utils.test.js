// formatting-utils.js's buildRecentMessagesSection(): the state-tracking
// prompt's context section, with the actual last chat message explicitly
// labeled "Most recent roleplay message" (a real report, 2026-09-22 - see
// this function's own header comment and requirements spec for the full
// reasoning). Shared by prompted-engine.js's runPromptedStateUpdate() and
// independent-presets.js's runIndependentPresetInternal() - both are
// covered end to end in their own test files (tests/datetime.test.js's
// "prompted updates" section, tests/api/independent-presets.test.js); this
// file is the function's own unit coverage.

import { buildRecentMessagesSection, selectPromptMessages } from '../src/ui/formatting-utils.js';

const msg = (isUser, text, name) => ({ is_user: isUser, mes: text, name });

describe('buildRecentMessagesSection', () => {
    it('an empty or missing message list -> "No conversation yet."', () => {
        expect(buildRecentMessagesSection([])).toBe('No conversation yet.');
        expect(buildRecentMessagesSection(undefined)).toBe('No conversation yet.');
        expect(buildRecentMessagesSection(null)).toBe('No conversation yet.');
    });

    it('messages that are all blank after stripping -> "No conversation yet.", same as none at all', () => {
        expect(buildRecentMessagesSection([msg(true, '   '), msg(false, '<br>')])).toBe('No conversation yet.');
    });

    it('exactly one real message: ONLY "Most recent roleplay message", no "Recent conversation" section', () => {
        const result = buildRecentMessagesSection([msg(true, 'hello there')], { name1: 'Alice' });
        expect(result).toBe('Most recent roleplay message:\nAlice: hello there');
        expect(result).not.toContain('Recent conversation');
    });

    it('two or more messages: "Recent conversation" holds everything EXCEPT the last, which gets its own label', () => {
        const result = buildRecentMessagesSection(
            [msg(true, 'first line', undefined), msg(false, 'second line', 'Bot'), msg(true, 'third and last', undefined)],
            { name1: 'Alice', name2: 'Bob' },
        );
        expect(result).toBe(
            'Recent conversation:\nAlice: first line\nBot: second line\n\nMost recent roleplay message:\nAlice: third and last'
        );
    });

    it('the last message is whichever one is chronologically last, regardless of who sent it', () => {
        const userLast = buildRecentMessagesSection([msg(false, 'a', 'Bot'), msg(true, 'b')], { name1: 'Alice' });
        expect(userLast).toContain('Most recent roleplay message:\nAlice: b');

        const botLast = buildRecentMessagesSection([msg(true, 'a'), msg(false, 'b', 'Bot')], { name1: 'Alice' });
        expect(botLast).toContain('Most recent roleplay message:\nBot: b');
    });

    it('a trailing blank message does not hide the real last message behind it', () => {
        const result = buildRecentMessagesSection([msg(true, 'real content'), msg(false, '   ', 'Bot')]);
        expect(result).toContain('Most recent roleplay message:\nUser: real content');
        expect(result).not.toContain('Recent conversation'); // the blank one never counted as history either
    });

    it('strips HTML from every message, including the most-recent one', () => {
        const result = buildRecentMessagesSection([msg(true, '<b>bold</b> text')]);
        expect(result).toBe('Most recent roleplay message:\nUser: bold text');
    });

    it('truncates to maxMessageLength when given, on both history and the most-recent line, without touching the original', () => {
        const original = 'a'.repeat(50);
        const messages = [msg(true, original), msg(false, original, 'Bot')];
        const result = buildRecentMessagesSection(messages, { maxMessageLength: 10 });
        expect(result).toContain('User: ' + 'a'.repeat(10) + '…');
        expect(result).toContain('Bot: ' + 'a'.repeat(10) + '…');
        expect(messages[0].mes).toBe(original); // the stored message itself is never mutated
    });

    it('maxMessageLength: 0 (or omitted) means no truncation at all', () => {
        const long = 'a'.repeat(500);
        expect(buildRecentMessagesSection([msg(true, long)])).toContain(long);
        expect(buildRecentMessagesSection([msg(true, long)], { maxMessageLength: 0 })).toContain(long);
    });

    it('falls back to "User"/"Character" when name1/name2 are not given', () => {
        const result = buildRecentMessagesSection([msg(true, 'hi'), msg(false, 'hello', undefined)]);
        expect(result).toContain('User: hi');
        expect(result).toContain('Character: hello');
    });

    it('an AI message with a name uses it over the generic name2 fallback', () => {
        const result = buildRecentMessagesSection([msg(false, 'hi', 'Gandalf')], { name2: 'Character' });
        expect(result).toBe('Most recent roleplay message:\nGandalf: hi');
    });

    // Spec 1.44: every message since the last user message.
    describe('Latest turn', () => {
        it('an AI-triggered run: the user message and every reply after it, ending with the most recent', () => {
            const result = buildRecentMessagesSection(
                [msg(false, 'earlier', 'Bot'), msg(true, 'we walk to town'), msg(false, 'It takes an hour.', 'Alice'), msg(false, 'Then dusk.', 'Bob')],
                { name1: 'Me' },
            );
            expect(result).toBe(
                'Recent conversation:\nBot: earlier\n\n'
                + 'Latest turn:\nMe: we walk to town\nAlice: It takes an hour.\nBob: Then dusk.\n\n'
                + 'Most recent roleplay message:\nBob: Then dusk.'
            );
        });

        it('a one-message turn (a user-triggered run) is not repeated as its own section', () => {
            const result = buildRecentMessagesSection([msg(false, 'a', 'Bot'), msg(true, 'b')], { name1: 'Me' });
            expect(result).toBe('Recent conversation:\nBot: a\n\nMost recent roleplay message:\nMe: b');
        });

        it('a hidden (is_system) user message does not start the turn', () => {
            const hidden = { is_user: true, is_system: true, mes: 'ooc note' };
            const result = buildRecentMessagesSection([msg(true, 'go'), msg(false, 'x', 'Bot'), hidden, msg(false, 'y', 'Bot')]);
            expect(result).toContain('Latest turn:\nUser: go\nBot: x\nUser: ooc note\nBot: y');
            expect(result).not.toContain('Recent conversation');
        });

        it('a blank user message does not start the turn', () => {
            const result = buildRecentMessagesSection([msg(true, 'go'), msg(false, 'x', 'Bot'), msg(true, '  '), msg(false, 'y', 'Bot')]);
            expect(result).toContain('Latest turn:\nUser: go\nBot: x\nBot: y');
        });

        it('no user message at all: the whole slice is the turn', () => {
            const result = buildRecentMessagesSection([msg(false, 'a', 'Bot'), msg(false, 'b', 'Bot')]);
            expect(result).toBe('Latest turn:\nBot: a\nBot: b\n\nMost recent roleplay message:\nBot: b');
        });
    });
});

describe('selectPromptMessages', () => {
    const chat = [msg(true, 'u1'), msg(false, 'a1'), msg(true, 'u2'), msg(false, 'a2'), msg(false, 'a3'), msg(false, 'a4')];
    const texts = (list) => list.map((m) => m.mes);

    it('the last `count` messages when they already hold the latest turn', () => {
        expect(texts(selectPromptMessages(chat, 5, 10))).toEqual(['a1', 'u2', 'a2', 'a3', 'a4']);
    });

    it('reaches back to the last user message when `count` would cut the turn short', () => {
        expect(texts(selectPromptMessages(chat, 2, 10))).toEqual(['u2', 'a2', 'a3', 'a4']);
    });

    it('never past the cap', () => {
        expect(texts(selectPromptMessages(chat, 2, 3))).toEqual(['a2', 'a3', 'a4']);
        expect(texts(selectPromptMessages(chat, 10, 3))).toEqual(['a2', 'a3', 'a4']);
    });

    it('a hidden user message is not where the turn starts', () => {
        const withHidden = [...chat, { is_user: true, is_system: true, mes: 'hidden' }, msg(false, 'a5')];
        expect(texts(selectPromptMessages(withHidden, 1, 10))).toEqual(['u2', 'a2', 'a3', 'a4', 'hidden', 'a5']);
    });

    it('a missing chat is an empty list', () => {
        expect(selectPromptMessages(undefined, 5, 5)).toEqual([]);
    });
});
