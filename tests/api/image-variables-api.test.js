// Image variables through the existing variable API, and where they are kept out:
// World Info conditions and the prompted (LLM) update.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import { getSettings } from '../../src/core/settings-core.js';
import { runPromptedStateUpdate } from '../../src/core/prompted-engine.js';
import { callBackgroundLLM } from '../../src/core/background-llm.js';
import { getVar } from '../../src/core/chat-state.js';
import * as wi from '../../src/world-info/wi-conditions.js';
import { addPresetToChat } from '../../src/core/preset-manager.js';

vi.mock('../../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

let instanceId;
const create = (name, extra = {}, ext = 'pp') => stateEngine.createVariable(ext, instanceId, { namespace: ext, presetName: 'Demo', name, ...extra });
const update = (name, patch, ext = 'pp') => stateEngine.updateVariable(ext, instanceId, { namespace: ext, presetName: 'Demo', variableName: name }, patch);
const read = (name, ext = 'pp') => stateEngine.getVariable(ext, instanceId, { namespace: ext, presetName: 'Demo', variableName: name });

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
    stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
    callBackgroundLLM.mockReset();
});

describe('createVariable: the three types', () => {
    it('image: a string reference, empty by default', () => {
        expect(create('icon', { type: 'image' })).toMatchObject({ type: 'image', defaultValue: '', name: 'pp__icon' });
        expect(create('avatar', { type: 'image', defaultValue: 'https://x.test/a.png' }).defaultValue).toBe('https://x.test/a.png');
    });

    it('imageList: an array of strings, [] by default; a JSON string is stored as the array', () => {
        expect(create('gallery', { type: 'imageList' }).defaultValue).toEqual([]);
        expect(create('faces', { type: 'imageList', defaultValue: ['a.png', 'b.png'] }).defaultValue).toEqual(['a.png', 'b.png']);
        expect(create('json', { type: 'imageList', defaultValue: '["x.png"]' }).defaultValue).toEqual(['x.png']);
    });

    it('imageMap: an object of strings, {} by default; currentKeyVariable is kept', () => {
        expect(create('portraits', { type: 'imageMap' }).defaultValue).toEqual({});
        const map = create('moods', { type: 'imageMap', defaultValue: { happy: 'h.png' }, currentKeyVariable: 'pp__emotion' });
        expect(map.defaultValue).toEqual({ happy: 'h.png' });
        expect(map.currentKeyVariable).toBe('pp__emotion');
        expect(create('fromjson', { type: 'imageMap', defaultValue: '{"a":"b"}' }).defaultValue).toEqual({ a: 'b' });
    });

    it('a wrong-shaped default is refused (null) and nothing is stored', () => {
        for (const [type, bad] of [['image', 5], ['image', ['a']], ['imageList', ['a', 1]], ['imageList', 'nope'], ['imageList', { 0: 'a' }],
            ['imageMap', { a: 1 }], ['imageMap', ['a']], ['imageMap', 'nope']]) {
            expect(create(`bad_${type}_${JSON.stringify(bad).length}`, { type, defaultValue: bad }), `${type} ${JSON.stringify(bad)}`).toBe(null);
        }
        expect(stateEngine.listVariables('pp', instanceId, 'pp', 'Demo')).toEqual([]);
    });

    it('the tracker default flag, label and description behave like any variable', () => {
        const v = create('icon', { type: 'image', label: 'Icon', description: 'the icon', showInTracker: true });
        expect(v).toMatchObject({ label: 'Icon', description: 'the icon', showInTracker: true });
    });

    it('an image or an image map cannot be given increment (rotation) behavior; an image list can', () => {
        const inc = { behaviors: { increment: true, prompted: false } };
        expect(create('a', { type: 'image', ...inc })).toBe(null);
        expect(create('b', { type: 'imageMap', ...inc })).toBe(null);
        expect(create('c', { type: 'imageList', ...inc, increment: { operation: 'rotateNext', triggers: ['ai'] } })).toMatchObject({ type: 'imageList' });
    });

    it('currentKeyVariable must be a string', () => {
        expect(create('m', { type: 'imageMap', currentKeyVariable: 5 })).toBe(null);
    });

    it('nothing is fetched: creating a variable makes no network request', () => {
        const spy = vi.fn();
        vi.stubGlobal('fetch', spy);
        try {
            create('icon', { type: 'image', defaultValue: 'https://x.test/a.png' });
            create('map', { type: 'imageMap', defaultValue: { a: 'https://x.test/b.png' } });
        } finally {
            vi.unstubAllGlobals();
        }
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('reading, updating and serializing', () => {
    it('getVariable and listVariables return them; presets serialize cleanly to JSON', () => {
        create('icon', { type: 'image', defaultValue: 'a.png' });
        create('faces', { type: 'imageList', defaultValue: ['a.png', 'b.png'] });
        create('moods', { type: 'imageMap', defaultValue: { happy: 'h.png' }, currentKeyVariable: 'pp__emotion' });

        expect(read('faces').defaultValue).toEqual(['a.png', 'b.png']);
        expect(stateEngine.listVariables('pp', instanceId, 'pp', 'Demo').map((v) => v.type).sort()).toEqual(['image', 'imageList', 'imageMap']);

        const snapshot = settings.snapshot();
        const stored = Object.values(Object.values(snapshot.presets).find((p) => p.name === 'Demo').variables);
        expect(stored.map((v) => v.type).sort()).toEqual(['image', 'imageList', 'imageMap']);
        expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
    });

    it('updateVariable can change a default, the key variable and the label; bad values are refused', () => {
        create('faces', { type: 'imageList', defaultValue: ['a.png'] });
        expect(update('faces', { defaultValue: ['x.png', 'y.png'] }).defaultValue).toEqual(['x.png', 'y.png']);
        expect(update('faces', { defaultValue: ['x.png', 3] })).toBe(null);
        expect(read('faces').defaultValue).toEqual(['x.png', 'y.png']);

        create('moods', { type: 'imageMap', defaultValue: { a: 'a.png' } });
        expect(update('moods', { currentKeyVariable: 'pp__emotion' }).currentKeyVariable).toBe('pp__emotion');
        expect(update('moods', { defaultValue: { a: 1 } })).toBe(null);
        expect(update('moods', { behaviors: { increment: true, prompted: false } })).toBe(null);
    });

    it('a variable that becomes an image type starts empty; one that stops being an image type is an ordinary variable again', () => {
        create('thing', { type: 'number', defaultValue: 7 });
        expect(update('thing', { type: 'imageList' })).toMatchObject({ type: 'imageList', defaultValue: [] });
        expect(update('thing', { type: 'imageList', defaultValue: ['a.png'] }).defaultValue).toEqual(['a.png']);
        expect(update('thing', { type: 'string', defaultValue: 'plain' })).toMatchObject({ type: 'string', defaultValue: 'plain' });
    });

    it('other extensions cannot touch them (same namespace rules as every variable)', () => {
        registerNamespaces('zz');
        create('icon', { type: 'image' });
        expect(() => stateEngine.updateVariable('zz', instanceId, { namespace: 'pp', presetName: 'Demo', variableName: 'icon' }, { label: 'x' })).toThrow();
    });
});

describe('computed variables', () => {
    it('a calculated variable can look an image up: portraits[emotion]', () => {
        create('emotion', { type: 'enum', enumValues: ['happy', 'sad'], defaultValue: 'happy' });
        create('portraits', { type: 'imageMap', defaultValue: { happy: 'h.png', sad: 's.png' } });
        // variables are stored under their namespace-qualified names, and so are referenced
        const calculated = create('current', { type: 'calculated', expression: 'pp__portraits[pp__emotion]' });
        expect(calculated).not.toBe(null);
        expect([...calculated.dependencies].sort()).toEqual(['pp__emotion', 'pp__portraits']);
    });

    it('an image list is usable in expressions too', () => {
        create('gallery', { type: 'imageList', defaultValue: ['a.png'] });
        expect(create('first', { type: 'calculated', expression: 'pp__gallery[0]' })).not.toBe(null);
        expect(create('count', { type: 'calculated', expression: 'pp__gallery.length' })).not.toBe(null);
    });
});

describe('restrictions: not for World Info, not for the prompted LLM', () => {
    const setup = () => {
        const presetId = Object.keys(getSettings().presets).find((id) => getSettings().presets[id].name === 'Demo');
        addPresetToChat('chat-1', presetId);
        return presetId;
    };

    it('image variables are not offered as World Info condition variables', () => {
        create('icon', { type: 'image' });
        create('faces', { type: 'imageList' });
        create('moods', { type: 'imageMap' });
        create('mood', { type: 'string', defaultValue: 'calm' });
        setup();
        const names = wi.getAvailableVariablesForConditions().map((v) => v.variableName);
        expect(names).toEqual(['pp__mood']);
    });

    it('a stored World Info condition on one is treated as met, with a warning - it cannot hide an entry', () => {
        create('icon', { type: 'image', defaultValue: 'a.png' });
        create('faces', { type: 'imageList', defaultValue: ['a.png'] });
        create('moods', { type: 'imageMap', defaultValue: { a: 'x' } });
        setup();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const [name, op, value] of [['pp__icon', 'equals', 'zzz'], ['pp__faces', 'contains', 'zzz'], ['pp__moods', 'regex', 'zzz'], ['pp__icon', 'greater_than', '1']]) {
            expect(wi.evaluateCondition(name, op, value), `${name} ${op}`).toBe(true);
        }
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot be used in WI conditions'));
        warn.mockRestore();

        getSettings().wiConditions['Book.1'] = [{ variable: 'pp__icon', operator: 'equals', value: 'zzz' }];
        expect(wi.shouldDisplayWIEntry('Book.1')).toBe(true);
    });

    it('the prompted update never asks the LLM for an image variable, even one marked prompted', async () => {
        create('mood', { type: 'string', defaultValue: 'calm', behaviors: { prompted: true, increment: false }, prompted: { instructions: 'infer mood' } });
        for (const [name, type] of [['icon', 'image'], ['faces', 'imageList'], ['moods', 'imageMap']]) {
            // created directly in settings: the API never refuses prompted, the engine just ignores it
            create(name, { type, behaviors: { prompted: true, increment: false }, prompted: { instructions: `infer ${name}` } });
        }
        setup();
        callBackgroundLLM.mockResolvedValue('{"pp__mood":"tense","pp__icon":"evil.png","pp__faces":["evil.png"],"pp__moods":{"a":"evil.png"}}');
        context.chat = [{ is_user: true, mes: 'hello' }, { is_user: false, name: 'Bot', mes: 'hi' }];

        await runPromptedStateUpdate('ai');

        const prompt = callBackgroundLLM.mock.calls[0][2][0].content;
        expect(prompt).toContain('pp__mood');
        for (const name of ['pp__icon', 'pp__faces', 'pp__moods']) expect(prompt).not.toContain(name);
        await vi.waitFor(() => expect(getVar('chat-1', 'pp__mood')?.value).toBe('tense'));
        for (const name of ['pp__icon', 'pp__faces', 'pp__moods']) expect(getVar('chat-1', name)?.value).not.toEqual(expect.stringContaining('evil'));
    });

    it('with only image variables there is nothing to ask, so the LLM is not called at all', async () => {
        create('icon', { type: 'image', behaviors: { prompted: true, increment: false }, prompted: { instructions: 'infer' } });
        setup();
        context.chat = [{ is_user: true, mes: 'hello' }, { is_user: false, name: 'Bot', mes: 'hi' }];
        await runPromptedStateUpdate('ai');
        expect(callBackgroundLLM).not.toHaveBeenCalled();
    });
});
