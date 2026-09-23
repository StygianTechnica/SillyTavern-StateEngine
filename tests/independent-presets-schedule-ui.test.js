// @vitest-environment jsdom
//
// Independent Preset scheduling (requirements spec 1.32), manager-modal UI:
// the "Scheduling" section of the independent-preset editor - Enable
// Schedule, Mode, Value, Repeat, Next Run (read-only), and the optional
// Calendar dropdown. Mirrors tests/independent-presets-ui.test.js's own
// setup - the api() object's updateIndependentPresetSchedule is the same
// thin presetId->(namespace,name) translation manager-api.js does, routing
// through the REAL src/api/independent-presets.js, so this file verifies
// the UI calls the right function with the right arguments and displays
// what comes back - not the CRUD/validation logic itself (already covered
// by tests/api/independent-presets-schedule.test.js).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jQuery from 'jquery';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { addPresetToChat, getPresetsForChat, removePresetFromChat } from '../src/core/preset-manager.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { ensureInstanceId } from '../src/api/identity.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { setManagerApi, buildManagerModal } from '../src/ui/manager-modal/manager-modal.js';
import { buildIndependentPresetRow } from '../src/ui/manager-modal/ui-templates.js';
import { callBackgroundLLM } from '../src/core/background-llm.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/manager-modal-ui.js', () => ({ renderVarTable: vi.fn() }));

const $ = jQuery;
const BUILTIN = 'se';
const ts = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

function findPresetById(presetId) {
    return getSettings().presets[presetId] || null;
}
const asBuiltin = (fn) => fn(BUILTIN, ensureInstanceId());

const api = () => ({
    getSettings,
    persistSettings: vi.fn(),
    getCurrentChatId: () => context.chatId,
    getPresetsForChat, addPresetToChat, removePresetFromChat,
    createPreset: vi.fn(), renamePreset: vi.fn(), deletePreset: vi.fn(),
    setStatus: vi.fn(), renderVarTable: vi.fn(), renderTrackerPanel: vi.fn(),
    restoreDefaultPresets: vi.fn(), toggleDebugMode: vi.fn(), getDebugInfo: () => ({}),
    isReservedVariable: () => false, blankDefinition,
    isVariableNameTaken: () => false, generateUniqueVariableName: (n) => n,
    listCalendars: () => getSettings().calendars,
    connectionProfiles: () => [],

    createIndependentPreset: (name) => asBuiltin((e, i) => stateEngine.createIndependentPreset(e, i, { namespace: BUILTIN, name })),
    updateIndependentPreset: (presetId, patch) => {
        const preset = findPresetById(presetId);
        if (!preset) return null;
        return asBuiltin((e, i) => stateEngine.updateIndependentPreset(e, i, preset.namespace || BUILTIN, preset.name, patch));
    },
    deleteIndependentPreset: () => false,
    toggleIndependentPreset: () => null,
    runIndependentPreset: () => Promise.resolve(false),
    getIndependentPresetStatus: (presetId) => {
        const preset = findPresetById(presetId);
        return preset ? stateEngine.getIndependentPresetStatus(preset.namespace || BUILTIN, preset.name) : null;
    },
    updateIndependentPresetSchedule: (presetId, schedule) => {
        const preset = findPresetById(presetId);
        if (!preset) return null;
        return asBuiltin((e, i) => stateEngine.updateIndependentPresetSchedule(e, i, preset.namespace || BUILTIN, preset.name, schedule));
    },
});

const pane = () => $('.se-manager-presets-subtab-pane[data-presets-subtab="independent"]');
const row = (name) => pane().find('.se-manager-independent-preset-item').filter((_, el) => $(el).find('.se-manager-preset-name').text().includes(name)).first();
const openSubtab = () => { $('.se-manager-presets-subtab-btn[data-presets-subtab="independent"]').trigger('click'); };
const openRow = (name) => { row(name).find('.se-manager-preset-accordion-header').trigger('click'); };
const create = (name) => asBuiltin((e, i) => stateEngine.createIndependentPreset(e, i, { namespace: BUILTIN, name }));

beforeEach(() => {
    settings.reset();
    document.body.innerHTML = '';
    globalThis.$ = globalThis.jQuery = jQuery;
    jQuery.fx.off = true;

    context.chatId = 'chat-1';
    context.chat = [];
    registerNamespaces(BUILTIN);
    setManagerApi(api());
    buildManagerModal();
    callBackgroundLLM.mockReset();

    vi.useFakeTimers();
    vi.setSystemTime(ts(2026, 9, 22, 12, 0, 0));
});

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

describe('the Scheduling section', () => {
    it('starts collapsed/disabled, with the settings sub-block hidden', () => {
        create('Indy');
        openSubtab();
        openRow('Indy');
        expect(row('Indy').find('[data-field="enabled"]').is(':checked')).toBe(false);
        expect(row('Indy').find('.se-indy-schedule-settings').css('display')).toBe('none');
    });

    it('checking Enable Schedule reveals mode/value/repeat/next-run (via the full re-render this editor already uses)', () => {
        create('Indy');
        openSubtab();
        openRow('Indy');
        row('Indy').find('[data-field="mode"]').val('interval').trigger('change');
        openRow('Indy'); // re-render collapses the accordion - reopen (see note below)
        row('Indy').find('[data-field="value"]').val('10 minutes').trigger('change');
        openRow('Indy');
        row('Indy').find('[data-field="enabled"]').prop('checked', true).trigger('change');
        openRow('Indy');

        expect(row('Indy').find('.se-indy-schedule-settings').css('display')).toBe('block');
        expect(row('Indy').find('.se-indy-schedule-nextrun').text()).toContain('2026');
    });

    it('an invalid mode/value combination refuses to enable, reverting the checkbox on re-render', () => {
        create('Indy');
        openSubtab();
        openRow('Indy');
        row('Indy').find('[data-field="enabled"]').prop('checked', true).trigger('change');
        openRow('Indy');

        expect(row('Indy').find('[data-field="enabled"]').is(':checked')).toBe(false);
    });

    it('saves mode/value/repeat/calendar into independentConfig.schedule', () => {
        const created = create('Indy');
        openSubtab();
        openRow('Indy');
        row('Indy').find('[data-field="mode"]').val('atTime').trigger('change');
        openRow('Indy');
        row('Indy').find('[data-field="value"]').val('2026-10-01 06:00:00').trigger('change');
        openRow('Indy');
        row('Indy').find('[data-field="repeat"]').prop('checked', true).trigger('change');
        openRow('Indy');
        row('Indy').find('[data-field="enabled"]').prop('checked', true).trigger('change');

        const stored = getSettings().presets[created.id].independentConfig.schedule;
        expect(stored).toMatchObject({ mode: 'atTime', value: '2026-10-01 06:00:00', repeat: true, enabled: true, nextRun: ts(2026, 10, 1, 6, 0, 0) });
    });

    // getSettings() auto-repairs any missing built-in calendar on every read
    // (settings-core.js) - faerun_inspired/three_moons/solar_cycle (spec
    // 1.22.7) always come back, so "zero fantasy calendars" cannot actually
    // be produced through the live settings store. These two exercise
    // buildIndependentPresetRow's own conditional directly instead, the same
    // way tests/calculated-datetime-ui.test.js's "the editor template" block
    // tests a template function in isolation from the full render pipeline.
    describe('the Calendar dropdown (template-level, isolated from the always-present built-ins)', () => {
        const statusFor = () => ({ enabled: true, contextMode: 'chat-history', lastRunAt: null, lastOutcome: 'never-run', lastError: null, changedVariables: [] });
        const presetFor = () => ({ name: 'Indy', description: '', independentConfig: {} });

        it('is absent when only the built-in Gregorian calendar exists', () => {
            const html = buildIndependentPresetRow('p1', presetFor(), 'chat-1', statusFor(), [], { gregorian: getSettings().calendars.gregorian });
            const el = document.createElement('div');
            el.innerHTML = html;
            expect(el.querySelector('[data-field="calendar"]')).toBe(null);
        });

        it('appears once a fantasy calendar is present, offering it alongside Gregorian', () => {
            const calendars = {
                gregorian: getSettings().calendars.gregorian,
                fantasy: { id: 'fantasy', label: 'Fantasy Realm', unit: 'seconds', secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24, leapYearRule: 'none', months: [{ name: 'A', days: 30 }] },
            };
            const html = buildIndependentPresetRow('p1', presetFor(), 'chat-1', statusFor(), [], calendars);
            const el = document.createElement('div');
            el.innerHTML = html;
            const options = [...el.querySelectorAll('[data-field="calendar"] option')].map((o) => o.value);
            expect(options).toEqual(['gregorian', 'fantasy']);
        });
    });

    it('Next Run shows "Due now" once the fake clock passes it, without any further edit', () => {
        const created = create('Indy');
        asBuiltin((e, i) => stateEngine.updateIndependentPresetSchedule(e, i, BUILTIN, 'Indy', { mode: 'interval', value: '10 minutes', enabled: true }));
        openSubtab();
        openRow('Indy');
        expect(row('Indy').find('.se-indy-schedule-nextrun').text()).not.toContain('Due now');

        vi.setSystemTime(ts(2026, 9, 22, 12, 10, 1));
        openSubtab(); // re-render from the same stored state, now past its nextRun
        openRow('Indy');
        expect(row('Indy').find('.se-indy-schedule-nextrun').text()).toContain('Due now');
        expect(created).toBeTruthy();
    });

    it('"Disabled" is shown as Next Run text whenever the schedule is off, regardless of a stale stored nextRun', () => {
        create('Indy');
        asBuiltin((e, i) => stateEngine.updateIndependentPresetSchedule(e, i, BUILTIN, 'Indy', { mode: 'interval', value: '10 minutes', enabled: true }));
        asBuiltin((e, i) => stateEngine.updateIndependentPresetSchedule(e, i, BUILTIN, 'Indy', { enabled: false }));
        openSubtab();
        openRow('Indy');
        // enabled is false, so the settings sub-block (and Next Run inside it) is
        // hidden entirely - confirmed via the checkbox and the collapsed block.
        expect(row('Indy').find('[data-field="enabled"]').is(':checked')).toBe(false);
        expect(row('Indy').find('.se-indy-schedule-settings').css('display')).toBe('none');
    });
});
