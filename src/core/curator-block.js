// State Engine — the State block, for Curator
//
// A block of prompt text the user defines, filled with the open chat's
// variable values, that Curator (an optional extension) can inject into the
// prompt. It is a VIRTUAL variable, se__state_block: there is no stored
// value - getVariableValue() (variable-value-api.js) renders the template
// for the chat whenever it is read, so Curator always sends the current
// state. State Engine offers it to Curator by declaring the capability
// curator.inject:se__state_block on its built-in `se` record (Curator's
// docs/injection-blocks.md); the user ticks it in Curator's Prompt Analyzer.
//
// The template is text with {{<variable>}} placeholders. An object variable
// (a character, a list of characters...) shows its objects' NAMES, as State
// Engine's own macros do; {{<variable>.<field>}} shows a field of each
// object instead - its own (description, role...) or a runtime value
// (mood, thought...): "Syrvanus: Suspicious, the gremlin: Curious" for a
// list. By default the template is generated from one preset - Scene
// Context unless the user picks another in the drawer
// (settings.curatorBlock.presetName): a line per variable,
// "- <label>: {{<name>}}". The user can edit it freely
// (settings.curatorBlock.template; null = the generated default). When
// rendered, a line whose placeholders all come out empty is left out, and a
// block with no values at all is '' (Curator then sends nothing).

import { BUILTIN_NAMESPACE, getSettings, persistSettings } from './settings-core.js';
import { getVar } from './chat-state.js';
import { formatValueForDisplay } from '../ui/formatting-utils.js';
import { isObjectDefinition, objectValueText } from './object-display.js';
import { getObject } from './objects.js';

export const CURATOR_BLOCK_NAME = `${BUILTIN_NAMESPACE}__state_block`;
export const CURATOR_BLOCK_CAPABILITY = `curator.inject:${CURATOR_BLOCK_NAME}`;
// Curator sends it as a user message (its suggested-role capability).
export const CURATOR_BLOCK_ROLE_CAPABILITY = `curator.inject.role:user:${CURATOR_BLOCK_NAME}`;

// The block's first line: the model reads it as reference, not as text to
// continue or imitate.
export const REFERENCE_MARKER = 'REFERENCE ONLY — DO NOT CONTINUE';
export const DEFAULT_BLOCK_PRESET = 'Scene Context';

// The display definition the value API hands out for the block.
export const CURATOR_BLOCK_DEF = Object.freeze({
    name: CURATOR_BLOCK_NAME,
    label: 'State block',
    description: 'State Engine values as prompt text, from the template in State Engine\'s settings (Curator block).',
    type: 'string',
    scope: 'chat',
});

// {{se__name}} or {{se__name.field}}.
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*__[A-Za-z0-9_]+)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\}\}/g;

export function blockSettings() {
    const settings = getSettings();
    const raw = settings.curatorBlock && typeof settings.curatorBlock === 'object' ? settings.curatorBlock : {};
    return {
        presetName: typeof raw.presetName === 'string' && raw.presetName ? raw.presetName : DEFAULT_BLOCK_PRESET,
        // Blocks saved when the default heading still named State Engine
        // ("Scene Context (State Engine):") lose that label: the model
        // doesn't need to know where the text came from.
        template: typeof raw.template === 'string' ? raw.template.replace(/[ \t]*\(State Engine\)/g, '') : null,
    };
}

export function updateBlockSettings(patch) {
    const settings = getSettings();
    settings.curatorBlock = { ...blockSettings(), ...patch };
    persistSettings();
    return blockSettings();
}

export function findPresetByName(name) {
    const wanted = String(name ?? '').toLowerCase();
    return Object.values(getSettings().presets || {}).find((p) => String(p?.name ?? '').toLowerCase() === wanted) ?? null;
}

// The template generated from `preset`: a line per variable that holds a
// value worth stating - not images, not calculated ones (usually derived
// flags; add them by hand if wanted).
export function defaultTemplate(preset) {
    if (!preset) return '';
    const lines = Object.values(preset.variables || {})
        .filter((def) => def?.name && def.type !== 'calculated' && !/^image/.test(def.type ?? ''))
        .map((def) => `- ${def.label || def.name.split('__').pop()}: {{${def.name}}}`);
    return lines.length ? [`${preset.name}:`, ...lines].join('\n') : '';
}

// The template in use: the user's, else the default of the chosen preset.
export function currentTemplate() {
    const { presetName, template } = blockSettings();
    return template ?? defaultTemplate(findPresetByName(presetName));
}

function definitionOf(name) {
    for (const preset of Object.values(getSettings().presets || {})) {
        for (const def of Object.values(preset?.variables || {})) if (def?.name === name) return def;
    }
    return null;
}

// `field` of object `id` as the chat sees it: its own field, else a runtime
// value ('' when it has none).
function objectField(chatId, id, field) {
    let object = null;
    try {
        object = getObject(chatId, id);
    } catch {
        object = null;
    }
    if (!object) return '';
    const value = object[field] ?? object.runtime?.values?.[field] ?? (field === 'present' ? object.runtime?.present : undefined);
    if (value === null || value === undefined) return '';
    return Array.isArray(value) ? value.join(', ') : String(value);
}

// One variable's value in `chatId` as prompt text ('' when it has none);
// with `field`, that field of its object(s).
function valueText(chatId, name, field = null) {
    const entry = getVar(chatId, name);
    if (!entry || entry.value === null || entry.value === undefined || entry.value === '') return '';
    const def = definitionOf(name);
    const value = entry.value;
    if (def && isObjectDefinition(def)) {
        const ids = (Array.isArray(value) ? value : [value]).filter((id) => typeof id === 'string' && id);
        if (!field) return objectValueText(def, value) || '';
        if (def.type === 'object') return ids.length ? objectField(chatId, ids[0], field) : '';
        return ids.map((id) => {
            const text = objectField(chatId, id, field);
            return text ? `${objectField(chatId, id, 'name') || id}: ${text}` : '';
        }).filter(Boolean).join(', ');
    }
    if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
    try {
        const shown = def ? formatValueForDisplay(value, def) : value;
        return typeof shown === 'object' ? JSON.stringify(shown) : String(shown ?? '');
    } catch {
        return String(value);
    }
}

// `template` filled in for `chatId`. Lines whose placeholders are all empty
// go; with no value anywhere, ''. Other {{macros}} ({{user}}, {{char}}) are
// left to SillyTavern's own substitution when it can do it here.
export function renderBlock(chatId, template = currentTemplate()) {
    if (!chatId || !template) return '';
    let filled = 0;
    const lines = [];
    for (const line of String(template).split('\n')) {
        const found = [...line.matchAll(PLACEHOLDER)];
        if (found.length === 0) {
            lines.push(line);
            continue;
        }
        const key = (name, field) => `${name}.${field ?? ''}`;
        const values = new Map(found.map(([, name, field]) => [key(name, field), valueText(chatId, name, field)]));
        if ([...values.values()].every((v) => v === '')) continue;
        filled++;
        lines.push(line.replace(PLACEHOLDER, (_, name, field) => values.get(key(name, field)) ?? ''));
    }
    if (filled === 0) return '';
    let text = lines.join('\n').trim();
    try {
        const substitute = SillyTavern.getContext()?.substituteParams;
        if (typeof substitute === 'function') text = substitute(text);
    } catch {
        // No SillyTavern context: macros stay as written.
    }
    return `${REFERENCE_MARKER}\n${text}`;
}

// The built-in `se` record offers the block to Curator, as a user message.
// Idempotent.
export function ensureCuratorBlockCapability() {
    const record = getSettings().extensions?.[BUILTIN_NAMESPACE];
    if (!record) return;
    const capabilities = Array.isArray(record.capabilities) ? record.capabilities : [];
    const missing = [CURATOR_BLOCK_CAPABILITY, CURATOR_BLOCK_ROLE_CAPABILITY].filter((c) => !capabilities.includes(c));
    if (missing.length === 0) return;
    record.capabilities = [...capabilities, ...missing];
    persistSettings();
}
