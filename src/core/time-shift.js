// Reading time in story text (requirements: time phrases are read in one
// place). Prompted answers are read by calendar-engine's resolveInstruction;
// this reads PROSE - a player's post, a reply - for the time it passes or
// reaches, and hands back an instruction resolveInstruction understands
// ("the next morning", "until evening", "a few hours"). Moved here from
// Scenario Builder, which keeps its own clock, so both read time the same
// way. Pure: no State Engine state, no calendar - the caller resolves the
// instruction on its calendar (advanceDateTime).
//
//   readTimeShift(text) -> {
//     skip:    { advance, sameDay } | null   a skip the text makes (a
//              player's "Early the next morning, ...", "The rest of the day
//              went by", "Morning dawned"); sameDay: never runs on into
//              tomorrow ("later that evening")
//     reached: { phrase, fraction } | null   the latest part of the day the
//              text shows the scene reaching ("the sun began to set")
//     elapsed: '' | span                     time it tells as passed ("two
//              hours later", "the hours crept by")
//     delta:   '' | advance                  a short "how much time passed"
//              answer read as an advance (a prompted scene_deltatime)
//   }

// ---- the time of day the story shows
//
// A reply that shows the day turning - "the sun began to set", "night fell",
// "dawn broke" - moves the clock to that part of the day (the story leads).
// Only plain narration of the scene counts: a sentence about later ("their
// meeting in the morning", "by nightfall", "would", "tomorrow") does not.
const TIME_CUES = [
    ['morning', 0.33, [/\b(?:it|the day) (?:was|is) (?:morning|full day)\b/, /\bmorning (?:came|had come|arrived|had arrived|broke|had broken)\b/, /\b(?:well|long) (?:after|past) (?:dawn|daybreak|sunrise)\b/, /\bthe morning sun(?:'s)? (?:\w+ ){0,3}(?:bathed|lit|warmed|spilled|shone|shines|rose|climbed|glowed|glows)\b/]],
    ['dawn', 0.25, [
        /\b(?:dawn|daybreak) (?:broke|breaks|had broken|came|comes|arrived|crept|creeps)\b/,
        /\bthe sun (?:rose|rises|had risen|came up|comes up|crested|crests|climbed above)\b/,
        /\bthe first light of (?:dawn|day|morning) (?:crept|spilled|broke|touched)\b/,
        // The scene lit by it: "the dim light of dawn", "the first pale light
        // of sunrise", "the dawn's early light" (never "the light of day").
        /\blight of (?:dawn|daybreak|sunrise)\b/,
        /\b(?:dawn|daybreak|sunrise)'s (?:\w+ ){0,2}light\b/,
        /\bfirst (?:\w+ ){0,2}light of (?:day|morning)\b/,
        /\b(?:sunrise|first light) (?:\w+ ){0,2}(?:crept|creeps|spread|spreads|broke|breaks|touched|touches|spilled|spills|painted|paints)\b/,
        /\b(?:light|glow|sun|sunlight|daylight) (?:\w+ ){0,3}(?:crept|creeps|crested|crests|rose|rises|spilled|spills|broke|breaks|peeked|peeks) over the horizon\b/,
    ]],
    ['noon', 0.5, [/\bthe (?:noon|midday) sun (?:beat|beats|blazed|blazes|hung|hangs)\b/]],
    ['sunset', 0.77, [/\bthe sun (?:began|begins|started|starts|was beginning|is beginning) to (?:set|sink|go down|dip)\b/, /\bthe sun (?:set|sets|was setting|is setting|sank|sinks|was sinking|is sinking|dipped|dips|went down|goes down|had set)\b/, /\b(?:dusk|twilight) (?:fell|falls|had fallen|settled|settles|gathered|gathers|crept|creeps|descended|descends)\b/, /\bas (?:the )?(?:daylight|the light|the day) (?:faded|fades|waned|wanes|died|dies)\b/]],
    ['night', 0.88, [/\b(?:night|darkness) (?:fell|falls|had fallen|has fallen|settled|settles|descended|descends|closed in|closes in)\b/]],
];
const NOT_NOW = /\b(?:will|would|tomorrow|until|by the time|before|by nightfall|by dawn|in the morning|tonight|later|soon|next)\b/i;
// A span told in the past ("Remus was unconscious until well after
// daybreak") reaches its end now, though it says "until".
const PAST_SPAN = /\b(?:was|were|had|lay|slept|stayed|remained)\b[^.!?]*\b(?:until|till)\b/i;
const FUTURE = /\b(?:will|would|shall|tomorrow|tonight|soon|later)\b/i;
// Waiting for it, or a likeness ("eyes bright as the light of dawn"), is
// not the day turning.
const NOT_REACHED = /\b(?:wait(?:s|ed|ing)? for|await(?:s|ed|ing)?|longed for|hoped for)\b|\b(?:like|as if|as though|bright as)\s+(?:a |an |the )?(?:\w+ ){0,2}(?:light|dawn|daybreak|sunrise|sun)\b/i;
// Speech is what someone says, not the scene: "We ride at first light."
const SPEECH = /"[^"]*"|“[^”]*”/g;

// The latest part of the day a reply shows the scene reaching:
// { phrase, fraction } (fraction of the day: sunset 0.77), or null.
function storyTimeCue(text) {
    const sentences = String(text ?? '').replace(SPEECH, ' ').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]*/g) ?? [];
    let found = null;
    for (const sentence of sentences) {
        const t = sentence.toLowerCase();
        if (NOT_NOW.test(t) && !(PAST_SPAN.test(t) && !FUTURE.test(t))) continue;
        if (NOT_REACHED.test(t)) continue;
        for (const [phrase, fraction, patterns] of TIME_CUES) {
            if (patterns.some((re) => re.test(t))) found = { phrase, fraction };
        }
    }
    return found;
}

// How much time the story says passed (sb__scene_deltatime), as an advance
// the clock can take - never a description of the moment taken for a jump.
// "minutes into the night" is a few minutes, not "on to the night"
// (which, at night, would be the next night - a whole day lost each reply).
//   - a counted span ("two hours", "20 minutes later") -> that span
//   - a bare unit ("minutes into the night", "hours of fighting") -> a few
//   - a jump the text asks for ("the next morning", "until dawn",
//     "overnight", "tomorrow") -> kept as it is
//   - a part of the day described, not reached ("into the night", "late
//     evening", "still night") -> '' (no advance)
function storyDelta(text) {
    const t = String(text ?? '').toLowerCase().replace(/[.!]+$/, '').trim();
    if (!t) return '';
    const counted = t.match(/(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|few|several|half)\s*(?:an?\s+)?(?:minute|min|hour|hr|day|week|month)s?/);
    if (counted) return counted[0];
    // "from late night through dawn": on to that dawn.
    const reached = t.match(/\b(?:through|till|until|to)\s+(?:the\s+)?(dawn|daybreak|sunrise|first light|morning)\b/);
    if (reached) return `until ${reached[1] === 'morning' ? 'morning' : 'dawn'}`;
    if (/\b(?:next|following|tomorrow|overnight|until|till|through the night|all night)\b/.test(t)) return t;
    const bare = t.match(/\b(minute|hour|day|week)s\b/);
    if (bare) return `a few ${bare[1]}s`;
    return '';
}

// A time skip the player's own post opens a sentence with ("Early the next
// morning, Zane drove Cyril back", "Two days later", "Later that evening")
// - the player moves time on, and the clock follows them, not a briefing
// that missed it. Only narration, only a sentence that starts with it, and
// never one about what will be. -> { advance, sameDay } or null: `advance`
// for advanceFrom; `sameDay` for "later that evening", which never runs on
// into tomorrow.
const SKIP_PART = String.raw`(?<part>dawn|daybreak|sunrise|morning|noon|midday|afternoon|evening|dusk|nightfall|night)`;
const SKIP_COUNT = String.raw`(?<n>an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a few|few|several|some|\d+)`;
const PART_WORD = { daybreak: 'dawn', sunrise: 'dawn', midday: 'noon', dusk: 'evening', nightfall: 'evening' };
const SKIP_OPENERS = [
    // "Early the next morning", "The following day", "Next morning", "The morning after"
    [new RegExp(String.raw`^(?:(?:very |quite )?(?:early|late)\s+(?:on\s+)?)?(?:on\s+)?(?:the\s+)?(?:next|following)\s+(?<part>day|dawn|daybreak|sunrise|morning|noon|midday|afternoon|evening|night)\b`), (m) => ({ advance: m.groups.part === 'day' ? 'the next morning' : `the next ${PART_WORD[m.groups.part] ?? m.groups.part}`, sameDay: false })],
    [new RegExp(String.raw`^(?:early\s+)?the\s+(?<part>morning|day)\s+after\b`), () => ({ advance: 'the next morning', sameDay: false })],
    [/^(?:early\s+)?tomorrow(?:\s+(?<part>morning|afternoon|evening))?\b/, (m) => ({ advance: `the next ${m.groups.part ?? 'morning'}`, sameDay: false })],
    // "Two days later", "Hours later", "A few hours later"
    [new RegExp(String.raw`^(?:${SKIP_COUNT}\s+)?(?<u>hours?|days?|weeks?)\s+(?:later|passed|went by)\b`), (m) => {
        const n = String(m.groups.n ?? '').toLowerCase();
        const unit = m.groups.u.replace(/s$/, '');
        return { advance: !n || ['few', 'a few', 'several', 'some'].includes(n) ? `a few ${unit}s` : ['a', 'an', 'one'].includes(n) ? `one ${unit}` : `${n} ${unit}s`, sameDay: false };
    }],
    // "Later that evening", "That night", "By nightfall", "At dawn"
    [new RegExp(String.raw`^(?:later\s+)?that\s+${SKIP_PART}\b`), (m) => ({ advance: `until ${PART_WORD[m.groups.part] ?? m.groups.part}`, sameDay: true })],
    [new RegExp(String.raw`^(?:by|at|come)\s+(?:the\s+)?${SKIP_PART}\b`), (m) => ({ advance: `until ${PART_WORD[m.groups.part] ?? m.groups.part}`, sameDay: !['dawn', 'daybreak', 'sunrise', 'morning'].includes(m.groups.part) })],
    [/^overnight\b/, () => ({ advance: 'the next morning', sameDay: false })],
    // "It was the next day when Cyril awoke" (Assassins Inc #403, a night
    // the clock never turned), "It was now early the following morning",
    // "It was the morning after".
    [new RegExp(String.raw`^it\s+(?:was|is)\s+(?:now\s+|already\s+)?(?:(?:very\s+)?(?:early|late)\s+(?:on\s+)?)?(?:on\s+)?(?:the\s+)?(?:next|following)\s+(?<part>day|dawn|daybreak|sunrise|morning|noon|midday|afternoon|evening|night)\b`), (m) => ({ advance: m.groups.part === 'day' ? 'the next morning' : `the next ${PART_WORD[m.groups.part] ?? m.groups.part}`, sameDay: false })],
    [/^it\s+(?:was|is)\s+(?:now\s+|already\s+)?(?:early\s+)?the\s+(?:morning|day)\s+after\b/, () => ({ advance: 'the next morning', sameDay: false })],
];
// Time passing told anywhere in a sentence, not only at its start: "The rest
// of the day went by quickly and he eventually dropped off to sleep",
// "Cyril managed to pass the night", "Before too long, morning dawned" -
// three posts in Assassins Inc that left the clock at midday.
const PASSAGES = [
    [/\bthe rest of the (?:day|afternoon) (?:went by|passed|slipped by|slipped away|wore on|dragged on|dragged by|flew by|crawled by)\b/, () => ({ advance: 'until evening', sameDay: true })],
    [/\bthe (?:day|afternoon) (?:wore on|slipped away|passed|went by|dragged on)\b/, () => ({ advance: 'until evening', sameDay: true })],
    [/\b(?:pass(?:ed)?|slept through|sleep through|got through|made it through|spent) the (?:night|rest of the night)\b|\bthe night (?:passed|went by|wore on|slipped by)\b/, () => ({ advance: 'until morning', sameDay: false })],
    [/\b(?:morning|dawn|daybreak) (?:dawned|came|arrived|broke)\b/, () => ({ advance: 'until morning', sameDay: false })],
    // Waking to it: "He woke the next morning well-rested" (Assassins Inc,
    // a night's sleep that left the clock on the evening before). Only a
    // waking told as done - "decided to leave the next morning" is a plan.
    [/\b(?<!to )(?:woke|awoke|awakened|wakes|awakes|got up|rose|stirred)(?: up)?(?: \w+){0,3}? (?:the )?(?:next|following) (?:morning|day)\b/, () => ({ advance: 'the next morning', sameDay: false })],
    [/\b(?:woke|awoke|awakened|wakes|awakes)(?: up)? (?:at|with|to) (?:the )?(?:dawn|daybreak|sunrise|first light)\b/, () => ({ advance: 'until morning', sameDay: false })],
    [/\bnight (?:fell|came|had fallen|settled in)\b|\bthe evening (?:came|wore on|drew on)\b/, () => ({ advance: 'until evening', sameDay: true })],
];
// The furthest skip the post makes, in the order it tells them: "the rest
// of the day went by... the night passed" is the next morning.
function playerTimeSkip(text) {
    const narration = String(text ?? '').replace(SPEECH, ' ').replace(/[‘’]/g, "'").replace(/\*/g, '').replace(/\s+/g, ' ');
    let found = null;
    for (const sentence of narration.match(/[^.!?…]+[.!?…]*/g) ?? []) {
        const t = sentence.trim().toLowerCase();
        if (/\b(?:will|would|shall|going to|planned to|plans to|meant to|hoped to|wanted to|until|before)\b|'ll\b/.test(t.replace(/^before (?:too|very)? ?long,?\s*/, ''))) continue;
        for (const [re, make] of [...SKIP_OPENERS, ...PASSAGES]) {
            const m = t.match(re);
            if (m) { found = make(m); break; }
        }
    }
    return found;
}

// Time the story says has passed ("he has been gone for hours", "two hours
// later", "after several hours") -> a span the clock can take ('a few
// hours', 'two hours'), or ''. Only what the text tells as passed - never
// what will be ("we will rest for hours"). Minutes are left to the
// per-reply advance; "had been ... for days" is too often backstory, so
// only hours count there.
const COUNT = String.raw`(?<n>an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a few|few|several|many|some|\d+)`;
const UNIT = String.raw`(?<u>hours?|days?)`;
const ELAPSED = [
    new RegExp(String.raw`\b(?:has|had|have|'s|'d)\s+(?:been\s+)?(?:\w+\s+){0,4}?for\s+(?:${COUNT}\s+)?(?<u>hours?)\b`, 'i'),
    new RegExp(String.raw`\b${COUNT}\s+${UNIT}\s+(?:later|passed|had passed|went by|had gone by|crept by|crawled by|slipped by|dragged on|dragged by)\b`, 'i'),
    // "After several hours", "after an hour", "after two days" - but a day
    // only when it is counted: "after a long day" is an idiom, said of any
    // evening ("It helps me relax after a long day"), and three of them
    // moved a clock three days on.
    new RegExp(String.raw`\b(?:after|over)\s+(?:${COUNT}\s+)?(?:long\s+)?(?<u>hours?)\b`, 'i'),
    new RegExp(String.raw`\b(?:after|over)\s+(?<n>two|three|four|five|six|seven|eight|nine|ten|twelve|a few|few|several|many|some|\d+)\s+(?:long\s+)?(?<u>days?)\b`, 'i'),
    // "As the hours crept by" - no count, a few.
    new RegExp(String.raw`\bthe\s+${UNIT}\s+(?:crept|crawled|slipped|dragged|ticked|went|wore)\s+(?:by|on|past)\b`, 'i'),
];
// "Over the next hour, they packed": told by the narration, never in speech
// ("We ride for the next two hours").
const SPENT = new RegExp(String.raw`\b(?:over|for|during|throughout)\s+the\s+(?:next|following)\s+(?:${COUNT}\s+)?(?:long\s+)?${UNIT}\b`, 'i');
const NOT_PASSED = /\b(?:will|would|shall|going to|tomorrow|tonight|soon|might|could)\b|'ll\b/i;
function storyElapsed(text) {
    const narration = String(text ?? '').replace(/"[^"]*"|“[^”]*”/g, ' ');
    for (const [source, patterns] of [[String(text ?? ''), ELAPSED], [narration, [SPENT]]]) {
        const span = spanIn(source, patterns);
        if (span) return span;
    }
    return '';
}

function spanIn(text, patterns) {
    for (const sentence of text.replace(/’/g, "'").split(/(?<=[.!?”"])\s+/)) {
        if (NOT_PASSED.test(sentence)) continue;
        for (const re of patterns) {
            const m = sentence.match(re);
            if (!m) continue;
            const unit = m.groups.u.toLowerCase().replace(/s$/, '');
            const n = String(m.groups.n ?? '').toLowerCase();
            // "over the next hour" is one; "for hours", a few.
            if (!n && !/s$/i.test(m.groups.u)) return `one ${unit}`;
            if (!n || ['few', 'a few', 'several', 'many', 'some'].includes(n)) return `a few ${unit}s`;
            if (['a', 'an', 'one'].includes(n)) return `one ${unit}`;
            return `${n} ${unit}s`;
        }
    }
    return '';
}

export function readTimeShift(text) {
    return { skip: playerTimeSkip(text), reached: storyTimeCue(text), elapsed: storyElapsed(text), delta: storyDelta(text) };
}
