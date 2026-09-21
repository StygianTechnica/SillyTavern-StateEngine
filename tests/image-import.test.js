// @vitest-environment jsdom
//
// Portable image import: what a dropped file becomes, and how images travel with
// presets. A fake SillyTavern image server stands in for /api/images/*; nothing
// touches a network or disk.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../tests/harness/context.js';
import context from './harness/context.js';
import settings from './harness/settings.js';
import { getSettings } from '../src/core/settings-core.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { exportPreset, exportPresetWithImages, importPresetWithImages, importPresetDetailed } from '../src/core/preset-export.js';
import { exportLorebookBundle } from '../src/core/lorebook-bundle.js';
import { bindPresetToLorebook } from '../src/core/lorebook-bindings.js';
import { safeImageSrc } from '../src/core/image-variables.js';
import {
    IMPORT_FOLDER, IMPORT_PATH_PREFIX, MAX_IMAGE_BYTES, isManagedImagePath, nonPortableReason, sniffImageFamily, extensionFor,
    safeBaseName, uniqueFileName, bytesToBase64, base64ToBytes, listImportedNames, importImageFile, importImageFiles,
    imageRefsOfDefinition, mapImageRefs, firstNonPortableReference, collectManagedPaths, embedManagedImages, restoreEmbeddedImages,
} from '../src/core/image-import.js';

const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

// Real image signatures (first bytes) + a distinguishing tail.
const SIGNATURES = {
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    jpg: [0xff, 0xd8, 0xff, 0xe0],
    gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
    bmp: [0x42, 0x4d, 0, 0],
};
const imageBytes = (kind = 'png', tail = 1) => new Uint8Array([...SIGNATURES[kind], tail, tail, tail, tail]);
const fileOf = (name, bytes, type) => new File([bytes], name, { type });
const png = (name = 'portrait.png', tail = 1) => fileOf(name, imageBytes('png', tail), 'image/png');

// A fake SillyTavern user image folder. Like the real endpoint it silently
// overwrites a file that has the same name.
// The real endpoint answers with a LEADING slash ("/user/images/<folder>/<file>") - checked
// against a live SillyTavern - so that is what the fake returns (`slashless` for the other form).
function fakeServer(initial = {}, { listOk = true, uploadOk = true, badPath = false, slashless = false } = {}) {
    const files = new Map(Object.entries(initial)); // name -> base64
    const log = { uploads: [], lists: 0 };
    const fetchImpl = vi.fn(async (url, init) => {
        if (url === '/api/images/list') {
            log.lists += 1;
            return listOk ? json([...files.keys()]) : json({}, false, 500);
        }
        if (url === '/api/images/upload') {
            const body = JSON.parse(init.body);
            log.uploads.push(body);
            if (!uploadOk) return json({}, false, 500);
            const name = body.filename;
            files.set(name, body.image);
            return json({ path: badPath ? '../../etc/passwd' : `${slashless ? '' : '/'}user/images/${body.ch_name}/${name}` });
        }
        if (url.startsWith(`/${IMPORT_PATH_PREFIX}`)) {
            const name = decodeURIComponent(url.slice(IMPORT_PATH_PREFIX.length + 1));
            if (!files.has(name)) return { ok: false, status: 404 };
            return { ok: true, status: 200, arrayBuffer: async () => base64ToBytes(files.get(name)).buffer };
        }
        throw new Error(`unexpected request ${url}`);
    });
    return { files, log, deps: { fetchImpl, headers: () => ({ 'Content-Type': 'application/json' }) } };
}

beforeEach(() => settings.reset());

// ---------------------------------------------------------------------------
describe('what a reference may be', () => {
    it('managed paths are exactly user/images/state-engine-images/<one file name>', () => {
        expect(IMPORT_PATH_PREFIX).toBe('user/images/state-engine-images/');
        expect(isManagedImagePath('user/images/state-engine-images/a.png')).toBe(true);
        expect(isManagedImagePath('user/images/state-engine-images/my photo-1.jpg')).toBe(true);
        for (const bad of ['user/images/other/a.png', 'user/images/state-engine-images/', 'user/images/state-engine-images/sub/a.png',
            'user/images/state-engine-images/../a.png', 'user/images/state-engine-images/..', 'user/images/state-engine-images/a.png?x=1',
            'user/images/state-engine-images/a#b.png', '/user/images/state-engine-images/a.png', 'user\\images\\state-engine-images\\a.png',
            'https://x.test/user/images/state-engine-images/a.png', '', null, undefined, 5]) {
            expect(isManagedImagePath(bad), String(bad)).toBe(false);
        }
    });

    it('a managed path is displayable (a path the previews accept)', () => {
        expect(safeImageSrc('user/images/state-engine-images/a.png')).toBe('user/images/state-engine-images/a.png');
    });

    it('blob: URLs and paths on this computer are not portable', () => {
        for (const bad of ['blob:https://x.test/1234', 'BLOB:abc', 'file:///C:/a.png', 'C:\\Users\\me\\a.png', 'c:/a.png', '\\\\server\\share\\a.png',
            '/Users/me/a.png', '/home/me/a.png', '/mnt/c/a.png', '/Volumes/x/a.png', '  blob:x  ']) {
            expect(nonPortableReason(bad), bad).toEqual(expect.any(String));
        }
        for (const ok of ['user/images/state-engine-images/a.png', 'https://x.test/a.png', 'portraits/a.png', '/user/images/a.png', 'asset:12', '', 'data:image/png;base64,AAAA']) {
            expect(nonPortableReason(ok), ok).toBe(null);
        }
        expect(nonPortableReason(5)).toBe(null);
    });
});

// ---------------------------------------------------------------------------
describe('recognizing and naming files', () => {
    it('sniffs the real format from the first bytes', () => {
        for (const [kind, family] of [['png', 'png'], ['jpg', 'jpeg'], ['gif', 'gif'], ['webp', 'webp'], ['bmp', 'bmp']]) {
            expect(sniffImageFamily(imageBytes(kind)), kind).toBe(family);
        }
        for (const notImage of [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), new TextEncoder().encode('MZ\u0090 program'),
            new Uint8Array([1, 2, 3]), new Uint8Array(0), null, undefined]) {
            expect(sniffImageFamily(notImage)).toBe(null);
        }
        expect(sniffImageFamily(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBe(null); // RIFF/WAVE is not WEBP
    });

    it('keeps the file\'s own extension when the format uses it, else the format\'s usual one', () => {
        expect(extensionFor('jpeg', 'jpeg')).toBe('jpeg');
        expect(extensionFor('jpeg', 'JPG')).toBe('jpg');
        expect(extensionFor('jpeg', 'png')).toBe('jpg');   // named .png but really a JPEG
        expect(extensionFor('png', '')).toBe('png');
    });

    it('safeBaseName keeps the original name where it can, and is never empty or dotted', () => {
        expect(safeBaseName('Elf Queen.png')).toBe('Elf Queen');
        expect(safeBaseName('portrait_01-final.PNG')).toBe('portrait_01-final');
        expect(safeBaseName('C:\\Users\\me\\Pictures\\Elf.png')).toBe('Elf');
        expect(safeBaseName('/home/me/Elf.png')).toBe('Elf');
        expect(safeBaseName('v1.2 hero.png')).toBe('v1_2 hero');            // a dot would be mistaken for an extension
        expect(safeBaseName('../../etc/passwd.png')).toBe('passwd');
        expect(safeBaseName('Ünïcödé 名前.png')).toBe('Ünïcödé 名前');
        expect(safeBaseName('a<b>:c?.png')).toBe('a_b_c');
        for (const empty of ['', '.png', '...', '???.png', null, undefined]) expect(safeBaseName(empty), String(empty)).toBe('image');
        expect(safeBaseName(`${'x'.repeat(200)}.png`).length).toBe(80);
    });

    it('uniqueFileName resolves a collision with a numeric suffix (case-insensitively)', () => {
        expect(uniqueFileName('a', 'png', new Set())).toBe('a.png');
        expect(uniqueFileName('a', 'png', new Set(['a.png']))).toBe('a-1.png');
        expect(uniqueFileName('a', 'png', new Set(['a.png', 'a-1.png', 'a-2.png']))).toBe('a-3.png');
        expect(uniqueFileName('Elf', 'png', new Set(['elf.png']))).toBe('Elf-1.png');
    });

    it('base64 round-trips, including large data', () => {
        const bytes = new Uint8Array(100000).map((_, i) => i % 256);
        expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    });
});

// ---------------------------------------------------------------------------
describe('importing a dropped file', () => {
    it('copies it into the image folder and returns the RELATIVE path - nothing else', async () => {
        const server = fakeServer();
        const result = await importImageFile(png('Elf Queen.png'), server.deps);
        expect(result).toEqual({ path: 'user/images/state-engine-images/Elf Queen.png', name: 'Elf Queen.png' });
        expect(server.log.uploads).toHaveLength(1);
        expect(server.log.uploads[0]).toMatchObject({ format: 'png', filename: 'Elf Queen.png', ch_name: IMPORT_FOLDER });
        expect(server.log.uploads[0].image).toBe(bytesToBase64(imageBytes('png')));   // the file's bytes, base64, no data: prefix
        expect(server.files.get('Elf Queen.png')).toBe(bytesToBase64(imageBytes('png')));
    });

    it('never stores anything but a managed relative path (not a blob, data, absolute or original path)', async () => {
        const server = fakeServer();
        const { path } = await importImageFile(png('C:\\Users\\me\\Desktop\\pic.png'), server.deps);
        expect(isManagedImagePath(path)).toBe(true);
        expect(path).not.toMatch(/^(blob:|data:|file:|[a-z]:|\/|\\)/i);
        expect(path).not.toContain('Users');
        expect(nonPortableReason(path)).toBe(null);
    });

    it('accepts every supported format, saved under the right extension', async () => {
        const server = fakeServer();
        const cases = [['a.png', 'png', 'image/png', 'png'], ['b.jpg', 'jpg', 'image/jpeg', 'jpg'], ['c.jpeg', 'jpg', 'image/jpeg', 'jpeg'], ['d.gif', 'gif', 'image/gif', 'gif'],
            ['e.webp', 'webp', 'image/webp', 'webp'], ['f.bmp', 'bmp', 'image/bmp', 'bmp']];
        for (const [name, kind, mime, ext] of cases) {
            const { path } = await importImageFile(fileOf(name, imageBytes(kind), mime), server.deps);
            expect(path.endsWith(`.${ext}`), name).toBe(true);
        }
    });

    it('a real JPEG named .png is saved as a jpg (the bytes decide, not the name)', async () => {
        const server = fakeServer();
        const { path } = await importImageFile(fileOf('photo.png', imageBytes('jpg'), 'image/jpeg'), server.deps);
        expect(path).toBe('user/images/state-engine-images/photo.jpg');
    });

    it('resolves a name collision with a numeric suffix and never overwrites', async () => {
        const server = fakeServer({ 'portrait.png': bytesToBase64(imageBytes('png', 9)) });
        const first = await importImageFile(png('portrait.png', 1), server.deps);
        const second = await importImageFile(png('portrait.png', 2), server.deps);
        expect(first.name).toBe('portrait-1.png');
        expect(second.name).toBe('portrait-2.png');
        expect(server.files.get('portrait.png')).toBe(bytesToBase64(imageBytes('png', 9))); // the original is untouched
    });

    it('rejects everything that is not a supported image, with a reason, and uploads nothing', async () => {
        const server = fakeServer();
        const rejects = [
            [fileOf('notes.txt', new TextEncoder().encode('hello'), 'text/plain'), /only image files/],
            [fileOf('doc.pdf', new TextEncoder().encode('%PDF'), 'application/pdf'), /only image files/],
            [fileOf('movie.mp4', new Uint8Array([0, 0, 0, 24]), 'video/mp4'), /only image files/],
            [fileOf('logo.svg', new TextEncoder().encode('<svg onload="alert(1)"/>'), 'image/svg+xml'), /SVG/],
            [fileOf('logo.svg', new TextEncoder().encode('<svg/>'), ''), /SVG/],
            [fileOf('fake.png', new TextEncoder().encode('this is really text'), 'image/png'), /not a supported image/],
            [fileOf('script.png', new TextEncoder().encode('<script>alert(1)</script>'), 'image/png'), /not a supported image/],
            [fileOf('empty.png', new Uint8Array(0), 'image/png'), /empty/],
            [fileOf('noext', imageBytes('png'), ''), /only image files/],
            [fileOf('scan.tiff', new Uint8Array([0x49, 0x49, 0x2a, 0x00, 1, 2]), 'image/tiff'), /not a supported image/],
            [null, /not a file/],
            [{ name: 5 }, /not a file/],
        ];
        for (const [file, message] of rejects) {
            await expect(importImageFile(file, server.deps), file?.name).rejects.toThrow(message);
        }
        expect(server.log.uploads).toEqual([]);
    });

    it('rejects a file over the size limit before reading it', async () => {
        const server = fakeServer();
        const big = png('big.png');
        Object.defineProperty(big, 'size', { value: MAX_IMAGE_BYTES + 1 });
        await expect(importImageFile(big, server.deps)).rejects.toThrow(/larger than 20 MB/);
        expect(server.log.uploads).toEqual([]);
    });

    it('an unlistable folder still never overwrites: the name gets a timestamp', async () => {
        const server = fakeServer({}, { listOk: false });
        const { name } = await importImageFile(png('portrait.png'), server.deps);
        expect(name).toMatch(/^portrait-\d{10,}\.png$/);
    });

    it('the server\'s leading slash is dropped: the stored path is always the relative form', async () => {
        const real = await importImageFile(png('a.png'), fakeServer().deps);
        expect(real.path).toBe('user/images/state-engine-images/a.png');
        const slashless = await importImageFile(png('b.png'), fakeServer({}, { slashless: true }).deps);
        expect(slashless.path).toBe('user/images/state-engine-images/b.png');
        for (const path of [real.path, slashless.path]) expect(path.startsWith('/')).toBe(false);
    });

    it('a failed upload, or a server answer outside our folder, is an error and nothing is stored', async () => {
        await expect(importImageFile(png(), fakeServer({}, { uploadOk: false }).deps)).rejects.toThrow(/refused the upload/);
        await expect(importImageFile(png(), fakeServer({}, { badPath: true }).deps)).rejects.toThrow(/unexpected path/);
        // a leading slash is only forgiven for OUR folder
        const elsewhere = { fetchImpl: async (url) => (url === '/api/images/list' ? json([]) : json({ path: '/user/images/other-folder/a.png' })), headers: () => ({}) };
        await expect(importImageFile(png(), elsewhere)).rejects.toThrow(/unexpected path/);
        const escape = { fetchImpl: async (url) => (url === '/api/images/list' ? json([]) : json({ path: '//user/images/state-engine-images/../../secret.png' })), headers: () => ({}) };
        await expect(importImageFile(png(), escape)).rejects.toThrow(/unexpected path/);
    });

    it('listImportedNames reads the folder (lower-cased) and reports failure as null', async () => {
        expect(await listImportedNames(fakeServer({ 'A.PNG': 'x', 'b.jpg': 'y' }).deps)).toEqual(new Set(['a.png', 'b.jpg']));
        expect(await listImportedNames(fakeServer({}, { listOk: false }).deps)).toBe(null);
        expect(await listImportedNames({ fetchImpl: async () => { throw new Error('offline'); }, headers: () => ({}) })).toBe(null);
    });

    describe('several files at once', () => {
        it('same-named files get distinct names; rejected ones are reported and do not stop the rest', async () => {
            const server = fakeServer();
            const result = await importImageFiles([png('a.png', 1), png('a.png', 2), fileOf('x.txt', new Uint8Array([1]), 'text/plain'), png('b.png', 3)], server.deps);
            expect(result.imported.map((i) => i.name)).toEqual(['a.png', 'a-1.png', 'b.png']);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toMatchObject({ file: 'x.txt', error: expect.stringMatching(/only image files/) });
        });

        it('never throws, even with garbage', async () => {
            await expect(importImageFiles(undefined, fakeServer().deps)).resolves.toEqual({ imported: [], errors: [] });
            const result = await importImageFiles([null, 5], fakeServer().deps);
            expect(result.imported).toEqual([]);
            expect(result.errors).toHaveLength(2);
        });
    });
});

// ---------------------------------------------------------------------------
describe('references inside variable definitions', () => {
    const image = (defaultValue) => ({ ...blankDefinition(), type: 'image', defaultValue });
    const list = (defaultValue) => ({ ...blankDefinition(), type: 'imageList', defaultValue });
    const map = (defaultValue) => ({ ...blankDefinition(), type: 'imageMap', defaultValue });

    it('finds every reference in an image, a list (array or JSON text) and a map', () => {
        expect(imageRefsOfDefinition(image('a.png'))).toEqual(['a.png']);
        expect(imageRefsOfDefinition(image(''))).toEqual([]);
        expect(imageRefsOfDefinition(list(['a', 'b']))).toEqual(['a', 'b']);
        expect(imageRefsOfDefinition(list('["a","b"]'))).toEqual(['a', 'b']);
        expect(imageRefsOfDefinition(map({ k: 'a', j: 'b' }))).toEqual(['a', 'b']);
        expect(imageRefsOfDefinition(map('{"k":"a"}'))).toEqual(['a']);
        expect(imageRefsOfDefinition({ ...blankDefinition(), type: 'string', defaultValue: 'a.png' })).toEqual([]);
        expect(imageRefsOfDefinition(undefined)).toEqual([]);
    });

    it('mapImageRefs rewrites references and keeps the default\'s shape', () => {
        const up = (r) => r.toUpperCase();
        expect(mapImageRefs(image('a.png'), up).defaultValue).toBe('A.PNG');
        expect(mapImageRefs(list(['a', 'b']), up).defaultValue).toEqual(['A', 'B']);
        expect(mapImageRefs(list('["a","b"]'), up).defaultValue).toBe('["A","B"]');   // JSON text stays JSON text
        expect(mapImageRefs(map({ k: 'a' }), up).defaultValue).toEqual({ k: 'A' });    // keys untouched
        expect(mapImageRefs(map('{"k":"a"}'), up).defaultValue).toBe('{"k":"A"}');
        const other = { ...blankDefinition(), type: 'string', defaultValue: 'a' };
        expect(mapImageRefs(other, up)).toBe(other);
    });

    it('firstNonPortableReference reports the first bad reference and why', () => {
        expect(firstNonPortableReference(image('blob:https://x/1'))).toMatchObject({ reference: 'blob:https://x/1', reason: expect.stringContaining('temporary') });
        expect(firstNonPortableReference(list(['user/images/state-engine-images/a.png', 'C:\\Users\\me\\b.png']))).toMatchObject({ reference: 'C:\\Users\\me\\b.png' });
        expect(firstNonPortableReference(map({ a: 'https://x.test/a.png', b: '/home/me/b.png' }))).toMatchObject({ reference: '/home/me/b.png' });
        expect(firstNonPortableReference(list(['user/images/state-engine-images/a.png']))).toBe(null);
    });

    it('collectManagedPaths finds only the files in State Engine\'s folder', () => {
        const preset = { variables: { a: image('user/images/state-engine-images/a.png'), b: list(['user/images/state-engine-images/b.png', 'https://x.test/c.png', 'user/images/other/d.png']) } };
        expect([...collectManagedPaths(preset)].sort()).toEqual(['user/images/state-engine-images/a.png', 'user/images/state-engine-images/b.png']);
    });
});

// ---------------------------------------------------------------------------
describe('images travel with presets', () => {
    const PATH = (n) => `${IMPORT_PATH_PREFIX}${n}`;
    const makePreset = (variables) => {
        getSettings().presets.p1 = { id: 'p1', name: 'Portraits', namespace: 'se', description: '', triggers: ['ai'], showInTracker: true, variables };
        return 'p1';
    };
    const def = (type, name, defaultValue) => ({ ...blankDefinition(), id: name, name: `se__${name}`, type, defaultValue });

    it('exporting embeds the image files the preset references, and nothing else', async () => {
        const machineA = fakeServer({ 'a.png': bytesToBase64(imageBytes('png', 1)), 'b.jpg': bytesToBase64(imageBytes('jpg', 2)), 'unused.png': bytesToBase64(imageBytes('png', 3)) });
        makePreset({
            icon: def('image', 'icon', PATH('a.png')),
            faces: def('imageList', 'faces', [PATH('b.jpg'), 'https://x.test/remote.png']),
            plain: { ...blankDefinition(), id: 'plain', name: 'se__plain', type: 'string', defaultValue: 'hi' },
        });
        const { data, missing } = await exportPresetWithImages('p1', machineA.deps);
        expect(Object.keys(data.stateEngineImages).sort()).toEqual(['a.png', 'b.jpg']);
        expect(data.stateEngineImages['a.png']).toBe(bytesToBase64(imageBytes('png', 1)));
        expect(missing).toEqual([]);
        expect(data.variables.faces.defaultValue).toEqual([PATH('b.jpg'), 'https://x.test/remote.png']); // references unchanged
        expect(getSettings().presets.p1.stateEngineImages).toBeUndefined();                             // the stored preset is untouched
    });

    it('a preset with no managed images exports exactly as before (no extra field, no requests)', async () => {
        makePreset({ n: def('string', 'n', 'x'), remote: def('image', 'remote', 'https://x.test/a.png') });
        const server = fakeServer();
        const { data, missing } = await exportPresetWithImages('p1', server.deps);
        expect(data).toEqual(exportPreset('p1'));
        expect(missing).toEqual([]);
        expect(server.deps.fetchImpl).not.toHaveBeenCalled();
    });

    it('an image whose file cannot be found is reported, left as a reference, and does not stop the export', async () => {
        makePreset({ a: def('image', 'a', PATH('gone.png')), b: def('image', 'b', PATH('here.png')) });
        const { data, missing } = await exportPresetWithImages('p1', fakeServer({ 'here.png': bytesToBase64(imageBytes('png')) }).deps);
        expect(missing).toEqual([PATH('gone.png')]);
        expect(Object.keys(data.stateEngineImages)).toEqual(['here.png']);
        expect(data.variables.a.defaultValue).toBe(PATH('gone.png'));
    });

    it('a file that is not really an image is not embedded', async () => {
        makePreset({ a: def('image', 'a', PATH('fake.png')) });
        const { data, missing } = await exportPresetWithImages('p1', fakeServer({ 'fake.png': bytesToBase64(new TextEncoder().encode('not an image')) }).deps);
        expect(data.stateEngineImages).toBeUndefined();
        expect(missing).toEqual([PATH('fake.png')]);
    });

    it('importing on another machine restores the files into the same folder and the preset keeps working', async () => {
        const machineA = fakeServer({ 'a.png': bytesToBase64(imageBytes('png', 1)), 'b.jpg': bytesToBase64(imageBytes('jpg', 2)) });
        makePreset({ icon: def('image', 'icon', PATH('a.png')), faces: def('imageList', 'faces', [PATH('b.jpg')]), moods: def('imageMap', 'moods', { happy: PATH('a.png') }) });
        const { data } = await exportPresetWithImages('p1', machineA.deps);
        const shared = JSON.parse(JSON.stringify(data));          // the file that gets sent to someone

        settings.reset();                                          // machine B: a fresh install
        const machineB = fakeServer();
        const imported = await importPresetWithImages(shared, machineB.deps);

        expect(imported.images).toEqual({ restored: 2, reused: 0, failed: [] });
        expect([...machineB.files.keys()].sort()).toEqual(['a.png', 'b.jpg']);
        expect(machineB.files.get('a.png')).toBe(bytesToBase64(imageBytes('png', 1)));
        const stored = getSettings().presets[imported.presetId];
        const byName = Object.fromEntries(Object.values(stored.variables).map((v) => [v.name, v]));
        expect(byName.se__icon.defaultValue).toBe(PATH('a.png'));
        expect(byName.se__faces.defaultValue).toEqual([PATH('b.jpg')]);
        expect(byName.se__moods.defaultValue).toEqual({ happy: PATH('a.png') });
        expect(stored.stateEngineImages).toBeUndefined();          // the pictures are files, never stored in settings
        expect(JSON.stringify(getSettings())).not.toContain(bytesToBase64(imageBytes('png', 1)));
    });

    it('importing the same preset twice reuses identical files (no duplicates)', async () => {
        makePreset({ icon: def('image', 'icon', PATH('a.png')) });
        const source = fakeServer({ 'a.png': bytesToBase64(imageBytes('png', 1)) });
        const { data } = await exportPresetWithImages('p1', source.deps);
        const target = fakeServer();
        await importPresetWithImages(data, target.deps);
        const again = await importPresetWithImages(data, target.deps);
        expect(again.images).toEqual({ restored: 0, reused: 1, failed: [] });
        expect([...target.files.keys()]).toEqual(['a.png']);
    });

    it('a name taken by a DIFFERENT file gets a numeric suffix and the preset\'s references follow', async () => {
        makePreset({ icon: def('image', 'icon', PATH('a.png')), faces: def('imageList', 'faces', JSON.stringify([PATH('a.png'), PATH('a.png')])), moods: def('imageMap', 'moods', { k: PATH('a.png') }) });
        const { data } = await exportPresetWithImages('p1', fakeServer({ 'a.png': bytesToBase64(imageBytes('png', 1)) }).deps);

        settings.reset();
        const target = fakeServer({ 'a.png': bytesToBase64(imageBytes('png', 99)) });     // someone else's a.png
        const imported = await importPresetWithImages(data, target.deps);

        expect(imported.images).toEqual({ restored: 1, reused: 0, failed: [] });
        expect(target.files.get('a.png')).toBe(bytesToBase64(imageBytes('png', 99)));       // theirs is untouched
        expect(target.files.get('a-1.png')).toBe(bytesToBase64(imageBytes('png', 1)));
        const byName = Object.fromEntries(Object.values(getSettings().presets[imported.presetId].variables).map((v) => [v.name, v]));
        expect(byName.se__icon.defaultValue).toBe(PATH('a-1.png'));
        expect(byName.se__faces.defaultValue).toBe(JSON.stringify([PATH('a-1.png'), PATH('a-1.png')]));   // JSON text stays JSON text
        expect(byName.se__moods.defaultValue).toEqual({ k: PATH('a-1.png') });
    });

    it('unsafe or bogus embedded files are refused, reported, and the rest still import', async () => {
        const good = bytesToBase64(imageBytes('png', 1));
        const data = {
            name: 'Shared', variables: { icon: def('image', 'icon', PATH('good.png')) },
            stateEngineImages: {
                'good.png': good,
                '../evil.png': good,
                'sub/dir.png': good,
                'text.png': bytesToBase64(new TextEncoder().encode('<script>alert(1)</script>')),
                'notbase64.png': '@@@@',
                'number.png': 5,
            },
        };
        const target = fakeServer();
        const imported = await importPresetWithImages(data, target.deps);
        expect(imported.images.restored).toBe(1);
        expect(imported.images.failed.sort()).toEqual(['../evil.png', 'notbase64.png', 'number.png', 'sub/dir.png', 'text.png']);
        expect([...target.files.keys()]).toEqual(['good.png']);
    });

    it('a preset with no embedded images imports as before, references untouched', async () => {
        makePreset({ icon: def('image', 'icon', PATH('a.png')), remote: def('image', 'remote', 'https://x.test/r.png') });
        const target = fakeServer();
        const imported = await importPresetWithImages(exportPreset('p1'), target.deps);
        expect(imported.images).toEqual({ restored: 0, reused: 0, failed: [] });
        expect(target.deps.fetchImpl).not.toHaveBeenCalledWith('/api/images/upload', expect.anything());
        // (imported into the same settings, so the variables were renamed to stay unique)
        const stored = Object.values(getSettings().presets[imported.presetId].variables).map((v) => v.defaultValue);
        expect(stored.sort()).toEqual([PATH('a.png'), 'https://x.test/r.png'].sort());
    });

    it('the plain synchronous import never stores embedded files in settings, and rejects non-presets', async () => {
        const result = importPresetDetailed({ name: 'x', variables: {}, stateEngineImages: { 'a.png': 'AAAA' } });
        expect(getSettings().presets[result.presetId].stateEngineImages).toBeUndefined();
        await expect(importPresetWithImages('nope')).resolves.toBe(null);
        await expect(importPresetWithImages({ name: 'x' }, fakeServer().deps)).resolves.toBe(null);
    });

    it('a lorebook bundle carries the images of its presets', async () => {
        makePreset({ icon: def('image', 'icon', PATH('a.png')) });
        const server = fakeServer({ 'a.png': bytesToBase64(imageBytes('png', 1)) });
        context.loadWorldInfo = async () => ({ entries: {} });
        vi.stubGlobal('fetch', server.deps.fetchImpl);
        try {
            bindPresetToLorebook('Book', 'Book', 'p1');
            const bundle = await exportLorebookBundle('Book', 'Book');
            expect(bundle.stateEngine.presets.p1.stateEngineImages).toEqual({ 'a.png': bytesToBase64(imageBytes('png', 1)) });
        } finally {
            vi.unstubAllGlobals();
            delete context.loadWorldInfo;
        }
    });

    it('restoreEmbeddedImages with nothing embedded returns a clean copy', async () => {
        const source = { name: 'x', variables: {} };
        const report = await restoreEmbeddedImages(source, fakeServer().deps);
        expect(report).toMatchObject({ restored: 0, reused: 0, failed: [] });
        expect(report.data).toEqual(source);
        expect(report.data).not.toBe(source);
    });

    it('embedManagedImages never mutates its input', async () => {
        const input = { name: 'x', variables: { a: def('image', 'a', PATH('a.png')) } };
        const before = JSON.stringify(input);
        await embedManagedImages(input, fakeServer({ 'a.png': bytesToBase64(imageBytes('png')) }).deps);
        expect(JSON.stringify(input)).toBe(before);
    });
});
