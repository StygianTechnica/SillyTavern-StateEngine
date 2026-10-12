// NEW EACH TURN for any variable (prompted.newEachTurn): the model is shown
// no current value and answers fresh every turn - in the main per-message
// update and in independent presets alike. Plus the record-list description
// it is most needed for, the editor field and the rules text.

import context from './harness/context.js';
import ensureInstanceId from './harness/instance.js';
import { registerNamespaces } from './harness/namespaces.js';
import { stateEngine } from '../src/api/index.js';
import { runPromptedStateUpdate } from '../src/core/prompted-engine.js';
import { callBackgroundLLM } from '../src/core/background-llm.js';
import { describeConstraint } from '../src/ui/formatting-utils.js';
import { normalizeCollectedValues } from '../src/ui/manager-modal/variable-ui-schema.js';
import { blankDefinition } from '../src/core/variable-schema.js';
import { DEFAULT_UNIFIED_VARIABLE_RULES } from '../src/core/settings-core.js';
import { setVar } from '../src/core/chat-state.js';

vi.mock('../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

let instanceId;

const MEMORIES = {
    type: 'array', itemType: 'record', itemSchema: { text: { type: 'string' } }, defaultValue: [],
    behaviors: { prompted: true, increment: false },
    prompted: { instructions: 'New memories from the latest message.', newEachTurn: true },
};
const NOTE = {
    type: 'string', defaultValue: '',
    behaviors: { prompted: true, increment: false },
    prompted: { instructions: 'A note about this turn.', newEachTurn: true },
};
const MOOD = {
    type: 'string', defaultValue: 'calm',
    behaviors: { prompted: true, increment: false },
    prompted: { instructions: 'The mood.' },
};

const create = (presetName, name, def) => stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName, name, ...def });
const prompt = () => callBackgroundLLM.mock.calls.at(-1)[2][0].content;
const lineFor = (name) => prompt().split('\n').find((line) => line.startsWith(`- "pp__${name}"`));

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp');
    callBackgroundLLM.mockReset();
    callBackgroundLLM.mockResolvedValue('{}');
    context.chat = [{ is_user: true, mes: 'hello' }, { is_user: false, name: 'Bot', mes: 'Mira hides the key.' }];
});

describe('the main per-message update', () => {
    beforeEach(() => {
        stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Main' });
        stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Main');
        create('Main', 'memories', MEMORIES);
        create('Main', 'note', NOTE);
        create('Main', 'mood', MOOD);
        setVar('chat-1', 'pp__note', 'last turn\'s note');
    });

    it('shows a NEW EACH TURN variable without its current value', async () => {
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(callBackgroundLLM).toHaveBeenCalled());
        expect(lineFor('note')).toBe('- "pp__note" [text; NEW EACH TURN] A note about this turn.');
        expect(prompt()).not.toContain('last turn\'s note');
    });

    it('lets a NEW EACH TURN list be empty, and describes a record list as objects', async () => {
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(callBackgroundLLM).toHaveBeenCalled());
        const line = lineFor('memories');
        expect(line).toContain('array of JSON objects');
        expect(line).toContain('(e.g. [{"text":"..."}])');
        expect(line).toContain('NEW EACH TURN - [] when nothing new applies]');
        expect(line).not.toContain('currently');
    });

    it('leaves other variables as they were', async () => {
        await runPromptedStateUpdate('ai');
        await vi.waitFor(() => expect(callBackgroundLLM).toHaveBeenCalled());
        expect(lineFor('mood')).toBe('- "pp__mood" [text] currently "calm". The mood.');
    });
});

describe('independent presets', () => {
    it('show a NEW EACH TURN variable the same way', async () => {
        stateEngine.createIndependentPreset('pp', instanceId, { namespace: 'pp', name: 'Indy' });
        create('Indy', 'memories', MEMORIES);
        create('Indy', 'mood', MOOD);
        await stateEngine.runIndependentPreset('pp', instanceId, 'chat-1', { namespace: 'pp', name: 'Indy' });
        expect(lineFor('memories')).toContain('NEW EACH TURN - [] when nothing new applies]');
        expect(lineFor('memories')).not.toContain('currently');
        expect(lineFor('mood')).toContain('currently "calm"');
    });
});

describe('definitions and the editor', () => {
    it('is off by default', () => {
        expect(blankDefinition().prompted.newEachTurn).toBe(false);
    });

    it('is kept by the API', () => {
        stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Defs' });
        create('Defs', 'note', NOTE);
        expect(stateEngine.getVariable('pp', instanceId, { namespace: 'pp', presetName: 'Defs', variableName: 'note' }).prompted.newEachTurn).toBe(true);
    });

    it('is saved from the editor checkbox', () => {
        expect(normalizeCollectedValues({ prompted: { instructions: 'x', newEachTurn: true } }).prompted).toEqual({ instructions: 'x', newEachTurn: true, answerLast: false });
        expect(normalizeCollectedValues({ prompted: { instructions: 'x', answerLast: true } }).prompted).toEqual({ instructions: 'x', newEachTurn: false, answerLast: true });
        expect(normalizeCollectedValues({ prompted: { instructions: 'x' } }).prompted).toEqual({ instructions: 'x', newEachTurn: false, answerLast: false });
    });
});

describe('describeConstraint for record lists', () => {
    it('gives an example built from the schema\'s fields', () => {
        const desc = describeConstraint({ type: 'array', itemType: 'record', itemSchema: { text: { type: 'string' }, mood: { type: 'string' } } });
        expect(desc).toMatch(/^array of JSON objects\. Reply with a full JSON array of items matching this description \(e\.g\. \[\{"text":"\.\.\.","mood":"\.\.\."\}\]\)/);
    });

    it('still works with no schema', () => {
        expect(describeConstraint({ type: 'array', itemType: 'record' })).toContain('(e.g. [{}])');
    });

    it('is unchanged for other lists', () => {
        expect(describeConstraint({ type: 'array', itemType: 'string' })).toContain('array of string. Reply with a full JSON array of items matching this description (e.g. ["a","b"])');
    });
});

it('the rules let a NEW EACH TURN list be empty', () => {
    expect(DEFAULT_UNIFIED_VARIABLE_RULES).toContain('A field marked NEW EACH TURN is never repeated: always answer it fresh from the latest turn - never empty, except a list, which is [] when nothing new applies.');
});
