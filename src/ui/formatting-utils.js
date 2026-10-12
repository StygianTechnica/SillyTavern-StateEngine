// State Engine — display/text formatting helpers

import { DEFAULT_CALENDAR_ID } from '../core/settings-core.js';
import { formatScalar, getCalendar } from '../core/calendar-engine.js';
import { isObjectDefinition, objectValueText, objectTypeOf } from '../core/object-display.js';
import { getObjectType } from '../core/object-types.js';

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
// `recentMessages` is already sliced by the caller - selectPromptMessages()
// below, from contextMessageCount / maxPromptHistoryMessages or an
// independent preset's own historyLimit override. Returns a single ready-
// to-embed string:
//   - nothing at all (or only blank/whitespace messages) -> 'No conversation yet.'
//   - one real message and nothing before it -> just the "Most recent
//     roleplay message:" section (no separate "Recent conversation:" for an
//     empty history)
//   - otherwise -> "Recent conversation:" (everything before the latest
//     turn), "Latest turn:" (when the turn is more than one message) and
//     "Most recent roleplay message:" (the last one)
//
// Latest turn (requirements spec 1.44, 2026-10-09): every message from the
// last user message on - the user's action plus every reply after it (one or
// more AI messages, a group chat's several characters). An instruction like
// "how much time passed?" must see the whole turn, not only its last
// message. The "Latest turn:" section INCLUDES the most recent message, and
// is shown only when the turn is more than that one message - a one-message
// turn (a user-triggered run) is exactly the "Most recent roleplay message"
// and is not repeated. With no user message in the slice the whole slice is
// the turn (selectPromptMessages() already reached back as far as allowed).
export function buildRecentMessagesSection(recentMessages, { name1, name2, maxMessageLength = 0 } = {}) {
    const entries = (recentMessages || [])
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
            return { line: `${speaker}: ${text}`, startsTurn: startsTurn(m) };
        })
        .filter((entry) => entry !== null);

    if (entries.length === 0) return 'No conversation yet.';

    const lines = entries.map((e) => e.line);
    const turnStart = Math.max(0, entries.map((e) => e.startsTurn).lastIndexOf(true));
    const history = lines.slice(0, turnStart);
    const turn = lines.slice(turnStart);

    const parts = [];
    if (history.length > 0) parts.push(`Recent conversation:\n${history.join('\n')}`);
    if (turn.length > 1) parts.push(`Latest turn:\n${turn.join('\n')}`);
    parts.push(`Most recent roleplay message:\n${lines[lines.length - 1]}`);
    return parts.join('\n\n');
}

// A turn starts at a user message the prompt actually sees - a hidden
// (is_system) one does not end the turn before it.
function startsTurn(m) {
    return !!(m && m.is_user && !m.is_system);
}

// The slice of `chat` both prompt builders send (spec 1.44): the last `count`
// messages, reaching further back when needed so the latest turn is never cut
// short - but never more than `cap` messages (maxPromptHistoryMessages stays a
// hard limit).
export function selectPromptMessages(chat, count, cap = count) {
    const messages = Array.isArray(chat) ? chat : [];
    const limit = Math.max(1, Math.min(count, cap));
    let start = Math.max(0, messages.length - limit);
    const turnStart = messages.findLastIndex(startsTurn);
    if (turnStart !== -1 && turnStart < start) start = Math.max(turnStart, messages.length - Math.max(1, cap));
    return messages.slice(start);
}

export function extractJsonObject(text) {
    if (!text) return null;
    let s = String(text).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1) return null;
    if (last > first) {
        try {
            const parsed = JSON.parse(s.slice(first, last + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
            return null;
        } catch {
            // Maybe cut off - see below.
        }
    }
    const salvaged = salvageTruncatedObject(s.slice(first));
    if (salvaged) {
        console.warn('[StateEngine] the model\'s answer was cut off before its end - kept the values it finished:',
            Object.keys(salvaged).join(', ') || '(none)', '- raise "Max response length" (or the connection profile\'s Max tokens) if this keeps happening');
    }
    return salvaged;
}

// Small models sometimes shorten a variable's name in their answer -
// "se__characters" for "se__scene_characters". An answer key that is no
// requested variable is taken as the one it clearly means: same namespace,
// its words all found, in order, in exactly ONE requested name that the
// answer did not also give under its real name. Anything else - keys
// without a namespace ("__characters", the runtime key), ambiguous or
// unmatched keys - is left as it is. Returns a new object (or `parsed`
// itself when nothing changed).
export function matchAnswerKeys(parsed, names) {
    if (!parsed || typeof parsed !== 'object') return parsed;
    const split = (key) => {
        const at = key.indexOf('__');
        if (at <= 0) return null;
        return { ns: key.slice(0, at).toLowerCase(), words: key.slice(at + 2).toLowerCase().split(/[_\s-]+/).filter(Boolean) };
    };
    const inOrder = (needle, hay) => {
        let i = 0;
        for (const word of hay) if (word === needle[i]) i++;
        return i === needle.length;
    };
    const requested = new Set(names);
    const open = names.filter((name) => !Object.prototype.hasOwnProperty.call(parsed, name)).map((name) => ({ name, parts: split(name) })).filter((n) => n.parts);
    let out = parsed;
    for (const key of Object.keys(parsed)) {
        if (requested.has(key)) continue;
        const parts = split(key);
        if (!parts || parts.words.length === 0) continue;
        const candidates = open.filter((n) => n.parts.ns === parts.ns && inOrder(parts.words, n.parts.words));
        if (candidates.length !== 1 || Object.prototype.hasOwnProperty.call(out, candidates[0].name)) continue;
        if (out === parsed) out = { ...parsed };
        out[candidates[0].name] = parsed[key];
        delete out[key];
        console.warn(`[StateEngine] the model answered "${key}" - taken as "${candidates[0].name}"`);
    }
    return out;
}

// An answer cut off mid-way (the model hit its token limit) is not valid
// JSON, but every key/value pair it finished before the cut is: this keeps
// those and drops the one it was writing. `s` starts at the object's "{".
// Returns the object of finished pairs, or null when there is none or the
// text is broken in some other way than being cut short.
export function salvageTruncatedObject(s) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let lastComplete = -1; // index just past the last finished top-level value
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
            depth--;
            if (depth === 0) return null; // the object closed: not a cut-off answer
            if (depth === 1) lastComplete = i + 1;
        } else if (ch === ',' && depth === 1) lastComplete = i;
    }
    if (lastComplete === -1) return null;
    try {
        const parsed = JSON.parse(`${s.slice(0, lastComplete).replace(/,\s*$/, '')}}`);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length ? parsed : null;
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
    // Objects: the model answers with NAMES (a list: a JSON array of names);
    // State Engine matches them to its objects of that type (or records new
    // ones). The wording is the type's own (object-types.js).
    if (isObjectDefinition(def)) {
        const t = getObjectType(objectTypeOf(def));
        return def.type === 'object' ? t.prompt.single : t.prompt.list;
    }
    if (def.type === 'array') {
        const itemType = def.itemType || 'any';
        // A record list is a list of OBJECTS: "array of record" with a
        // list-of-strings example misled small models. Its example shows the
        // record's own fields (itemSchema).
        const recordExample = itemType === 'record'
            ? JSON.stringify([Object.fromEntries(Object.keys(def.itemSchema && typeof def.itemSchema === 'object' ? def.itemSchema : {}).map((field) => [field, '...']))])
            : null;
        let desc = itemType === 'record' ? 'array of JSON objects' : `array of ${itemType}`;
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
        desc += `. Reply with a full JSON array of items matching this description (e.g. ${recordExample ?? '["a","b"]'}) - `
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

// A variable's type as shown in the manager: an object variable as its
// object type ("Location"), a list as "List of Locations"; anything else by
// typeLabel(). `def` may be a definition or a bare type.
export function definitionTypeLabel(def) {
    const objectType = getObjectType(objectTypeOf(def));
    if (objectType) return def.type === 'object' ? objectType.label : `List of ${objectType.plural}`;
    return typeLabel(typeof def === 'string' ? def : def?.type);
}

// The colour and icon an object variable is shown with, or null for a
// basic type - objects read as a family of their own.
export function objectTypeStyle(def) {
    const t = getObjectType(objectTypeOf(def));
    return t ? { color: t.color, icon: t.icon, label: definitionTypeLabel(def) } : null;
}

export function typeLabel(type) {
    if (type === 'number') return 'Number';
    if (type === 'boolean') return 'True/False';
    if (type === 'enum') return 'Choice';
    if (type === 'array') return 'Array';
    if (type === 'calculated') return 'Calculated';
    if (type === 'image') return 'Image';
    if (type === 'imageList') return 'Image list';
    if (type === 'imageMap') return 'Image map';
    if (type === 'object') return 'Object';
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
    // Datetime mode (requirements spec 1.36): "dateOnly" suppresses the time
    // portion of the display, "timeOnly" suppresses the date - purely a
    // formatting choice (a dateOnly scalar still carries its time-of-day).
    if (def?.type === 'datetime') {
        const style = def.datetimeMode === 'dateOnly' ? 'date' : def.datetimeMode === 'timeOnly' ? 'time' : 'full';
        return formatScalar(def.calendar || DEFAULT_CALENDAR_ID, value, style) ?? String(value);
    }
    // Object ids show as names.
    if (isObjectDefinition(def)) return objectValueText(def, value) || '—';
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
