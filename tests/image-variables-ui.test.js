// @vitest-environment jsdom
//
// Image variables in the UI: safe previews, the manager modal editors (driven
// through the real modal, not just the templates) and the tracker.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jQuery from 'jquery';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { addPresetToChat, getPresetsForChat, removePresetFromChat } from '../src/core/preset-manager.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { setVar } from '../src/core/chat-state.js';
import { setManagerApi, buildManagerModal } from '../src/ui/manager-modal/manager-modal.js';
import { buildInlineVariableEditor } from '../src/ui/manager-modal/ui-templates.js';
import { canIncrement, normalizeCollectedValues, describeVariable } from '../src/ui/manager-modal/variable-ui-schema.js';
import { renderTrackerPanel } from '../src/ui/tracker-panel-ui.js';
import {
    thumbHtml, thumbInnerHtml, updateThumb, initImagePreviews, showEnlargedImage, hideEnlargedImage, removeHoverBoxForTests,
} from '../src/ui/image-preview.js';

vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/manager-modal-ui.js', () => ({ renderVarTable: vi.fn() }));

const $ = jQuery;
const ID = { name: 'se__x' };

beforeEach(() => {
    settings.reset();
    document.body.innerHTML = '';
    globalThis.$ = globalThis.jQuery = jQuery;
    jQuery.fx.off = true;
    globalThis.alert = vi.fn();
    window.alert = globalThis.alert;
    initImagePreviews();
});

afterEach(() => {
    removeHoverBoxForTests();
    document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
describe('safe previews', () => {
    it('an http(s) URL, a data:image URL and a path become an <img>, lazily, with no referrer and no script', () => {
        for (const ref of ['https://x.test/a.png', 'data:image/png;base64,AAAA', '/user/a.png', 'portraits/a.webp']) {
            const el = document.createElement('div');
            el.innerHTML = thumbHtml(ref, { enlarge: true });
            const img = el.querySelector('img.se-image-thumb-img');
            expect(img, ref).not.toBe(null);
            expect(img.getAttribute('src')).toBe(ref);
            expect(img.getAttribute('loading')).toBe('lazy');
            expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
            expect(img.getAttribute('onerror')).toBe(null);
            expect(el.querySelector('script')).toBe(null);
        }
    });

    it('anything else is a neutral placeholder that shows the reference as text - never an <img>', () => {
        for (const ref of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'asset:portrait-12', 'portrait_12', '', '   ', null, undefined, 42]) {
            const el = document.createElement('div');
            el.innerHTML = thumbHtml(ref);
            expect(el.querySelector('img'), String(ref)).toBe(null);
            expect(el.querySelector('.se-image-thumb-empty'), String(ref)).not.toBe(null);
        }
        expect(thumbInnerHtml('asset:portrait-12')).toContain('asset:portrait-12');
        expect(thumbInnerHtml('', { label: 'No image for the current key' })).toContain('No image for the current key');
    });

    it('hostile references are escaped in every attribute (no markup, no event handlers)', () => {
        const hostile = 'https://x.test/a.png" onerror="alert(1)" x="';
        const el = document.createElement('div');
        el.innerHTML = thumbHtml(hostile, { enlarge: true });
        const img = el.querySelector('img');
        expect(img.getAttribute('onerror')).toBe(null);
        expect(img.getAttribute('src')).toBe(hostile);
        expect(el.querySelector('.se-image-thumb').getAttribute('data-full')).toBe(hostile);

        const html = thumbHtml('"><img src=x onerror=alert(1)>');
        const holder = document.createElement('div');
        holder.innerHTML = html;
        expect(holder.querySelectorAll('img').length).toBe(0);
        expect(holder.querySelector('.se-image-thumb-empty').title).toContain('"><img src=x onerror=alert(1)>');
    });

    it('updateThumb redraws a thumbnail live, and turns enlarging on and off', () => {
        const el = document.createElement('span');
        updateThumb(el, 'https://x.test/1.png', { enlarge: true });
        expect(el.querySelector('img').getAttribute('src')).toBe('https://x.test/1.png');
        expect(el.getAttribute('data-enlarge')).toBe('1');
        updateThumb(el, 'javascript:alert(1)', { enlarge: true });
        expect(el.querySelector('img')).toBe(null);
        expect(el.hasAttribute('data-enlarge')).toBe(false);
    });

    it('hover-to-enlarge: hovering a thumbnail shows a bigger copy, leaving or Escape hides it; nothing is loaded in advance', () => {
        document.body.innerHTML = thumbHtml('https://x.test/a.png', { enlarge: true });
        const thumb = document.querySelector('.se-image-thumb');
        expect(document.getElementById('se_image_hover_preview')).toBe(null); // no enlarged <img> until hover

        thumb.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        const box = document.getElementById('se_image_hover_preview');
        expect(box.hidden).toBe(false);
        expect(box.querySelector('img').getAttribute('src')).toBe('https://x.test/a.png');

        thumb.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        expect(box.hidden).toBe(true);

        thumb.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(box.hidden).toBe(true);
    });

    it('a thumbnail without data-enlarge (or with an unsafe source) never enlarges', () => {
        document.body.innerHTML = `${thumbHtml('https://x.test/a.png')}<span class="se-image-thumb" data-enlarge="1" data-full="javascript:alert(1)"></span>`;
        for (const thumb of document.querySelectorAll('.se-image-thumb')) thumb.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        expect(document.getElementById('se_image_hover_preview')?.hidden ?? true).toBe(true);
        expect(showEnlargedImage(document.querySelectorAll('.se-image-thumb')[1])).toBe(false);
        hideEnlargedImage();
    });

    it('a broken image becomes the placeholder', () => {
        document.body.innerHTML = thumbHtml('https://x.test/missing.png', { enlarge: true });
        const img = document.querySelector('img');
        img.dispatchEvent(new Event('error'));
        expect(document.querySelector('img')).toBe(null);
        expect(document.querySelector('.se-image-thumb-empty')).not.toBe(null);
        expect(document.querySelector('.se-image-thumb').hasAttribute('data-enlarge')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
describe('the editor templates', () => {
    const editor = (over = {}) => {
        const d = { ...blankDefinition(), name: 'se__thing', ...over };
        return buildInlineVariableEditor(d, canIncrement(d.type), [
            { name: 'se__mood', label: 'Mood', type: 'string' }, { name: 'se__stance', type: 'enum' },
            { name: 'se__party', type: 'array' }, { name: 'se__score', type: 'calculated' }, { name: 'se__other_map', type: 'imageMap' },
        ]);
    };
    const dom = (html) => { const el = document.createElement('div'); el.innerHTML = html; return el; };

    it('the type dropdown offers Image, Image list and Image map', () => {
        const options = [...dom(editor()).querySelectorAll('[data-field="type"] option')].map((o) => [o.value, o.textContent]);
        expect(options).toEqual(expect.arrayContaining([['image', 'Image'], ['imageList', 'Image list'], ['imageMap', 'Image map']]));
    });

    it('image: one text input and a thumbnail preview', () => {
        const el = dom(editor({ type: 'image', defaultValue: 'https://x.test/a.png' }));
        expect(el.querySelector('input[data-field="defaultValue"]').value).toBe('https://x.test/a.png');
        expect(el.querySelector('.se-image-editor-preview img').getAttribute('src')).toBe('https://x.test/a.png');
    });

    it('imageList: an array editor with a preview, a grip and up/down/remove per row', () => {
        const el = dom(editor({ type: 'imageList', defaultValue: '["https://x.test/a.png","asset:b"]' }));
        const rows = el.querySelectorAll('.se-manager-image-list .se-manager-array-row');
        expect(rows).toHaveLength(2);
        expect(rows[0].querySelector('img').getAttribute('src')).toBe('https://x.test/a.png');
        expect(rows[1].querySelector('img')).toBe(null);                     // "asset:b" is not loadable: placeholder
        expect(rows[0].querySelector('.se-manager-array-grip')).not.toBe(null);
        for (const cls of ['.se-manager-image-up', '.se-manager-image-down', '.se-manager-array-delete', '.se-manager-array-item']) expect(rows[0].querySelector(cls), cls).not.toBe(null);
        expect(el.querySelector('.se-manager-array-add')).not.toBe(null);
        expect(el.querySelector('[data-field="itemType"]')).toBe(null);      // no item-type choice for images
    });

    it('imageMap: a key/reference table with a preview per row, and the current-key variable choice', () => {
        const el = dom(editor({ type: 'imageMap', defaultValue: { happy: 'https://x.test/h.png', sad: 'asset:s' }, currentKeyVariable: 'se__mood' }));
        const rows = el.querySelectorAll('.se-manager-imagemap-row');
        expect(rows).toHaveLength(2);
        expect(rows[0].querySelector('.se-manager-imagemap-key').value).toBe('happy');
        expect(rows[0].querySelector('.se-manager-imagemap-value').value).toBe('https://x.test/h.png');
        expect(rows[0].querySelector('img')).not.toBe(null);
        expect(rows[1].querySelector('img')).toBe(null);
        const select = el.querySelector('select[data-field="currentKeyVariable"]');
        const values = [...select.options].map((o) => o.value);
        // any variable that resolves to a string may supply the key: string, enum, array, calculated...
        expect(values).toEqual(['', 'se__mood', 'se__stance', 'se__party', 'se__score']);
        expect(select.value).toBe('se__mood');
        expect(values).not.toContain('se__other_map'); // ...but not another image map
    });

    it('a current-key variable that is no longer in the preset is kept and flagged, not silently dropped', () => {
        const el = dom(editor({ type: 'imageMap', currentKeyVariable: 'se__gone' }));
        const select = el.querySelector('select[data-field="currentKeyVariable"]');
        expect(select.value).toBe('se__gone');
        expect(select.selectedOptions[0].textContent).toContain('not in this preset');
    });

    it('hostile references and keys are escaped in the editor', () => {
        const hostile = '"><script>alert(1)</script>';
        const el = dom(editor({ type: 'imageMap', defaultValue: { [hostile]: hostile }, currentKeyVariable: hostile }));
        expect(el.querySelector('script')).toBe(null);
        expect(el.querySelector('.se-manager-imagemap-key').value).toBe(hostile);
        const list = dom(editor({ type: 'imageList', defaultValue: [hostile] }));
        expect(list.querySelector('script')).toBe(null);
        expect(list.querySelector('.se-manager-array-item').value).toBe(hostile);
    });

    it('image types have no prompted behavior; an image list can rotate (next / previous); an image and a map cannot', () => {
        for (const type of ['image', 'imageList', 'imageMap']) {
            const el = dom(editor({ type }));
            expect(el.querySelector('#se-manager-prompted-toggle'), type).toBe(null);
        }
        expect(canIncrement('imageList')).toBe(true);
        expect(canIncrement('image')).toBe(false);
        expect(canIncrement('imageMap')).toBe(false);

        const list = dom(editor({ type: 'imageList', behaviors: { increment: true, prompted: false }, increment: { ...blankDefinition().increment, operation: 'rotateNext' } }));
        const ops = [...list.querySelectorAll('select[data-field="increment.operation"] option')].map((o) => o.value);
        expect(ops).toEqual(['', 'rotateNext', 'rotate']);
        expect(list.querySelector('select[data-field="increment.operation"]').value).toBe('rotateNext');
        expect(dom(editor({ type: 'imageMap' })).querySelector('#se-manager-increment-toggle')).toBe(null);
        expect(dom(editor({ type: 'image' })).querySelector('#se-manager-increment-toggle')).toBe(null);
    });

    it('there is no World Info condition editor in it', () => {
        for (const type of ['image', 'imageList', 'imageMap']) expect(editor({ type })).not.toMatch(/world info|wiCondition|wi-cond/i);
    });

    it('normalizing forces prompted off for an image type, and increment off unless it is an image list', () => {
        const want = { behaviors: { prompted: true, increment: true } };
        expect(normalizeCollectedValues({ type: 'image', ...want }).behaviors).toEqual({ increment: false, prompted: false });
        expect(normalizeCollectedValues({ type: 'imageMap', ...want }).behaviors).toEqual({ increment: false, prompted: false });
        expect(normalizeCollectedValues({ type: 'imageList', ...want }).behaviors).toEqual({ increment: true, prompted: false });
        expect(normalizeCollectedValues({ type: 'string', ...want }).behaviors).toEqual({ increment: true, prompted: true });
    });

    it('the explanation describes an image list\'s rotation', () => {
        expect(describeVariable({ ...blankDefinition(), name: 'g', type: 'imageList', behaviors: { increment: true, prompted: false }, increment: { operation: 'rotateNext', triggers: ['ai'] } })).toContain('shows the next image');
    });
});

// ---------------------------------------------------------------------------
describe('the manager modal, end to end', () => {
    let presetId;
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
    });

    const stored = (name) => Object.values(getSettings().presets[presetId].variables).find((v) => v.name === name);
    // jsdom has no layout, so :visible does not work: the open editor is the one with content.
    const editor = () => $('.se-manager-variable-editor-inline').filter((_, el) => el.innerHTML.trim() !== '');

    beforeEach(() => {
        context.chatId = 'chat-1';
        presetId = 'p1';
        getSettings().presets[presetId] = { id: presetId, name: 'Alpha', namespace: 'se', description: '', triggers: ['ai'], showInTracker: false, variables: {
            m: { ...blankDefinition(), id: 'm', name: 'se__mood', type: 'string', defaultValue: 'calm' },
        } };
        addPresetToChat('chat-1', presetId);
        setManagerApi(api());
        buildManagerModal();
        $('.se-manager-tab-btn[data-tab="variables"]').trigger('click');
    });

    // Opens the new-variable editor, names it and picks its type.
    const startNew = (name, type) => {
        $('#se-manager-new-variable').trigger('click');
        editor().find('[data-field="name"]').val(name);
        editor().find('[data-field="type"]').val(type).trigger('change');
        editor().find('[data-field="name"]').val(name); // (the type change re-renders from the collected values)
    };
    const save = () => editor().find('.se-manager-save-variable-inline').trigger('click');
    const setRef = ($input, ref) => $input.val(ref).trigger('input');

    it('an image: type a reference, see the preview change, save it as a string', () => {
        startNew('icon', 'image');
        const $field = editor().find('[data-field="defaultValue"]');
        setRef($field, 'https://x.test/a.png');
        expect(editor().find('.se-image-editor-preview img').attr('src')).toBe('https://x.test/a.png');
        setRef($field, 'javascript:alert(1)');
        expect(editor().find('.se-image-editor-preview img').length).toBe(0);
        setRef($field, 'https://x.test/b.png');
        save();
        expect(stored('se__icon')).toMatchObject({ type: 'image', defaultValue: 'https://x.test/b.png' });
        expect(stored('se__icon').behaviors).toEqual({ increment: false, prompted: false });
    });

    it('an image list: add, edit with live previews, reorder, remove, save in that order', () => {
        startNew('faces', 'imageList');
        for (let i = 0; i < 3; i++) editor().find('.se-manager-array-add').trigger('click');
        const rows = () => editor().find('.se-manager-image-list .se-manager-array-row');
        expect(rows().length).toBe(3);
        expect(rows().first().find('.se-manager-array-item').val()).toBe(''); // a new image row is blank

        ['https://x.test/1.png', 'https://x.test/2.png', 'https://x.test/3.png'].forEach((ref, i) => setRef(rows().eq(i).find('.se-manager-array-item'), ref));
        expect(rows().eq(1).find('img').attr('src')).toBe('https://x.test/2.png');

        rows().eq(0).find('.se-manager-image-down').trigger('click');                 // 2 1 3
        rows().eq(2).find('.se-manager-image-up').trigger('click');                   // 2 3 1
        rows().eq(0).find('.se-manager-image-up').trigger('click');                   // already first: no change
        expect(rows().map((_, r) => $(r).find('.se-manager-array-item').val()).get())
            .toEqual(['https://x.test/2.png', 'https://x.test/3.png', 'https://x.test/1.png']);

        rows().eq(1).find('.se-manager-array-delete').trigger('click');               // remove 3
        editor().find('.se-manager-array-add').trigger('click');                      // a blank row is dropped on save
        save();
        expect(JSON.parse(stored('se__faces').defaultValue)).toEqual(['https://x.test/2.png', 'https://x.test/1.png']);
        expect(stored('se__faces').type).toBe('imageList');
    });

    it('an image map: rows of key + reference with previews, and the current-key variable, saved as an object', () => {
        startNew('portraits', 'imageMap');
        editor().find('.se-manager-imagemap-add').trigger('click');
        editor().find('.se-manager-imagemap-add').trigger('click');
        const rows = () => editor().find('.se-manager-imagemap-row');
        rows().eq(0).find('.se-manager-imagemap-key').val('happy');
        setRef(rows().eq(0).find('.se-manager-imagemap-value'), 'https://x.test/h.png');
        rows().eq(1).find('.se-manager-imagemap-key').val('sad');
        setRef(rows().eq(1).find('.se-manager-imagemap-value'), 'asset:sad');
        expect(rows().eq(0).find('img').attr('src')).toBe('https://x.test/h.png');
        expect(rows().eq(1).find('img').length).toBe(0);

        editor().find('[data-field="currentKeyVariable"]').val('se__mood');
        save();
        expect(stored('se__portraits')).toMatchObject({ type: 'imageMap', currentKeyVariable: 'se__mood' });
        expect(JSON.parse(stored('se__portraits').defaultValue)).toEqual({ happy: 'https://x.test/h.png', sad: 'asset:sad' });
    });

    it('a repeated key, or a reference with no key, is refused with a message and nothing is written', () => {
        startNew('dupes', 'imageMap');
        editor().find('.se-manager-imagemap-add').trigger('click');
        editor().find('.se-manager-imagemap-add').trigger('click');
        const rows = () => editor().find('.se-manager-imagemap-row');
        rows().eq(0).find('.se-manager-imagemap-key').val('a');
        rows().eq(0).find('.se-manager-imagemap-value').val('1.png');
        rows().eq(1).find('.se-manager-imagemap-key').val('a');
        rows().eq(1).find('.se-manager-imagemap-value').val('2.png');
        save();
        expect(globalThis.alert).toHaveBeenLastCalledWith(expect.stringContaining('"a" is used more than once'));
        expect(stored('se__dupes')).toBeUndefined();

        rows().eq(1).find('.se-manager-imagemap-key').val('');
        save();
        expect(globalThis.alert).toHaveBeenLastCalledWith(expect.stringContaining('needs a key'));
        expect(stored('se__dupes')).toBeUndefined();

        rows().eq(1).find('.se-manager-imagemap-key').val('b');
        save();
        expect(JSON.parse(stored('se__dupes').defaultValue)).toEqual({ a: '1.png', b: '2.png' });
    });

    it('an image map row can be removed', () => {
        startNew('m2', 'imageMap');
        editor().find('.se-manager-imagemap-add').trigger('click');
        editor().find('.se-manager-imagemap-delete').trigger('click');
        expect(editor().find('.se-manager-imagemap-row').length).toBe(0);
        save();
        expect(JSON.parse(stored('se__m2').defaultValue)).toEqual({});
    });

    it('switching the type to or from an image type starts the default blank and clears prompted', () => {
        $('#se-manager-new-variable').trigger('click');
        editor().find('[data-field="name"]').val('thing');
        editor().find('[data-field="defaultValue"]').val('42');
        editor().find('[data-field="type"]').val('image').trigger('change');
        expect(editor().find('[data-field="defaultValue"]').val()).toBe('');
        expect(editor().find('#se-manager-prompted-toggle').length).toBe(0);

        editor().find('[data-field="defaultValue"]').val('https://x.test/a.png');
        editor().find('[data-field="type"]').val('string').trigger('change');
        expect(editor().find('[data-field="defaultValue"]').val()).toBe('');
    });

    it('an existing image list opens with its rows and saves unchanged', () => {
        getSettings().presets[presetId].variables.g = { ...blankDefinition(), id: 'g', name: 'se__gallery', type: 'imageList', defaultValue: ['https://x.test/a.png', 'https://x.test/b.png'] };
        $('.se-manager-tab-btn[data-tab="presets"]').trigger('click');
        $('.se-manager-tab-btn[data-tab="variables"]').trigger('click');
        // re-render so the new variable is listed
        buildManagerModal();
        $('.se-manager-tab-btn[data-tab="variables"]').trigger('click');
        $('.se-manager-edit-variable[data-var-id="g"]').trigger('click');
        expect(editor().find('.se-manager-image-list .se-manager-array-row').length).toBe(2);
        save();
        expect(JSON.parse(stored('se__gallery').defaultValue)).toEqual(['https://x.test/a.png', 'https://x.test/b.png']);
    });

    it('an image variable cannot be saved as prompted, and only an image list keeps increment', () => {
        startNew('icon2', 'image');
        save();
        expect(stored('se__icon2').behaviors).toEqual({ increment: false, prompted: false });
    });

    // ---- drag and drop of image files (core/image-import.js) ----
    describe('dropping image files', () => {
        const PREFIX = 'user/images/state-engine-images/';
        const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
        const pngFile = (name = 'portrait.png') => new File([PNG], name, { type: 'image/png' });
        let serverFiles; let uploads;

        beforeEach(() => {
            serverFiles = new Map();
            uploads = [];
            vi.stubGlobal('fetch', vi.fn(async (url, init) => {
                if (url === '/api/images/list') return { ok: true, json: async () => [...serverFiles.keys()] };
                if (url === '/api/images/upload') {
                    const body = JSON.parse(init.body);
                    uploads.push(body);
                    serverFiles.set(body.filename, body.image);
                    return { ok: true, json: async () => ({ path: `user/images/${body.ch_name}/${body.filename}` }) };
                }
                throw new Error(`unexpected request ${url}`);
            }));
            globalThis.toastr = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
        });
        afterEach(() => {
            vi.unstubAllGlobals();
            delete globalThis.toastr;
        });

        const fire = (type, target, files = [], types = ['Files']) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'dataTransfer', { value: { files, types, dropEffect: '' } });
            target.dispatchEvent(event);
            return event;
        };
        const settle = () => new Promise((r) => setTimeout(r, 30));
        const drop = async (target, files) => { const event = fire('drop', target, files); await settle(); return event; };

        it('image: dragging over highlights the editor, dropping replaces the reference, previews it and says so', async () => {
            startNew('icon', 'image');
            const editorEl = editor()[0];
            expect(fire('dragover', editorEl).defaultPrevented).toBe(true);
            expect(editor().hasClass('se-drop-active')).toBe(true);

            const event = await drop(editorEl, [pngFile('Elf Queen.png')]);
            expect(event.defaultPrevented).toBe(true);
            expect(editor().hasClass('se-drop-active')).toBe(false);
            expect(editor().find('[data-field="defaultValue"]').val()).toBe(`${PREFIX}Elf Queen.png`);
            expect(editor().find('.se-image-editor-preview img').attr('src')).toBe(`${PREFIX}Elf Queen.png`);
            expect(editor().find('.se-image-editor-preview .se-image-thumb').attr('data-enlarge')).toBe('1');   // hover-to-enlarge
            expect(globalThis.toastr.success).toHaveBeenCalledWith('Image imported');

            save();
            expect(stored('se__icon').defaultValue).toBe(`${PREFIX}Elf Queen.png`);
        });

        it('image: a second drop replaces the first (one reference)', async () => {
            startNew('icon', 'image');
            await drop(editor()[0], [pngFile('one.png')]);
            await drop(editor()[0], [pngFile('two.png')]);
            expect(editor().find('[data-field="defaultValue"]').val()).toBe(`${PREFIX}two.png`);
        });

        it('imageList: each dropped file is appended as a new row, with a preview', async () => {
            startNew('faces', 'imageList');
            editor().find('.se-manager-array-add').trigger('click');
            setRef(editor().find('.se-manager-array-item').first(), 'https://x.test/existing.png');
            await drop(editor()[0], [pngFile('a.png')]);
            await drop(editor()[0], [pngFile('b.png'), pngFile('c.png')]);

            const rows = editor().find('.se-manager-image-list .se-manager-array-row');
            expect(rows.map((_, r) => $(r).find('.se-manager-array-item').val()).get())
                .toEqual(['https://x.test/existing.png', `${PREFIX}a.png`, `${PREFIX}b.png`, `${PREFIX}c.png`]);
            expect(rows.eq(3).find('img').attr('src')).toBe(`${PREFIX}c.png`);
            expect(rows.eq(3).find('.se-image-thumb').attr('data-enlarge')).toBe('1');
            expect(globalThis.toastr.success).toHaveBeenLastCalledWith('2 images imported');
            save();
            expect(JSON.parse(stored('se__faces').defaultValue).slice(1)).toEqual([`${PREFIX}a.png`, `${PREFIX}b.png`, `${PREFIX}c.png`]);
        });

        describe('imageMap', () => {
            const setupMap = () => {
                startNew('portraits', 'imageMap');
                editor().find('.se-manager-imagemap-add').trigger('click');
                editor().find('.se-manager-imagemap-key').first().val('happy');
                setRef(editor().find('.se-manager-imagemap-value').first(), 'https://x.test/old.png');
            };

            it("dropped ON a row: that row's image is updated and its key is kept; hovering it highlights the row", async () => {
                setupMap();
                const row = editor().find('.se-manager-imagemap-row')[0];
                fire('dragover', row.querySelector('.se-manager-imagemap-value'));
                expect($(row).hasClass('se-drop-row')).toBe(true);

                await drop(row.querySelector('.se-manager-imagemap-value'), [pngFile('happy.png')]);
                expect(editor().find('.se-manager-imagemap-row').length).toBe(1);
                expect(editor().find('.se-manager-imagemap-key').val()).toBe('happy');
                expect(editor().find('.se-manager-imagemap-value').val()).toBe(`${PREFIX}happy.png`);
                expect(editor().find('.se-manager-imagemap-row img').attr('src')).toBe(`${PREFIX}happy.png`);
                expect($('.se-drop-row').length).toBe(0);
            });

            it('dropped into empty space: a new row with an EMPTY key and the imported path', async () => {
                setupMap();
                await drop(editor().find('.se-manager-label').first()[0], [pngFile('new.png')]);
                const rows = editor().find('.se-manager-imagemap-row');
                expect(rows.length).toBe(2);
                expect(rows.eq(1).find('.se-manager-imagemap-key').val()).toBe('');
                expect(rows.eq(1).find('.se-manager-imagemap-value').val()).toBe(`${PREFIX}new.png`);
                expect(rows.eq(0).find('.se-manager-imagemap-value').val()).toBe('https://x.test/old.png'); // untouched
                expect(rows.eq(1).find('.se-image-thumb').attr('data-enlarge')).toBe('1');
            });

            it('several files on a row: the first updates it, the rest become new rows', async () => {
                setupMap();
                await drop(editor().find('.se-manager-imagemap-value')[0], [pngFile('a.png'), pngFile('b.png')]);
                const rows = editor().find('.se-manager-imagemap-row');
                expect(rows.map((_, r) => $(r).find('.se-manager-imagemap-value').val()).get()).toEqual([`${PREFIX}a.png`, `${PREFIX}b.png`]);
                expect(rows.eq(1).find('.se-manager-imagemap-key').val()).toBe('');
            });

            it('a new row with an empty key cannot be saved until it has a key', async () => {
                setupMap();
                await drop(editor().find('.se-manager-label').first()[0], [pngFile('new.png')]);
                save();
                expect(globalThis.alert).toHaveBeenLastCalledWith(expect.stringContaining('needs a key'));
                expect(stored('se__portraits')).toBeUndefined();
                editor().find('.se-manager-imagemap-key').last().val('sad');
                save();
                expect(JSON.parse(stored('se__portraits').defaultValue)).toEqual({ happy: 'https://x.test/old.png', sad: `${PREFIX}new.png` });
            });
        });

        it('files that are not images are refused with a message and change nothing', async () => {
            startNew('faces', 'imageList');
            await drop(editor()[0], [new File(['hello'], 'notes.txt', { type: 'text/plain' }), new File([new Uint8Array([1, 2, 3, 4, 5])], 'fake.png', { type: 'image/png' })]);
            expect(editor().find('.se-manager-image-list .se-manager-array-row').length).toBe(0);
            expect(globalThis.toastr.error).toHaveBeenCalledWith(expect.stringMatching(/notes\.txt: only image files/));
            expect(globalThis.toastr.error).toHaveBeenCalledWith(expect.stringMatching(/fake\.png: that file is not a supported image/));
            expect(globalThis.toastr.success).not.toHaveBeenCalled();
            expect(uploads).toEqual([]);
        });

        it('a mixed drop imports the images and reports the rest', async () => {
            startNew('faces', 'imageList');
            await drop(editor()[0], [pngFile('ok.png'), new File(['x'], 'bad.txt', { type: 'text/plain' })]);
            expect(editor().find('.se-manager-image-list .se-manager-array-row').length).toBe(1);
            expect(globalThis.toastr.error).toHaveBeenCalledTimes(1);
            expect(globalThis.toastr.success).toHaveBeenCalledWith('Image imported');
        });

        it('a failed upload is reported and nothing is added', async () => {
            fetch.mockImplementation(async (url) => (url === '/api/images/list' ? { ok: true, json: async () => [] } : { ok: false, status: 500, json: async () => ({}) }));
            startNew('faces', 'imageList');
            await drop(editor()[0], [pngFile('a.png')]);
            expect(editor().find('.se-manager-image-list .se-manager-array-row').length).toBe(0);
            expect(globalThis.toastr.error).toHaveBeenCalledWith(expect.stringContaining('refused the upload'));
        });

        it('leaving the editor removes the highlight; non-file drags (text, links) are ignored', async () => {
            startNew('faces', 'imageList');
            fire('dragover', editor()[0]);
            expect(editor().hasClass('se-drop-active')).toBe(true);
            fire('dragleave', editor()[0]);
            expect(editor().hasClass('se-drop-active')).toBe(false);

            const text = fire('dragover', editor()[0], [], ['text/plain']);
            expect(text.defaultPrevented).toBe(false);
            expect(editor().hasClass('se-drop-active')).toBe(false);
            const textDrop = fire('drop', editor()[0], [], ['text/plain']);
            await settle();
            expect(textDrop.defaultPrevented).toBe(false);
            expect(uploads).toEqual([]);
        });

        it('an editor of another type takes no drops - but the browser is still stopped from opening the file', async () => {
            startNew('name', 'string');
            const over = fire('dragover', editor()[0]);
            expect(over.defaultPrevented).toBe(true);           // never navigate away from SillyTavern
            expect(editor().hasClass('se-drop-active')).toBe(false);
            const event = await drop(editor()[0], [pngFile('a.png')]);
            expect(event.defaultPrevented).toBe(true);
            expect(uploads).toEqual([]);
            expect(globalThis.toastr.success).not.toHaveBeenCalled();
        });

        it('a drop stores only a managed relative path - never a blob, data, absolute or original location', async () => {
            startNew('faces', 'imageList');
            const file = pngFile('C:\\Users\\me\\Desktop\\pic.png');
            await drop(editor()[0], [file]);
            const value = editor().find('.se-manager-array-item').val();
            expect(value).toBe(`${PREFIX}pic.png`);
            expect(value).not.toMatch(/^(blob:|data:|file:|[a-z]:|\/|\\)/i);
            save();
            expect(stored('se__faces').defaultValue).not.toMatch(/blob:|data:|C:|Users/);
        });

        it('every stored reference is escaped when drawn', async () => {
            startNew('faces', 'imageList');
            await drop(editor()[0], [pngFile('x"><img src=y onerror=alert(1)>.png')]);
            expect(editor().find('img[onerror]').length).toBe(0);
            expect(editor().find('script').length).toBe(0);
            expect(editor().find('.se-manager-array-item').val()).toMatch(/^user\/images\/state-engine-images\/[^"<>]+\.png$/);
        });
    });

    describe('saving refuses references that are not portable', () => {
        it('a typed blob: URL or a path on this computer is refused with a way out; nothing is written', () => {
            startNew('icon', 'image');
            setRef(editor().find('[data-field="defaultValue"]'), 'blob:http://localhost:8000/1234-5678');
            save();
            expect(globalThis.alert).toHaveBeenLastCalledWith(expect.stringMatching(/blob:.*temporary.*Drop the image file/s));
            expect(stored('se__icon')).toBeUndefined();

            setRef(editor().find('[data-field="defaultValue"]'), 'C:\\Users\\me\\a.png');
            save();
            expect(globalThis.alert).toHaveBeenLastCalledWith(expect.stringContaining('absolute path on this computer'));
            expect(stored('se__icon')).toBeUndefined();

            setRef(editor().find('[data-field="defaultValue"]'), 'user/images/state-engine-images/a.png');
            save();
            expect(stored('se__icon').defaultValue).toBe('user/images/state-engine-images/a.png');
        });

        it('in a list or a map too', () => {
            startNew('faces', 'imageList');
            editor().find('.se-manager-array-add').trigger('click');
            setRef(editor().find('.se-manager-array-item'), '/home/me/a.png');
            save();
            expect(globalThis.alert).toHaveBeenLastCalledWith(expect.stringContaining('/home/me/a.png'));
            expect(stored('se__faces')).toBeUndefined();

            startNew('moods', 'imageMap');
            editor().find('.se-manager-imagemap-add').trigger('click');
            editor().find('.se-manager-imagemap-key').val('a');
            setRef(editor().find('.se-manager-imagemap-value'), 'file:///C:/a.png');
            save();
            expect(globalThis.alert).toHaveBeenLastCalledWith(expect.stringContaining('file:///C:/a.png'));
            expect(stored('se__moods')).toBeUndefined();
        });
    });
});

// ---------------------------------------------------------------------------
describe('the tracker', () => {
    let presetId;
    const body = () => document.getElementById('se_tracker_body');
    const rowFor = (label) => [...body().querySelectorAll('.se-tracker-row')].find((r) => r.querySelector('.se-tracker-label').textContent.includes(label));
    const imgOf = (label) => rowFor(label).querySelector('img');

    const add = (name, type, defaultValue, extra = {}) => {
        const def = { ...blankDefinition(), id: name, name: `se__${name}`, label: name, type, defaultValue, showInTracker: true, ...extra };
        getSettings().presets[presetId].variables[name] = def;
        return def;
    };
    const value = (def, v) => setVar('chat-1', def.name, v, def);

    beforeEach(() => {
        context.chatId = 'chat-1';
        presetId = 'p1';
        getSettings().presets[presetId] = { id: presetId, name: 'Alpha', namespace: 'se', description: '', triggers: ['ai'], showInTracker: true, variables: {} };
        addPresetToChat('chat-1', presetId);
        document.body.innerHTML = '<div id="se_tracker_body"></div>';
    });

    it('an image shows as a thumbnail, hover-to-enlarge, and cannot be edited from the tracker', () => {
        const icon = add('icon', 'image', '');
        value(icon, 'https://x.test/a.png');
        add('note', 'string', 'hi');
        renderTrackerPanel();
        expect(imgOf('icon').getAttribute('src')).toBe('https://x.test/a.png');
        expect(rowFor('icon').querySelector('.se-image-thumb').getAttribute('data-enlarge')).toBe('1');
        expect(rowFor('icon').querySelector('.se-tracker-edit-btn')).toBe(null);
        expect(rowFor('note').querySelector('.se-tracker-edit-btn')).not.toBe(null); // an ordinary variable still can
    });

    it('a numeric-looking reference is shown as it was stored (SillyTavern\'s macro store would turn "12345" into a number)', () => {
        const icon = add('icon', 'image', '');
        value(icon, '12345');
        context.variables.local.set('se__icon', 12345);
        renderTrackerPanel();
        expect(rowFor('icon').querySelector('.se-image-thumb-empty').title).toContain('12345'); // an id, not loadable, but shown as stored
    });

    it('an image list shows ONLY the first image - never the list', () => {
        const gallery = add('gallery', 'imageList', []);
        value(gallery, ['https://x.test/1.png', 'https://x.test/2.png', 'https://x.test/3.png']);
        renderTrackerPanel();
        const row = rowFor('gallery');
        expect(row.querySelectorAll('img')).toHaveLength(1);
        expect(imgOf('gallery').getAttribute('src')).toBe('https://x.test/1.png');
        expect(row.textContent).not.toContain('2.png');
        expect(row.querySelector('.se-tracker-edit-btn')).toBe(null);
    });

    it('rotating the list changes which image is active', () => {
        const gallery = add('gallery', 'imageList', []);
        value(gallery, ['https://x.test/2.png', 'https://x.test/3.png', 'https://x.test/1.png']);
        renderTrackerPanel();
        expect(imgOf('gallery').getAttribute('src')).toBe('https://x.test/2.png');
    });

    it('an empty image or list shows the neutral placeholder', () => {
        add('icon', 'image', '');
        add('gallery', 'imageList', []);
        renderTrackerPanel();
        for (const label of ['icon', 'gallery']) {
            expect(imgOf(label), label).toBe(null);
            expect(rowFor(label).querySelector('.se-image-thumb-empty')).not.toBe(null);
        }
    });

    describe('an image map shows the image for the current key, read from any variable as text', () => {
        const map = { happy: 'https://x.test/h.png', sad: 'https://x.test/s.png', 3: 'https://x.test/three.png', true: 'https://x.test/yes.png', default: 'https://x.test/d.png' };
        const setup = (keyVar) => {
            const portraits = add('portraits', 'imageMap', {}, { currentKeyVariable: keyVar ? `se__${keyVar}` : '' });
            value(portraits, map);
            return portraits;
        };

        it('a string variable', () => {
            const mood = add('mood', 'string', ''); setup('mood');
            value(mood, 'sad');
            renderTrackerPanel();
            expect(imgOf('portraits').getAttribute('src')).toBe('https://x.test/s.png');
        });

        it('an enum variable', () => {
            const stance = add('stance', 'enum', 'happy', { enumValues: ['happy', 'sad'] }); setup('stance');
            value(stance, 'happy');
            renderTrackerPanel();
            expect(imgOf('portraits').getAttribute('src')).toBe('https://x.test/h.png');
        });

        it('an array variable: its current (first) value', () => {
            const party = add('party', 'array', [], { itemType: 'string' }); setup('party');
            value(party, ['sad', 'happy']);
            renderTrackerPanel();
            expect(imgOf('portraits').getAttribute('src')).toBe('https://x.test/s.png');
        });

        it('a calculated variable: its returned value, as text (a number 3 is the key "3", true is "true")', () => {
            const score = add('score', 'calculated', 0, { expression: '1', dependencies: [] }); setup('score');
            value(score, 3);
            context.variables.local.set('se__score', 3);
            renderTrackerPanel();
            expect(imgOf('portraits').getAttribute('src')).toBe('https://x.test/three.png');

            value(score, true);
            context.variables.local.set('se__score', true);
            renderTrackerPanel();
            expect(imgOf('portraits').getAttribute('src')).toBe('https://x.test/yes.png');
        });

        it('a key that is not in the map: the placeholder, with NO fallback to another image (not even a "default" key)', () => {
            const mood = add('mood', 'string', ''); setup('mood');
            value(mood, 'angry');
            renderTrackerPanel();
            expect(imgOf('portraits')).toBe(null);
            expect(rowFor('portraits').querySelector('.se-image-thumb-empty')).not.toBe(null);
        });

        it('no current-key variable, or one that does not exist: the placeholder', () => {
            setup('');
            renderTrackerPanel();
            expect(imgOf('portraits')).toBe(null);
            document.getElementById('se_tracker_body').innerHTML = '';
            getSettings().presets[presetId].variables.portraits.currentKeyVariable = 'se__nothing';
            renderTrackerPanel();
            expect(imgOf('portraits')).toBe(null);
        });

        it('a key variable with an empty array, or an object, gives the placeholder', () => {
            const party = add('party', 'array', [], { itemType: 'string' }); setup('party');
            value(party, []);
            renderTrackerPanel();
            expect(imgOf('portraits')).toBe(null);
        });

        it('the full map is never shown, and it cannot be edited from the tracker', () => {
            const mood = add('mood', 'string', ''); setup('mood');
            value(mood, 'happy');
            renderTrackerPanel();
            const row = rowFor('portraits');
            expect(row.querySelectorAll('img')).toHaveLength(1);
            expect(row.textContent).not.toContain('s.png');
            expect(row.querySelector('.se-tracker-edit-btn')).toBe(null);
        });

        it('follows the key variable: change the mood and the picture changes', () => {
            const mood = add('mood', 'string', ''); setup('mood');
            value(mood, 'happy');
            renderTrackerPanel();
            expect(imgOf('portraits').getAttribute('src')).toBe('https://x.test/h.png');
            value(mood, 'sad');
            renderTrackerPanel();
            expect(imgOf('portraits').getAttribute('src')).toBe('https://x.test/s.png');
        });
    });

    it('an unsafe reference in a tracker row is never loaded or run', () => {
        const icon = add('icon', 'image', '');
        value(icon, 'javascript:alert(1)');
        renderTrackerPanel();
        expect(body().querySelector('img')).toBe(null);
        expect(body().querySelector('script')).toBe(null);
        expect(rowFor('icon').querySelector('.se-image-thumb-empty').title).toContain('javascript:alert(1)');
    });

    it('nothing is fetched by drawing the tracker with no image variables on screen', () => {
        add('icon', 'image', '', { showInTracker: false });
        renderTrackerPanel();
        expect(body().querySelector('img')).toBe(null);
    });
});
