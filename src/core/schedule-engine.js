// State Engine — Independent Preset scheduling: pure calendar math
// (requirements spec 1.32).
//
// Time-based automatic execution for independent presets: interval, atTime,
// delay and repeat modes. A fifth mode the request specified, "threshold"
// (run when a datetime VARIABLE crosses a value, evaluated inside
// recalculateDependents()), is deliberately NOT built in this pass - see
// docs/STATE ENGINE API SPECIFICATION.md Section 15 for why (it needs a
// small variable-comparison expression language the request's own schema
// never defines a field for, and it is the one mode with a real, non-
// hypothetical cycle risk - building it on a guessed-at format would mean
// exactly the kind of unverified assumption this project avoids).
//
// "now" for every mode here is REAL wall-clock time (Math.floor(Date.now()/
// 1000)), treated as the chosen calendar's own running scalar clock - the
// SAME calendar-engine functions (resolveInstruction/incrementScalar,
// already used to advance a stored datetime VARIABLE - 1.21/1.22/1.31) are
// reused completely unchanged, just fed the real clock instead of a
// variable's stored value. This needs no new parsing (request Section 5)
// and is the only definition of "now" that makes "every 10 minutes" mean
// anything: nothing in this codebase tracks one global "story time"
// independent of a specific datetime variable, and the request names no
// variable for these four modes to read "now" from.
//
// CONFIRMED GAP, not guessed around: "dawn", "midnight", "sunrise" and
// "sunset" (the request's own atTime/repeat examples) are not phrases any
// calendar's NL rules understand - resolvePhraseRule() only recognizes
// relative advance/rewind durations, "next season"/"next cycle"/"next
// <cycle name>" (only when the calendar defines seasons/cycles), "move to
// <season/cycle>", and absolute dates - there is no hour-of-day vocabulary
// anywhere in calendar-engine.js. Inventing one here would be the "new
// parsing subsystem" Section 5 forbids, so these phrases are honestly
// unsupported: parseScheduleTarget() returns ok:false for them, same as any
// other unparseable text. A user can still express a specific hour via an
// absolute time ("2026-09-22 06:00:00") or a season/cycle name where the
// calendar defines one.

import { DEFAULT_CALENDAR_ID } from './settings-core.js';
import { getCalendar, resolveInstruction } from './calendar-engine.js';

export const SCHEDULE_MODES = ['interval', 'atTime', 'delay', 'repeat'];

// Defense-in-depth against a pathological phrase/calendar combination that
// could otherwise loop for a very long time inside parseScheduleTarget's
// repeat-mode advancement (e.g. a custom calendar whose "next season" rule
// somehow always lands earlier than the last one, which would otherwise be
// an infinite loop) - mirrors calculated-engine.js's own
// MAX_DATETIME_TRIGGER_DEPTH guard in spirit (a hard, generous cap rather
// than trusting every possible calendar definition to be well-formed).
export const MAX_REPEAT_ADVANCE_STEPS = 1000;

function nowScalar() {
    return Math.floor(Date.now() / 1000);
}

// Resolves `text` against `currentScalar` for `calendarId`, trying it as-is
// first (an absolute date, or a phrase that already has its own verb - "set
// to 2026-09-22", "next season") and, only if that fails, retried with an
// implicit "advance " prefix so a bare duration ("10 minutes", "1 hour", "2
// days", "1 mo" - the request's own interval examples) resolves too - the
// same fallback calculated-engine.js's applyDatetimeDeltaTriggers() already
// uses for a deltaSource's text (1.31), reused verbatim rather than
// reimplemented. Returns the resolved scalar or null.
function resolveWithAdvanceFallback(calendarId, currentScalar, text) {
    return resolveInstruction(calendarId, currentScalar, text)
        ?? resolveInstruction(calendarId, currentScalar, `advance ${text}`);
}

// Validates and computes the FIRST nextRun for a freshly created/edited
// schedule. `schedule` is { mode, value, calendar? }. Returns
// { ok: true, nextRun (ms since epoch) } or { ok: false, error }. Never
// throws - an unparseable value or unknown mode/calendar is a normal
// validation failure, not an exception.
export function parseScheduleTarget(schedule) {
    try {
        const mode = schedule?.mode;
        if (!SCHEDULE_MODES.includes(mode)) {
            return { ok: false, error: `schedule.mode must be one of ${SCHEDULE_MODES.join(', ')} (got ${JSON.stringify(mode)})` };
        }
        const calendarId = schedule.calendar || DEFAULT_CALENDAR_ID;
        if (!getCalendar(calendarId)) {
            return { ok: false, error: `schedule: calendar "${calendarId}" does not exist` };
        }
        const text = String(schedule.value ?? '').trim();
        if (!text) {
            return { ok: false, error: 'schedule.value is required' };
        }

        const current = nowScalar();
        const resolved = resolveWithAdvanceFallback(calendarId, current, text);
        if (resolved === null) {
            return { ok: false, error: `schedule.value "${text}" is not understood for calendar "${calendarId}"` };
        }

        // interval/delay: request 3A/3C - "nextRun = now + parsedDelta". A
        // resolved moment at or before "now" means the text was an absolute
        // past date/time, not a forward duration - refused rather than
        // silently scheduling something that is already overdue by
        // construction (a genuine duration, "10 minutes", can never resolve
        // to <= current).
        if ((mode === 'interval' || mode === 'delay') && resolved <= current) {
            return { ok: false, error: `schedule.value "${text}" must be a forward duration (e.g. "10 minutes", "1 hour", "2 days"), not a past or present moment` };
        }

        // atTime: request 3B - "nextRun = parsed absolute datetime", used
        // exactly as resolved, even if already in the past (an already-
        // passed one-shot time is simply overdue and fires on the next
        // check - not silently reinterpreted as "next year" or similar).
        //
        // repeat: request 3D - "nextRun = next occurrence of parsed time".
        // If the first resolution already lies at or before now (e.g. the
        // calendar's own "next season" from the CURRENT real moment landed
        // earlier today because of how this calendar's day boundaries fall,
        // or the phrase named a moment already past), resolveInstruction is
        // called again using its OWN previous result as the new "current" -
        // every phrase this system understands (a duration, or a "next X"
        // rule) is inherently relative/iterative, so re-resolving against
        // its own prior answer walks forward one real occurrence at a time
        // with no phrase-specific period logic needed. Capped, not
        // unbounded - see MAX_REPEAT_ADVANCE_STEPS.
        let nextScalar = resolved;
        if (mode === 'repeat') {
            let steps = 0;
            while (nextScalar <= current && steps < MAX_REPEAT_ADVANCE_STEPS) {
                const advanced = resolveWithAdvanceFallback(calendarId, nextScalar, text);
                if (advanced === null || advanced <= nextScalar) break; // cannot advance further - stop rather than loop
                nextScalar = advanced;
                steps += 1;
            }
            if (nextScalar <= current) {
                return { ok: false, error: `schedule.value "${text}" never resolves to a future occurrence for calendar "${calendarId}"` };
            }
        }

        return { ok: true, nextRun: nextScalar * 1000 };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

// After a due schedule has just run: the next nextRun (ms), and whether the
// schedule should remain enabled, per request Section 3's per-mode rules -
// interval always reschedules (3A does not mention `repeat` at all, despite
// Section 2 listing it as "for interval/repeat modes" - 3A's own explicit
// engine-behavior text is the more specific, authoritative source, and is
// followed literally here; flagged as a spec inconsistency, not silently
// resolved either way without saying so); atTime disables unless
// schedule.repeat is explicitly true; delay always disables (one-shot,
// regardless of `repeat`); repeat-mode always stays enabled and always
// recomputes (recurrence is what the mode name itself means - `repeat`
// is inert here, same as it is for interval/delay).
// Returns { nextRun, enabled } - null nextRun means "not rescheduled"
// (the caller should leave schedule.nextRun as null/unset).
export function scheduleAfterRun(schedule) {
    const calendarId = schedule.calendar || DEFAULT_CALENDAR_ID;
    const text = String(schedule.value ?? '').trim();
    const current = nowScalar();

    if (schedule.mode === 'interval') {
        const resolved = resolveWithAdvanceFallback(calendarId, current, text);
        return { nextRun: resolved !== null ? resolved * 1000 : null, enabled: resolved !== null };
    }
    if (schedule.mode === 'delay') {
        return { nextRun: null, enabled: false };
    }
    if (schedule.mode === 'atTime') {
        return { nextRun: null, enabled: schedule.repeat === true };
    }
    if (schedule.mode === 'repeat') {
        const result = parseScheduleTarget({ ...schedule, value: text });
        return { nextRun: result.ok ? result.nextRun : null, enabled: result.ok };
    }
    return { nextRun: null, enabled: false };
}
