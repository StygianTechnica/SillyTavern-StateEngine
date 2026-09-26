// @vitest-environment jsdom
//
// stateEngine.importImageFile: another extension storing an image through State
// Engine's own import pipeline, into a folder of its choosing. A fake SillyTavern
// image server stands in for /api/images/*.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../harness/context.js';
import ensureInstanceId from '../harness/instance.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import { IMPORT_FOLDER } from '../../src/core/image-import.js';

const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
const png = (name = 'Clock Face.png') => new File([new Uint8Array(PNG)], name, { type: 'image/png' });

let instanceId;
let server;

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    const files = new Map();
    const log = { uploads: [], lists: [] };
    server = { files, log };
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        const body = JSON.parse(init?.body ?? '{}');
        if (url === '/api/images/list') {
            log.lists.push(body.folder);
            return json([...files.keys()].filter((k) => k.startsWith(`${body.folder}/`)).map((k) => k.slice(body.folder.length + 1)));
        }
        if (url === '/api/images/upload') {
            log.uploads.push(body);
            files.set(`${body.ch_name}/${body.filename}`, body.image);
            return json({ path: `/user/images/${body.ch_name}/${body.filename}` });
        }
        throw new Error(`unexpected request ${url}`);
    }));
});

afterEach(() => vi.unstubAllGlobals());

describe('stateEngine.importImageFile', () => {
    it('stores the file in the caller\'s folder and returns a relative path', async () => {
        const path = await stateEngine.importImageFile('pp', instanceId, png(), { folder: 'pretty-panels-theme-assets' });
        expect(path).toBe('user/images/pretty-panels-theme-assets/Clock Face.png');
        expect(server.log.uploads[0]).toMatchObject({ ch_name: 'pretty-panels-theme-assets', format: 'png', filename: 'Clock Face.png' });
        expect(server.log.lists).toEqual(['pretty-panels-theme-assets']);
    });

    it('never reuses a name already in that folder', async () => {
        const first = await stateEngine.importImageFile('pp', instanceId, png('face.png'), { folder: 'pp-assets' });
        const second = await stateEngine.importImageFile('pp', instanceId, png('face.png'), { folder: 'pp-assets' });
        expect(first).toBe('user/images/pp-assets/face.png');
        expect(second).toBe('user/images/pp-assets/face-1.png');
    });

    it('defaults to State Engine\'s own folder', async () => {
        const path = await stateEngine.importImageFile('pp', instanceId, png('x.png'));
        expect(path).toBe(`user/images/${IMPORT_FOLDER}/x.png`);
    });

    it('applies State Engine\'s own checks (no SVG, real image bytes)', async () => {
        await expect(stateEngine.importImageFile('pp', instanceId, new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }), { folder: 'pp' }))
            .rejects.toThrow(/SVG images cannot be imported/);
        await expect(stateEngine.importImageFile('pp', instanceId, new File(['not an image'], 'a.png', { type: 'image/png' }), { folder: 'pp' }))
            .rejects.toThrow(/not a supported image/);
        expect(server.log.uploads).toHaveLength(0);
    });

    it('refuses a folder that is not a plain name', async () => {
        for (const folder of ['../escape', 'a/b', '', '.hidden', 'with space']) {
            await expect(stateEngine.importImageFile('pp', instanceId, png(), { folder }), folder).rejects.toThrow(/not a usable folder name/);
        }
        expect(server.log.uploads).toHaveLength(0);
    });

    it('checks the caller\'s identity first', async () => {
        await expect(stateEngine.importImageFile('pp', 'wrong-instance', png(), { folder: 'pp' })).rejects.toThrow(/wrong instance/);
        await expect(stateEngine.importImageFile('nobody', instanceId, png(), { folder: 'pp' })).rejects.toThrow(/does not own a namespace/);
        expect(server.log.uploads).toHaveLength(0);
    });
});
