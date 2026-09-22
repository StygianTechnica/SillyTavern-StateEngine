// State Engine — display/text formatting helpers

import { DEFAULT_CALENDAR_ID } from '../core/settings-core.js';
import { formatScalar, getCalendar } from '../core/calendar-engine.js';

export function stripHtml(str) {
    return String(str ?? '').replace(/<[^>]*>/g, '').trim();
}

// Turns a slice of the chat array into the state-tracking prompt's context
// section, with the actual LAST chat message explicitly, separately labeled
// "Most recent roleplay message" - not just folded into the "Recent
// conversation" block along with everything else.
//
// Why this exists (a real report, 2026-09-22): the messages array both
// prompted-engine.js's runPromptedStateUpdate() and independent-presets.js's
// runIndependentPresetInternal() send to the background LLM ends with a
// SEPARATE, synthetic instruction turn ({ role: 'user', content: 'Output
// the JSON object now...' }) appended AFTER the system prompt (see either
// file's own `messages` array). That wrapper is genuinely the literal last
// message in the API call. A user writing a variable's own prompted
// instructions naturally says things like "only evaluate the latest
// message" - with no explicit field named "the latest message" anywhere in
// the prompt, the model has no reliable way to know that means the actual
// last ROLEPLAY line buried inside the "Recent conversation" transcript,
// not the wrapper instruction that comes after the whole system prompt.
// Giving that line its own explicit, consistently-named heading gives every
// preset's prompted instructions a stable term to reference.
//
// `recentMessages` is already sliced to whatever history-length limit the
// caller computed (contextMessageCount / maxPromptHistoryMessages, or an
// independent preset's own historyLimit override - both callers already do
// this themselves, unchanged, before calling this). Returns a single ready-
// to-embed string:
//   - nothing at all (or only blank/whitespace messages) -> 'No conversation yet.'
//   - one real message and nothing before it -> just the "Most recent
//     roleplay message:" section (no separate "Recent conversation:" for an
//     empty history)
//   - otherwise -> "Recent conversation:" (everything except the last
//     message) followed by "Most recent roleplay message:" (the last one)
export function buildRecentMessagesSection(recentMessages, { name1, name2, maxMessageLength = 0 } = {}) {
    const lines = (recentMessages || [])
        .map((m) => {
            const speaker = m.is_user ? (name1 || 'User') : (m.name || name2 || 'Character');
            const strippedText = stripHtml(m.mes);
            // A message that is blank after HTML-stripping (an image-only
            // message, a blank system/OOC entry, ...) contributes nothing -
            // checked on the RAW text, before the speaker prefix is added,
            // so it is dropped entirely rather than surviving as a bare
            // "Speaker: " line. Caught by this function's own tests, not
            // assumed - the ORIGINAL inline version of this logic (before
            // being extracted here) filtered the already-prefixed line
            // instead, which a trimmed "Speaker: " line always has non-zero
            // length even with nothing after the colon, so it never actually
            // filtered a blank message out. That mattered less before this
            // feature - a stray blank line just sat unlabeled in "Recent
            // conversation" - but would have let a blank trailing message
            // be mislabeled as the "Most recent roleplay message" here.
            if (!strippedText.trim()) return null;
            let text = strippedText;
            // Trims only this local prompt copy - m.mes (the stored message) is never touched.
            if (maxMessageLength > 0 && text.length > maxMessageLength) {
                text = text.slice(0, maxMessageLength) + '…';
            }
            return `${speaker}: ${text}`;
        })
        .filter((line) => line !== null);

    if (lines.length === 0) return 'No conversation yet.';

    const mostRecent = lines[lines.length - 1];
    const history = lines.slice(0, -1);

    const parts = [];
    if (history.length > 0) parts.push(`Recent conversation:\n${history.join('\n')}`);
    parts.push(`Most recent roleplay message:\n${mostRecent}`);
    return parts.join('\n\n');
}

export function extractJsonObject(text) {
    if (!text) return null;
    let s = String(text).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) return null;
    const candidate = s.slice(first, last + 1);
    try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        return null;
    } catch {
        return null;
    }
}

export function describeConstraint(def) {
    if (def.type === 'number') {
        const parts = [];
        if (def.min !== '' && def.min !== null && def.min !== undefined) parts.push(`min ${def.min}`);
        if (def.max !== '' && def.max !== null && def.max !== undefined) parts.push(`max ${def.max}`);
        return `number${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    if (def.type === 'boolean') {
        return def.flagMode === true
            ? 'true or false - a one-way flag: once you answer true it stays true and you will not be asked again, so only answer true, never false'
            : 'true or false';
    }
    if (def.type === 'datetime') {
        // A calendar other than Gregorian (spec 1.22) is described in its own
        // terms: the model sees the date in that calendar's names, so its
        // answer options are the relative phrases that calendar understands
        // (seasons and cycles only where it has them) or a numeric-month date.
        const calendar = getCalendar(def.calendar || DEFAULT_CALENDAR_ID);
        if (calendar && calendar.leapYearRule !== 'gregorian') {
            const extras = [
                calendar.seasons?.length ? ', "advance 1 season"' : '',
                calendar.cycles?.length ? ', "next cycle"' : '',
            ].join('');
            return `date and time in the ${calendar.label || calendar.id} calendar. Reply with how far to move it from its current value `
                + `(e.g. "advance 3 hours", "advance 1 day", "advance 1 month"${extras}), `
                + 'or a new date-time as "YYYY-MM-DD HH:MM:SS" with the month as its number (e.g. "1203-08-17 12:00:00"). '
                + 'If no time has passed, repeat the current value';
        }
        return 'date and time. Reply with either a new date-time as "YYYY-MM-DD HH:MM:SS" (e.g. "2026-09-18 22:00:00"), '
            + 'or how far to move it from its current value (e.g. "advance 3 hours", "advance 1 day", "advance 1 month"). '
            + 'If no time has passed, repeat the current value';
    }
    if (def.type === 'enum') return `one of: ${def.enumValues.join(', ')}`;
    if (def.type === 'array') {
        const itemType = def.itemType || 'any';
        let desc = `array of ${itemType}`;
        if (itemType === 'enum') {
            const allowed = Array.isArray(def.itemEnumValues) ? def.itemEnumValues : [];
            desc += ` (each item one of: ${allowed.join(', ')})`;
        }
        const constraints = [];
        if (Number.isFinite(def.maxLength)) constraints.push(`max ${def.maxLength} items`);
        if (def.unique) constraints.push('unique items');
        if (def.sorted) constraints.push('sorted');
        if (constraints.length) desc += ` (${constraints.join(', ')})`;
        // Prompted arrays only ever accept a full array replacement - the
        // model is never asked to perform an increment-style operation
        // itself (that's applyIncrement's job, triggered deterministically
        // or via the incrementVars true/false path, never described here).
        desc += `. Reply with a full JSON array of items matching this description (e.g. ["a","b"]) - `
            + `never an operation object, never a partial update, never anything besides the JSON array value for this key`;
        return desc;
    }
    return 'text';
}

// function categoryLabel(cat) {
//     if (cat === 'counter') return 'Counter';
//     if (cat === 'cycling') return 'Cycling';
//     if (cat === 'prompted') return 'Prompted';
//     return 'Manual';
// }

export function typeLabel(type) {
    if (type === 'number') return 'Number';
    if (type === 'boolean') return 'True/False';
    if (type === 'enum') return 'Choice';
    if (type === 'array') return 'Array';
    if (type === 'calculated') return 'Calculated';
    if (type === 'image') return 'Image';
    if (type === 'imageList') return 'Image list';
    if (type === 'imageMap') return 'Image map';
    return 'Text';
}

// `def` is optional (2026-09-09) - when the variable's declared type is
// "boolean", the display is forced to "true"/"false" regardless of what
// shape the underlying stored value actually is (a real boolean, the
// strings "true"/"false", or - for a value written before a since-fixed
// bug - a raw leftover number like 1/0/2 from applyIncrement's old
// non-boolean-aware arithmetic branch). Deliberately NOT applied to
// "calculated" variables: a calculated expression's boolean result is
// still shown via the generic typeof check below, per the instruction
// that calculated booleans may remain numeric-looking without a
// dedicated type-inference pass.
export function formatValueForDisplay(value, def) {
    // A datetime variable stores scalar seconds; the tracker shows the
    // calendar's structured form, "2026-09-18 22:55:00" (requirements spec
    // 1.21). A value the calendar cannot convert is shown as stored.
    if (def?.type === 'datetime') {
        return formatScalar(def.calendar || DEFAULT_CALENDAR_ID, value) ?? String(value);
    }
    if (def?.type === 'boolean') {
        const isTrue = value === true || value === 'true'
            || (typeof value === 'number' && value !== 0);
        return isTrue ? 'true' : 'false';
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return `[${value.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(', ')}]`;
    }
    if (value === '' || value === undefined || value === null) return '—';
    // An image map (an object of key -> reference) as JSON, not "[object Object]".
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}
