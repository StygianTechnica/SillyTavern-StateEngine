// @vitest-environment jsdom
//
// A deterministic increment (an image list rotating, a counter, a variable that
// feeds an image map) must show up in the tracker as soon as it happens - not only
// when something else happens to redraw it. This runs the REAL message handlers,
// the REAL increment and the REAL tracker; nothing here calls a refresh by hand.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jQuery from 'jquery';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { addPresetToChat } from '../src/core/preset-manager.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { runDeterministicIncrements } from '../src/core/deterministic-engine.js';
import { setVar, getVar } from '../src/core/chat-state.js';
import { registerEvents } from '../src/events/event-engine.js';

// The harness replaces these two with in-memory mocks for every other suite; this one
// needs the real thing.
vi.mock('../src/core/chat-state.js', async () => vi.importActual('../src/core/chat-state.js'));
vi.mock('../src/events/event-engine.js', async () => vi.importActual('../src/events/event-engine.js'));
vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/manager-modal-ui.js', () => ({ renderVarTable: vi.fn() }));
vi.mock('../src/ui/manager-modal/manager-modal.js', () => ({ refreshVariableManagementTabIfOpen: vi.fn(), buildManagerModal: vi.fn(), hideManagerModal: vi.fn() }));
vi.mock('../src/ui/wand-ui.js', () => ({ updateManagerButtonState: vi.fn(), refreshManagerButtonLater: vi.fn(), getCurrentChatId: () => 'chat-1' }));
vi.mock('../src/ui/connection-profile-ui.js', () => ({ populateConnectionProfileDropdown: vi.fn() }));

const $ = jQuery;
const EVENTS = { CHAT_CHANGED: 'chat_changed', CHAT_CREATED: 'chat_created', USER_MESSAGE_RENDERED: 'user_rendered', CHARACTER_MESSAGE_RENDERED: 'ai_rendered' };
const imgs = () => [...document.querySelectorAll('#se_tracker_body img')].map((i) => i.getAttribute('src'));
const rowFor = (label) => [...document.querySelectorAll('#se_tracker_body .se-tracker-row')].find((r) => r.querySelector('.se-tracker-label').textContent.includes(label));
const settle = () => new Promise((r) => setTimeout(r, 20));
const messageArrives = async (kind) => { await context.eventSource.emit(EVENTS[kind]); await settle(); };

let presetId;
const add = (name, type, defaultValue, extra = {}) => {
    const def = { ...blankDefinition(), id: name, name: `se__${name}`, label: name, type, defaultValue, showInTracker: true, ...extra };
    getSettings().presets[presetId].variables[name] = def;
    return def;
};
const rotating = (operation, triggers = 'ai') => ({ behaviors: { increment: true, prompted: false }, increment: { ...blankDefinition().increment, operation, triggers, delta: 1 } });

beforeEach(() => {
    settings.reset();
    globalThis.$ = globalThis.jQuery = jQuery;
    presetId = 'p1';
    getSettings().presets[presetId] = { id: presetId, name: 'Alpha', namespace: 'se', description: '', triggers: ['ai'], showInTracker: true, variables: {} };
    addPresetToChat('chat-1', presetId);
    document.body.innerHTML = '<div id="se_tracker_panel"><div id="se_tracker_body"></div></div>';
    context.eventTypes = EVENTS;
    context.chat = [{ is_user: true, mes: 'hi' }, { is_user: false, name: 'Bot', mes: 'hello' }];
    registerEvents();
});

afterEach(() => { document.body.innerHTML = ''; });

const A = 'user/images/state-engine-images/a.png';
const B = 'user/images/state-engine-images/b.png';
const C = 'user/images/state-engine-images/c.png';

describe('an image list rotating on a message', () => {
    it('the tracker shows the next image straight away, message after message', async () => {
        const gallery = add('gallery', 'imageList', [], rotating('rotateNext'));
        setVar('chat-1', gallery.name, [A, B, C], gallery);
        // first draw (what opening the tracker does)
        const { renderTrackerPanel } = await import('../src/ui/tracker-panel-ui.js');
        renderTrackerPanel();
        expect(imgs()).toEqual([A]);

        await messageArrives('CHARACTER_MESSAGE_RENDERED');
        expect(getVar('chat-1', gallery.name).value).toEqual([B, C, A]);
        expect(imgs()).toEqual([B]);                       // used to stay on A until the manager was opened

        await messageArrives('CHARACTER_MESSAGE_RENDERED');
        expect(imgs()).toEqual([C]);
    });

    it('rotating backwards works the same', async () => {
        const gallery = add('gallery', 'imageList', [], rotating('rotate'));
        setVar('chat-1', gallery.name, [A, B, C], gallery);
        const { renderTrackerPanel } = await import('../src/ui/tracker-panel-ui.js');
        renderTrackerPanel();
        await messageArrives('CHARACTER_MESSAGE_RENDERED');
        expect(imgs()).toEqual([C]);
    });

    it('a rotation triggered by the USER\'s message refreshes too', async () => {
        const gallery = add('gallery', 'imageList', [], rotating('rotateNext', 'user'));
        setVar('chat-1', gallery.name, [A, B], gallery);
        const { renderTrackerPanel } = await import('../src/ui/tracker-panel-ui.js');
        renderTrackerPanel();
        await messageArrives('USER_MESSAGE_RENDERED');
        expect(imgs()).toEqual([B]);
    });

    it('only the trigger that was asked for rotates it', async () => {
        const gallery = add('gallery', 'imageList', [], rotating('rotateNext', 'ai'));
        setVar('chat-1', gallery.name, [A, B], gallery);
        const { renderTrackerPanel } = await import('../src/ui/tracker-panel-ui.js');
        renderTrackerPanel();
        await messageArrives('USER_MESSAGE_RENDERED');
        expect(imgs()).toEqual([A]);
    });
});

describe('an image map follows a variable that changes on a message', () => {
    it('the picture changes when the key variable steps (an enum cycling)', async () => {
        const stance = add('stance', 'enum', 'happy', { enumValues: ['happy', 'sad', 'angry'], ...rotating(null, 'ai') });
        const portraits = add('portraits', 'imageMap', {}, { currentKeyVariable: 'se__stance' });
        setVar('chat-1', stance.name, 'happy', stance);
        setVar('chat-1', portraits.name, { happy: A, sad: B }, portraits);
        const { renderTrackerPanel } = await import('../src/ui/tracker-panel-ui.js');
        renderTrackerPanel();
        expect(imgs()).toEqual([A]);

        await messageArrives('CHARACTER_MESSAGE_RENDERED');   // enum increments: happy -> sad
        expect(getVar('chat-1', stance.name).value).toBe('sad');
        expect(imgs()).toEqual([B]);

        await messageArrives('CHARACTER_MESSAGE_RENDERED');   // sad -> angry: no picture for that key
        expect(imgs()).toEqual([]);
        expect(rowFor('portraits').querySelector('.se-image-thumb-empty')).not.toBe(null);
    });
});

describe('any deterministic increment refreshes the tracker (not only images)', () => {
    it('a counter', async () => {
        const count = add('count', 'number', 0, { behaviors: { increment: true, prompted: false }, increment: { ...blankDefinition().increment, triggers: 'ai', delta: 2 } });
        setVar('chat-1', count.name, 0, count);
        const { renderTrackerPanel } = await import('../src/ui/tracker-panel-ui.js');
        renderTrackerPanel();
        expect(rowFor('count').querySelector('.se-tracker-value').textContent).toBe('0');
        await messageArrives('CHARACTER_MESSAGE_RENDERED');
        expect(rowFor('count').querySelector('.se-tracker-value').textContent).toBe('2');
    });

    it('nothing to increment: the tracker is NOT redrawn (an edit in progress is not wiped on every message)', async () => {
        add('note', 'string', 'hi');
        const { renderTrackerPanel } = await import('../src/ui/tracker-panel-ui.js');
        renderTrackerPanel();
        const marker = document.createElement('input');
        marker.id = 'edit-in-progress';
        document.getElementById('se_tracker_body').appendChild(marker);
        await messageArrives('CHARACTER_MESSAGE_RENDERED');
        await messageArrives('USER_MESSAGE_RENDERED');
        expect(document.getElementById('edit-in-progress')).toBe(marker);
    });

    it('with State Engine switched off nothing changes and nothing is redrawn', async () => {
        const gallery = add('gallery', 'imageList', [], rotating('rotateNext'));
        setVar('chat-1', gallery.name, [A, B], gallery);
        const { renderTrackerPanel } = await import('../src/ui/tracker-panel-ui.js');
        renderTrackerPanel();
        getSettings().enabled = false;
        await messageArrives('CHARACTER_MESSAGE_RENDERED');
        expect(getVar('chat-1', gallery.name).value).toEqual([A, B]);
        expect(imgs()).toEqual([A]);
    });
});

describe('runDeterministicIncrements reports what it did', () => {
    it('the number of variables it incremented', () => {
        const a = add('a', 'imageList', [], rotating('rotateNext'));
        const b = add('b', 'imageList', [], rotating('rotateNext', 'user'));
        setVar('chat-1', a.name, [A, B], a);
        setVar('chat-1', b.name, [A, B], b);
        expect(runDeterministicIncrements('chat-1', 'ai')).toBe(1);
        expect(runDeterministicIncrements('chat-1', 'user')).toBe(1);
        expect(runDeterministicIncrements('chat-1', 'both-nothing')).toBe(0);
    });

    it('0 when disabled, or when there is no chat', () => {
        const a = add('a', 'imageList', [], rotating('rotateNext'));
        setVar('chat-1', a.name, [A, B], a);
        getSettings().enabled = false;
        expect(runDeterministicIncrements('chat-1', 'ai')).toBe(0);
        getSettings().enabled = true;
        expect(runDeterministicIncrements(undefined, 'ai')).toBe(0);
    });
});
