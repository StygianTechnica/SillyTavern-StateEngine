// State Engine — built-in prompt texts that follow updates (requirements spec 1.45).
//
// The prompted-update header and rules used to be saved into settings as full
// text on install (DEFAULT_SETTINGS.promptedHeader) and whenever the settings
// box was edited or reset - so a later change to the built-in text never
// reached anyone. Now:
//   settings[key] === null       use the built-in text (always the current one)
//   settings[key] === '<text>'   the user's own text
//
// reconcilePromptDefaults() (startup) turns a saved copy of ANY built-in
// version - current or past, compared ignoring whitespace - back into null, so
// it follows the built-in from then on. A user's own text is kept; when its
// built-in has changed since they last saw it, it is listed as outdated so the
// user can be asked once (src/events/prompt-default-updates.js).
//
// Changing a built-in prompt: edit its DEFAULT_* text in settings-core.js and
// add the OLD text to the end of its `past` list below - the version is
// past.length + 1. tests/prompt-defaults.test.js pins each version's text, so
// an edit without that step fails.

import { DEFAULT_PROMPTED_HEADER, DEFAULT_UNIFIED_VARIABLE_RULES } from './settings-core.js';

// Every earlier built-in text, oldest first.
const PAST_PROMPTED_HEADERS = [
    [
        'You are a silent background state-tracking process for a roleplay chat application.',
        'You are not a character in the roleplay and must not narrate, comment, or add anything besides the requested output.',
        'You will be given a recent conversation excerpt and a list of state counters/flags that may need to increment/cycle based on story conditions.',
        'Decide if each variable should increment/cycle based on the conversation and the per-variable conditions.',
        '',
        'Output rules:',
        '- Reply with ONLY a single raw JSON object. No markdown code fences, no explanation, no extra text.',
        '- The object maps variable names to increment instruction: true if should increment, false if should not.',
        '- Example: {"rounds": true, "tournament_phase": false} means increment "rounds" but leave "tournament_phase" unchanged.',
    ].join('\n'),
    [
        'You are a silent background state-tracking process for a roleplay chat application.',
        'You are not a character in the roleplay and must not narrate, comment, or add anything besides the requested output.',
        'You will be given a recent conversation excerpt and a list of state counters/flags that may need to increment/cycle based on story conditions.',
        'Decide if each variable should increment/cycle based on the conversation and the per-variable conditions.',
        '',
    ].join('\n'),
    [
        'You are a silent background state‑tracking process for a roleplay chat application.',
        'You are not a character in the roleplay and must not narrate, comment, or add anything besides the requested output.',
        'You will be given a recent conversation excerpt and a list of state variables with conditions.',
        'Evaluate each variable according to its conditions and return the required JSON output.',
        '',
    ].join('\n'),
    [
        'You are a silent background state‑tracking process for a roleplay chat application.',
        'You are not a character in the roleplay and must not narrate, comment, or add anything besides the requested output.',
        'You will be given a recent conversation excerpt, the actual latest chat message - always separately labeled "Most recent roleplay message" - and a list of state variables with conditions.',
        'When a variable\'s own instructions refer to "the latest message" or similar, they mean the "Most recent roleplay message" specifically - never the instruction that follows this system prompt asking for the JSON output.',
        'Evaluate each variable according to its conditions and return the required JSON output.',
        '',
    ].join('\n'),
];

const PAST_PROMPTED_RULES = [
    [
        '',
        'Output rules:',
        '- Reply with ONLY a single raw JSON object. No markdown code fences, no explanation, no extra text.',
        '- The object must contain exactly one key per listed variable.',
        '- For update variables: return the new value. If no change is needed, repeat the current value unchanged.',
        '- For boolean-condition variables: return true if the condition is met, otherwise false.',
    ].join('\n'),
    [
        '',
        'Output rules:',
        '- Reply with ONLY a single raw JSON object. No markdown code fences, no explanation, no extra text.',
        '- The object must contain exactly one key per listed variable.',
        '- For update variables: return the new value. If no change is needed, repeat the current value unchanged.',
        '- For boolean-condition variables: return true if the condition is met, otherwise false.',
        '- The JSON object MUST contain one key for every update variable AND every boolean-condition variable.',
    ].join('\n'),
];

// key (the settings field) -> { label, current, past, version }
export const PROMPT_DEFAULTS = Object.freeze({
    promptedHeader: Object.freeze({ label: 'Prompted update header prompt', current: DEFAULT_PROMPTED_HEADER, past: PAST_PROMPTED_HEADERS, version: PAST_PROMPTED_HEADERS.length + 1 }),
    promptedRules: Object.freeze({ label: 'Generated variable rules prompt', current: DEFAULT_UNIFIED_VARIABLE_RULES, past: PAST_PROMPTED_RULES, version: PAST_PROMPTED_RULES.length + 1 }),
});
export const PROMPT_DEFAULT_KEYS = Object.freeze(Object.keys(PROMPT_DEFAULTS));

// Text as compared: whitespace runs collapsed, the non-breaking hyphen one
// built-in once used treated as "-".
function comparable(text) {
    return String(text).replace(/‑/g, '-').replace(/\s+/g, ' ').trim();
}

// Whether `text` is the current or any earlier built-in text for `key`.
export function isBuiltinPromptText(key, text) {
    const entry = PROMPT_DEFAULTS[key];
    if (!entry || typeof text !== 'string') return false;
    const wanted = comparable(text);
    return [entry.current, ...entry.past].some((t) => comparable(t) === wanted);
}

// What settings[key] should hold for `text` typed into the settings box:
// null for blank or any built-in text, otherwise the text itself.
export function storedPromptValue(key, text) {
    if (typeof text !== 'string' || !text.trim() || isBuiltinPromptText(key, text)) return null;
    return text;
}

// The text the prompt uses for `key`.
export function effectivePrompt(settings, key) {
    return (typeof settings?.[key] === 'string' && settings[key].trim()) ? settings[key] : PROMPT_DEFAULTS[key].current;
}

function seenStore(settings) {
    if (!settings.promptDefaultsSeen || typeof settings.promptDefaultsSeen !== 'object' || Array.isArray(settings.promptDefaultsSeen)) settings.promptDefaultsSeen = {};
    return settings.promptDefaultsSeen;
}

// Records that the user has seen the current built-in for `key`.
export function acknowledgePromptDefault(settings, key) {
    seenStore(settings)[key] = PROMPT_DEFAULTS[key].version;
}

// Startup: a saved built-in copy becomes null (follows the built-in); a user's
// own text stays. Returns { changed, outdated } - outdated: the keys holding
// the user's own text whose built-in changed since they last saw it (a text
// saved before versions were recorded counts as not seen).
export function reconcilePromptDefaults(settings) {
    const outdated = [];
    let changed = false;
    if (!settings) return { changed, outdated };
    const seen = seenStore(settings);
    for (const key of PROMPT_DEFAULT_KEYS) {
        const value = storedPromptValue(key, settings[key]);
        if (value !== settings[key]) {
            settings[key] = value;
            changed = true;
        }
        if (value === null) {
            if (seen[key] !== PROMPT_DEFAULTS[key].version) {
                seen[key] = PROMPT_DEFAULTS[key].version;
                changed = true;
            }
        } else if (!(Number(seen[key]) >= PROMPT_DEFAULTS[key].version)) {
            outdated.push(key);
        }
    }
    return { changed, outdated };
}
