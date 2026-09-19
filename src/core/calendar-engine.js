// State Engine — calendar engine
//
// Datetime variables (docs/STATE ENGINE REQUIREMENTS SPECIFICATION.md 1.21)
// store SCALAR TIME: a plain number of seconds. This module is the only place
// that knows how a scalar maps to a human date, and it does that by reading a
// CALENDAR DEFINITION out of settings.calendars (settings-core.js) by id -
// never by assuming a calendar.
//
// Scalar epoch: 0 is 1970-01-01 00:00:00 (the Unix epoch) in the proleptic
// Gregorian calendar; negative scalars are dates before it. Structured months
// and days are 1-based, matching ISO 8601 ("2026-09-18" is month 9, day 18).
//
// Only the "gregorian" calendar is implemented. A definition is a pluggable
// object (months, daysPerMonth, leapYearRule, ...) so fantasy calendars can be
// added later, but any definition whose leapYearRule this module does not
// implement is refused with an error rather than guessed at - see
// requireCalendar() below.

import { getSettings } from './settings-core.js';

// ---------------------------------------------------------------------------
// Calendar lookup
// ---------------------------------------------------------------------------

// settings.calendars[calendarId], or null when there is no such calendar.
export function getCalendar(calendarId) {
    const calendars = getSettings().calendars;
    if (!calendars || typeof calendars !== 'object') return null;
    if (typeof calendarId !== 'string' || !Object.prototype.hasOwnProperty.call(calendars, calendarId)) return null;
    return calendars[calendarId] ?? null;
}

// The calendar a definition refers to, or an Error naming what is wrong with
// it. Every conversion below goes through this, so an unknown or
// not-yet-implemented calendar can never silently convert with the wrong
// rules.
function requireCalendar(calendarId) {
    const calendar = getCalendar(calendarId);
    if (!calendar) throw new Error(`Unknown calendar "${calendarId}"`);
    if (calendar.leapYearRule !== 'gregorian') {
        throw new Error(`Calendar "${calendarId}" uses leapYearRule "${calendar.leapYearRule}", which is not implemented yet (only "gregorian" is)`);
    }
    if (!Array.isArray(calendar.months) || calendar.months.length === 0) {
        throw new Error(`Calendar "${calendarId}" defines no months`);
    }
    return calendar;
}

// ---------------------------------------------------------------------------
// Gregorian arithmetic
// ---------------------------------------------------------------------------

function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(calendar, year, month) {
    const entry = calendar.months[month - 1];
    return (entry.leap !== undefined && isLeapYear(year)) ? entry.leap : entry.days;
}

// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
// days_from_civil).
function daysFromCivil(year, month, day) {
    const y = month <= 2 ? year - 1 : year;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}

// Inverse of daysFromCivil.
function civilFromDays(days) {
    const z = days + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp < 10 ? mp + 3 : mp - 9;
    return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

function secondsPerDay(calendar) {
    return calendar.secondsPerMinute * calendar.minutesPerHour * calendar.hoursPerDay;
}

// ---------------------------------------------------------------------------
// Scalar <-> structured
// ---------------------------------------------------------------------------

// Scalar seconds -> { year, month, day, hour, minute, second }. A fractional
// scalar is floored to a whole second. Throws on a non-finite scalar or an
// unusable calendar.
export function toStructured(calendarId, scalarTime) {
    const calendar = requireCalendar(calendarId);
    if (typeof scalarTime !== 'number' || !Number.isFinite(scalarTime)) {
        throw new Error(`Scalar time must be a finite number (got ${scalarTime})`);
    }
    const total = Math.floor(scalarTime);
    const perDay = secondsPerDay(calendar);
    const days = Math.floor(total / perDay);
    let rem = total - days * perDay;

    const { year, month, day } = civilFromDays(days);
    const perHour = calendar.secondsPerMinute * calendar.minutesPerHour;
    const hour = Math.floor(rem / perHour);
    rem -= hour * perHour;
    const minute = Math.floor(rem / calendar.secondsPerMinute);
    const second = rem - minute * calendar.secondsPerMinute;
    return { year, month, day, hour, minute, second };
}

function requireInteger(value, label) {
    if (!Number.isInteger(value)) throw new Error(`${label} must be an integer (got ${value})`);
    return value;
}

// { year, month, day, hour?, minute?, second? } -> scalar seconds. year,
// month and day are required; the time of day defaults to 00:00:00. Throws on
// any out-of-range field (month 13, Feb 30, hour 24, ...) rather than rolling
// it over into the next unit.
export function fromStructured(calendarId, structured) {
    const calendar = requireCalendar(calendarId);
    if (!structured || typeof structured !== 'object') throw new Error('Structured time must be an object');

    const year = requireInteger(structured.year, 'year');
    const month = requireInteger(structured.month, 'month');
    const day = requireInteger(structured.day, 'day');
    const hour = requireInteger(structured.hour ?? 0, 'hour');
    const minute = requireInteger(structured.minute ?? 0, 'minute');
    const second = requireInteger(structured.second ?? 0, 'second');

    if (month < 1 || month > calendar.months.length) throw new Error(`month must be 1-${calendar.months.length} (got ${month})`);
    const monthLength = daysInMonth(calendar, year, month);
    if (day < 1 || day > monthLength) throw new Error(`day must be 1-${monthLength} for ${year}-${String(month).padStart(2, '0')} (got ${day})`);
    if (hour < 0 || hour >= calendar.hoursPerDay) throw new Error(`hour must be 0-${calendar.hoursPerDay - 1} (got ${hour})`);
    if (minute < 0 || minute >= calendar.minutesPerHour) throw new Error(`minute must be 0-${calendar.minutesPerHour - 1} (got ${minute})`);
    if (second < 0 || second >= calendar.secondsPerMinute) throw new Error(`second must be 0-${calendar.secondsPerMinute - 1} (got ${second})`);

    const secondsIntoDay = (hour * calendar.minutesPerHour + minute) * calendar.secondsPerMinute + second;
    return daysFromCivil(year, month, day) * secondsPerDay(calendar) + secondsIntoDay;
}

// ---------------------------------------------------------------------------
// Text <-> scalar
// ---------------------------------------------------------------------------

const ISO_DATETIME = /^(-?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*Z?$/i;
const PLAIN_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;

// "2026-09-18", "2026-09-18 22:00", "2026-09-18T22:00:05" -> scalar, or null
// when the text is not that shape or names a date that does not exist.
export function parseDateTime(calendarId, text) {
    if (typeof text !== 'string') return null;
    const m = ISO_DATETIME.exec(text.trim());
    if (!m) return null;
    try {
        return fromStructured(calendarId, {
            year: Number(m[1]),
            month: Number(m[2]),
            day: Number(m[3]),
            hour: m[4] === undefined ? 0 : Number(m[4]),
            minute: m[5] === undefined ? 0 : Number(m[5]),
            second: m[6] === undefined ? 0 : Number(m[6]),
        });
    } catch {
        return null;
    }
}

// Anything a datetime variable is allowed to be handed -> a scalar, or null
// when it cannot be one: a finite number as-is, a numeric string as that
// number, or an ISO date/datetime string. Never throws.
export function toScalar(calendarId, raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (PLAIN_NUMBER.test(text)) return Number(text);
    return parseDateTime(calendarId, text);
}

// Scalar -> "2026-09-18 22:55:00", or null when it cannot be converted
// (unknown calendar, non-finite scalar, calendar without formatting). Never
// throws - a display-safe wrapper over format(calendarId, scalar, "full").
export function formatScalar(calendarId, scalarTime) {
    try {
        return format(calendarId, Number(scalarTime), { style: 'full' });
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Formatting (requirements spec 1.21.5)
// ---------------------------------------------------------------------------

// format() is the ONLY official way to turn a scalar into text. First pass:
// only "gregorian" has formatting rules; any other calendar id is refused
// (before it is even looked up) so a fantasy calendar can never be shown with
// Gregorian rules. Fantasy calendars will override this later.
function requireFormattableCalendar(calendarId) {
    if (calendarId !== 'gregorian') throw new Error('Formatting not implemented for this calendar');
    return requireCalendar(calendarId);
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

function formatYear(year) {
    return year < 0 ? `-${pad(-year, 4)}` : pad(year, 4);
}

// One left-to-right pass, longest token first, so text produced by one token
// ("May") is never re-read as another. Anything that is not a token is kept.
const PATTERN_TOKENS = /YYYY|MMMM|MMM|MM|DD|HH|mm|ss/g;

// format(calendarId, scalarTime, options)
//   options.style   "full" (default) | "date" | "time" | "month" | "year" | "custom"
//   options.pattern custom only: tokens YYYY MM DD HH mm ss MMM (short month
//                   name) MMMM (full month name)
//   options.locale  reserved; ignored for now
//   full   -> "YYYY-MM-DD HH:mm:ss"      date -> "YYYY-MM-DD"     time -> "HH:mm:ss"
//   month  -> the calendar's month name  year -> the year as a string
// Throws on an unformattable calendar, a bad scalar, an unknown style, or a
// custom style without a pattern.
export function format(calendarId, scalarTime, options = {}) {
    const calendar = requireFormattableCalendar(calendarId);
    const { style = 'full', pattern } = options ?? {};
    const t = toStructured(calendarId, scalarTime);
    const monthName = calendar.months[t.month - 1].name;
    const date = `${formatYear(t.year)}-${pad(t.month)}-${pad(t.day)}`;
    const time = `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;

    switch (style) {
        case 'full': return `${date} ${time}`;
        case 'date': return date;
        case 'time': return time;
        case 'month': return monthName;
        case 'year': return String(t.year);
        case 'custom': {
            if (typeof pattern !== 'string' || pattern === '') throw new Error('Custom format style requires a pattern');
            const values = {
                YYYY: formatYear(t.year), MMMM: monthName, MMM: monthName.slice(0, 3), MM: pad(t.month),
                DD: pad(t.day), HH: pad(t.hour), mm: pad(t.minute), ss: pad(t.second),
            };
            return pattern.replace(PATTERN_TOKENS, (token) => values[token]);
        }
        default:
            throw new Error(`Unknown format style "${style}"`);
    }
}

const PARTIAL_FIELDS = ['year', 'month', 'day', 'hour', 'minute', 'second'];

// formatPartial(calendarId, scalarTime, fields) -> an object holding only the
// requested fields: year, day, hour, minute and second as numbers, month as
// the calendar's month NAME. formatPartial("gregorian", t, ["month", "day"])
// -> { month: "September", day: 18 }. Throws on an unformattable calendar, a
// bad scalar, or an unknown field name.
export function formatPartial(calendarId, scalarTime, fields = []) {
    const calendar = requireFormattableCalendar(calendarId);
    if (!Array.isArray(fields)) throw new Error('fields must be an array');
    const t = toStructured(calendarId, scalarTime);
    const out = {};
    for (const field of fields) {
        if (!PARTIAL_FIELDS.includes(field)) throw new Error(`Unknown datetime field "${field}"`);
        out[field] = field === 'month' ? calendar.months[t.month - 1].name : t[field];
    }
    return out;
}

// ---------------------------------------------------------------------------
// Calendar definitions (read access, exposed through the API layer)
// ---------------------------------------------------------------------------

// Every calendar definition, keyed by id (the live settings object).
export function listCalendars() {
    return getSettings().calendars || {};
}

// One calendar definition, or null.
export function getCalendarDefinition(calendarId) {
    return getSettings().calendars?.[calendarId] || null;
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

// unit word -> [kind, multiplier]. "s"/"m"/"h" are second/minute/hour and
// "mo" is month, so "5m" is five minutes, never five months.
const UNIT_TABLE = (() => {
    const table = new Map();
    const add = (words, entry) => words.forEach((w) => table.set(w, entry));
    add(['s', 'sec', 'secs', 'second', 'seconds'], ['seconds', 1]);
    add(['m', 'min', 'mins', 'minute', 'minutes'], ['minutes', 1]);
    add(['h', 'hr', 'hrs', 'hour', 'hours'], ['hours', 1]);
    add(['d', 'day', 'days'], ['days', 1]);
    add(['w', 'wk', 'wks', 'week', 'weeks'], ['days', 7]);
    add(['mo', 'mos', 'month', 'months'], ['months', 1]);
    add(['y', 'yr', 'yrs', 'year', 'years'], ['years', 1]);
    return table;
})();

const DELTA_TOKEN = /\s*(?:,|\band\b)?\s*([+-]?\d+(?:\.\d+)?)\s*([a-z]*)/y;

// "1h", "3 hours", "1d 2h", "1y, 2mo and 3d", "-2d" -> { years, months,
// seconds } where seconds already covers every fixed-length unit for
// `calendar`. A bare number is seconds. Months and years must be whole
// numbers (half a month has no fixed length). Throws on anything else.
function parseDeltaFor(calendar, delta) {
    if (typeof delta === 'number') {
        if (!Number.isFinite(delta)) throw new Error(`Invalid delta ${delta}`);
        return { years: 0, months: 0, seconds: delta };
    }
    if (typeof delta !== 'string' || !delta.trim()) throw new Error(`Invalid delta "${delta}"`);

    const text = delta.trim().toLowerCase();
    const perMinute = calendar.secondsPerMinute;
    const perHour = perMinute * calendar.minutesPerHour;
    const perDay = perHour * calendar.hoursPerDay;
    const out = { years: 0, months: 0, seconds: 0 };
    let tokens = 0;

    DELTA_TOKEN.lastIndex = 0;
    while (DELTA_TOKEN.lastIndex < text.length) {
        const m = DELTA_TOKEN.exec(text);
        if (!m) throw new Error(`Invalid delta "${delta}"`);
        tokens++;
        const amount = Number(m[1]);
        if (m[2] === '') {
            // A unit-less number is only meaningful on its own (seconds).
            if (tokens > 1 || DELTA_TOKEN.lastIndex < text.length) throw new Error(`Invalid delta "${delta}": missing unit`);
            out.seconds += amount;
            break;
        }
        const unit = UNIT_TABLE.get(m[2]);
        if (!unit) throw new Error(`Invalid delta "${delta}": unknown unit "${m[2]}"`);
        const [kind, multiplier] = unit;
        if ((kind === 'months' || kind === 'years') && !Number.isInteger(amount)) {
            throw new Error(`Invalid delta "${delta}": months and years must be whole numbers`);
        }
        if (kind === 'years') out.years += amount;
        else if (kind === 'months') out.months += amount;
        else out.seconds += amount * multiplier * { seconds: 1, minutes: perMinute, hours: perHour, days: perDay }[kind];
    }
    return out;
}

// Whether `delta` is something incrementScalar() accepts for this calendar.
export function isValidDelta(calendarId, delta) {
    try {
        parseDeltaFor(requireCalendar(calendarId), delta);
        return true;
    } catch {
        return false;
    }
}

function applyParsedDelta(calendarId, calendar, scalarTime, parsed, sign) {
    if (typeof scalarTime !== 'number' || !Number.isFinite(scalarTime)) {
        throw new Error(`Scalar time must be a finite number (got ${scalarTime})`);
    }
    let result = scalarTime;
    const monthsPerYear = calendar.months.length;
    const wholeMonths = sign * (parsed.years * monthsPerYear + parsed.months);

    if (wholeMonths !== 0) {
        // Calendar-aware: land on the same day-of-month and time of day in
        // the target month, clamping to that month's length (Jan 31 + 1mo =
        // Feb 28/29, Feb 29 + 1y = Feb 28) instead of spilling into the next
        // month. Sub-second remainder of the scalar is kept.
        const s = toStructured(calendarId, result);
        const fraction = result - Math.floor(result);
        const index = s.year * monthsPerYear + (s.month - 1) + wholeMonths;
        const year = Math.floor(index / monthsPerYear);
        const month = index - year * monthsPerYear + 1;
        const day = Math.min(s.day, daysInMonth(calendar, year, month));
        result = fromStructured(calendarId, { year, month, day, hour: s.hour, minute: s.minute, second: s.second }) + fraction;
    }
    return result + sign * parsed.seconds;
}

// scalarTime advanced by `delta` (a string such as "1h", "1d", "1mo", "1y" -
// see parseDeltaFor for the full grammar; a number is seconds) in calendar
// `calendarId`. Fixed units (s/m/h/d/w) are exact seconds; months and years
// follow the calendar's real month lengths and leap years. Negative deltas
// step backwards. Returns the new scalar; throws on a bad delta, scalar or
// calendar.
export function incrementScalar(calendarId, scalarTime, delta) {
    const calendar = requireCalendar(calendarId);
    return applyParsedDelta(calendarId, calendar, scalarTime, parseDeltaFor(calendar, delta), 1);
}

// ---------------------------------------------------------------------------
// Natural-language instructions (prompted updates)
// ---------------------------------------------------------------------------

const SET_PATTERN = /^(?:set|change|update)(?:\s+the)?(?:\s+(?:time|date|datetime|clock))?\s+to\s+(.+)$/;
const ADVANCE_PATTERN = /^(?:advance|move\s+forward|move\s+ahead|skip\s+ahead|skip\s+forward|jump\s+ahead|jump\s+forward|fast[- ]forward|forward|add|pass)(?:\s+the)?(?:\s+(?:time|clock))?(?:\s+by)?\s+(.+)$/;
const REWIND_PATTERN = /^(?:rewind|go\s+back|move\s+back|move\s+backwards?|step\s+back|turn\s+back|subtract)(?:\s+the)?(?:\s+(?:time|clock))?(?:\s+by)?\s+(.+)$/;

// What a prompted update means for a datetime variable currently at
// `currentScalar`. `text` is what the model (or a user) wrote, and can be:
//   "advance 3 hours" / "move forward 1 day"  -> current + delta
//   "rewind 2 days" / "go back 1 hour"        -> current - delta
//   "set time to 2026-09-18 22:00"            -> that exact moment
//   "2026-09-18 22:00", "3600" or a number     -> that exact moment / scalar
// Returns the resulting scalar, or null when the text is not an instruction
// this understands (the caller skips the write rather than guessing). Never
// throws.
export function resolveInstruction(calendarId, currentScalar, text) {
    try {
        if (typeof text === 'number') return Number.isFinite(text) ? text : null;
        if (typeof text !== 'string') return null;
        const calendar = requireCalendar(calendarId);
        const phrase = text.trim().toLowerCase().replace(/[.!]+$/, '');
        if (!phrase) return null;

        const absolute = toScalar(calendarId, phrase);
        if (absolute !== null) return absolute;

        const set = SET_PATTERN.exec(phrase);
        if (set) return toScalar(calendarId, set[1]);

        const advance = ADVANCE_PATTERN.exec(phrase);
        if (advance) return applyParsedDelta(calendarId, calendar, currentScalar, parseDeltaFor(calendar, advance[1]), 1);

        const rewind = REWIND_PATTERN.exec(phrase);
        if (rewind) return applyParsedDelta(calendarId, calendar, currentScalar, parseDeltaFor(calendar, rewind[1]), -1);

        return null;
    } catch {
        return null;
    }
}
