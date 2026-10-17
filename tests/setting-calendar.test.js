// "Follow the setting" calendars (requirements spec 1.22.6): a setting names
// its calendar; a datetime variable whose calendar is "@setting" reads its
// scalar through the calendar of the setting the open chat uses.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import context from './harness/context.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { createCalendar, resolveCalendarId, SETTING_CALENDAR_ID } from '../src/core/calendar-engine.js';
import * as O from '../src/core/objects.js';

vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

// A fantasy calendar: 4 months x 10 days; a day is 10h x 20m x 30s = 6000s.
const fantasy = {
    id: 'tidefrost', label: 'Tidefrost', unit: 'seconds', secondsPerMinute: 30, minutesPerHour: 20, hoursPerDay: 10,
    months: ['Ice', 'Thaw', 'Bloom', 'Ember'].map((name) => ({ name, days: 10 })), leapYearRule: 'none',
};

let id;
const api = (fn, ...args) => stateEngine[fn]('pp', id, ...args);
let elven;
let modern;

beforeEach(() => {
    id = ensureInstanceId();
    registerNamespaces('pp');
    createCalendar(fantasy);
    elven = O.createSetting({ name: 'Elven Coast' });
    modern = O.createSetting({ name: 'Modern City' });
    O.setChatSetting('chat-1', elven.id);
    O.setChatSetting('chat-2', modern.id);
    context.chatId = 'chat-1';
});

describe('a setting\'s calendar', () => {
    it('is kept on the setting, checked, and cleared with null', () => {
        expect(api('updateSetting', elven.id, { calendarId: 'tidefrost' }).calendarId).toBe('tidefrost');
        expect(api('getSetting', elven.id).calendarId).toBe('tidefrost');
        expect(api('updateSetting', elven.id, { calendarId: 'nope' })).toBeNull();
        expect(api('getSetting', elven.id).calendarId).toBe('tidefrost');
        expect(api('updateSetting', elven.id, { calendarId: null }).calendarId).toBeNull();
    });
});

describe('following the setting', () => {
    beforeEach(() => {
        api('updateSetting', elven.id, { calendarId: 'tidefrost' });
    });

    it('resolves to the open chat\'s setting calendar, else the default', () => {
        expect(resolveCalendarId(SETTING_CALENDAR_ID)).toBe('tidefrost');
        context.chatId = 'chat-2';
        expect(resolveCalendarId(SETTING_CALENDAR_ID)).toBe('gregorian');
        expect(resolveCalendarId('tidefrost')).toBe('tidefrost');
    });

    it('reads the same scalar through each chat\'s calendar', () => {
        const t = 6000 * 12 + 3 * 600; // day 13, 3 o'clock
        expect(api('getDateTimeParts', '@setting', t)).toMatchObject({ month: 2, day: 3, hour: 3, calendar: { id: 'tidefrost', hoursPerDay: 10 } });
        expect(api('formatDateTime', '@setting', t, { style: 'custom', pattern: '{monthName} {day}' })).toBe('Thaw 3');
        expect(api('getCalendarDefinition', '@setting').id).toBe('tidefrost');
        context.chatId = 'chat-2';
        expect(api('getDateTimeParts', '@setting', t).calendar.id).toBe('gregorian');
    });

    it('is accepted as a datetime variable\'s calendar', () => {
        api('createPreset', { namespace: 'pp', name: 'Clock' });
        const def = api('createVariable', { namespace: 'pp', presetName: 'Clock', name: 'now', type: 'datetime', calendar: '@setting', defaultValue: 0, scope: 'chat' });
        expect(def?.calendar).toBe('@setting');
    });

    it('follows the default when the setting\'s calendar is gone', () => {
        O.updateSetting(elven.id, { calendarId: null });
        expect(resolveCalendarId(SETTING_CALENDAR_ID)).toBe('gregorian');
    });
});
