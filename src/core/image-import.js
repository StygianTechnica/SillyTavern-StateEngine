// State Engine — portable image import for image variables.
//
// A dropped image file becomes a PORTABLE reference: a relative path to a copy of
// the file that State Engine stores on the SillyTavern server, never anything that
// only works on this machine or in this tab. Nothing stored is ever an absolute OS
// path, a blob: URL, another temporary browser URL or a data: URL.
//
// Where the copy goes (and why it is not public/state-engine-images/):
//   A browser extension cannot write into SillyTavern/public/, and a browser never
//   tells a page where a dropped file lives on disk - so the "is it already inside
//   public/?" question cannot be asked. What SillyTavern DOES provide is
//   POST /api/images/upload, which saves into the user's own image folder
//     data/<user>/user/images/<folder>/<file>
//   and serves it at the relative path
//     user/images/<folder>/<file>
//   (the same route other extensions use for their images). State Engine uses the
//   folder "state-engine-images", so a reference is always
//     user/images/state-engine-images/<file>
//   which survives reloads, works for every chat and is the same string on every
//   install. Exporting a preset embeds the files it references and importing puts
//   them back in the same folder (rewriting the paths if a name is taken by a
//   different file), so a shared preset keeps its pictures.
//
// Other extensions use the same pipeline through the public API
// (stateEngine.importImageFile, src/api/image-api.js) with a folder of their
// own: every function below that touches the folder takes an optional `folder`
// (a plain name, isImportFolderName), defaulting to State Engine's.
//
// Network access is through `deps` ({ fetchImpl, headers }) so it can be tested.

import { LOG_PREFIX } from './settings-core.js';
import { isImageType } from './image-variables.js';

export const IMPORT_FOLDER = 'state-engine-images';
export const IMPORT_PATH_PREFIX = `user/images/${IMPORT_FOLDER}/`;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// A folder name another caller may import into: letters, digits, "_" and "-",
// starting with a letter or digit - one folder under user/images/, never a path.
export function isImportFolderName(folder) {
    return typeof folder === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder);
}

// "user/images/<folder>/" - the relative prefix of every path in `folder`.
export function importPathPrefix(folder = IMPORT_FOLDER) {
    return `user/images/${folder}/`;
}

// The formats SillyTavern's upload endpoint accepts as images (its MEDIA_EXTENSIONS),
// minus jfif. No SVG: an SVG opened directly runs scripts in SillyTavern's origin.
export const IMPORT_FORMATS = Object.freeze({
    png: ['png'],
    jpeg: ['jpg', 'jpeg'],
    gif: ['gif'],
    webp: ['webp'],
    bmp: ['bmp'],
});
const FORMAT_LIST = 'png, jpg, gif, webp, bmp';

const defaultDeps = () => ({
    fetchImpl: (...args) => fetch(...args),
    headers: () => {
        try { return SillyTavern.getContext().getRequestHeaders(); } catch { return { 'Content-Type': 'application/json' }; }
    },
});

// ---- what a reference may be ----------------------------------------------------

// A path State Engine itself produced: "user/images/state-engine-images/<file>"
// (or the same inside `folder`), one file name, no folders, no "..", no query or
// fragment.
export function isManagedImagePath(ref, folder = IMPORT_FOLDER) {
    const prefix = importPathPrefix(folder);
    if (typeof ref !== 'string' || !ref.startsWith(prefix)) return false;
    const name = ref.slice(prefix.length);
    return name !== '' && !/[\\/?#\u0000-\u001f]/.test(name) && name !== '.' && name !== '..' && !name.includes('..');
}

// Why a typed or pasted reference is not portable, or null when it is fine. Refused:
//   blob:   a temporary URL that dies with the tab
//   file:, C:\..., \\server\..., /Users/..., /home/...   a path on THIS computer
// URLs and relative paths pass (data: URLs and http(s) URLs are still allowed when
// typed; drag-and-drop never produces them).
const OS_ABSOLUTE = /^(file:|[a-z]:[\\/]|\\\\|\/(users|home|mnt|volumes|tmp|var|private|opt|etc|root|proc|dev)\/)/i;
export function nonPortableReason(ref) {
    if (typeof ref !== 'string') return null;
    const text = ref.trim();
    if (/^blob:/i.test(text)) return 'a blob: URL is temporary - it stops working when the page reloads';
    if (OS_ABSOLUTE.test(text)) return 'an absolute path on this computer only works here';
    return null;
}

// ---- reading and naming files -----------------------------------------------------

// The image format a file's first bytes declare, or null.
export function sniffImageFamily(bytes) {
    if (!bytes || bytes.length < 4) return null;
    const at = (i) => bytes[i];
    if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png';
    if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg';
    if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'gif';
    if (bytes.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
        && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'webp';
    if (at(0) === 0x42 && at(1) === 0x4d) return 'bmp';
    return null;
}

// The extension to save under: the file's own when it is one the format uses,
// otherwise the format's usual one.
export function extensionFor(family, originalExtension) {
    const allowed = IMPORT_FORMATS[family] || [];
    const own = String(originalExtension || '').toLowerCase();
    return allowed.includes(own) ? own : allowed[0];
}

// A file name reduced to something safe to store and to type in a URL: no folders,
// no extension, letters/digits/space/underscore/hyphen only (a dot in the middle of a
// name would make SillyTavern's endpoint mistake it for an extension). Never empty.
export function safeBaseName(filename) {
    const last = String(filename ?? '').split(/[\\/]/).pop() || '';
    const noExt = last.replace(/\.[^.]*$/, '');
    const cleaned = noExt.normalize('NFC')
        .replace(/[^\p{L}\p{N} _-]+/gu, '_')
        .replace(/[ _]{2,}/g, '_')
        .replace(/^[\s_.-]+|[\s_.-]+$/g, '')
        .slice(0, 80);
    return cleaned || 'image';
}

// "name.ext", or "name-1.ext", "name-2.ext"... - the first not in `taken` (a Set of
// lower-cased file names; the file system may ignore case).
export function uniqueFileName(base, ext, taken) {
    let candidate = `${base}.${ext}`;
    for (let n = 1; taken.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}.${ext}`;
    return candidate;
}

export function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return btoa(binary);
}

export function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function readFileBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('the file could not be read'));
        reader.onload = () => {
            const text = String(reader.result || '');
            resolve(text.slice(text.indexOf(',') + 1)); // strip "data:<mime>;base64,"
        };
        reader.readAsDataURL(file);
    });
}

// ---- the server folder -------------------------------------------------------------

// The file names already in the import folder (or `folder`), as a Set of
// lower-cased names, or null when the list could not be read.
export async function listImportedNames(deps = defaultDeps(), folder = IMPORT_FOLDER) {
    try {
        const response = await deps.fetchImpl('/api/images/list', {
            method: 'POST',
            headers: deps.headers(),
            body: JSON.stringify({ folder }),
        });
        if (!response.ok) return null;
        const names = await response.json();
        return Array.isArray(names) ? new Set(names.filter((n) => typeof n === 'string').map((n) => n.toLowerCase())) : null;
    } catch {
        return null;
    }
}

async function uploadBase64(base64, ext, base, deps, folder = IMPORT_FOLDER) {
    const response = await deps.fetchImpl('/api/images/upload', {
        method: 'POST',
        headers: deps.headers(),
        body: JSON.stringify({ image: base64, format: ext, filename: `${base}.${ext}`, ch_name: folder }),
    });
    if (!response.ok) throw new Error(`the server refused the upload (${response.status})`);
    const body = await response.json();
    // The server's answer is authoritative (it may have sanitized the name), but it
    // must be a path inside OUR folder - anything else is not stored. SillyTavern
    // answers with a LEADING slash ("/user/images/state-engine-images/a.png", checked
    // against a real server); the stored form is the relative one, without it.
    const path = typeof body?.path === 'string' ? body.path.replace(/^\/+/, '') : '';
    if (!isManagedImagePath(path, folder)) throw new Error('the server returned an unexpected path');
    return path;
}

// ---- importing dropped files --------------------------------------------------------

// Checks one dropped File and copies it into the import folder.
// -> { path, name }. Rejects with an Error whose message says why:
//   not an image / not a format we accept / SVG / empty / too large / unreadable /
//   upload failed. `alsoTaken` (a Set of lower-cased names) is names already used by
//   earlier files of the same drop; the folder itself is listed for every file.
//   `folder` (default State Engine's own) is where the copy goes.
export async function importImageFile(file, deps = defaultDeps(), alsoTaken = new Set(), folder = IMPORT_FOLDER) {
    if (!isImportFolderName(folder)) throw new Error(`"${folder}" is not a usable image folder name`);
    if (!file || typeof file.name !== 'string') throw new Error('that is not a file');
    const originalExtension = (file.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
    const mime = String(file.type || '').toLowerCase();

    if (originalExtension === 'svg' || mime === 'image/svg+xml') throw new Error(`SVG images cannot be imported (they can contain scripts). Use ${FORMAT_LIST}.`);
    if (mime && !mime.startsWith('image/')) throw new Error(`only image files can be imported (${FORMAT_LIST})`);
    if (!mime && !Object.values(IMPORT_FORMATS).flat().includes(originalExtension)) throw new Error(`only image files can be imported (${FORMAT_LIST})`);
    if (file.size === 0) throw new Error('the file is empty');
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`the file is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);

    const base64 = await readFileBase64(file);
    const family = sniffImageFamily(base64ToBytes(base64.slice(0, 24)));
    if (!family) throw new Error(`that file is not a supported image (${FORMAT_LIST})`);

    const ext = extensionFor(family, originalExtension);
    const base = safeBaseName(file.name);
    // The server overwrites a same-named file silently, so the name must be unused. If
    // the folder cannot be listed, a timestamp makes a clash practically impossible.
    const listed = await listImportedNames(deps, folder);
    const names = new Set([...(listed ?? []), ...alsoTaken]);
    const name = uniqueFileName(listed ? base : `${base}-${Date.now()}`, ext, names);

    const path = await uploadBase64(base64, ext, name.slice(0, -(ext.length + 1)), deps, folder);
    const prefix = importPathPrefix(folder);
    alsoTaken.add(path.slice(prefix.length).toLowerCase());
    return { path, name: path.slice(prefix.length) };
}

// Imports several dropped files one after another (so two files with the same name
// cannot collide). Never throws: { imported: [{ path, name }], errors: [{ file, error }] }.
export async function importImageFiles(files, deps = defaultDeps()) {
    const result = { imported: [], errors: [] };
    const alsoTaken = new Set();
    for (const file of Array.from(files || [])) {
        try {
            result.imported.push(await importImageFile(file, deps, alsoTaken));
        } catch (err) {
            console.warn(LOG_PREFIX, `image import: "${file?.name}" was not imported`, err);
            result.errors.push({ file: file?.name ?? '', error: err?.message || String(err) });
        }
    }
    return result;
}

// ---- references inside definitions ---------------------------------------------------

function parsedDefault(value) {
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { return value; }
    }
    return value;
}

// Every reference string an image variable's DEFAULT holds ([] for other types).
export function imageRefsOfDefinition(def) {
    if (!def || !isImageType(def.type)) return [];
    const value = def.type === 'image' ? def.defaultValue : parsedDefault(def.defaultValue);
    if (def.type === 'image') return typeof value === 'string' && value ? [value] : [];
    if (def.type === 'imageList') return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value).filter((v) => typeof v === 'string') : [];
}

// A copy of `def` with every reference in its default passed through `map(ref)`,
// keeping the default's shape (an array/object stays one, JSON text stays JSON text).
export function mapImageRefs(def, map) {
    if (!def || !isImageType(def.type)) return def;
    const copy = { ...def };
    const wasText = typeof def.defaultValue === 'string' && def.type !== 'image';
    const value = def.type === 'image' ? def.defaultValue : parsedDefault(def.defaultValue);
    let mapped = value;
    if (def.type === 'image') mapped = typeof value === 'string' ? map(value) : value;
    else if (def.type === 'imageList' && Array.isArray(value)) mapped = value.map((v) => (typeof v === 'string' ? map(v) : v));
    else if (def.type === 'imageMap' && value && typeof value === 'object' && !Array.isArray(value)) {
        mapped = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'string' ? map(v) : v]));
    } else return def;
    copy.defaultValue = wasText ? JSON.stringify(mapped) : mapped;
    return copy;
}

// The first non-portable reference in a variable's default, or null:
// { reference, reason }. Used by the manager modal before it saves.
export function firstNonPortableReference(def) {
    for (const reference of imageRefsOfDefinition(def)) {
        const reason = nonPortableReason(reference);
        if (reason) return { reference, reason };
    }
    return null;
}

export function collectManagedPaths(preset) {
    const paths = new Set();
    for (const def of Object.values(preset?.variables || {})) {
        for (const ref of imageRefsOfDefinition(def)) if (isManagedImagePath(ref.trim())) paths.add(ref.trim());
    }
    return paths;
}

// ---- export / import of the files themselves ------------------------------------------

// Adds the files a preset's image variables reference to a COPY of its export data,
// under `stateEngineImages: { "<file name>": "<base64>" }`, and reports what could not
// be read: { data, missing: [paths] }. Only files in the import folder are embedded;
// a reference to anything else (a URL, another path) is left as it is.
export async function embedManagedImages(presetData, deps = defaultDeps()) {
    const data = JSON.parse(JSON.stringify(presetData));
    const files = {};
    const missing = [];
    for (const path of collectManagedPaths(data)) {
        try {
            const response = await deps.fetchImpl(`/${path}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || !sniffImageFamily(bytes)) throw new Error('not a usable image');
            files[path.slice(IMPORT_PATH_PREFIX.length)] = bytesToBase64(bytes);
        } catch (err) {
            console.warn(LOG_PREFIX, `export: could not include "${path}"`, err);
            missing.push(path);
        }
    }
    if (Object.keys(files).length > 0) data.stateEngineImages = files;
    return { data, missing };
}

// Puts the embedded files back into the import folder and rewrites the preset's
// references to where they now are. Returns
// { data (a copy without stateEngineImages), restored, reused, failed: [file names] }.
//   - a name not in the folder yet is uploaded as is
//   - a name that is taken by an IDENTICAL file is reused (no duplicate)
//   - a name taken by a DIFFERENT file gets a numeric suffix, and the references follow
// Everything embedded is checked first: a safe file name, a real image, a sane size.
export async function restoreEmbeddedImages(presetData, deps = defaultDeps()) {
    const data = JSON.parse(JSON.stringify(presetData));
    const embedded = data.stateEngineImages;
    delete data.stateEngineImages;
    const report = { data, restored: 0, reused: 0, failed: [] };
    if (!embedded || typeof embedded !== 'object' || Array.isArray(embedded)) return report;

    const taken = await listImportedNames(deps) ?? new Set();
    const pathMap = new Map();

    for (const [fileName, base64] of Object.entries(embedded)) {
        try {
            if (typeof fileName !== 'string' || typeof base64 !== 'string' || !isManagedImagePath(IMPORT_PATH_PREFIX + fileName)) throw new Error('unsafe file name');
            const bytes = base64ToBytes(base64);
            const family = sniffImageFamily(bytes);
            if (!family || bytes.length > MAX_IMAGE_BYTES) throw new Error('not a usable image');

            const ext = extensionFor(family, (fileName.match(/\.([^.]+)$/) || [])[1]);
            const base = safeBaseName(fileName);
            const wanted = `${base}.${ext}`;
            let target = wanted;

            if (taken.has(wanted.toLowerCase())) {
                // Same name already there: identical bytes -> reuse it, else a new name.
                const existing = await deps.fetchImpl(`/${IMPORT_PATH_PREFIX}${wanted}`).catch(() => null);
                if (existing?.ok && bytesToBase64(new Uint8Array(await existing.arrayBuffer())) === base64) {
                    pathMap.set(IMPORT_PATH_PREFIX + fileName, IMPORT_PATH_PREFIX + wanted);
                    report.reused += 1;
                    continue;
                }
                target = uniqueFileName(base, ext, taken);
            }

            const path = await uploadBase64(base64, ext, target.slice(0, -(ext.length + 1)), deps);
            taken.add(path.slice(IMPORT_PATH_PREFIX.length).toLowerCase());
            pathMap.set(IMPORT_PATH_PREFIX + fileName, path);
            report.restored += 1;
        } catch (err) {
            console.warn(LOG_PREFIX, `import: could not restore "${fileName}"`, err);
            report.failed.push(fileName);
        }
    }

    if (pathMap.size > 0) {
        for (const [id, def] of Object.entries(data.variables || {})) {
            data.variables[id] = mapImageRefs(def, (ref) => pathMap.get(ref.trim()) ?? ref);
        }
    }
    return report;
}
