// State Engine — lorebook -> preset bindings
//
// settings.lorebookPresetBindings: { [worldName]: { [lorebookId]: [presetId, ...] } }
//
// In SillyTavern a lorebook is identified by its book name, and that same name
// is the `world` on every entry (and the prefix of every WI condition key,
// "<world>.<uid>"). So worldName and lorebookId are the same string for a real
// lorebook; both are kept because the storage shape asks for both. Where a
// caller leaves lorebookId out it defaults to the world.

import { LOG_PREFIX, getSettings, persistSettings } from './settings-core.js';
import { normalizeWorldName } from '../world-info/world-names.js';

// World names go through normalizeWorldName() like every other key State Engine
// builds from a lorebook name; a lorebookId defaults to its world.
function cleanWorld(world) {
    return normalizeWorldName({ world: typeof world === 'string' ? world.trim() : '' });
}

function cleanName(value, fallback) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

// ---------------------------------------------------------------------------
// Declined activation prompts (settings.lorebookPresetDeclines)
// ---------------------------------------------------------------------------
// { [chatId]: ["<world>|<lorebookId>|<presetId>", ...] } - the presets a user
// said No to for a chat, so the prompt is not repeated on every chat load.

export function declineKey(world, lorebookId, presetId) {
    return `${world}|${lorebookId}|${presetId}`;
}

// Removes every decline for which `matches(key, chatId)` is true; saves when
// something was removed. Returns how many were removed.
function dropDeclines(matches) {
    const declines = getSettings().lorebookPresetDeclines;
    let removed = 0;
    for (const [chatId, keys] of Object.entries(declines)) {
        if (!Array.isArray(keys)) continue;
        const kept = keys.filter((key) => !matches(key, chatId));
        removed += keys.length - kept.length;
        if (kept.length === 0) delete declines[chatId];
        else if (kept.length !== keys.length) declines[chatId] = kept;
    }
    if (removed > 0) persistSettings();
    return removed;
}

// The "Clear Declines" button: forget every declined prompt, in every chat, so
// the presets are offered again. Returns how many were forgotten.
export function clearLorebookPresetDeclines() {
    const total = Object.values(getSettings().lorebookPresetDeclines)
        .reduce((n, keys) => n + (Array.isArray(keys) ? keys.length : 0), 0);
    getSettings().lorebookPresetDeclines = {};
    if (total > 0) persistSettings();
    return total;
}

// A binding for this lorebook changed: what was declined no longer describes it.
function clearDeclinesForBinding(world, lorebookId) {
    const prefix = `${world}|${lorebookId}|`;
    return dropDeclines((key) => typeof key === 'string' && key.startsWith(prefix));
}

// The user activated this preset in this chat themselves: its declines go.
export function clearDeclinesForPreset(chatId, presetId) {
    const suffix = `|${presetId}`;
    return dropDeclines((key, id) => id === chatId && typeof key === 'string' && key.endsWith(suffix));
}

// Keeps only the declines of lorebooks still attached to the chat: a lorebook
// that was unassigned takes its declines with it. `activeBooks` are lorebook names.
export function pruneDeclinesForChat(chatId, activeBooks) {
    const keys = getSettings().lorebookPresetDeclines[chatId];
    if (!Array.isArray(keys) || keys.length === 0) return 0;
    const attached = (key) => typeof key === 'string' && activeBooks.some((b) => key.startsWith(`${b}|${b}|`));
    return dropDeclines((key, id) => id === chatId && !attached(key));
}

function presetExists(presetId) {
    return typeof presetId === 'string' && !!getSettings().presets?.[presetId];
}

// The preset ids bound to a lorebook that still exist (a deleted preset is
// skipped, not returned). A copy - edit through bind/unbind.
export function getPresetsForLorebook(world, lorebookId) {
    const worldName = cleanWorld(world);
    const id = cleanName(lorebookId, worldName);
    const list = getSettings().lorebookPresetBindings?.[worldName]?.[id];
    return Array.isArray(list) ? list.filter(presetExists) : [];
}

// Binds a preset to a lorebook. Returns true when it is bound afterwards (also
// when it already was), false for an unknown preset. Persists on a change.
export function bindPresetToLorebook(world, lorebookId, presetId) {
    if (!presetExists(presetId)) {
        console.warn(LOG_PREFIX, `bindPresetToLorebook: preset "${presetId}" does not exist`);
        return false;
    }
    const worldName = cleanWorld(world);
    const id = cleanName(lorebookId, worldName);
    const bindings = getSettings().lorebookPresetBindings;
    if (!bindings[worldName]) bindings[worldName] = {};
    if (!Array.isArray(bindings[worldName][id])) bindings[worldName][id] = [];
    if (!bindings[worldName][id].includes(presetId)) {
        bindings[worldName][id].push(presetId);
        clearDeclinesForBinding(worldName, id); // the binding changed: ask again
        persistSettings();
    }
    return true;
}

// Removes a binding. Returns true when one was removed. Empty containers are
// removed with it. Persists on a change.
export function unbindPresetFromLorebook(world, lorebookId, presetId) {
    const worldName = cleanWorld(world);
    const id = cleanName(lorebookId, worldName);
    const bindings = getSettings().lorebookPresetBindings;
    const list = bindings[worldName]?.[id];
    if (!Array.isArray(list) || !list.includes(presetId)) return false;

    bindings[worldName][id] = list.filter((p) => p !== presetId);
    if (bindings[worldName][id].length === 0) delete bindings[worldName][id];
    if (Object.keys(bindings[worldName]).length === 0) delete bindings[worldName];
    clearDeclinesForBinding(worldName, id); // the binding changed
    persistSettings();
    return true;
}

// A copy of every binding: { [world]: { [lorebookId]: [presetId, ...] } }.
export function getLorebookBindings() {
    return JSON.parse(JSON.stringify(getSettings().lorebookPresetBindings || {}));
}

// ---------------------------------------------------------------------------
// Which lorebooks exist / are active (SillyTavern 1.18 - verified against its
// source: context.getWorldInfoNames(), chatMetadata.world_info,
// characters[i].data.extensions.world, and the #world_info global-select list).
// ---------------------------------------------------------------------------

// Names of every lorebook the user has. Falls back to what State Engine itself
// knows about (bound lorebooks, lorebooks with conditions) when ST's list is
// not available.
export function listLorebookNames() {
    const names = new Set();
    try {
        const context = SillyTavern.getContext();
        for (const name of context.getWorldInfoNames?.() || []) names.add(name);
    } catch { /* not available - use the fallbacks below */ }

    const settings = getSettings();
    for (const world of Object.keys(settings.lorebookPresetBindings || {})) names.add(world);
    for (const key of Object.keys(settings.wiConditions || {})) {
        const dot = key.indexOf('.');
        if (dot > 0) names.add(key.slice(0, dot));
    }
    return [...names].sort((a, b) => a.localeCompare(b));
}

// A character's ADDITIONAL lorebooks (Character Lore -> "additional books") are
// not on the character card: SillyTavern keeps them in world-info.js's
// `world_info.charLore` ([{ name: <avatar file name without extension>,
// extraBooks: [...] }]), which the extension context does not expose. The module
// is imported once, in the background (the path is relative to this file, which
// sits at <ST>/scripts/extensions/third-party/<extension>/src/core/); `world_info`
// is a live export, so reading it later always sees the current value. Until it
// has loaded (or where it cannot be - tests), additional books are simply not
// seen.
let stWorldInfoModule = null;
try {
    const stWorldInfoPath = '../../../../../world-info.js';
    import(/* @vite-ignore */ stWorldInfoPath).then((m) => { stWorldInfoModule = m; }).catch(() => {});
} catch { /* no dynamic import here */ }

// For tests: stand in for SillyTavern's world-info.js module.
export function setStWorldInfoModuleForTests(module) { stWorldInfoModule = module; }

function additionalBooksOf(character) {
    const avatar = character?.avatar;
    if (typeof avatar !== 'string') return [];
    const fileName = avatar.replace(/\.[^/.]+$/, '');
    const entry = stWorldInfoModule?.world_info?.charLore?.find?.((e) => e?.name === fileName);
    return Array.isArray(entry?.extraBooks) ? entry.extraBooks.filter((b) => typeof b === 'string' && b) : [];
}

// Names of the lorebooks attached to the current chat: the chat's own lorebook,
// the character's - primary and additional (or every group member's) - the
// active persona's, and the globally selected ones.
export function getActiveLorebookNames() {
    const names = new Set();
    try {
        const context = SillyTavern.getContext();

        const chatBook = context.chatMetadata?.world_info;
        if (typeof chatBook === 'string' && chatBook) names.add(chatBook);

        // The active persona's lorebook (Persona Management -> lorebook).
        const personaBook = context.powerUserSettings?.persona_description_lorebook;
        if (typeof personaBook === 'string' && personaBook) names.add(personaBook);

        const characters = context.characters || [];
        const addCharacterBook = (character) => {
            const book = character?.data?.extensions?.world;
            if (typeof book === 'string' && book) names.add(book);
            for (const extra of additionalBooksOf(character)) names.add(extra);
        };
        if (context.groupId) {
            const group = (context.groups || []).find((g) => String(g.id) === String(context.groupId));
            for (const avatar of group?.members || []) addCharacterBook(characters.find((c) => c.avatar === avatar));
        } else if (context.characterId !== undefined && context.characterId !== null) {
            addCharacterBook(characters[context.characterId]);
        }
    } catch { /* keep whatever was found */ }

    // The globally selected books are only exposed through ST's own list.
    try {
        if (typeof document !== 'undefined') {
            document.querySelectorAll('#world_info option:checked').forEach((option) => {
                const name = option.textContent?.trim();
                if (name) names.add(name);
            });
        }
    } catch { /* no DOM */ }

    return [...names];
}
