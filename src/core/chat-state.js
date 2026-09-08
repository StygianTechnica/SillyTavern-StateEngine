// State Engine — isolated per-chat variable store
//
// This extension runs entirely in the browser (a SillyTavern front-end UI
// extension), which has no filesystem access - there is no `fs`, no Node
// runtime, and no build step in this project to provide one. A literal
// extensions/state-engine/data/chats/<chatId>.json layout with temp-file
// atomic writes is therefore not something this code can implement.
//
// Instead, this module backs the exact same API/schema shape onto
// context.extensionSettings[MODULE_NAME] - the same persistence substrate
// this extension already uses for its own settings and presets, saved via
// the existing getSettings()/persistSettings() (SillyTavern's
// saveSettingsDebounced()). That storage bucket is completely separate
// from SillyTavern's chat metadata, so State Engine variable values can
// never leak into or corrupt the chat prompt/request.
//
// This module is the single source of truth for State Engine variable
// *values*. It never reads or writes SillyTavern chat storage/metadata.

import { LOG_PREFIX, getSettings, persistSettings } from './settings-core.js';
import { setMacroValue, deleteMacroValue } from './macro-store.js';
import { getPresetsForChat, getAllVariablesFromPresets } from './preset-manager.js';

const SCHEMA_VERSION = 1;

function defaultChatState(characterAvatar, groupId) {
    return {
        variables: {},
        lastUpdated: Date.now(),
        version: SCHEMA_VERSION,
        seeded: false,
        // Which character or group this chat belongs to, so
        // cleanupDeadChats() can tell chats apart when deciding what's safe
        // to delete. Exactly one of these is ever set - a chat is either a
        // solo chat (characterAvatar) or a group chat (groupId). Only known
        // for certain at the moment a chat's entry is first created (see
        // loadChatState below) - both null when that can't be determined.
        characterAvatar: characterAvatar ?? null,
        groupId: groupId ?? null,
    };
}

function getStore() {
    const settings = getSettings();
    if (!settings.variableStore || typeof settings.variableStore !== 'object') {
        settings.variableStore = { chats: {} };
    }
    if (!settings.variableStore.chats || typeof settings.variableStore.chats !== 'object') {
        settings.variableStore.chats = {};
    }
    return settings.variableStore;
}

// Reads <chatId>'s state, or an empty default state if none has been saved
// yet. Never throws.
export function loadChatState(chatId) {
    try {
        if (!chatId) return defaultChatState();
        const store = getStore();
        const state = store.chats[chatId];
        if (!state || typeof state !== 'object') {
            const context = SillyTavern.getContext();
            if (context.groupId) {
                return defaultChatState(null, context.groupId);
            }
            const characterAvatar = context.characters?.[context.characterId]?.avatar ?? null;
            return defaultChatState(characterAvatar, null);
        }
        return state;
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        return defaultChatState();
    }
}

// Writes the full state object back for <chatId>. Never throws.
export function saveChatState(chatId, state) {
    try {
        if (!chatId) return;
        const store = getStore();
        store.chats[chatId] = state;
        persistSettings();
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

// Returns { value, def } for a stored variable, or undefined if it has
// never been written for this chat. `def` here is whatever
// type/behaviors/increment metadata was captured alongside the value (see
// setVar's optional def argument below) - it is a snapshot, not a live
// preset lookup.
export function getVar(chatId, varName) {
    try {
        const state = loadChatState(chatId);
        const entry = state.variables[varName];
        if (!entry) return undefined;

        // Look up the preset definition fresh
        const presetIds = getPresetsForChat(chatId);
        const defs = getAllVariablesFromPresets(presetIds);
        const def = defs[varName];

        return { value: entry.value, def };
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        return undefined;
    }
}


// Updates variables[varName].value and writes the state back — AND mirrors
// the same value into the macro-visible var store ({{getvar::name}}) via
// the existing setMacroValue()/macroStore() mechanism from macro-store.js.
// That mechanism is context.variables.local/global, not chat metadata, so
// this mirroring does not reintroduce chat storage.
//
// `def` is optional and not part of the originally specified 3-argument
// signature; when a caller passes it (a preset variable definition), it's
// snapshotted onto the stored entry as entry.def (the canonical schema at
// write time, never hand-copied individual fields that could drift out of
// sync with variable-schema.js) and used to route the macro-store mirror
// write to the right def.name/def.scope. Omitting it falls back to
// whatever def was already stored, and mirrors into the macro store as a
// chat-scoped variable named varName.
export function setVar(chatId, varName, value, def) {
    try {
        const state = loadChatState(chatId);

        // 1. Update the isolated store: the value, plus a snapshot of the
        // canonical schema (def) that produced it.
        const existing = state.variables[varName] || {};
        state.variables[varName] = {
            value,
            def: def ?? existing.def ?? null,
        };

        saveChatState(chatId, state);

        // 2. Mirror into macro store ({{getvar::name}})
        // Use the preset definition (def) for type/scope, NOT stored metadata.
        const macroDef = def || { name: varName, type: 'string' };
        setMacroValue(SillyTavern.getContext(), macroDef, value);

    } catch (err) {
        console.warn(LOG_PREFIX, 'setVar failed (gracefully handled)', err);
    }
}


// Reads the current value and writes back the next one — AND mirrors the
// result into the macro-visible var store the same way setVar does. For
// def.type === 'enum' this cycles through def.enumValues instead of adding
// delta (enum values are never coerced to numbers); every other type keeps
// the original numeric "read current value, add delta, write back" behavior.
export function applyIncrement(chatId, varName, delta, def) {
    try {
        const state = loadChatState(chatId);
        // Ensure entry exists
        let entry = state.variables[varName];
        if (!entry) {
            state.variables[varName] = { value: 0, def: def ?? null };
            entry = state.variables[varName];
        } else if (def) {
            // Keep the stored schema snapshot current. This never sources
            // delta itself - delta is always the caller's live argument,
            // read fresh from the current preset definitions before this
            // call, never from this (or any) stored snapshot.
            entry.def = def;
        }

        let next;
        if (def?.type === 'enum') {
            const list = Array.isArray(def.enumValues) ? def.enumValues : [];
            if (list.length === 0) {
                // Nothing to cycle through - leave the value untouched.
                saveChatState(chatId, state);
                return;
            }
            const idx = list.indexOf(entry.value);
            next = idx === -1 ? list[0] : list[(idx + 1) % list.length];
        } else {
            // Convert current value to number safely
            let current = Number(entry.value);
            if (Number.isNaN(current)) {
                console.warn(LOG_PREFIX, `applyIncrement: non-numeric value for "${varName}", defaulting to 0`);
                current = 0;
            }
            next = current + delta;
        }

        entry.value = next;
        saveChatState(chatId, state);

        // Mirror into macro-visible var store
        setMacroValue(
            SillyTavern.getContext(),
            def || { name: varName, type: 'number' },
            next
        );
    } catch (err) {
        console.warn(LOG_PREFIX, 'applyIncrement failed (gracefully handled)', err);
    }
}



// Seeds any preset variable that doesn't yet have an entry in this chat's
// isolated state, so the store (and the macro mirror) is never empty for a
// chat that has active presets. Writes exclusively through setVar() - never
// mutates state.variables directly - so the isolated store and the macro
// mirror stay in sync through the one write path.
//

// If a stored variable's snapshotted def.type no longer matches the
// variable's current type, its value is stale (a number left over from a
// number/boolean/enum definition, say) and must be reset to the new type's
// default rather than being reinterpreted. Never touches enumValues or
// defaultValue - only the stored value/def snapshot for this one chat.
export function resetValueIfTypeChanged(chatId, def) {
    try {
        if (!chatId || !def?.name || !def?.type) return;
        const state = loadChatState(chatId);
        const entry = state.variables[def.name];
        if (!entry) return;

        const oldType = entry.def?.type;
        const newType = def.type;
        if (!oldType || oldType === newType) return;

        const next = def.defaultValue ?? null;
        state.variables[def.name] = {
            value: next,
            def,
        };
        saveChatState(chatId, state);

        // Mirror into macro store
        setMacroValue(SillyTavern.getContext(), def, next);
    } catch (err) {
        console.warn(LOG_PREFIX, 'resetValueIfTypeChanged failed (gracefully handled)', err);
    }
}

export function seedVariablesForChat(chatId) {
    try {
        if (!chatId) return;
        const activePresetIds = getPresetsForChat(chatId);
        const variables = getAllVariablesFromPresets(activePresetIds);
        const state = loadChatState(chatId);

        for (const def of Object.values(variables)) {
            try {
                if (!def.name) continue;
                if (Object.prototype.hasOwnProperty.call(state.variables, def.name)) continue;

                const value = def.defaultValue ?? null;
                setVar(chatId, def.name, value, def);

            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        }

        for (const def of Object.values(variables)) {
            try {
                if (!def.name) continue;
                resetValueIfTypeChanged(chatId, def);
            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        }

        state.seeded = true;
        saveChatState(chatId, state);
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

// Mirrors this chat's already-stored isolated values into the macro-visible
// var store ({{getvar::name}}) via setVar() - never setMacroValue() directly.
// Used on CHAT_CHANGED, where (per spec 3.1) seeding is forbidden: this only
// republishes what's already in the isolated store, and skips any preset
// variable that has no stored entry yet - no defaults, no seeding, no new
// isolated-store entries are created.
export function hydrateMacroStoreForChat(chatId) {
    try {
        if (!chatId) return;
        const state = loadChatState(chatId);
        const activePresetIds = getPresetsForChat(chatId);
        const variables = getAllVariablesFromPresets(activePresetIds);

        for (const def of Object.values(variables)) {
            try {
                if (!def.name) continue;
                const stored = state.variables[def.name];
                if (!stored) continue; // not seeded yet - do not invent a value

                setVar(chatId, def.name, stored.value, def);
            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

// Deletes every macro-visible variable this chat's isolated state knows
// about, via deleteMacroValue() (the same macroStore mechanism setVar/
// applyIncrement already mirror through) - never chat metadata.
//
// context.variables.local only ever reflects the chat SillyTavern currently
// has open (it swaps automatically on chat switch); there is no API this
// extension can use to reach a *different* chat's macro variables. So this
// can only actually delete anything when chatId is the chat that's active
// right now - for any other chatId it safely no-ops (see cleanupDeadChats).
export function clearMacroVarsForChat(chatId) {
    try {
        if (!chatId) return;
        const context = SillyTavern.getContext();
        if (context.chatId !== chatId) return;

        const state = loadChatState(chatId);
        for (const varName of Object.keys(state.variables || {})) {
            try {
                deleteMacroValue(context, { name: varName });
            } catch (err) {
                console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
            }
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

// Fetches the real, current list of chat ids that exist on disk for a
// character avatar, via the same server endpoint SillyTavern's own "past
// chats" UI calls internally (getPastCharacterChats() in script.js) -
// there is no such list on getContext() itself. Confirmed against a live
// getContext() dump that no chatList (or equivalent) property exists there.
//
// Returns null - not an empty array - when the check itself couldn't be
// completed (network error, non-ok response), so callers can tell
// "verified: this character has zero chats" apart from "couldn't verify
// right now" and never delete on the latter. Only a 200 response whose
// body is exactly `{ error: true }` (character has no chat folder at all)
// counts as a verified empty list.
async function fetchExistingChatIdsForAvatar(context, avatar) {
    try {
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, simple: true }),
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (data && data.error === true) return [];
        return Object.values(data).map(c => c.file_id ?? String(c.file_name || '').replace(/\.jsonl$/, ''));
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
        return null;
    }
}

// Removes isolated-store entries for chats that no longer exist.
//
// context.chatList is not a real SillyTavern API - confirmed absent from a
// live getContext() dump. The only real way to check whether a chat still
// exists is POST /api/characters/chats, which is scoped to one character's
// avatar_url; there is no global "every chat that exists" endpoint. So:
//
//   1. Stored chats are grouped by the character avatar recorded on them
//      (state.characterAvatar, stamped by loadChatState when a chat's
//      entry is first created).
//   2. A recorded character that no longer appears in context.characters
//      at all has its chats deleted outright - that character (and so
//      those chats) can never again be reached through SillyTavern's UI or
//      re-verified through this API, so keeping the data serves no purpose.
//   3. A character that still exists has its real chat list fetched, and
//      only stored chats confirmed absent from it are deleted. A failed
//      fetch returns null, not an empty list, so a network hiccup is never
//      treated as "no chats live" - that was the exact shape of the bug
//      that used to wipe everything off an unreliable context.chatList.
//   4. Group chats follow the same pattern via state.groupId instead of
//      characterAvatar, using context.groups instead of context.characters.
//      A group's .chats field (an array of chat ids) is already present on
//      the group object with no server round-trip needed - confirmed
//      against SillyTavern's own source: context.groups is refreshed on
//      the same cadence as context.characters (both via getCharacters()),
//      so "group id no longer in context.groups" is exactly as reliable a
//      "this group is gone" signal as it is for characters.
//   5. Entries with neither characterAvatar nor groupId recorded (created
//      before these fields existed) are left alone, except the currently
//      active chat, which gets backfilled with whichever applies (the
//      active group, or the active character) so it becomes eligible for
//      verification on a future pass.
export async function cleanupDeadChats() {
    try {
        const context = SillyTavern.getContext();
        const store = getStore();

        // An empty context.characters is ambiguous between "this install
        // genuinely has zero characters" and "SillyTavern hasn't finished
        // loading them yet" - this function can run before that resolves
        // depending on extension-vs-core-app load timing (registerEvents()
        // listens for APP_READY, but index.js also calls runStartupOnce()
        // directly right after registering, with no check for whether
        // APP_READY has actually fired - so this can still run early).
        // Never treat that ambiguity as "confirmed no characters exist" -
        // same rule this function already applies to a failed/non-ok
        // /api/characters/chats response. If characters really is
        // permanently empty (a fresh install), nothing in store.chats could
        // have a real characterAvatar stamped on it anyway, so skipping
        // here is always safe, not just safe in the race case.
        if (!Array.isArray(context.characters) || context.characters.length === 0) {
            console.warn(LOG_PREFIX, 'cleanupDeadChats: context.characters not populated yet - skipping this pass rather than treating every stored chat as dead');
            return;
        }

        const knownAvatars = new Set(context.characters.map(c => c.avatar));
        const groupsById = new Map((context.groups || []).map(g => [g.id, g]));

        const chatsByAvatar = new Map();
        const chatsByGroup = new Map();
        for (const [chatId, state] of Object.entries(store.chats)) {
            if (state?.groupId) {
                if (!chatsByGroup.has(state.groupId)) chatsByGroup.set(state.groupId, []);
                chatsByGroup.get(state.groupId).push(chatId);
                continue;
            }
            const avatar = state?.characterAvatar;
            if (!avatar) continue;
            if (!chatsByAvatar.has(avatar)) chatsByAvatar.set(avatar, []);
            chatsByAvatar.get(avatar).push(chatId);
        }

        for (const [avatar, chatIds] of chatsByAvatar) {
            let live;
            if (!knownAvatars.has(avatar)) {
                // Character no longer exists - its chats are unreachable, delete all of them.
                live = [];
            } else {
                live = await fetchExistingChatIdsForAvatar(context, avatar);
                if (live === null) continue; // couldn't verify this pass - leave alone, try again later
            }

            const liveSet = new Set(live);
            for (const chatId of chatIds) {
                if (liveSet.has(chatId)) continue;

                try {
                    clearMacroVarsForChat(chatId);
                } catch (err) {
                    console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
                }

                delete store.chats[chatId];
            }
        }

        for (const [groupId, chatIds] of chatsByGroup) {
            const group = groupsById.get(groupId);
            // Group gone entirely -> its chats are unreachable, delete all of them.
            // Group still exists -> group.chats is its authoritative chat-id list, no fetch needed.
            const liveSet = new Set(group ? (group.chats || []) : []);

            for (const chatId of chatIds) {
                if (liveSet.has(chatId)) continue;

                try {
                    clearMacroVarsForChat(chatId);
                } catch (err) {
                    console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
                }

                delete store.chats[chatId];
            }
        }

        // Backfill characterAvatar/groupId on the active chat if its entry
        // predates these fields, so it becomes eligible for verification later.
        const activeEntry = context.chatId ? store.chats[context.chatId] : null;
        if (activeEntry && !activeEntry.characterAvatar && !activeEntry.groupId) {
            if (context.groupId) {
                activeEntry.groupId = context.groupId;
            } else {
                const activeAvatar = context.characters?.[context.characterId]?.avatar;
                if (activeAvatar) {
                    activeEntry.characterAvatar = activeAvatar;
                }
            }
        }

        persistSettings();
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine error (gracefully handled)', err);
    }
}

export function migrateStateStore() {
    const store = getStore();
    for (const chatId of Object.keys(store.chats)) {
        const state = loadChatState(chatId);
        for (const name of Object.keys(state.variables)) {
            const value = state.variables[name].value;
            state.variables[name] = { value };
        }
        saveChatState(chatId, state);
    }
}
