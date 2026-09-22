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
// Two arithmetic models are implemented, chosen by the definition's
// leapYearRule (requirements spec 1.22):
//   "gregorian"     - the real Gregorian calendar (leap years, days-from-civil).
//   absent / "none" - a FANTASY calendar: every year has the same length (the
//                     sum of its months' days), and scalar 0 is year 1, month
//                     1, day 1, 00:00:00. Fantasy years are not zero-padded.
// Any other leapYearRule is refused with an error rather than guessed at -
// see requireCalendar() below.

import { getSettings, persistSettings, structuredCloneSafe, BUILTIN_CALENDAR_IDS } from './settings-core.js';

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

const SUPPORTED_LEAP_RULES = ['gregorian', 'none'];

function usesGregorianRule(calendar) {
    return calendar.leapYearRule === 'gregorian';
}

// The calendar a definition refers to, or an Error naming what is wrong with
// it. Every conversion below goes through this, so an unknown or
// not-yet-implemented calendar can never silently convert with the wrong
// rules.
function requireCalendar(calendarId) {
    const calendar = getCalendar(calendarId);
    if (!calendar) throw new Error(`Unknown calendar "${calendarId}"`);
    const rule = calendar.leapYearRule;
    if (rule !== undefined && rule !== null && !SUPPORTED_LEAP_RULES.includes(rule)) {
        throw new Error(`Calendar "${calendarId}" uses leapYearRule "${rule}", which is not implemented yet (only "gregorian" and "none" are)`);
    }
    if (!Array.isArray(calendar.months) || calendar.months.length === 0) {
        throw new Error(`Calendar "${calendarId}" defines no months`);
    }
    for (const key of ['secondsPerMinute', 'minutesPerHour', 'hoursPerDay']) {
        if (!Number.isInteger(calendar[key]) || calendar[key] < 1) throw new Error(`Calendar "${calendarId}" has an invalid ${key}`);
    }
    if (usesGregorianRule(calendar) && calendar.months.length !== 12) {
        throw new Error(`Calendar "${calendarId}" uses leapYearRule "gregorian", which needs the twelve Gregorian months`);
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
    return (usesGregorianRule(calendar) && entry.leap !== undefined && isLeapYear(year)) ? entry.leap : entry.days;
}

// Fantasy calendars: a year is always the same length.
function yearLength(calendar) {
    return calendar.months.reduce((n, m) => n + m.days, 0);
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

// Days since the calendar's epoch for a year/month/day, and the inverse -
// Gregorian (real leap years) or fantasy (fixed-length years, epoch year 1).
function daysFromDate(calendar, year, month, day) {
    if (usesGregorianRule(calendar)) return daysFromCivil(year, month, day);
    let days = (year - 1) * yearLength(calendar);
    for (let i = 0; i < month - 1; i++) days += calendar.months[i].days;
    return days + day - 1;
}

function dateFromDays(calendar, days) {
    if (usesGregorianRule(calendar)) return civilFromDays(days);
    const length = yearLength(calendar);
    const yearIndex = Math.floor(days / length);
    let remaining = days - yearIndex * length;
    let month = 0;
    while (remaining >= calendar.months[month].days) {
        remaining -= calendar.months[month].days;
        month++;
    }
    return { year: yearIndex + 1, month: month + 1, day: remaining + 1 };
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

    const { year, month, day } = dateFromDays(calendar, days);
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
    return daysFromDate(calendar, year, month, day) * secondsPerDay(calendar) + secondsIntoDay;
}

// ---------------------------------------------------------------------------
// Text <-> scalar
// ---------------------------------------------------------------------------

const ISO_DATETIME = /^(-?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*Z?$/i;
const PLAIN_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;

// Unicode characters that read as, and are frequently substituted for, a
// plain ASCII hyphen-minus by autocorrect/smart-typography/IME software
// (Windows AutoCorrect, Word, some mobile keyboards): hyphen, non-breaking
// hyphen, figure dash, en dash, em dash, horizontal bar, minus sign. Visually
// indistinguishable from "-" in most fonts, so a user has no way to notice
// before saving - confirmed root cause of a real report (2026-09-22): typing
// a date like "2026-09-22" produced a non-breaking hyphen that silently
// failed ISO_DATETIME (which only ever matched literal "-"), rejected as
// "not a date-time" with no hint why. Normalized once here, at the single
// root every date-parsing path in this codebase already funnels through
// (toScalar - the manager modal, prompted LLM answers, deltaSource jumps,
// World Info conditions, tracker editing, ...), rather than patched
// per-caller.
const DASH_LOOKALIKES = /[‐-―−]/g;

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
    const text = raw.trim().replace(DASH_LOOKALIKES, '-');
    if (PLAIN_NUMBER.test(text)) return Number(text);
    const iso = parseDateTime(calendarId, text);
    if (iso !== null) return iso;
    // A calendar's own written form - "Stormfall 17, 1203 12:00:00", what
    // format() produces by default. The year is required here (an absolute
    // moment); resolveInstruction() also accepts it left out.
    try {
        return resolveMonthDay(calendarId, requireCalendar(calendarId), null, text);
    } catch {
        return null;
    }
}

// Scalar -> "2026-09-18 22:55:00", or null when it cannot be converted
// (unknown calendar, non-finite scalar, calendar without formatting). Never
// throws - a display-safe wrapper over format(calendarId, scalar, "full").
// Scalar -> "YYYY-MM-DD HH:mm:ss" with a numeric month, whatever the calendar's
// own patterns say, or null. This is the form toScalar() ALWAYS reads back, so
// it is what an editable text field should show (the calendar's display form -
// "Starfall 17, Year 1203 - Nightseason" - is not necessarily parseable).
export function formatIsoScalar(calendarId, scalarTime) {
    try {
        return format(calendarId, Number(scalarTime), { style: 'custom', pattern: 'YYYY-MM-DD HH:mm:ss' });
    } catch {
        return null;
    }
}

export function formatScalar(calendarId, scalarTime) {
    try {
        return format(calendarId, Number(scalarTime), { style: 'full' });
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Seasons and cycles (fantasy calendars, requirements spec 1.22)
// ---------------------------------------------------------------------------

// A season is { name, startDay, endDay }: 1-based day-of-year, inclusive. A
// season whose startDay is after its endDay wraps the year end (a winter
// running from day 300 to day 40). Validation guarantees seasons never
// overlap, so a wrapping season is always the LAST one by startDay.
function sortedSeasons(calendar) {
    return [...(calendar.seasons || [])].sort((a, b) => a.startDay - b.startDay);
}

function seasonSpan(calendar, season) {
    return season.endDay >= season.startDay
        ? season.endDay - season.startDay + 1
        : yearLength(calendar) - season.startDay + 1 + season.endDay;
}

function seasonAtDayOfYear(calendar, dayOfYear) {
    for (const season of calendar.seasons || []) {
        const inside = season.startDay <= season.endDay
            ? dayOfYear >= season.startDay && dayOfYear <= season.endDay
            : dayOfYear >= season.startDay || dayOfYear <= season.endDay;
        if (inside) return season;
    }
    return null;
}

function dayOfYearOf(calendar, month, day) {
    let n = day;
    for (let i = 0; i < month - 1; i++) n += calendar.months[i].days;
    return n;
}

// Everything format()/formatPartial() know about one moment. Season and cycle
// only exist for calendars that define them (and seasons only for fixed-length
// years, which validation enforces).
function describeMoment(calendarId, calendar, scalarTime) {
    const t = toStructured(calendarId, scalarTime);
    const rules = calendar.formattingRules || {};
    const days = Math.floor(Math.floor(scalarTime) / secondsPerDay(calendar));

    const season = seasonAtDayOfYear(calendar, dayOfYearOf(calendar, t.month, t.day));
    const seasonIndex = season ? calendar.seasons.indexOf(season) : -1;
    const cycle = calendar.cycles?.[0] || null;

    // 1-based day within the current season (a wrapped winter counts on
    // through the year end), and the day in EVERY cycle, for {cycle:name}.
    let dayOfSeason = null;
    if (season) {
        const doy = dayOfYearOf(calendar, t.month, t.day);
        dayOfSeason = doy >= season.startDay ? doy - season.startDay + 1 : yearLength(calendar) - season.startDay + 1 + doy;
    }
    const cycleDays = (calendar.cycles || []).map((c) => ({ name: c.name, day: (((days % c.length) + c.length) % c.length) + 1 }));

    return {
        dayOfSeason, cycleDays,
        t,
        monthName: rules.monthNames?.[t.month - 1] ?? calendar.months[t.month - 1].name,
        seasonName: season ? (rules.seasonNames?.[seasonIndex] ?? season.name) : null,
        cycleName: cycle ? cycle.name : null,
        cycleDay: cycle ? (((days % cycle.length) + cycle.length) % cycle.length) + 1 : null,
        cycleLength: cycle ? cycle.length : null,
    };
}

// ---------------------------------------------------------------------------
// Formatting (requirements spec 1.21.5 and 1.22.2)
// ---------------------------------------------------------------------------

const pad = (n, width = 2) => String(n).padStart(width, '0');

function formatYear(year) {
    return year < 0 ? `-${pad(-year, 4)}` : pad(year, 4);
}

// One left-to-right pass, longest token first, so text produced by one token
// ("May") is never re-read as another. Anything that is not a token is kept.
// Fantasy calendars (no Gregorian leap rule) add SEASON, CYCLE, CDAY, ERA and
// an unpadded day D; Gregorian keeps exactly its original token set.
const GREGORIAN_TOKENS = /YYYY|MMMM|MMM|MM|DD|HH|mm|ss/g;
const FANTASY_TOKENS = /YYYY|MMMM|MMM|MM|DD|HH|mm|ss|SEASON|CYCLE|CDAY|ERA|D/g;

const DEFAULT_GREGORIAN_PATTERNS = Object.freeze({
    full: 'YYYY-MM-DD HH:mm:ss', date: 'YYYY-MM-DD', time: 'HH:mm:ss', month: 'MMMM',
});
const DEFAULT_FANTASY_PATTERNS = Object.freeze({
    full: 'MMMM D, YYYY HH:mm:ss', date: 'MMMM D, YYYY', time: 'HH:mm:ss', month: 'MMMM',
});

function hasOwn(object, key) {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

// format(calendarId, scalarTime, options)
//   options.style   "full" (default) | "date" | "time" | "month" | "year" |
//                   "custom" | any style named in the calendar's
//                   formattingRules.patterns
//   options.pattern custom only. Tokens: YYYY MM DD HH mm ss MMM (short month
//                   name) MMMM (full month name); fantasy calendars also get
//                   D (day, unpadded) SEASON CYCLE (first cycle's name) CDAY
//                   (day within that cycle) ERA (formattingRules.era)
//   options.locale  reserved; ignored for now
//   Gregorian defaults: full "YYYY-MM-DD HH:mm:ss", date "YYYY-MM-DD", time
//   "HH:mm:ss", month = month name, year = the year as a string.
//   Fantasy defaults use "MMMM D, YYYY" instead of the numeric date.
//   A calendar's formattingRules.patterns entry for a style replaces that
//   style's default; formattingRules.monthNames / seasonNames replace the
//   names shown; monthAbbreviationLength sets MMM's width (default 3).
// Throws on an unknown calendar, a bad scalar, an unknown style, or a custom
// style without a pattern.
export function format(calendarId, scalarTime, options = {}) {
    const calendar = requireCalendar(calendarId);
    const { style = 'full', pattern } = options ?? {};
    const gregorian = usesGregorianRule(calendar);
    const rules = calendar.formattingRules || {};
    const moment = describeMoment(calendarId, calendar, scalarTime);
    const { t, monthName } = moment;

    let chosen;
    if (style === 'custom') {
        if (typeof pattern !== 'string' || pattern === '') throw new Error('Custom format style requires a pattern');
        chosen = pattern;
    } else if (hasOwn(rules.patterns, style)) {
        chosen = rules.patterns[style];
    } else if (style === 'year') {
        return String(t.year);
    } else if (hasOwn(gregorian ? DEFAULT_GREGORIAN_PATTERNS : DEFAULT_FANTASY_PATTERNS, style)) {
        chosen = (gregorian ? DEFAULT_GREGORIAN_PATTERNS : DEFAULT_FANTASY_PATTERNS)[style];
    } else {
        throw new Error(`Unknown format style "${style}"`);
    }

    if (chosen.includes('{')) return formatTemplate(chosen, moment, rules);

    const values = {
        YYYY: gregorian ? formatYear(t.year) : String(t.year),
        MMMM: monthName, MMM: monthName.slice(0, rules.monthAbbreviationLength ?? 3), MM: pad(t.month),
        DD: pad(t.day), HH: pad(t.hour), mm: pad(t.minute), ss: pad(t.second),
        D: String(t.day),
        SEASON: moment.seasonName ?? '', CYCLE: moment.cycleName ?? '',
        CDAY: moment.cycleDay === null ? '' : String(moment.cycleDay),
        ERA: rules.era ?? '',
    };
    return chosen.replace(gregorian ? GREGORIAN_TOKENS : FANTASY_TOKENS, (token) => values[token]);
}

// "{monthName} {day}, Year {year} — {season}": brace placeholders, used by a
// pattern that contains "{". monthName, month (number), day, year, HH, mm, ss,
// season, dayOfSeason, era, cycle (the first cycle's name) and cycle:<name> -
// the day within the cycle whose name is, or starts with, <name> ("cycle:red"
// finds "Red Moon"). An unknown placeholder is left as written.
function formatTemplate(template, moment, rules) {
    const { t } = moment;
    const values = {
        monthName: moment.monthName, month: String(t.month), day: String(t.day), year: String(t.year),
        HH: pad(t.hour), mm: pad(t.minute), ss: pad(t.second),
        season: moment.seasonName ?? '', dayOfSeason: moment.dayOfSeason === null ? '' : String(moment.dayOfSeason),
        era: rules.era ?? '', cycle: moment.cycleName ?? '',
    };
    return template.replace(/\{([A-Za-z]+)(?::([^}]*))?\}/g, (whole, key, arg) => {
        if (key === 'cycle' && arg !== undefined) {
            const want = arg.trim().toLowerCase();
            const found = moment.cycleDays.find((c) => c.name.toLowerCase() === want || c.name.toLowerCase().split(/\s+/)[0] === want);
            return found ? String(found.day) : whole;
        }
        return hasOwn(values, key) && arg === undefined ? values[key] : whole;
    });
}

const PARTIAL_FIELDS = ['year', 'month', 'day', 'hour', 'minute', 'second', 'season', 'cycle', 'cycleDay'];

// formatPartial(calendarId, scalarTime, fields) -> an object holding only the
// requested fields: year, day, hour, minute and second as numbers, month as
// the calendar's month NAME. formatPartial("gregorian", t, ["month", "day"])
// -> { month: "September", day: 18 }. Fantasy additions: season (the season's
// name), cycle (the first cycle's name) and cycleDay (1-based day within it);
// each is null when the calendar does not define one. Throws on an unknown
// calendar, a bad scalar, or an unknown field name.
export function formatPartial(calendarId, scalarTime, fields = []) {
    const calendar = requireCalendar(calendarId);
    if (!Array.isArray(fields)) throw new Error('fields must be an array');
    const moment = describeMoment(calendarId, calendar, scalarTime);
    const out = {};
    for (const field of fields) {
        if (!PARTIAL_FIELDS.includes(field)) throw new Error(`Unknown datetime field "${field}"`);
        if (field === 'month') out.month = moment.monthName;
        else if (field === 'season') out.season = moment.seasonName;
        else if (field === 'cycle') out.cycle = moment.cycleName;
        else if (field === 'cycleDay') out.cycleDay = moment.cycleDay;
        else out[field] = moment.t[field];
    }
    return out;
}

// ---------------------------------------------------------------------------
// Calendar definitions: validation and CRUD (requirements spec 1.22 / 1.22.1)
// ---------------------------------------------------------------------------

// Every calendar definition, keyed by id (the live settings object).
export function listCalendars() {
    return getSettings().calendars || {};
}

// One calendar definition, or null.
export function getCalendarDefinition(calendarId) {
    return getSettings().calendars?.[calendarId] || null;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TOP_LEVEL_KEYS = ['id', 'label', 'unit', 'secondsPerMinute', 'minutesPerHour', 'hoursPerDay', 'months',
    'seasons', 'cycles', 'leapYearRule', 'formattingRules', 'nlRules', 'version'];
const FORMATTING_KEYS = ['patterns', 'monthNames', 'seasonNames', 'era', 'monthAbbreviationLength'];
const NL_KEYS = ['unitAliases', 'advanceVerbs', 'rewindVerbs', 'setVerbs'];
// Phrase lists (nlRules.nextSeason: ["next season"]): these fixed keys, plus next<CycleName> ("nextRedMoon") per cycle.
const NL_PHRASE_KEYS = ['nextSeason', 'nextCycle', 'moveToDay', 'moveToSeason'];
const cycleKey = (cycle) => `next${cycle.name.replace(/\s+/g, '')}`.toLowerCase();
const GREGORIAN_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isPositiveInt = (v, max = Infinity) => Number.isInteger(v) && v >= 1 && v <= max;

// Is `def` a usable calendar definition? -> { valid, errors } (errors is an
// array of human-readable strings; never throws). Checks the shape only - an id
// already being taken is createCalendar()'s concern.
export function validateCalendarDefinition(def) {
    const errors = [];
    if (!isPlainObject(def)) return { valid: false, errors: ['Calendar definition must be an object'] };

    for (const key of Object.keys(def)) {
        if (!TOP_LEVEL_KEYS.includes(key)) errors.push(`Unknown field "${key}"`);
    }
    if (typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) errors.push('id must be letters, digits, "-" and "_" (starting with a letter or digit)');
    if (!isText(def.label)) errors.push('label must be a non-empty string');
    if (def.unit !== 'seconds') errors.push(`unit must be "seconds" (got ${JSON.stringify(def.unit)})`);
    for (const key of ['secondsPerMinute', 'minutesPerHour', 'hoursPerDay']) {
        if (!isPositiveInt(def[key], 10000)) errors.push(`${key} must be a whole number from 1 to 10000`);
    }
    if (def.version !== undefined && !isPositiveInt(def.version)) errors.push('version must be a positive whole number');

    const rule = def.leapYearRule;
    if (rule !== undefined && rule !== null && !SUPPORTED_LEAP_RULES.includes(rule)) {
        errors.push(`leapYearRule ${JSON.stringify(rule)} is not supported (use "gregorian" or "none", or leave it out)`);
    }
    const gregorian = rule === 'gregorian';

    // Months
    let yearDays = 0;
    let monthsOk = false;
    if (!Array.isArray(def.months) || def.months.length === 0 || def.months.length > 100) {
        errors.push('months must be a list of 1 to 100 months');
    } else {
        monthsOk = true;
        const seen = new Set();
        def.months.forEach((month, i) => {
            const at = `months[${i}]`;
            if (!isPlainObject(month)) { errors.push(`${at} must be an object`); monthsOk = false; return; }
            if (!isText(month.name)) errors.push(`${at}.name must be a non-empty string`);
            else if (seen.has(month.name.trim().toLowerCase())) errors.push(`${at}.name "${month.name}" is used twice`);
            else seen.add(month.name.trim().toLowerCase());
            if (!isPositiveInt(month.days, 1000)) { errors.push(`${at}.days must be a whole number from 1 to 1000`); monthsOk = false; }
            else yearDays += month.days;
            if (month.leap !== undefined && (!gregorian || !isPositiveInt(month.leap, 1000))) {
                errors.push(`${at}.leap is only allowed with leapYearRule "gregorian", as a whole number of days`);
            }
        });
        if (gregorian && monthsOk) {
            const matches = def.months.length === 12 && def.months.every((m, i) => m.days === GREGORIAN_MONTH_DAYS[i]);
            if (!matches) errors.push('leapYearRule "gregorian" needs the twelve Gregorian months (31, 28, 31, 30, ... days); use "none" for other calendars');
        }
    }

    // Seasons: whole-year day ranges that never overlap.
    if (def.seasons !== undefined && def.seasons !== null) {
        if (!Array.isArray(def.seasons)) errors.push('seasons must be a list');
        else if (def.seasons.length > 0 && gregorian) errors.push('seasons are only supported for calendars with fixed-length years (leapYearRule "none")');
        else if (monthsOk) {
            const claimed = new Map();
            const names = new Set();
            def.seasons.forEach((season, i) => {
                const at = `seasons[${i}]`;
                if (!isPlainObject(season)) { errors.push(`${at} must be an object`); return; }
                if (!isText(season.name)) errors.push(`${at}.name must be a non-empty string`);
                else if (names.has(season.name.trim().toLowerCase())) errors.push(`${at}.name "${season.name}" is used twice`);
                else names.add(season.name.trim().toLowerCase());
                if (!isPositiveInt(season.startDay, yearDays) || !isPositiveInt(season.endDay, yearDays)) {
                    errors.push(`${at}.startDay and endDay must be whole days of the year (1-${yearDays})`);
                    return;
                }
                const wraps = season.startDay > season.endDay;
                const covered = [];
                for (let d = season.startDay; wraps ? d <= yearDays : d <= season.endDay; d++) covered.push(d);
                if (wraps) for (let d = 1; d <= season.endDay; d++) covered.push(d);
                for (const d of covered) {
                    if (claimed.has(d)) { errors.push(`${at} overlaps seasons[${claimed.get(d)}] on day ${d}`); return; }
                    claimed.set(d, i);
                }
            });
        }
    }

    // Cycles: repeating periods measured in days.
    if (def.cycles !== undefined && def.cycles !== null) {
        if (!Array.isArray(def.cycles)) errors.push('cycles must be a list');
        else {
            const names = new Set();
            def.cycles.forEach((cycle, i) => {
                const at = `cycles[${i}]`;
                if (!isPlainObject(cycle)) { errors.push(`${at} must be an object`); return; }
                if (!isText(cycle.name)) errors.push(`${at}.name must be a non-empty string`);
                else if (names.has(cycle.name.trim().toLowerCase())) errors.push(`${at}.name "${cycle.name}" is used twice`);
                else names.add(cycle.name.trim().toLowerCase());
                if (!isPositiveInt(cycle.length, 100000)) errors.push(`${at}.length must be a whole number of days from 1 to 100000`);
            });
        }
    }

    // formattingRules
    if (def.formattingRules !== undefined && def.formattingRules !== null) {
        const rules = def.formattingRules;
        if (!isPlainObject(rules)) errors.push('formattingRules must be an object');
        else {
            for (const key of Object.keys(rules)) if (!FORMATTING_KEYS.includes(key)) errors.push(`formattingRules has an unknown field "${key}"`);
            if (rules.patterns !== undefined) {
                if (!isPlainObject(rules.patterns)) errors.push('formattingRules.patterns must be an object of style name -> pattern');
                else for (const [name, p] of Object.entries(rules.patterns)) {
                    if (name === 'custom') errors.push('formattingRules.patterns cannot redefine "custom" (it takes its pattern from the caller)');
                    if (typeof p !== 'string' || p === '') errors.push(`formattingRules.patterns.${name} must be a non-empty string`);
                }
            }
            for (const key of ['monthNames', 'seasonNames']) {
                if (rules[key] !== undefined && (!Array.isArray(rules[key]) || !rules[key].every(isText))) {
                    errors.push(`formattingRules.${key} must be a list of non-empty strings`);
                }
            }
            if (rules.era !== undefined && typeof rules.era !== 'string') errors.push('formattingRules.era must be a string');
            if (rules.monthAbbreviationLength !== undefined && !isPositiveInt(rules.monthAbbreviationLength, 20)) {
                errors.push('formattingRules.monthAbbreviationLength must be a whole number from 1 to 20');
            }
        }
    }

    // nlRules
    if (def.nlRules !== undefined && def.nlRules !== null) {
        const rules = def.nlRules;
        if (!isPlainObject(rules)) errors.push('nlRules must be an object');
        else {
            const cycleKeys = new Set((Array.isArray(def.cycles) ? def.cycles : []).filter(isPlainObject).filter((c) => isText(c.name)).map(cycleKey));
            const phraseKeys = Object.keys(rules).filter((k) => NL_PHRASE_KEYS.includes(k) || cycleKeys.has(k.toLowerCase()));
            for (const key of Object.keys(rules)) if (!NL_KEYS.includes(key) && !phraseKeys.includes(key)) errors.push(`nlRules has an unknown field "${key}"`);
            for (const key of ['advanceVerbs', 'rewindVerbs', 'setVerbs', ...phraseKeys]) {
                if (rules[key] !== undefined && (!Array.isArray(rules[key]) || !rules[key].every(isText))) {
                    errors.push(`nlRules.${key} must be a list of non-empty phrases`);
                }
            }
            if (rules.unitAliases !== undefined) {
                if (!isPlainObject(rules.unitAliases)) errors.push('nlRules.unitAliases must be an object of word -> unit');
                else for (const [word, target] of Object.entries(rules.unitAliases)) {
                    if (!/^[a-z]+$/.test(word)) { errors.push(`nlRules.unitAliases key "${word}" must be lowercase letters only`); continue; }
                    const unitWord = isPlainObject(target) ? target.unit : target;
                    if (typeof unitWord !== 'string' || !UNIT_TABLE.has(unitWord)) errors.push(`nlRules.unitAliases.${word} must name a unit (day, month, year, season, cycle, ...)`);
                    if (isPlainObject(target) && (typeof target.multiplier !== 'number' || !Number.isFinite(target.multiplier) || target.multiplier <= 0)) {
                        errors.push(`nlRules.unitAliases.${word}.multiplier must be a positive number`);
                    }
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

function requireValidDefinition(def) {
    const { valid, errors } = validateCalendarDefinition(def);
    if (!valid) throw new Error(`Invalid calendar definition: ${errors.join('; ')}`);
}

// The built-in Gregorian calendar is fixed: it is what a datetime variable
// falls back to. Customise a copy instead.
function requireEditable(calendarId) {
    if (BUILTIN_CALENDAR_IDS.includes(calendarId)) throw new Error(`The built-in "${calendarId}" calendar cannot be changed or deleted - duplicate it instead`);
}

// Stores a new calendar (version 1) and returns a copy of it. Throws on an
// invalid definition or an id already in use.
export function createCalendar(def) {
    requireValidDefinition(def);
    const settings = getSettings();
    if (getCalendar(def.id)) throw new Error(`A calendar with id "${def.id}" already exists`);
    const stored = structuredCloneSafe(def);
    stored.version = 1;
    settings.calendars[stored.id] = stored;
    persistSettings();
    return structuredCloneSafe(stored);
}

// Merges `patch` onto calendar `calendarId`, re-validates the result, bumps its
// version and returns a copy. A patch value of null/undefined removes an
// optional field (seasons, cycles, formattingRules, nlRules, leapYearRule).
// The id and version cannot be patched. Throws when the calendar is missing,
// built in, or the merged definition is invalid - nothing is changed then.
export function updateCalendar(calendarId, patch) {
    requireEditable(calendarId);
    const existing = getCalendar(calendarId);
    if (!existing) throw new Error(`Unknown calendar "${calendarId}"`);
    if (!isPlainObject(patch)) throw new Error('Calendar patch must be an object');
    if (patch.id !== undefined && patch.id !== calendarId) throw new Error('A calendar\'s id cannot be changed');

    const merged = { ...structuredCloneSafe(existing) };
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || key === 'version') continue;
        if (value === undefined || value === null) delete merged[key];
        else merged[key] = structuredCloneSafe(value);
    }
    requireValidDefinition(merged);
    merged.version = (existing.version || 1) + 1;
    getSettings().calendars[calendarId] = merged;
    persistSettings();
    return structuredCloneSafe(merged);
}

// Names of every datetime variable (in any preset) that uses `calendarId`.
// Only datetime variables count: every variable definition carries a
// `calendar` field (the default), but only a datetime one ever reads it.
export function variablesUsingCalendar(calendarId) {
    const users = [];
    for (const preset of Object.values(getSettings().presets || {})) {
        for (const def of Object.values(preset?.variables || {})) {
            if (def?.type === 'datetime' && def.calendar === calendarId) users.push(def.name);
        }
    }
    return users;
}

// Removes a calendar. Throws when it is missing, built in, or still used by a
// variable (a datetime variable pointing at a deleted calendar could no longer
// be shown or advanced).
export function deleteCalendar(calendarId) {
    requireEditable(calendarId);
    if (!getCalendar(calendarId)) throw new Error(`Unknown calendar "${calendarId}"`);
    const users = variablesUsingCalendar(calendarId);
    if (users.length > 0) throw new Error(`Calendar "${calendarId}" is still used by ${users.length} variable(s): ${users.slice(0, 5).join(', ')}`);
    delete getSettings().calendars[calendarId];
    persistSettings();
    return true;
}

// ---------------------------------------------------------------------------
// Draft preview (calendar manager)
// ---------------------------------------------------------------------------

const PREVIEW_ID = '__preview__';

// Runs the real engine over a calendar definition that has NOT been saved, so
// the editor can show what an edit would do. The draft is installed under a
// reserved id for the duration of this synchronous call and always removed
// again; nothing is persisted. options: scalar (moment to show; default noon
// on day 1 of the calendar), delta (an increment to apply, e.g. "1season"),
// instruction (natural language to resolve, e.g. "next cycle"), scalarText
// (the moment as typed - seconds or a date; overridden by a numeric scalar).
// -> { valid: false, errors } for a bad definition, otherwise
//    { valid: true, errors: [], scalar, scalarError, full, date, partial,
//      incremented: { delta, scalar, text, error }|null,
//      resolved: { instruction, scalar, text }|null }
export function previewCalendarDefinition(def, options = {}) {
    const { valid, errors } = validateCalendarDefinition(def);
    if (!valid) return { valid: false, errors };

    const calendars = getSettings().calendars;
    const hadPreview = hasOwn(calendars, PREVIEW_ID);
    const saved = calendars[PREVIEW_ID];
    calendars[PREVIEW_ID] = { ...structuredCloneSafe(def), id: PREVIEW_ID };
    try {
        const opts = isPlainObject(options) ? options : {};
        const typed = typeof opts.scalarText === 'string' && opts.scalarText.trim() !== ''
            ? toScalar(PREVIEW_ID, opts.scalarText)
            : null;
        const scalar = Number.isFinite(opts.scalar)
            ? opts.scalar
            : (typed ?? fromStructured(PREVIEW_ID, { year: 1, month: 1, day: 1, hour: Math.floor(def.hoursPerDay / 2) }));
        const show = (value) => format(PREVIEW_ID, value, { style: 'full' });
        const out = {
            valid: true, errors: [], scalar,
            scalarError: typeof opts.scalarText === 'string' && opts.scalarText.trim() !== '' && typed === null
                ? `Could not read "${opts.scalarText}" as a moment - showing day 1 instead` : null,
            full: show(scalar),
            date: format(PREVIEW_ID, scalar, { style: 'date' }),
            partial: formatPartial(PREVIEW_ID, scalar, ['month', 'season', 'cycle', 'cycleDay']),
            incremented: null,
            resolved: null,
        };
        if (typeof opts.delta === 'string' && opts.delta.trim() !== '') {
            try {
                const next = incrementScalar(PREVIEW_ID, scalar, opts.delta);
                out.incremented = { delta: opts.delta, scalar: next, text: show(next), error: null };
            } catch (err) {
                out.incremented = { delta: opts.delta, scalar: null, text: null, error: err.message };
            }
        }
        if (typeof opts.instruction === 'string' && opts.instruction.trim() !== '') {
            const next = resolveInstruction(PREVIEW_ID, scalar, opts.instruction);
            out.resolved = { instruction: opts.instruction, scalar: next, text: next === null ? null : show(next) };
        }
        return out;
    } finally {
        if (hadPreview) calendars[PREVIEW_ID] = saved;
        else delete calendars[PREVIEW_ID];
    }
}

// ---------------------------------------------------------------------------
// Random calendar generator (requirements spec 1.22.5)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hashSeed(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(seed) >>> 0;
    let h = 2166136261;
    for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return h >>> 0;
}

const NAME_PREFIXES = ['Storm', 'Frost', 'Ember', 'Ash', 'Moon', 'Sun', 'Iron', 'Raven', 'Silver', 'Thorn', 'Mist', 'Gold', 'Star', 'Wolf', 'Oak', 'Tide', 'Dusk', 'Dawn'];
const NAME_SUFFIXES = ['fall', 'tide', 'wane', 'rise', 'moot', 'reach', 'song', 'ward', 'bloom', 'hollow', 'gale', 'watch', 'frost', 'mere'];
const SEASON_NAMES = ['Dawnrise', 'Highsun', 'Duskfall', 'Deepfrost', 'Thaw', 'Harvest', 'Emberwane'];
const ERAS = ['AR', 'FA', 'YR'];

// A random, VALID calendar definition (not stored - pass it to createCalendar
// to keep it). options: seed (number or string; the same seed always gives the
// same calendar), id, label, monthCount (3-24, default random 8-13),
// seasonCount (0-7, default 4), includeCycle (default true).
export function generateRandomCalendarDefinition(options = {}) {
    const opts = isPlainObject(options) ? options : {};
    const seed = opts.seed !== undefined ? opts.seed : Math.floor(Math.random() * 4294967296);
    const rand = mulberry32(hashSeed(seed));
    const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
    const pick = (list) => list[int(0, list.length - 1)];

    const monthCount = opts.monthCount !== undefined ? opts.monthCount : int(8, 13);
    const seasonCount = opts.seasonCount !== undefined ? opts.seasonCount : 4;
    if (!Number.isInteger(monthCount) || monthCount < 3 || monthCount > 24) throw new Error('monthCount must be a whole number from 3 to 24');
    if (!Number.isInteger(seasonCount) || seasonCount < 0 || seasonCount > SEASON_NAMES.length) throw new Error(`seasonCount must be a whole number from 0 to ${SEASON_NAMES.length}`);

    const usedNames = new Set();
    const uniqueName = () => {
        for (let attempt = 0; attempt < 200; attempt++) {
            const name = `${pick(NAME_PREFIXES)}${pick(NAME_SUFFIXES)}`;
            if (!usedNames.has(name)) { usedNames.add(name); return name; }
        }
        const fallback = `Month${usedNames.size + 1}`;
        usedNames.add(fallback);
        return fallback;
    };

    const months = Array.from({ length: monthCount }, () => ({ name: uniqueName(), days: int(20, 40) }));
    const yearDays = months.reduce((n, m) => n + m.days, 0);

    let id = isText(opts.id) ? opts.id.trim() : `random-${hashSeed(seed).toString(36)}`;
    if (!isText(opts.id)) {
        const base = id;
        for (let n = 2; getCalendar(id); n++) id = `${base}-${n}`;
    }

    const era = pick(ERAS);
    const def = {
        id,
        label: isText(opts.label) ? opts.label.trim() : `${pick(NAME_PREFIXES)}${pick(NAME_SUFFIXES)} Reckoning`,
        unit: 'seconds',
        secondsPerMinute: int(40, 80),
        minutesPerHour: int(40, 80),
        hoursPerDay: int(16, 30),
        months,
        leapYearRule: 'none',
        formattingRules: {
            era,
            patterns: { full: 'MMMM D, YYYY ERA HH:mm:ss', date: 'MMMM D, YYYY ERA', short: 'D MMM YYYY' },
        },
        nlRules: { unitAliases: {} },
    };

    if (seasonCount > 0) {
        const span = Math.floor(yearDays / seasonCount);
        const names = [...SEASON_NAMES].slice(0, seasonCount);
        def.seasons = names.map((name, i) => ({
            name,
            startDay: i * span + 1,
            endDay: i === seasonCount - 1 ? yearDays : (i + 1) * span,
        }));
    }
    if (opts.includeCycle !== false) {
        const cycleName = `${pick(NAME_PREFIXES)} Moon`;
        def.cycles = [{ name: cycleName, length: int(7, 30) }];
        def.nlRules.unitAliases.moon = 'cycle';
    }

    requireValidDefinition(def);
    return def;
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

// unit word -> [kind, multiplier]. "s"/"m"/"h" are second/minute/hour and
// "mo" is month, so "5m" is five minutes, never five months. "season" and
// "cycle" only work on a calendar that defines seasons / cycles.
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
    add(['season', 'seasons'], ['seasons', 1]);
    add(['cycle', 'cycles'], ['cycles', 1]);
    return table;
})();

// The [kind, multiplier] a unit word means for `calendar`: the calendar's own
// nlRules.unitAliases first, then the built-in table. undefined when unknown.
function lookupUnit(calendar, word) {
    const alias = calendar.nlRules?.unitAliases;
    // An alias is written once, in the singular ("moon"); "moons" works too.
    const aliasKey = hasOwn(alias, word) ? word : (word.endsWith('s') && hasOwn(alias, word.slice(0, -1)) ? word.slice(0, -1) : null);
    if (aliasKey !== null) {
        const target = alias[aliasKey];
        const unitWord = isPlainObject(target) ? target.unit : target;
        const entry = UNIT_TABLE.get(unitWord);
        if (entry) return [entry[0], entry[1] * (isPlainObject(target) ? target.multiplier : 1)];
    }
    return UNIT_TABLE.get(word);
}

const DELTA_TOKEN = /\s*(?:,|\band\b)?\s*([+-]?\d+(?:\.\d+)?)\s*([a-z]*)/y;

// "1h", "3 hours", "1d 2h", "1y, 2mo and 3d", "-2d", "1season", "2 cycles" ->
// { years, months, seasons, seconds } where seconds already covers every
// fixed-length unit for `calendar` (a cycle is its first cycle's length in
// days). A bare number is seconds. Months, years and seasons must be whole
// numbers (half a month has no fixed length). Throws on anything else.
function parseDeltaFor(calendar, delta) {
    if (typeof delta === 'number') {
        if (!Number.isFinite(delta)) throw new Error(`Invalid delta ${delta}`);
        return { years: 0, months: 0, seasons: 0, seconds: delta };
    }
    if (typeof delta !== 'string' || !delta.trim()) throw new Error(`Invalid delta "${delta}"`);

    const text = delta.trim().toLowerCase();
    const perMinute = calendar.secondsPerMinute;
    const perHour = perMinute * calendar.minutesPerHour;
    const perDay = perHour * calendar.hoursPerDay;
    const out = { years: 0, months: 0, seasons: 0, seconds: 0 };
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
        const unit = lookupUnit(calendar, m[2]);
        if (!unit) throw new Error(`Invalid delta "${delta}": unknown unit "${m[2]}"`);
        const [kind, multiplier] = unit;
        if ((kind === 'months' || kind === 'years' || kind === 'seasons') && !Number.isInteger(amount * multiplier)) {
            throw new Error(`Invalid delta "${delta}": months, years and seasons must be whole numbers`);
        }
        if (kind === 'years') out.years += amount * multiplier;
        else if (kind === 'months') out.months += amount * multiplier;
        else if (kind === 'seasons') {
            if (!calendar.seasons?.length) throw new Error(`Invalid delta "${delta}": this calendar has no seasons`);
            out.seasons += amount * multiplier;
        } else if (kind === 'cycles') {
            const cycle = calendar.cycles?.[0];
            if (!cycle) throw new Error(`Invalid delta "${delta}": this calendar has no cycles`);
            out.seconds += amount * multiplier * cycle.length * perDay;
        } else out.seconds += amount * multiplier * { seconds: 1, minutes: perMinute, hours: perHour, days: perDay }[kind];
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

// Moves a fixed-length-year moment `count` seasons on (negative = back): the
// same number of days into the target season and the same time of day, clamped
// to the target season's length - the season analogue of "Jan 31 + 1mo = Feb
// 28". Throws when the moment is not inside any season.
function shiftSeasons(calendar, scalarTime, count) {
    const seasons = sortedSeasons(calendar);
    const perDay = secondsPerDay(calendar);
    const length = yearLength(calendar);
    const total = Math.floor(scalarTime);
    const fraction = scalarTime - total;
    const days = Math.floor(total / perDay);
    const secondsIntoDay = total - days * perDay;
    const yearIndex = Math.floor(days / length);
    const dayIndex = days - yearIndex * length; // 0-based day of the year

    let current = -1;
    let baseYear = yearIndex;
    seasons.forEach((season, i) => {
        const start = season.startDay - 1;
        const end = season.endDay - 1;
        if (season.startDay <= season.endDay) {
            if (dayIndex >= start && dayIndex <= end) current = i;
        } else if (dayIndex >= start) {
            current = i;
        } else if (dayIndex <= end) {
            current = i;
            baseYear = yearIndex - 1; // the tail of a season that began last year
        }
    });
    if (current < 0) throw new Error('The current date is not inside any season');

    const offset = days - (baseYear * length + (seasons[current].startDay - 1));
    const target = current + count;
    const wraps = Math.floor(target / seasons.length);
    const targetSeason = seasons[((target % seasons.length) + seasons.length) % seasons.length];
    const targetStart = (baseYear + wraps) * length + (targetSeason.startDay - 1);
    const newDays = targetStart + Math.min(offset, seasonSpan(calendar, targetSeason) - 1);
    return newDays * perDay + secondsIntoDay + fraction;
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
    if (parsed.seasons !== 0) result = shiftSeasons(calendar, result, sign * parsed.seasons);
    return result + sign * parsed.seconds;
}

// scalarTime advanced by `delta` (a string such as "1h", "1d", "1mo", "1y",
// "1season", "1cycle" - see parseDeltaFor for the full grammar; a number is
// seconds) in calendar `calendarId`. Fixed units (s/m/h/d/w/cycle) are exact
// seconds; months and years follow the calendar's real month lengths (and
// leap years, for Gregorian); seasons follow its season boundaries. Negative
// deltas step backwards. Returns the new scalar; throws on a bad delta,
// scalar or calendar.
export function incrementScalar(calendarId, scalarTime, delta) {
    const calendar = requireCalendar(calendarId);
    return applyParsedDelta(calendarId, calendar, scalarTime, parseDeltaFor(calendar, delta), 1);
}

// ---------------------------------------------------------------------------
// Natural-language instructions (prompted updates; requirements spec 1.22.4)
// ---------------------------------------------------------------------------

const SET_PATTERN = /^(?:set|change|update)(?:\s+the)?(?:\s+(?:time|date|datetime|clock))?\s+to\s+(.+)$/;
const MOVE_TO_PATTERN = /^(?:move|go|jump|skip|travel|advance|fast[- ]forward)\s+to\s+(.+)$/;
const ADVANCE_PATTERN = /^(?:advance|move\s+forward|move\s+ahead|skip\s+ahead|skip\s+forward|jump\s+ahead|jump\s+forward|fast[- ]forward|forward|add|pass)(?:\s+the)?(?:\s+(?:time|clock))?(?:\s+by)?\s+(.+)$/;
const REWIND_PATTERN = /^(?:rewind|go\s+back|move\s+back|move\s+backwards?|step\s+back|turn\s+back|subtract)(?:\s+the)?(?:\s+(?:time|clock))?(?:\s+by)?\s+(.+)$/;
const NEXT_PATTERN = /^(?:next|following)\s+([a-z]+)$/;
const PREVIOUS_PATTERN = /^(?:previous|prior|last)\s+([a-z]+)$/;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A verb list from the calendar's nlRules (e.g. "let time pass") as the same
// kind of pattern the built-in verbs use, or null when there are none.
function customVerbPattern(calendar, key, allowTo) {
    const verbs = calendar.nlRules?.[key];
    if (!Array.isArray(verbs) || verbs.length === 0) return null;
    const alternatives = verbs.map((v) => escapeRegex(v.trim().toLowerCase()).replace(/\s+/g, '\\s+'));
    return new RegExp(`^(?:${alternatives.join('|')})${allowTo ? '(?:\\s+to)?' : '(?:\\s+by)?'}\\s+(.+)$`);
}

// "Stormfall 17", "17 Stormfall", "Stormfall 17, 1203", "the 17th of
// Stormfall 1203 at 14:30" -> scalar, or null. The year defaults to the
// current moment's year and the time of day to 00:00:00; with a null
// currentScalar the year is required instead (toScalar's absolute form).
function resolveMonthDay(calendarId, calendar, currentScalar, phrase) {
    const names = new Map();
    calendar.months.forEach((month, i) => {
        names.set(month.name.toLowerCase(), i + 1);
        const shown = calendar.formattingRules?.monthNames?.[i];
        if (shown) names.set(shown.toLowerCase(), i + 1);
    });
    const alternation = [...names.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
    const tail = '(?:\\s*,?\\s*(?:year\\s+)?(-?\\d+))?(?:\\s+(?:at\\s+)?(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?';
    const monthFirst = new RegExp(`^(${alternation})\\s+(\\d{1,4})(?:st|nd|rd|th)?${tail}$`, 'i').exec(phrase);
    const dayFirst = monthFirst ? null : new RegExp(`^(?:the\\s+)?(\\d{1,4})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${alternation})${tail}$`, 'i').exec(phrase);
    const match = monthFirst || dayFirst;
    if (!match) return null;

    const monthName = (monthFirst ? match[1] : match[2]).toLowerCase();
    const day = Number(monthFirst ? match[2] : match[1]);
    if (match[3] === undefined && currentScalar === null) return null;
    const year = match[3] !== undefined ? Number(match[3]) : toStructured(calendarId, currentScalar).year;
    return fromStructured(calendarId, {
        year, month: names.get(monthName), day,
        hour: match[4] === undefined ? 0 : Number(match[4]),
        minute: match[5] === undefined ? 0 : Number(match[5]),
        second: match[6] === undefined ? 0 : Number(match[6]),
    });
}

const normalizePhrase = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');

// The calendar's nlRules phrase lists (nextSeason, nextCycle, next<CycleName>,
// moveToSeason, moveToDay). undefined when no rule matches, so the general
// grammar carries on; a value (a scalar, or null for a recognised-but-
// impossible request) when one does.
//   nextSeason / nextCycle    exact phrases -> one season / one (first) cycle on
//   next<CycleName>           exact phrases -> that cycle's length in days on
//   moveToSeason "<p> <name>" -> midnight on the first day of that season, this year
//   moveToDay "<p> <target>"  -> a month-and-day (or date) target, as "move to" does
function resolvePhraseRule(calendarId, calendar, currentScalar, phrase) {
    const rules = calendar.nlRules;
    if (!rules) return undefined;
    const exact = (key) => Array.isArray(rules[key]) && rules[key].some((p) => normalizePhrase(p) === phrase);
    const step = (delta) => applyParsedDelta(calendarId, calendar, currentScalar, parseDeltaFor(calendar, delta), 1);

    if (exact('nextSeason')) return step('1 season');
    if (exact('nextCycle')) return step('1 cycle');
    for (const cycle of calendar.cycles || []) {
        if (exact(Object.keys(rules).find((k) => k.toLowerCase() === cycleKey(cycle)))) {
            return currentScalar + cycle.length * secondsPerDay(calendar);
        }
    }

    const withTarget = (key) => {
        for (const p of Array.isArray(rules[key]) ? rules[key] : []) {
            const prefix = `${normalizePhrase(p)} `;
            if (phrase.startsWith(prefix)) return phrase.slice(prefix.length).trim();
        }
        return null;
    };
    const seasonName = withTarget('moveToSeason');
    if (seasonName !== null) {
        const shown = calendar.formattingRules?.seasonNames;
        const index = (calendar.seasons || []).findIndex((sn, i) => sn.name.toLowerCase() === seasonName || shown?.[i]?.toLowerCase() === seasonName);
        if (index < 0) return null;
        const days = Math.floor(Math.floor(currentScalar) / secondsPerDay(calendar));
        const yearIndex = Math.floor(days / yearLength(calendar));
        return (yearIndex * yearLength(calendar) + calendar.seasons[index].startDay - 1) * secondsPerDay(calendar);
    }
    const target = withTarget('moveToDay');
    if (target !== null) return toScalar(calendarId, target) ?? resolveMonthDay(calendarId, calendar, currentScalar, target);
    return undefined;
}

// What a prompted update means for a datetime variable currently at
// `currentScalar`. `text` is what the model (or a user) wrote, and can be:
//   "advance 3 hours" / "move forward 1 day"  -> current + delta
//   "rewind 2 days" / "go back 1 hour"        -> current - delta
//   "advance 1 season" / "next cycle"         -> a season / cycle later
//   "previous month" / "last season"          -> one unit earlier
//   "set time to 2026-09-18 22:00"            -> that exact moment
//   "move to Stormfall 17" / "Stormfall 17"   -> that day (this year, 00:00)
//   "2026-09-18 22:00", "3600" or a number     -> that exact moment / scalar
// The calendar's own nlRules add verbs (advanceVerbs, rewindVerbs, setVerbs)
// and unit words (unitAliases) on top of these. Returns the resulting scalar,
// or null when the text is not an instruction this understands (the caller
// skips the write rather than guessing). Never throws.
export function resolveInstruction(calendarId, currentScalar, text) {
    try {
        if (typeof text === 'number') return Number.isFinite(text) ? text : null;
        if (typeof text !== 'string') return null;
        const calendar = requireCalendar(calendarId);
        const phrase = text.trim().toLowerCase().replace(/[.!]+$/, '');
        if (!phrase) return null;

        const absolute = toScalar(calendarId, phrase);
        if (absolute !== null) return absolute;

        const phrased = resolvePhraseRule(calendarId, calendar, currentScalar, phrase);
        if (phrased !== undefined) return phrased;

        const customSet = customVerbPattern(calendar, 'setVerbs', true)?.exec(phrase);
        const set = customSet || SET_PATTERN.exec(phrase) || MOVE_TO_PATTERN.exec(phrase);
        if (set) return toScalar(calendarId, set[1]) ?? resolveMonthDay(calendarId, calendar, currentScalar, set[1]);

        const customAdvance = customVerbPattern(calendar, 'advanceVerbs', false)?.exec(phrase);
        const advance = customAdvance || ADVANCE_PATTERN.exec(phrase);
        if (advance) return applyParsedDelta(calendarId, calendar, currentScalar, parseDeltaFor(calendar, advance[1]), 1);

        const customRewind = customVerbPattern(calendar, 'rewindVerbs', false)?.exec(phrase);
        const rewind = customRewind || REWIND_PATTERN.exec(phrase);
        if (rewind) return applyParsedDelta(calendarId, calendar, currentScalar, parseDeltaFor(calendar, rewind[1]), -1);

        const next = NEXT_PATTERN.exec(phrase);
        if (next) return applyParsedDelta(calendarId, calendar, currentScalar, parseDeltaFor(calendar, `1 ${next[1]}`), 1);

        const previous = PREVIOUS_PATTERN.exec(phrase);
        if (previous) return applyParsedDelta(calendarId, calendar, currentScalar, parseDeltaFor(calendar, `1 ${previous[1]}`), -1);

        return resolveMonthDay(calendarId, calendar, currentScalar, phrase);
    } catch {
        return null;
    }
}
