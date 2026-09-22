// formatting-utils.js's buildRecentMessagesSection(): the state-tracking
// prompt's context section, with the actual last chat message explicitly
// labeled "Most recent roleplay message" (a real report, 2026-09-22 - see
// this function's own header comment and requirements spec for the full
// reasoning). Shared by prompted-engine.js's runPromptedStateUpdate() and
// independent-presets.js's runIndependentPresetInternal() - both are
// covered end to end in their own test files (tests/datetime.test.js's
// "prompted updates" section, tests/api/independent-presets.test.js); this
// file is the function's own unit coverage.

import { buildRecentMessagesSection } from '../src/ui/formatting-utils.js';

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
});
