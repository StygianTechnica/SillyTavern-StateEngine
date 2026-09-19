import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import settings from './harness/settings.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { DEFAULT_CALENDARS, BUILTIN_CALENDAR_IDS } from '../src/core/settings-core.js';
import {
    format, formatPartial, incrementScalar, resolveInstruction, validateCalendarDefinition, getCalendarDefinition, createCalendar,
} from '../src/core/calendar-engine.js';
import { runDeterministicIncrements } from '../src/core/deterministic-engine.js';
import { getVar } from '../src/core/chat-state.js';
import * as uiTemplates from '../src/ui/manager-modal/ui-templates.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { formatIsoScalar, toScalar } from '../src/core/calendar-engine.js';
import * as variableUiSchema from '../src/ui/manager-modal/variable-ui-schema.js';

const SEEDS = ['faerun_inspired', 'three_moons', 'solar_cycle'];

// Scalar seconds for a moment, from the calendar's own clock and month lengths
// (fixed-length years, epoch = year 1, month 1, day 1).
const at = (id, year, month, day, hour = 0) => {
    const c = DEFAULT_CALENDARS[id];
    const perDay = c.secondsPerMinute * c.minutesPerHour * c.hoursPerDay;
    const yearDays = c.months.reduce((n, m) => n + m.days, 0);
    const before = c.months.slice(0, month - 1).reduce((n, m) => n + m.days, 0);
    return ((year - 1) * yearDays + before + day - 1) * perDay + hour * c.secondsPerMinute * c.minutesPerHour;
};
const perDay = (id) => DEFAULT_CALENDARS[id].secondsPerMinute * DEFAULT_CALENDARS[id].minutesPerHour * DEFAULT_CALENDARS[id].hoursPerDay;

let instanceId;
beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
});

describe('built-in fantasy calendars: presence', () => {
    it.each(SEEDS)('%s exists in DEFAULT_CALENDARS and settings.calendars', (id) => {
        expect(BUILTIN_CALENDAR_IDS).toContain(id);
        expect(DEFAULT_CALENDARS[id].id).toBe(id);
        expect(settings.get().calendars[id]).toEqual(DEFAULT_CALENDARS[id]);
        expect(settings.get().calendars[id].version).toBe(1);
    });

    it('has the specified labels, clocks and shapes', () => {
        const c = settings.get().calendars;
        expect(c.faerun_inspired).toMatchObject({ label: 'Faerûn-Inspired Calendar', secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 });
        expect(c.faerun_inspired.months).toHaveLength(12);
        expect(c.faerun_inspired.cycles.map((x) => [x.name, x.length])).toEqual([['Lunar', 28], ['Astral', 60]]);
        expect(c.three_moons.months).toHaveLength(10);
        expect(c.three_moons.months.every((m) => m.days === 36)).toBe(true);
        expect(c.three_moons.cycles.map((x) => x.length)).toEqual([18, 24, 30]);
        expect(c.solar_cycle).toMatchObject({ label: 'Solar-Cycle Calendar', secondsPerMinute: 100, minutesPerHour: 100, hoursPerDay: 30 });
        expect(c.solar_cycle.months.map((m) => m.name)).toEqual(['Scorchrise', 'Fadewind', 'Coldrest', 'Bloomreach', 'Highbloom', 'Lowbloom']);
    });

    it('every built-in passes the engine\'s own validation', () => {
        for (const id of BUILTIN_CALENDAR_IDS) expect(validateCalendarDefinition(getCalendarDefinition(id)), id).toEqual({ valid: true, errors: [] });
    });

    it('seasons cover each year exactly, with no gaps', () => {
        for (const id of ['faerun_inspired', 'solar_cycle']) {
            const c = DEFAULT_CALENDARS[id];
            const year = c.months.reduce((n, m) => n + m.days, 0);
            expect(c.seasons[0].startDay).toBe(1);
            expect(c.seasons.at(-1).endDay).toBe(year);
            c.seasons.slice(1).forEach((s, i) => expect(s.startDay).toBe(c.seasons[i].endDay + 1));
        }
    });

    it('is restored by getSettings() when missing, and existing entries are left alone', () => {
        const s = settings.get();
        delete s.calendars.three_moons;
        s.calendars.faerun_inspired = { ...s.calendars.faerun_inspired, label: 'kept as is' };
        expect(settings.get().calendars.three_moons).toEqual(DEFAULT_CALENDARS.three_moons);
        expect(settings.get().calendars.faerun_inspired.label).toBe('kept as is');
    });

    it('the stored copies are not the frozen defaults, so live settings cannot corrupt them', () => {
        settings.get().calendars.solar_cycle.months[0].days = 1;
        settings.reset();
        expect(settings.get().calendars.solar_cycle.months[0].days).toBe(50);
        expect(() => { DEFAULT_CALENDARS.solar_cycle.months[0].days = 1; }).toThrow();
    });

    it('is accessible through the Calendar API', () => {
        expect(stateEngine.listCalendarDefinitions('pp', instanceId).map((c) => c.id)).toEqual(expect.arrayContaining(SEEDS));
        expect(stateEngine.getCalendarDefinition('pp', instanceId, 'solar_cycle').label).toBe('Solar-Cycle Calendar');
        expect(Object.keys(stateEngine.getCalendarDefinitions('pp', instanceId))).toEqual(expect.arrayContaining(SEEDS));
    });
});

describe('built-in fantasy calendars: protection and duplication', () => {
    it.each(BUILTIN_CALENDAR_IDS)('%s cannot be deleted or edited', (id) => {
        expect(() => stateEngine.deleteCalendarDefinition('pp', instanceId, id)).toThrow(/built-in/);
        expect(() => stateEngine.updateCalendarDefinition('pp', instanceId, id, { label: 'x' })).toThrow(/built-in/);
        expect(getCalendarDefinition(id)).toEqual(DEFAULT_CALENDARS[id]);
    });

    it.each(SEEDS)('%s can be duplicated, and the duplicate is fully editable and deletable', (id) => {
        const copy = JSON.parse(JSON.stringify(getCalendarDefinition(id)));
        delete copy.version;
        copy.id = `${id}_copy`;
        const created = stateEngine.createCalendarDefinition('pp', instanceId, copy);
        expect(created.version).toBe(1);
        const updated = stateEngine.updateCalendarDefinition('pp', instanceId, copy.id, { label: 'Mine', hoursPerDay: 20 });
        expect(updated).toMatchObject({ label: 'Mine', version: 2 });
        expect(updated.hoursPerDay).toBe(20);
        // and structural edits are validated as for any calendar
        expect(() => stateEngine.updateCalendarDefinition('pp', instanceId, copy.id, { months: [] })).toThrow(/Invalid calendar/);
        expect(stateEngine.deleteCalendarDefinition('pp', instanceId, copy.id)).toBe(true);
        expect(getCalendarDefinition(id)).toEqual(DEFAULT_CALENDARS[id]); // the original never changed
    });
});

describe('built-in fantasy calendars: formatting', () => {
    it('faerun_inspired: full / date / time', () => {
        const t = at('faerun_inspired', 1203, 10, 17, 12); // Starfall 17 = day 287, Nightseason
        expect(format('faerun_inspired', t)).toBe('Starfall 17, Year 1203 — Nightseason');
        expect(format('faerun_inspired', t, { style: 'full' })).toBe('Starfall 17, Year 1203 — Nightseason');
        expect(format('faerun_inspired', t, { style: 'date' })).toBe('Starfall 17, 1203');
        expect(format('faerun_inspired', t + 34 * 60 + 5, { style: 'time' })).toBe('12:34:05');
        expect(format('faerun_inspired', at('faerun_inspired', 5, 1, 1), { style: 'full' })).toBe('Deepwinter 1, Year 5 — Winter');
    });

    it('three_moons: full shows the day within each named moon cycle', () => {
        const t = at('three_moons', 1203, 3, 5, 6); // Highcrest 5
        const days = Math.floor(t / perDay('three_moons'));
        const [r, b, w] = [18, 24, 30].map((n) => (days % n) + 1);
        expect(format('three_moons', t)).toBe(`Highcrest 5, Year 1203 — Moons: ${r}/${b}/${w}`);
        expect(format('three_moons', t, { style: 'date' })).toBe('Highcrest 5, 1203');
        expect(format('three_moons', t, { style: 'time' })).toBe('06:00:00');
        expect(format('three_moons', 0)).toBe('Firstlight 1, Year 1 — Moons: 1/1/1');
    });

    it('solar_cycle: full shows the season and the day of the season', () => {
        const t = at('solar_cycle', 7, 4, 20, 3); // Bloomreach 20 = day 170, 20th day of Cold (151-225)
        expect(format('solar_cycle', t)).toBe('Cold Cycle — Day 20 (Bloomreach 20)');
        expect(format('solar_cycle', t, { style: 'date' })).toBe('Bloomreach 20, 7');
        expect(format('solar_cycle', t, { style: 'time' })).toBe('03:00:00');
        expect(format('solar_cycle', at('solar_cycle', 7, 4, 1), { style: 'full' })).toBe('Cold Cycle — Day 1 (Bloomreach 1)');
        expect(format('solar_cycle', at('solar_cycle', 7, 1, 1))).toBe('Scorch Cycle — Day 1 (Scorchrise 1)');
        expect(format('solar_cycle', at('solar_cycle', 7, 6, 50))).toBe('Bloom Cycle — Day 75 (Lowbloom 50)');
    });

    it('placeholders it does not know stay as written, and formatPartial still works', () => {
        createCalendar({ ...JSON.parse(JSON.stringify(DEFAULT_CALENDARS.solar_cycle)), id: 'odd', version: undefined, formattingRules: { patterns: { full: '{monthName} {nothing} {cycle:x}' } } });
        expect(format('odd', 0)).toBe('Scorchrise {nothing} {cycle:x}');
        expect(formatPartial('faerun_inspired', at('faerun_inspired', 1, 3, 1), ['month', 'season'])).toEqual({ month: 'Greengold', season: 'Spring' });
    });
});

describe('built-in fantasy calendars: increments', () => {
    it('1season keeps the position in the season and rolls the year', () => {
        // Nightseason day 47 (Starfall 17) -> next season is Winter of the next year, day 47 = Rainswell 17.
        expect(incrementScalar('faerun_inspired', at('faerun_inspired', 1203, 10, 17, 12), '1season')).toBe(at('faerun_inspired', 1204, 2, 17, 12));
        // Winter day 16 (Deepwinter 16) -> Spring day 16 (day 76 = Greengold 16)
        expect(incrementScalar('faerun_inspired', at('faerun_inspired', 1203, 1, 16), '1season')).toBe(at('faerun_inspired', 1203, 3, 16));
        // solar: Cold day 20 -> Bloom day 20 (day 245 = Highbloom 45)
        expect(incrementScalar('solar_cycle', at('solar_cycle', 7, 4, 20, 3), '1season')).toBe(at('solar_cycle', 7, 5, 45, 3));
        expect(incrementScalar('solar_cycle', at('solar_cycle', 7, 6, 50), '1season')).toBe(at('solar_cycle', 8, 2, 25)); // Bloom day 75 -> Scorch day 75
    });

    it('1cycle advances by the first cycle', () => {
        const f = at('faerun_inspired', 1203, 10, 17, 12);
        expect(incrementScalar('faerun_inspired', f, '1cycle')).toBe(f + 28 * perDay('faerun_inspired'));
        const m = at('three_moons', 1203, 3, 5);
        expect(incrementScalar('three_moons', m, '1cycle')).toBe(m + 18 * perDay('three_moons')); // Red Moon is first
    });

    it('1mo and 1y use each calendar\'s own months', () => {
        expect(incrementScalar('three_moons', at('three_moons', 1203, 10, 36), '1mo')).toBe(at('three_moons', 1204, 1, 36));
        expect(incrementScalar('solar_cycle', at('solar_cycle', 7, 2, 10), '1y')).toBe(at('solar_cycle', 8, 2, 10));
    });

    it('a delta the calendar cannot honour is refused: no seasons on three_moons, no cycles on solar_cycle', () => {
        expect(() => incrementScalar('three_moons', 0, '1season')).toThrow(/no seasons/);
        expect(() => incrementScalar('solar_cycle', 0, '1cycle')).toThrow(/no cycles/);
    });

    it('a deterministic variable on a built-in calendar steps by season', () => {
        stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
        stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
        stateEngine.createVariable('pp', instanceId, {
            namespace: 'pp', presetName: 'Demo', name: 'clock', type: 'datetime', calendar: 'solar_cycle',
            defaultValue: at('solar_cycle', 7, 4, 20, 3), behaviors: { increment: true, prompted: false }, increment: { delta: '1season', triggers: 'ai' },
        });
        runDeterministicIncrements('chat-1', 'ai');
        expect(getVar('chat-1', 'pp__clock').value).toBe(at('solar_cycle', 7, 5, 45, 3));
    });
});

describe('built-in fantasy calendars: natural language', () => {
    const f = at('faerun_inspired', 1203, 10, 17, 12);
    const nextSeason = at('faerun_inspired', 1204, 2, 17, 12);

    it('"next season" and "advance season" (faerun_inspired)', () => {
        expect(resolveInstruction('faerun_inspired', f, 'next season')).toBe(nextSeason);
        expect(resolveInstruction('faerun_inspired', f, 'Advance Season.')).toBe(nextSeason);
        expect(resolveInstruction('faerun_inspired', f, 'advance 1 season')).toBe(nextSeason); // general grammar still works
    });

    it('"next cycle" and "advance cycle"', () => {
        expect(resolveInstruction('faerun_inspired', f, 'next cycle')).toBe(f + 28 * perDay('faerun_inspired'));
        expect(resolveInstruction('faerun_inspired', f, 'advance cycle')).toBe(f + 28 * perDay('faerun_inspired'));
        const m = at('three_moons', 1203, 3, 5);
        expect(resolveInstruction('three_moons', m, 'next cycle')).toBe(m + 18 * perDay('three_moons'));
    });

    it('three_moons: each named moon advances by its own length', () => {
        const m = at('three_moons', 1203, 3, 5);
        expect(resolveInstruction('three_moons', m, 'next red moon')).toBe(m + 18 * perDay('three_moons'));
        expect(resolveInstruction('three_moons', m, 'next blue moon')).toBe(m + 24 * perDay('three_moons'));
        expect(resolveInstruction('three_moons', m, 'Next White Moon')).toBe(m + 30 * perDay('three_moons'));
    });

    it('"move to <month> <day>" on each calendar', () => {
        const from = at('faerun_inspired', 1203, 2, 3, 9);
        expect(resolveInstruction('faerun_inspired', from, 'move to Starfall 17')).toBe(at('faerun_inspired', 1203, 10, 17));
        expect(resolveInstruction('three_moons', at('three_moons', 9, 1, 1), 'move to Moonrise 8')).toBe(at('three_moons', 9, 8, 8));
        expect(resolveInstruction('solar_cycle', at('solar_cycle', 7, 1, 1), 'move to Lowbloom 3')).toBe(at('solar_cycle', 7, 6, 3));
    });

    it('"move to Stormfall 17" is not understood: none of the three calendars has a month called Stormfall', () => {
        for (const id of SEEDS) expect(resolveInstruction(id, 0, 'move to Stormfall 17'), id).toBeNull();
    });

    it('solar_cycle: "next season" and "move to season <name>"', () => {
        const t = at('solar_cycle', 7, 4, 20, 3);
        expect(resolveInstruction('solar_cycle', t, 'next season')).toBe(at('solar_cycle', 7, 5, 45, 3));
        expect(resolveInstruction('solar_cycle', t, 'move to season bloom')).toBe(at('solar_cycle', 7, 5, 26)); // day 226
        expect(resolveInstruction('solar_cycle', t, 'Move to season Fade')).toBe(at('solar_cycle', 7, 2, 26)); // day 76
        expect(resolveInstruction('solar_cycle', t, 'move to season monsoon')).toBeNull();
    });

    it('a calendar does not understand another calendar\'s phrases', () => {
        expect(resolveInstruction('three_moons', 0, 'next season')).toBeNull();
        expect(resolveInstruction('solar_cycle', 0, 'next cycle')).toBeNull();
        expect(resolveInstruction('solar_cycle', 0, 'next red moon')).toBeNull();
        expect(resolveInstruction('faerun_inspired', 0, 'move to season bloom')).toBeNull();
    });

    it('the phrase-list nlRules validate on a duplicate and are rejected when malformed', () => {
        const base = JSON.parse(JSON.stringify(DEFAULT_CALENDARS.three_moons));
        expect(validateCalendarDefinition({ ...base, id: 'dup' }).valid).toBe(true);
        expect(validateCalendarDefinition({ ...base, id: 'dup', nlRules: { nextGreenMoon: ['x'] } }).errors.join()).toMatch(/unknown field "nextGreenMoon"/);
        expect(validateCalendarDefinition({ ...base, id: 'dup', nlRules: { nextRedMoon: 'next red moon' } }).errors.join()).toMatch(/nextRedMoon/);
    });
});

describe('built-in fantasy calendars: UI', () => {
    const rows = () => Object.values(settings.get().calendars).map((c) => uiTemplates.buildCalendarRow(c, '', 0)).join('');

    it('the Calendars tab lists every built-in calendar', () => {
        const html = uiTemplates.buildCalendarsTabContainer(rows(), '');
        for (const id of BUILTIN_CALENDAR_IDS) expect(html, id).toContain(`data-calendar-id="${id}"`);
        for (const label of ['Faerûn-Inspired Calendar', 'Three-Moon Calendar', 'Solar-Cycle Calendar']) expect(html).toContain(label);
        expect(html.match(/built in/g)).toHaveLength(4);
    });

    it('a built-in row offers duplicate and export, but no edit and no delete', () => {
        for (const id of BUILTIN_CALENDAR_IDS) {
            const row = uiTemplates.buildCalendarRow(getCalendarDefinition(id));
            expect(row).toContain('se-cal-duplicate');
            expect(row).toContain('se-cal-export');
            expect(row).not.toContain('se-cal-edit');
            expect(row).not.toContain('se-cal-delete');
        }
    });

    it('a duplicate\'s row is fully editable', () => {
        const copy = JSON.parse(JSON.stringify(DEFAULT_CALENDARS.solar_cycle));
        copy.id = 'solar_mine';
        delete copy.version;
        const row = uiTemplates.buildCalendarRow(createCalendar(copy));
        for (const cls of ['se-cal-edit', 'se-cal-duplicate', 'se-cal-export', 'se-cal-delete']) expect(row).toContain(cls);
        expect(row).not.toContain('built in');
    });

    it('the event handlers refuse to edit or delete a built-in even if the button were clicked', () => {
        const src = readFileSync(new URL('../src/ui/manager-modal/ui-events.js', import.meta.url), 'utf8');
        expect(src.match(/BUILTIN_CALENDAR_IDS\.includes/g).length).toBeGreaterThanOrEqual(2);
    });

    describe('the variable editor\'s calendar dropdown', () => {
        const editor = (extra = {}) => uiTemplates.buildInlineVariableEditor(
            variableUiSchema.mergeDefinition(blankDefinition(), { name: 'clock', type: 'datetime', ...extra }), true, []);

        it('lists every calendar in settings.calendars, built-ins included', () => {
            const html = editor({ calendar: 'three_moons' });
            for (const id of BUILTIN_CALENDAR_IDS) expect(html, id).toContain(`<option value="${id}"`);
            expect(html).toContain('<option value="three_moons" selected>Three-Moon Calendar</option>');
            expect(html).not.toContain('se-cal-missing-warning');
        });

        it('includes calendars added later', () => {
            createCalendar({ ...JSON.parse(JSON.stringify(DEFAULT_CALENDARS.three_moons)), id: 'later', version: undefined });
            expect(editor()).toContain('<option value="later"');
        });

        it('warns, and keeps the value visible, when the variable\'s calendar is missing', () => {
            const html = editor({ calendar: 'vanished' });
            expect(html).toContain('se-cal-missing-warning');
            expect(html).toContain('"vanished"');
            expect(html).toContain('<option value="vanished" selected>⚠ vanished (missing)</option>');
        });

        it('a missing calendar id is not silently kept by normalizeCollectedValues', () => {
            expect(variableUiSchema.normalizeCollectedValues({ type: 'datetime', calendar: 'vanished' }).calendar).toBe('gregorian');
            expect(variableUiSchema.normalizeCollectedValues({ type: 'datetime', calendar: 'solar_cycle' }).calendar).toBe('solar_cycle');
        });
    });
});

describe('editing a fantasy default in the variable editor', () => {
    it.each(BUILTIN_CALENDAR_IDS)('%s: the redisplayed default reads back to the same scalar', (id) => {
        const t = id === 'gregorian' ? Date.UTC(2026, 8, 18, 22) / 1000 : at(id, 1203, 3, 5, 6);
        const shown = formatIsoScalar(id, t);
        expect(shown).toMatch(/^-?\d+-\d\d-\d\d \d\d:\d\d:\d\d$/);
        expect(toScalar(id, shown)).toBe(t); // the save handler's check passes
        expect(variableUiSchema.normalizeCollectedValues({ type: 'datetime', calendar: id, defaultValue: shown }).defaultValue).toBe(t);
    });

    it('the calendar display form is not what the editor input shows', () => {
        expect(format('faerun_inspired', at('faerun_inspired', 1203, 10, 17, 12))).toContain('Nightseason');
        expect(toScalar('faerun_inspired', format('faerun_inspired', at('faerun_inspired', 1203, 10, 17, 12)))).toBeNull();
        expect(formatIsoScalar('faerun_inspired', at('faerun_inspired', 1203, 10, 17, 12))).toBe('1203-10-17 12:00:00');
    });
});

describe('the formatted default shows beside the input, not in it', () => {
    it('datetimeDefaultPreview shows the calendar form, or a hint', () => {
        expect(variableUiSchema.datetimeDefaultPreview('faerun_inspired', '1203-10-17 12:00:00')).toBe('Shown as: Starfall 17, Year 1203 — Nightseason');
        expect(variableUiSchema.datetimeDefaultPreview('solar_cycle', '7-04-20 03:00:00')).toBe('Shown as: Cold Cycle — Day 20 (Bloomreach 20)');
        expect(variableUiSchema.datetimeDefaultPreview('faerun_inspired', 'garbage')).toMatch(/Not a readable date/);
        expect(variableUiSchema.datetimeDefaultPreview('faerun_inspired', '')).toBe('');
        expect(variableUiSchema.datetimeDefaultPreview('nope', '0')).toBe('');
    });

    it('the editor input holds the numeric form and the preview sits below it', () => {
        const html = uiTemplates.buildInlineVariableEditor(variableUiSchema.mergeDefinition(blankDefinition(), {
            name: 'c', type: 'datetime', calendar: 'faerun_inspired', defaultValue: '1203-10-17 12:00:00',
        }), true, []);
        expect(html).toContain('value="1203-10-17 12:00:00"');
        expect(html).toMatch(/se-manager-datetime-preview">Shown as: Starfall 17, Year 1203/);
        expect(html.indexOf('data-field="defaultValue"')).toBeLessThan(html.indexOf('se-manager-datetime-preview'));
    });
});
