// State Engine — calendar editor schema helpers
// Pure conversions between a calendar definition (settings.calendars, see
// requirements spec 1.22) and the flat "editor values" the Calendars tab's
// form collects from the DOM. No DOM, no settings access - so the form's
// logic can be tested without one. Validation itself stays in
// calendar-engine.js's validateCalendarDefinition().

const num = (value) => {
    const text = String(value ?? '').trim();
    return text === '' ? NaN : Number(text);
};

const lines = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

// "style = pattern" per line -> { style: pattern }. Splits at the FIRST "=".
function parsePairs(text) {
    const out = {};
    for (const line of lines(text)) {
        const at = line.indexOf('=');
        if (at < 1) continue;
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (key && value) out[key] = value;
    }
    return out;
}

// "moon = cycle" or "tenday = day * 10" -> { moon: "cycle", tenday: { unit: "day", multiplier: 10 } }
function parseUnitAliases(text) {
    const out = {};
    for (const line of lines(text)) {
        const m = /^([A-Za-z]+)\s*=\s*([A-Za-z]+)(?:\s*[x*]\s*(\d+(?:\.\d+)?))?$/.exec(line);
        if (!m) continue;
        out[m[1].toLowerCase()] = m[3] === undefined ? m[2].toLowerCase() : { unit: m[2].toLowerCase(), multiplier: Number(m[3]) };
    }
    return out;
}

function formatPairs(object) {
    return Object.entries(object || {}).map(([k, v]) => `${k} = ${v}`).join('\n');
}

function formatUnitAliases(object) {
    return Object.entries(object || {})
        .map(([word, target]) => (typeof target === 'string' ? `${word} = ${target}` : `${word} = ${target.unit} * ${target.multiplier}`))
        .join('\n');
}

// A blank definition for "New calendar": a Gregorian-sized clock and one empty
// month row to start from.
export function blankCalendarEditorValues() {
    return {
        isNew: true, id: '', label: '', leapYearRule: 'none',
        secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24,
        months: [{ name: '', days: 30 }], seasons: [], cycles: [],
        era: '', monthAbbreviationLength: '',
        patternsText: '', monthNamesText: '', seasonNamesText: '',
        unitAliasesText: '', advanceVerbsText: '', rewindVerbsText: '', setVerbsText: '',
    };
}

// A stored definition -> the editor's flat values.
export function editorValuesFromDefinition(def) {
    const fr = def?.formattingRules || {};
    const nl = def?.nlRules || {};
    return {
        isNew: false,
        id: def?.id ?? '',
        label: def?.label ?? '',
        leapYearRule: def?.leapYearRule ?? 'none',
        secondsPerMinute: def?.secondsPerMinute ?? 60,
        minutesPerHour: def?.minutesPerHour ?? 60,
        hoursPerDay: def?.hoursPerDay ?? 24,
        months: (def?.months || []).map((m) => ({ name: m.name, days: m.days, ...(m.leap !== undefined ? { leap: m.leap } : {}) })),
        seasons: (def?.seasons || []).map((s) => ({ name: s.name, startDay: s.startDay, endDay: s.endDay })),
        cycles: (def?.cycles || []).map((c) => ({ name: c.name, length: c.length })),
        era: fr.era ?? '',
        monthAbbreviationLength: fr.monthAbbreviationLength ?? '',
        patternsText: formatPairs(fr.patterns),
        monthNamesText: (fr.monthNames || []).join('\n'),
        seasonNamesText: (fr.seasonNames || []).join('\n'),
        unitAliasesText: formatUnitAliases(nl.unitAliases),
        advanceVerbsText: (nl.advanceVerbs || []).join('\n'),
        rewindVerbsText: (nl.rewindVerbs || []).join('\n'),
        setVerbsText: (nl.setVerbs || []).join('\n'),
    };
}

// The editor's flat values -> a calendar definition (NOT yet validated - the
// caller runs validateCalendarDefinition()). Numbers are coerced from the
// form's text; blank rows are dropped; optional sections that are empty are
// left out entirely. A field that is not a number stays NaN so validation
// reports it rather than it being silently defaulted.
export function definitionFromEditorValues(values) {
    const v = values || {};
    const def = {
        id: String(v.id ?? '').trim(),
        label: String(v.label ?? '').trim(),
        unit: 'seconds',
        secondsPerMinute: num(v.secondsPerMinute),
        minutesPerHour: num(v.minutesPerHour),
        hoursPerDay: num(v.hoursPerDay),
        months: (v.months || [])
            .filter((m) => String(m?.name ?? '').trim() !== '' || String(m?.days ?? '').trim() !== '')
            .map((m) => ({ name: String(m.name ?? '').trim(), days: num(m.days), ...(m.leap !== undefined ? { leap: num(m.leap) } : {}) })),
    };
    if (v.leapYearRule === 'gregorian') def.leapYearRule = 'gregorian';
    else def.leapYearRule = 'none';

    const seasons = (v.seasons || [])
        .filter((s) => String(s?.name ?? '').trim() !== '')
        .map((s) => ({ name: String(s.name).trim(), startDay: num(s.startDay), endDay: num(s.endDay) }));
    if (seasons.length) def.seasons = seasons;

    const cycles = (v.cycles || [])
        .filter((c) => String(c?.name ?? '').trim() !== '')
        .map((c) => ({ name: String(c.name).trim(), length: num(c.length) }));
    if (cycles.length) def.cycles = cycles;

    const formattingRules = {};
    if (String(v.era ?? '').trim() !== '') formattingRules.era = String(v.era).trim();
    if (String(v.monthAbbreviationLength ?? '').trim() !== '') formattingRules.monthAbbreviationLength = num(v.monthAbbreviationLength);
    const patterns = parsePairs(v.patternsText);
    if (Object.keys(patterns).length) formattingRules.patterns = patterns;
    const monthNames = lines(v.monthNamesText);
    if (monthNames.length) formattingRules.monthNames = monthNames;
    const seasonNames = lines(v.seasonNamesText);
    if (seasonNames.length) formattingRules.seasonNames = seasonNames;
    if (Object.keys(formattingRules).length) def.formattingRules = formattingRules;

    const nlRules = {};
    const unitAliases = parseUnitAliases(v.unitAliasesText);
    if (Object.keys(unitAliases).length) nlRules.unitAliases = unitAliases;
    for (const [key, text] of [['advanceVerbs', v.advanceVerbsText], ['rewindVerbs', v.rewindVerbsText], ['setVerbs', v.setVerbsText]]) {
        const list = lines(text);
        if (list.length) nlRules[key] = list;
    }
    if (Object.keys(nlRules).length) def.nlRules = nlRules;

    return def;
}

// The optional fields calendar-engine's updateCalendar() treats as "remove
// when null": a definition built from the editor simply omits an emptied
// section, so an update must say so explicitly or the old section would be kept.
const OPTIONAL_FIELDS = ['seasons', 'cycles', 'formattingRules', 'nlRules'];

export function updatePatchFromDefinition(def) {
    const patch = { ...def };
    delete patch.id;
    for (const key of OPTIONAL_FIELDS) if (patch[key] === undefined) patch[key] = null;
    return patch;
}
