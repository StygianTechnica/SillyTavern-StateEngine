// Image API
//
// Lets another extension store an image file exactly the way State Engine
// stores image-variable files (src/core/image-import.js): same checks (format
// read from the file's bytes - png, jpg, gif, webp, bmp; no SVG; 20 MB at
// most), same upload through SillyTavern's /api/images/upload, same unique
// file naming - into a folder of the caller's choosing under the user's
// images:
//
//   importImageFile(extensionId, instanceId, file, { folder })
//     -> "user/images/<folder>/<file>"   a relative path, portable across
//                                        reloads and installs
//
// `folder` is a plain name (letters, digits, "_" and "-"); left out, the file
// goes into State Engine's own "state-engine-images". Open to any registered
// caller (resolveCallerRecord). THROWS on failure - an identity error, a bad
// folder name, or the import's own reason ("SVG images cannot be imported...",
// "the file is larger than 20 MB", "the server refused the upload (500)") -
// because the caller has to be able to show the user why.

import { resolveCallerRecord } from './identity.js';
import { importImageFile as importIntoFolder, isImportFolderName, IMPORT_FOLDER } from '../core/image-import.js';

export async function importImageFile(extensionId, instanceId, file, options = {}) {
    resolveCallerRecord(extensionId, instanceId);
    const folder = options?.folder ?? IMPORT_FOLDER;
    if (!isImportFolderName(folder)) {
        throw new Error(`importImageFile: "${folder}" is not a usable folder name (letters, digits, "_" and "-")`);
    }
    const { path } = await importIntoFolder(file, undefined, new Set(), folder);
    return path;
}
