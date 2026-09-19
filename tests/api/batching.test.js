import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import * as apiIndex from '../../src/api/index.js';
import { DEFAULT_BATCH, batchOf, blankDefinition, getDefaultValue, clampNumber } from '../../src/core/variable-schema.js';
import { runPromptedStateUpdate, selectBatchVariables } from '../../src/core/prompted-engine.js';
import { callBackgroundLLM } from '../../src/core/background-llm.js';
import { getVar, setVar, loadChatState, seedVariablesForChat, applyIncrement, deleteVariableValueEverywhere } from '../../src/core/chat-state.js';
import { createPreset as createPresetCore, addPresetToChat, renamePreset, deletePreset } from '../../src/core/preset-manager.js';
import { recalculateAllForChat, recalculateDependents, evaluateCalculatedVariable } from '../../src/core/calculated-engine.js';
import { refreshVariableMacros } from '../../src/core/macro-registration.js';
import { dispatchNamespacedEvent } from '../../src/events/event-engine.js';

// Only the LLM call and the two UI status hooks prompted-engine.js reaches
// for are faked; everything else in that module runs for real.
vi.mock('../../src/core/background-llm.js', () => ({ callBackgroundLLM: vi.fn() }));
vi.mock('../../src/ui/settings-panel-ui.js', () => ({ setStatus: vi.fn() }));
vi.mock('../../src/ui/ui-entrypoints.js', () => ({ refreshPanelIfOpen: vi.fn() }));

// The harness swaps chat-state for a mock; the snapshot rule lives in the
// REAL module, so that one is loaded directly.
const realChatState = await vi.importActual('../../src/core/chat-state.js');

const WRONG_INSTANCE = 'State Engine API call rejected: wrong instance';
let instanceId;

const assign = (variable, batch, ext = 'pp') => stateEngine.assignBatch(ext, instanceId, variable, batch);
const remove = (variable, ext = 'pp') => stateEngine.removeBatch(ext, instanceId, variable);
const create = (name, extra = {}, ext = 'pp', preset = 'Demo') => stateEngine.createVariable(ext, instanceId, {
    namespace: ext, presetName: preset, name, type: 'number', defaultValue: 1, ...extra,
});
const live = (name, ext = 'pp', preset = 'Demo') => stateEngine.getVariable(ext, instanceId, { namespace: ext, presetName: preset, variableName: name });
const batchOfVar = (name, ext = 'pp', preset = 'Demo') => live(name, ext, preset).batch;

beforeEach(() => {
    instanceId = ensureInstanceId();
    registerNamespaces('pp', 'zz');
    stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Demo' });
    stateEngine.activatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
    stateEngine.createPreset('zz', instanceId, { namespace: 'zz', name: 'Other' });
    stateEngine.activatePreset('zz', instanceId, 'chat-1', 'zz', 'Other');
    callBackgroundLLM.mockReset();
});

describe('variable batching', () => {
    describe('schema (variable-schema.js)', () => {
        it('a blank definition is in the default batch "core"', () => {
            expect(DEFAULT_BATCH).toBe('core');
            expect(blankDefinition().batch).toBe('core');
        });

        it('batchOf treats a definition with no usable batch as "core" (so legacy variables need no migration)', () => {
            expect(batchOf({ batch: 'extra' })).toBe('extra');
            for (const def of [{}, { batch: '' }, { batch: null }, { batch: 5 }, undefined, null]) expect(batchOf(def)).toBe('core');
        });

        it('getDefaultValue and clampNumber never read or alter batch', () => {
            const def = { ...blankDefinition(), type: 'number', defaultValue: '7', min: 0, max: 5, batch: 'extra' };
            const before = JSON.stringify(def);

            expect(getDefaultValue(def)).toBe(7);
            expect(clampNumber(def, 99)).toBe(5);
            for (const type of ['string', 'boolean', 'enum', 'array', 'calculated']) getDefaultValue({ ...def, type, enumValues: ['a'] });

            expect(JSON.stringify(def)).toBe(before);
            expect(def.batch).toBe('extra');
        });

        it('every variable created through the API belongs to "core" unless told otherwise', () => {
            expect(create('a').batch).toBe('core');
        });

        it('createVariable accepts a valid batch and stores it trimmed', () => {
            expect(create('a', { batch: '  extra ' }).batch).toBe('extra');
        });

        it.each([[''], ['   '], [42], [null], [{}], ['two\nlines']])('createVariable rejects an invalid batch (%j) and creates nothing', (bad) => {
            expect(create('a', { batch: bad })).toBeNull();
            expect(live('a')).toBeUndefined();
        });
    });

    describe('assignBatch', () => {
        it('with correct identity, moves the variable into the batch and returns the stored name', () => {
            create('a');
            expect(assign('a', 'extra')).toBe('extra');
            expect(batchOfVar('a')).toBe('extra');
        });

        it('accepts the local name or the stored qualified name', () => {
            create('a');
            create('b');
            assign('a', 'x');
            assign('pp__b', 'y');
            expect([batchOfVar('a'), batchOfVar('b')]).toEqual(['x', 'y']);
        });

        it('persists to settings', () => {
            create('a');
            context.saveSettingsDebounced.mockClear();
            assign('a', 'extra');
            expect(context.saveSettingsDebounced).toHaveBeenCalled();
            const persisted = Object.values(settings.snapshot().presets).find((p) => p.name === 'Demo');
            expect(Object.values(persisted.variables).find((v) => v.name === 'pp__a').batch).toBe('extra');
        });

        it('a variable belongs to exactly one batch - re-assigning moves it', () => {
            create('a');
            assign('a', 'one');
            assign('a', 'two');
            expect(batchOfVar('a')).toBe('two');
            const batches = stateEngine.getBatches('chat-1');
            expect(Object.entries(batches).filter(([, names]) => names.includes('pp__a')).map(([b]) => b)).toEqual(['two']);
        });

        it('stores the trimmed name', () => {
            create('a');
            expect(assign('a', '  extra  ')).toBe('extra');
            expect(batchOfVar('a')).toBe('extra');
        });

        it('replaces the definition object rather than mutating it (a chat snapshot must not change underneath a chat)', () => {
            create('a');
            const before = live('a');
            assign('a', 'extra');
            expect(before.batch).toBe('core');
            expect(live('a')).not.toBe(before);
        });

        it('changes nothing else about the definition', () => {
            create('a', { defaultValue: 9, label: 'A' });
            const before = { ...live('a') };
            assign('a', 'extra');
            expect({ ...live('a'), batch: 'core' }).toEqual(before);
        });

        describe('wrong identity is rejected', () => {
            it.each([
                ['a wrong instanceId', 'nope'], ['a missing instanceId', undefined], ['a null instanceId', null], ['a non-string instanceId', 5],
            ])('rejects %s and writes nothing', (_label, bad) => {
                create('a');
                const before = JSON.stringify(settings.snapshot());
                expect(() => stateEngine.assignBatch('pp', bad, 'a', 'extra')).toThrow(WRONG_INSTANCE);
                expect(() => stateEngine.removeBatch('pp', bad, 'a')).toThrow(WRONG_INSTANCE);
                expect(JSON.stringify(settings.snapshot())).toBe(before);
            });

            it('checks the instance before anything else', () => {
                expect(() => stateEngine.assignBatch('ghost', 'nope', 'nothing', '')).toThrow(WRONG_INSTANCE);
            });
        });

        describe('wrong namespace is rejected', () => {
            // No namespace parameter: the target is the caller's OWN namespace.
            it.each([['ghost'], [''], [undefined], [null]])('rejects an extension that owns no namespace (%j)', (id) => {
                create('a');
                expect(() => stateEngine.assignBatch(id, instanceId, 'a', 'extra')).toThrow(/does not own a namespace - call createNamespace\(\) first/);
            });

            it('a variable in ANOTHER extension\'s namespace does not exist as far as the caller is concerned', () => {
                create('z', {}, 'zz', 'Other');
                expect(() => assign('z', 'extra')).toThrow("Batch assignment rejected: variable 'z' does not exist in namespace 'pp'");
                expect(() => assign('zz__z', 'extra')).toThrow(/does not exist in namespace 'pp'/);
                expect(batchOfVar('z', 'zz', 'Other')).toBe('core');
            });

            it('the owner can, of course, reach its own', () => {
                create('z', {}, 'zz', 'Other');
                expect(assign('z', 'extra', 'zz')).toBe('extra');
            });

            it('rejects after the extension is unregistered', () => {
                create('a');
                stateEngine.unregisterExtension('pp');
                expect(() => assign('a', 'extra')).toThrow(/does not own a namespace/);
            });
        });

        describe('the variable must exist', () => {
            it('rejects a variable that does not exist', () => {
                expect(() => assign('ghost', 'extra')).toThrow("Batch assignment rejected: variable 'ghost' does not exist in namespace 'pp'");
            });

            it.each([[undefined], [null], [''], [42], [{}]])('rejects an invalid variableName (%j)', (bad) => {
                expect(() => assign(bad, 'extra')).toThrow('Batch assignment rejected: variableName must be a non-empty string');
            });

            it('a deleted variable no longer exists', () => {
                create('a');
                stateEngine.deleteVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', variableName: 'a' });
                expect(() => assign('a', 'extra')).toThrow(/does not exist/);
            });

            it('does not need the variable\'s preset to be active for any chat', () => {
                create('a');
                stateEngine.deactivatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
                expect(assign('a', 'extra')).toBe('extra');
            });
        });

        describe('batchName must be a non-empty string', () => {
            it.each([
                ['undefined', undefined], ['null', null], ['an empty string', ''], ['whitespace only', '   '],
                ['a number', 5], ['an object', {}], ['an array', ['x']], ['a boolean', true],
            ])('rejects %s', (_label, bad) => {
                create('a');
                expect(() => assign('a', bad)).toThrow('Batch assignment rejected: batchName must be a non-empty string');
            });

            it('rejects a name containing a line break (it is written into a prompt heading)', () => {
                create('a');
                expect(() => assign('a', 'x\ninjected')).toThrow('batchName must not contain line breaks');
                expect(() => assign('a', 'x\r\ny')).toThrow('batchName must not contain line breaks');
            });

            it('a rejected assignment leaves the previous batch untouched', () => {
                create('a');
                assign('a', 'keep');
                expect(() => assign('a', '')).toThrow();
                expect(batchOfVar('a')).toBe('keep');
            });

            it('throws an Error rather than returning null', () => {
                create('a');
                let caught;
                try { assign('a', 5); } catch (err) { caught = err; }
                expect(caught).toBeInstanceOf(Error);
            });
        });
    });

    describe('removeBatch', () => {
        it('resets the variable to "core"', () => {
            create('a');
            assign('a', 'extra');
            expect(remove('a')).toBe('core');
            expect(batchOfVar('a')).toBe('core');
            expect(stateEngine.getBatch('extra', 'chat-1')).toEqual([]);
            expect(stateEngine.getBatch('core', 'chat-1').map((v) => v.name)).toEqual(['pp__a']);
        });

        it('is harmless on a variable that is already in "core"', () => {
            create('a');
            expect(() => remove('a')).not.toThrow();
            expect(batchOfVar('a')).toBe('core');
        });

        it('persists to settings', () => {
            create('a');
            assign('a', 'extra');
            context.saveSettingsDebounced.mockClear();
            remove('a');
            expect(context.saveSettingsDebounced).toHaveBeenCalled();
        });

        it('applies the same identity, namespace and existence rules', () => {
            create('a');
            create('z', {}, 'zz', 'Other');
            expect(() => stateEngine.removeBatch('pp', 'nope', 'a')).toThrow(WRONG_INSTANCE);
            expect(() => stateEngine.removeBatch('ghost', instanceId, 'a')).toThrow(/does not own a namespace/);
            expect(() => remove('z')).toThrow(/does not exist in namespace 'pp'/);
            expect(() => remove('ghost')).toThrow(/does not exist/);
            expect(() => remove('')).toThrow(/variableName must be a non-empty string/);
        });
    });

    describe('retrieval', () => {
        beforeEach(() => {
            create('a', { defaultValue: 1 });
            create('b', { type: 'string', defaultValue: 'hi' });
            create('c', { defaultValue: 3 });
            assign('a', 'extra');
            assign('b', 'extra');
        });

        describe('getBatch', () => {
            it('returns exactly the variables in that batch, with name, value and definition', () => {
                const result = stateEngine.getBatch('extra', 'chat-1');
                expect(result.map((v) => v.name)).toEqual(['pp__a', 'pp__b']);
                expect(result.map((v) => v.value)).toEqual([1, 'hi']);
                expect(result[0].def).toMatchObject({ name: 'pp__a', type: 'number', batch: 'extra' });
            });

            it('"core" returns the variables nobody moved', () => {
                expect(stateEngine.getBatch('core', 'chat-1').map((v) => v.name)).toEqual(['pp__c']);
            });

            it('returns [] for an unknown or empty batch', () => {
                expect(stateEngine.getBatch('nope', 'chat-1')).toEqual([]);
            });

            it.each([[undefined], [null], [''], [42], [{}]])('returns [] for an invalid batchName (%j)', (bad) => {
                expect(stateEngine.getBatch(bad, 'chat-1')).toEqual([]);
            });

            it.each([[undefined], [null], ['']])('returns [] for a missing chatId (%j)', (bad) => {
                expect(stateEngine.getBatch('extra', bad)).toEqual([]);
            });

            it('reads the CURRENT stored value, not the default', () => {
                setVar('chat-1', 'pp__a', 42, live('a'));
                expect(stateEngine.getBatch('extra', 'chat-1')[0].value).toBe(42);
            });

            it('falls back to the type default for a variable not yet seeded into this chat', () => {
                deleteVariableValueEverywhere('pp__b');
                expect(stateEngine.getBatch('extra', 'chat-1').find((v) => v.name === 'pp__b').value).toBe('hi');
            });

            it('only includes variables from presets ACTIVE for that chat', () => {
                stateEngine.deactivatePreset('pp', instanceId, 'chat-1', 'pp', 'Demo');
                expect(stateEngine.getBatch('extra', 'chat-1')).toEqual([]);
                expect(stateEngine.getBatch('extra', 'some-other-chat')).toEqual([]);
            });

            it('returns copies - mutating a result never touches the stored definition', () => {
                const result = stateEngine.getBatch('extra', 'chat-1');
                result[0].def.batch = 'hacked';
                result[0].name = 'hacked';
                expect(batchOfVar('a')).toBe('extra');
                expect(stateEngine.getBatch('extra', 'chat-1')[0].name).toBe('pp__a');
            });

            it('spans namespaces: a batch is a prompt scope for the whole chat, not for one extension', () => {
                create('z', {}, 'zz', 'Other');
                assign('z', 'extra', 'zz');
                expect(stateEngine.getBatch('extra', 'chat-1').map((v) => v.name).sort()).toEqual(['pp__a', 'pp__b', 'zz__z']);
            });

            it('needs no identity', () => {
                expect(stateEngine.getBatch.length).toBe(2);
            });
        });

        describe('getBatches', () => {
            it('returns every batch with its variable names', () => {
                expect(stateEngine.getBatches('chat-1')).toEqual({ core: ['pp__c'], extra: ['pp__a', 'pp__b'] });
            });

            it('only lists batches that have at least one active variable', () => {
                remove('a');
                remove('b');
                expect(stateEngine.getBatches('chat-1')).toEqual({ core: ['pp__a', 'pp__b', 'pp__c'] });
            });

            it('puts a definition with no batch field (a legacy variable) in "core"', () => {
                delete live('c').batch; // as a pre-batching definition would look
                expect(stateEngine.getBatches('chat-1').core).toEqual(['pp__c']);
                expect(stateEngine.getBatch('core', 'chat-1').map((v) => v.name)).toEqual(['pp__c']);
            });

            it('covers every namespace active in the chat', () => {
                create('z', {}, 'zz', 'Other');
                assign('z', 'shared', 'zz');
                assign('c', 'shared');
                expect(stateEngine.getBatches('chat-1')).toEqual({ extra: ['pp__a', 'pp__b'], shared: ['pp__c', 'zz__z'] });
            });

            it('returns {} for no chat, or a chat with nothing active', () => {
                expect(stateEngine.getBatches(undefined)).toEqual({});
                expect(stateEngine.getBatches('empty-chat')).toEqual({});
            });

            it('every active variable is in exactly one batch', () => {
                const names = Object.values(stateEngine.getBatches('chat-1')).flat();
                expect(names.sort()).toEqual(['pp__a', 'pp__b', 'pp__c']);
                expect(new Set(names).size).toBe(names.length);
            });

            it('returns fresh objects', () => {
                stateEngine.getBatches('chat-1').extra.push('hacked');
                expect(stateEngine.getBatches('chat-1').extra).toEqual(['pp__a', 'pp__b']);
            });
        });

        describe('batchPrompt', () => {
            it('returns the formatted segment: an upper-cased heading, then one `name = JSON` line per variable', () => {
                expect(stateEngine.batchPrompt('extra', 'chat-1')).toBe('### EXTRA\npp__a = 1\npp__b = "hi"');
                expect(stateEngine.batchPrompt('core', 'chat-1')).toBe('### CORE\npp__c = 3');
            });

            it('uses getVar for the values, JSON-encoded (strings quoted, booleans and arrays literal)', () => {
                create('flag', { type: 'boolean', defaultValue: false, batch: 'mix' });
                create('tags', { type: 'array', defaultValue: [], batch: 'mix' });
                create('note', { type: 'string', defaultValue: '', batch: 'mix' });
                setVar('chat-1', 'pp__flag', true, live('flag'));
                setVar('chat-1', 'pp__tags', ['a', 'b'], live('tags'));
                setVar('chat-1', 'pp__note', 'say "hi"\nthen leave', live('note'));

                expect(stateEngine.batchPrompt('mix', 'chat-1')).toBe(
                    '### MIX\npp__flag = true\npp__tags = ["a","b"]\npp__note = "say \\"hi\\"\\nthen leave"',
                );
            });

            it('a value with a line break stays on ONE line (JSON-escaped) - it cannot start a new prompt line', () => {
                create('note', { type: 'string', batch: 'mix' });
                setVar('chat-1', 'pp__note', 'x\n### CORE\nfake = 1', live('note'));
                expect(stateEngine.batchPrompt('mix', 'chat-1').split('\n')).toHaveLength(2);
            });

            it('does NOT include the chat transcript', () => {
                context.chat = [{ is_user: true, mes: 'the secret transcript text' }, { is_user: false, mes: 'reply' }];
                const prompt = stateEngine.batchPrompt('extra', 'chat-1');
                expect(prompt).not.toContain('transcript');
                expect(prompt).not.toContain('reply');
            });

            it('does NOT include unrelated variables - other batches, other names', () => {
                const prompt = stateEngine.batchPrompt('extra', 'chat-1');
                expect(prompt).not.toContain('pp__c');
                expect(stateEngine.batchPrompt('core', 'chat-1')).not.toContain('pp__a');
            });

            it('carries no per-variable instructions or constraints (unlike the main prompted update)', () => {
                create('inst', { batch: 'mix', prompted: { instructions: 'infer it from context' }, description: 'a description' });
                expect(stateEngine.batchPrompt('mix', 'chat-1')).toBe('### MIX\npp__inst = 1');
            });

            it('follows assignment: moving a variable moves its line', () => {
                assign('a', 'core');
                expect(stateEngine.batchPrompt('extra', 'chat-1')).toBe('### EXTRA\npp__b = "hi"');
                expect(stateEngine.batchPrompt('core', 'chat-1')).toBe('### CORE\npp__a = 1\npp__c = 3');
            });

            it('is an empty string for an empty or unknown batch, so a caller can skip it', () => {
                expect(stateEngine.batchPrompt('nope', 'chat-1')).toBe('');
                expect(stateEngine.batchPrompt('extra', 'empty-chat')).toBe('');
            });

            it.each([[undefined], [null], [''], [42], [{}]])('is "" for an invalid batchName (%j)', (bad) => {
                expect(stateEngine.batchPrompt(bad, 'chat-1')).toBe('');
            });

            it('is deterministic - definition order, not value order', () => {
                expect(stateEngine.batchPrompt('extra', 'chat-1')).toBe(stateEngine.batchPrompt('extra', 'chat-1'));
                setVar('chat-1', 'pp__b', 'zzz', live('b'));
                setVar('chat-1', 'pp__a', 999, live('a'));
                expect(stateEngine.batchPrompt('extra', 'chat-1').split('\n').slice(1).map((l) => l.split(' = ')[0])).toEqual(['pp__a', 'pp__b']);
            });

            it('spans namespaces, like getBatch', () => {
                create('z', { type: 'string', defaultValue: 'zz' }, 'zz', 'Other');
                assign('z', 'extra', 'zz');
                expect(stateEngine.batchPrompt('extra', 'chat-1')).toContain('zz__z = "zz"');
            });
        });
    });

    describe('integration', () => {
        describe('variable updates preserve batch', () => {
            it('updateVariable with an unrelated patch keeps the batch', () => {
                create('a');
                assign('a', 'extra');
                stateEngine.updateVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', variableName: 'a' }, { label: 'Renamed label', defaultValue: 5 });
                expect(batchOfVar('a')).toBe('extra');
            });

            it('updateVariable keeps the batch across a type change', () => {
                create('a');
                assign('a', 'extra');
                stateEngine.updateVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', variableName: 'a' }, { type: 'string', defaultValue: 'x' });
                expect(batchOfVar('a')).toBe('extra');
            });

            it('updateVariable can change the batch itself, validated like assignBatch', () => {
                create('a');
                const ref = { namespace: 'pp', presetName: 'Demo', variableName: 'a' };
                expect(stateEngine.updateVariable('pp', instanceId, ref, { batch: ' moved ' }).batch).toBe('moved');
                expect(stateEngine.updateVariable('pp', instanceId, ref, { batch: '' })).toBeNull();
                expect(stateEngine.updateVariable('pp', instanceId, ref, { batch: 'a\nb' })).toBeNull();
                expect(batchOfVar('a')).toBe('moved');
            });

            it('a calculated variable keeps its batch when its expression changes', () => {
                create('a');
                create('calc', { type: 'calculated', expression: 'pp__a * 2' });
                assign('calc', 'derived');
                stateEngine.updateVariable('pp', instanceId, { namespace: 'pp', presetName: 'Demo', variableName: 'calc' }, { expression: 'pp__a * 3' });
                expect(batchOfVar('calc')).toBe('derived');
                expect(stateEngine.getBatch('derived', 'chat-1')[0].value).toBe(3);
            });

            it('cloning-style deep copies (JSON) keep the batch', () => {
                create('a');
                assign('a', 'extra');
                expect(JSON.parse(JSON.stringify(live('a'))).batch).toBe('extra');
            });
        });

        describe('chat-state snapshots preserve batch (through the API, mocked chat-state)', () => {
            it('a write snapshots the definition\'s batch into entry.def', () => {
                create('a');
                assign('a', 'extra');
                setVar('chat-1', 'pp__a', 5, live('a'));
                expect(loadChatState('chat-1').variables.pp__a.def.batch).toBe('extra');
            });

            it('a write with a definition that has no batch keeps the batch already snapshotted', () => {
                create('a');
                assign('a', 'extra');
                setVar('chat-1', 'pp__a', 5, live('a'));
                setVar('chat-1', 'pp__a', 6, { name: 'pp__a', type: 'number' });
                expect(loadChatState('chat-1').variables.pp__a.def.batch).toBe('extra');
                expect(loadChatState('chat-1').variables.pp__a.value).toBe(6);
            });

            it('a write with no definition at all keeps the snapshot as it was', () => {
                create('a');
                assign('a', 'extra');
                setVar('chat-1', 'pp__a', 5, live('a'));
                setVar('chat-1', 'pp__a', 7);
                expect(loadChatState('chat-1').variables.pp__a.def.batch).toBe('extra');
            });

            it('the snapshot is per-write: assigning does not rewrite it underneath the chat, and getBatch reads the live definition anyway', () => {
                create('a');
                setVar('chat-1', 'pp__a', 5, live('a'));
                assign('a', 'extra');

                expect(loadChatState('chat-1').variables.pp__a.def.batch).toBe('core'); // stale until the next write
                expect(stateEngine.getBatch('extra', 'chat-1').map((v) => v.name)).toEqual(['pp__a']); // live definition wins

                setVar('chat-1', 'pp__a', 6, live('a'));
                expect(loadChatState('chat-1').variables.pp__a.def.batch).toBe('extra');
            });
        });

        describe('the REAL chat-state.js', () => {
            const def = (extra = {}) => ({ name: 'pp__a', type: 'number', defaultValue: 0, ...extra });
            const snapshot = () => realChatState.loadChatState('chat-1').variables.pp__a;

            it('setVar stores the definition\'s batch in entry.def - the very same object, not a copy, when it has one', () => {
                const d = def({ batch: 'extra' });
                realChatState.setVar('chat-1', 'pp__a', 1, d);
                expect(snapshot().def).toBe(d);
                expect(snapshot().def.batch).toBe('extra');
            });

            it('setVar keeps the previous snapshot\'s batch when handed a definition with no batch', () => {
                realChatState.setVar('chat-1', 'pp__a', 1, def({ batch: 'extra' }));
                realChatState.setVar('chat-1', 'pp__a', 2, def());

                expect(snapshot().def.batch).toBe('extra');
                expect(snapshot().value).toBe(2);
            });

            it('setVar with no definition leaves the snapshot alone', () => {
                realChatState.setVar('chat-1', 'pp__a', 1, def({ batch: 'extra' }));
                realChatState.setVar('chat-1', 'pp__a', 2);
                expect(snapshot().def.batch).toBe('extra');
            });

            it('a definition that DOES carry a batch replaces the old one (the batch can change)', () => {
                realChatState.setVar('chat-1', 'pp__a', 1, def({ batch: 'one' }));
                realChatState.setVar('chat-1', 'pp__a', 1, def({ batch: 'two' }));
                expect(snapshot().def.batch).toBe('two');
            });

            it('a variable with no previous snapshot and no batch is stored with no batch invented for it', () => {
                realChatState.setVar('chat-1', 'pp__a', 1, def());
                expect(snapshot().def.batch).toBeUndefined();
                expect(batchOf(snapshot().def)).toBe('core');
            });

            it('never copies or alters the caller\'s own definition object', () => {
                realChatState.setVar('chat-1', 'pp__a', 1, def({ batch: 'extra' }));
                const incoming = def();
                realChatState.setVar('chat-1', 'pp__a', 2, incoming);
                expect(incoming.batch).toBeUndefined();
            });

            it('resetValueIfTypeChanged resets the value but keeps the snapshot\'s batch', () => {
                realChatState.setVar('chat-1', 'pp__a', 5, def({ batch: 'extra' }));
                realChatState.resetValueIfTypeChanged('chat-1', { name: 'pp__a', type: 'string', defaultValue: 'fresh' });

                expect(snapshot().value).toBe('fresh');
                expect(snapshot().def.type).toBe('string');
                expect(snapshot().def.batch).toBe('extra');
            });

            it('resetValueIfTypeChanged takes a new definition\'s own batch when it has one', () => {
                realChatState.setVar('chat-1', 'pp__a', 5, def({ batch: 'extra' }));
                realChatState.resetValueIfTypeChanged('chat-1', { name: 'pp__a', type: 'string', defaultValue: 'x', batch: 'other' });
                expect(snapshot().def.batch).toBe('other');
            });

            it('resetValueIfTypeChanged does nothing (batch included) when the type has not changed', () => {
                const d = def({ batch: 'extra' });
                realChatState.setVar('chat-1', 'pp__a', 5, d);
                realChatState.resetValueIfTypeChanged('chat-1', def({ batch: 'ignored' }));
                expect(snapshot().def).toBe(d);
                expect(snapshot().value).toBe(5);
            });
        });

        describe('the manager modal\'s save path', () => {
            it('a definition rebuilt the way ui-events.js does (blankDefinition + form values) needs the stored batch carried over', () => {
                // ui-events.js builds `{ ...blankDefinition(), ...collectedValues }` and the editor has no
                // batch field - without its explicit carry-over the batch would silently reset to "core".
                create('a');
                assign('a', 'extra');
                const rebuilt = { ...blankDefinition(), id: live('a').id, name: 'pp__a', type: 'number' };
                expect(rebuilt.batch).toBe('core');
                const previousDef = live('a');
                if (typeof previousDef?.batch === 'string' && previousDef.batch) rebuilt.batch = previousDef.batch; // the ui-events.js line
                expect(rebuilt.batch).toBe('extra');
            });
        });

        describe('registration and the capability graph are unaffected', () => {
            it('assigning and removing batches changes neither', () => {
                create('a');
                stateEngine.registerExtension('pp', instanceId, { namespace: 'pp', variables: ['pp__a'], capabilities: ['ui.panel'], dependsOn: ['data.x'], description: 'p' });
                const registration = JSON.stringify(stateEngine.getExtensionRegistration('pp'));
                const graph = JSON.stringify(stateEngine.getCapabilityGraph());
                const registered = JSON.stringify(stateEngine.getRegisteredExtensions());
                const extensions = JSON.stringify(settings.snapshot().extensions);

                assign('a', 'extra');
                remove('a');
                assign('a', 'again');

                expect(JSON.stringify(stateEngine.getExtensionRegistration('pp'))).toBe(registration);
                expect(JSON.stringify(stateEngine.getCapabilityGraph())).toBe(graph);
                expect(JSON.stringify(stateEngine.getRegisteredExtensions())).toBe(registered);
                expect(JSON.stringify(settings.snapshot().extensions)).toBe(extensions);
            });

            it('registration and capability declarations do not change a variable\'s batch', () => {
                create('a');
                assign('a', 'extra');
                stateEngine.registerExtension('pp', instanceId, { namespace: 'pp', variables: ['pp__a'], capabilities: ['x'] });
                stateEngine.declareCapabilities('pp', instanceId, ['y']);
                stateEngine.declareDependencies('pp', instanceId, ['z']);
                expect(batchOfVar('a')).toBe('extra');
            });

            it('a declared variable name in a registration is independent of its batch', () => {
                stateEngine.registerExtension('pp', instanceId, { namespace: 'pp', variables: ['pp__not_created_yet'] });
                expect(stateEngine.getBatches('chat-1')).toEqual({});
            });
        });

        describe('no side effects', () => {
            beforeEach(() => {
                create('a');
                create('b');
                create('calc', { type: 'calculated', expression: 'pp__a + pp__b' });
                stateEngine.registerEventSource('pp', instanceId, { namespace: 'pp', eventName: 'tick' });
                vi.clearAllMocks();
            });

            const write = () => { assign('a', 'extra'); assign('calc', 'extra'); remove('calc'); };
            const read = () => { stateEngine.getBatch('core', 'chat-1'); stateEngine.getBatches('chat-1'); stateEngine.batchPrompt('core', 'chat-1'); };

            it('a batch write changes only that variable definition\'s `batch` in settings', () => {
                const before = settings.snapshot();
                write();
                const after = settings.snapshot();

                const strip = (s) => {
                    const c = JSON.parse(JSON.stringify(s));
                    for (const preset of Object.values(c.presets)) for (const v of Object.values(preset.variables || {})) delete v.batch;
                    return c;
                };
                expect(strip(after)).toEqual(strip(before));
                expect(batchOfVar('a')).toBe('extra');
            });

            it('does not touch chat-state (no write, seed, increment or delete; stored values and snapshots unchanged)', () => {
                const store = JSON.stringify(settings.get().variableStore);
                write();

                expect(setVar).not.toHaveBeenCalled();
                expect(seedVariablesForChat).not.toHaveBeenCalled();
                expect(applyIncrement).not.toHaveBeenCalled();
                expect(deleteVariableValueEverywhere).not.toHaveBeenCalled();
                expect(JSON.stringify(settings.get().variableStore)).toBe(store);
                expect(context.variables.local.get('pp__a')).toBe(1);
            });

            it('does not touch presets (no create/rename/delete/bind, no membership or binding change)', () => {
                const names = () => Object.values(settings.get().presets).map((p) => [p.id, p.name, p.namespace, Object.keys(p.variables)]);
                const before = JSON.stringify(names());
                const bindings = JSON.stringify(settings.get().chatPresetBindings);
                write();

                for (const spy of [createPresetCore, addPresetToChat, renamePreset, deletePreset]) expect(spy).not.toHaveBeenCalled();
                expect(JSON.stringify(names())).toBe(before);
                expect(JSON.stringify(settings.get().chatPresetBindings)).toBe(bindings);
            });

            it('does not touch the variable dependency graph (no recalculation, edges unchanged)', () => {
                const deps = stateEngine.getDependencies({ namespace: 'pp', presetName: 'Demo', variableName: 'calc' });
                write();

                expect(recalculateAllForChat).not.toHaveBeenCalled();
                expect(recalculateDependents).not.toHaveBeenCalled();
                expect(evaluateCalculatedVariable).not.toHaveBeenCalled();
                expect(stateEngine.getDependencies({ namespace: 'pp', presetName: 'Demo', variableName: 'calc' })).toEqual(deps);
                expect(stateEngine.getDependents({ namespace: 'pp', variableName: 'a' }).map((d) => d.name)).toEqual(['pp__calc']);
            });

            it('does not refresh macros, and does not fire or register events', () => {
                const sources = JSON.stringify(settings.get().eventSources);
                const heard = vi.fn();
                context.eventSource.on('pp.tick', heard);
                write();

                expect(refreshVariableMacros).not.toHaveBeenCalled();
                expect(context.registerMacro).not.toHaveBeenCalled();
                expect(dispatchNamespacedEvent).not.toHaveBeenCalled();
                expect(heard).not.toHaveBeenCalled();
                expect(JSON.stringify(settings.get().eventSources)).toBe(sources);
            });

            it('reads (getBatch / getBatches / batchPrompt) change nothing and call nothing', () => {
                const before = JSON.stringify(settings.snapshot());
                context.saveSettingsDebounced.mockClear();
                read();

                expect(JSON.stringify(settings.snapshot())).toBe(before);
                expect(context.saveSettingsDebounced).not.toHaveBeenCalled();
                for (const spy of [setVar, seedVariablesForChat, recalculateAllForChat, refreshVariableMacros, dispatchNamespacedEvent]) {
                    expect(spy).not.toHaveBeenCalled();
                }
            });

            it('a REJECTED write has none of these effects either', () => {
                const before = JSON.stringify(settings.snapshot());
                expect(() => assign('ghost', 'x')).toThrow();
                expect(() => assign('a', '')).toThrow();
                expect(() => stateEngine.assignBatch('pp', 'nope', 'a', 'x')).toThrow();
                expect(() => stateEngine.removeBatch('ghost', instanceId, 'a')).toThrow();

                expect(JSON.stringify(settings.snapshot())).toBe(before);
                expect(setVar).not.toHaveBeenCalled();
            });
        });
    });

    describe('main prompted update (the real prompted-engine.js)', () => {
        const runAi = async () => {
            context.chat = [{ is_user: true, mes: 'hello there' }, { is_user: false, name: 'Bot', mes: 'hi' }];
            await runPromptedStateUpdate('ai');
        };
        const prompted = (name, extra = {}) => create(name, {
            type: 'string', defaultValue: 'calm', behaviors: { prompted: true, increment: false },
            prompted: { instructions: `infer ${name} from context` }, ...extra,
        });
        const systemPrompt = () => callBackgroundLLM.mock.calls[0][2][0].content;

        describe('selectBatchVariables', () => {
            const defs = { 1: { name: 'a' }, 2: { name: 'b', batch: 'core' }, 3: { name: 'c', batch: 'extra' }, 4: { name: 'd', batch: '' } };

            it('defaults to "core", counting a definition with no batch as core', () => {
                expect(selectBatchVariables(defs).map((d) => d.name)).toEqual(['a', 'b', 'd']);
            });

            it('selects any other batch on request', () => {
                expect(selectBatchVariables(defs, 'extra').map((d) => d.name)).toEqual(['c']);
                expect(selectBatchVariables(defs, 'nope')).toEqual([]);
            });

            it('tolerates a missing map', () => {
                expect(selectBatchVariables(undefined)).toEqual([]);
                expect(selectBatchVariables(null)).toEqual([]);
            });
        });

        it('with every variable in "core" (the default), asks about all of them exactly as before', async () => {
            prompted('mood');
            prompted('weather');
            callBackgroundLLM.mockResolvedValue('{"pp__mood":"tense","pp__weather":"rain"}');

            await runAi();

            expect(systemPrompt()).toContain('"pp__mood"');
            expect(systemPrompt()).toContain('"pp__weather"');
            await vi.waitFor(() => expect(getVar('chat-1', 'pp__weather').value).toBe('rain'));
            expect(getVar('chat-1', 'pp__mood').value).toBe('tense');
        });

        it('keeps a variable assigned to another batch OUT of the main prompt', async () => {
            prompted('mood');
            prompted('secret');
            assign('secret', 'extra');
            callBackgroundLLM.mockResolvedValue('{"pp__mood":"tense","pp__secret":"leaked"}');

            await runAi();

            expect(systemPrompt()).toContain('"pp__mood"');
            expect(systemPrompt()).not.toContain('pp__secret');
        });

        it('and never updates that variable even if the model answers for it', async () => {
            prompted('mood');
            prompted('secret');
            assign('secret', 'extra');
            callBackgroundLLM.mockResolvedValue('{"pp__mood":"tense","pp__secret":"leaked"}');

            await runAi();
            await vi.waitFor(() => expect(getVar('chat-1', 'pp__mood').value).toBe('tense'));

            expect(getVar('chat-1', 'pp__secret').value).toBe('calm');
        });

        it('makes no LLM call at all when every prompted variable is in another batch', async () => {
            prompted('secret');
            assign('secret', 'extra');
            await runAi();
            expect(callBackgroundLLM).not.toHaveBeenCalled();
        });

        it('a variable moved back with removeBatch is asked about again', async () => {
            prompted('secret');
            assign('secret', 'extra');
            remove('secret');
            callBackgroundLLM.mockResolvedValue('{"pp__secret":"back"}');

            await runAi();

            expect(systemPrompt()).toContain('"pp__secret"');
        });

        it('a legacy variable with no batch field is still asked about (no migration needed)', async () => {
            prompted('legacy');
            delete live('legacy').batch;
            callBackgroundLLM.mockResolvedValue('{"pp__legacy":"x"}');

            await runAi();

            expect(systemPrompt()).toContain('"pp__legacy"');
        });

        it('keeps each variable\'s instructions and constraints in the prompt - it does not use the value-only batchPrompt format', async () => {
            prompted('mood', { prompted: { instructions: 'infer the room mood in one word' } });
            callBackgroundLLM.mockResolvedValue('{"pp__mood":"tense"}');

            await runAi();

            expect(systemPrompt()).toContain('infer the room mood in one word');
            expect(systemPrompt()).toContain('currently "calm"');
            expect(systemPrompt()).not.toContain('### CORE');
        });

        it('a prompted-increment variable in another batch is left out too', async () => {
            create('count', { behaviors: { prompted: true, increment: true }, increment: { delta: 1 } });
            assign('count', 'extra');
            prompted('mood');
            callBackgroundLLM.mockResolvedValue('{"pp__mood":"x","pp__count":true}');

            await runAi();
            await vi.waitFor(() => expect(getVar('chat-1', 'pp__mood').value).toBe('x'));

            expect(systemPrompt()).not.toContain('pp__count');
            expect(getVar('chat-1', 'pp__count').value).toBe(1);
        });
    });

    describe('surface', () => {
        it.each(['assignBatch', 'removeBatch', 'getBatch', 'getBatches', 'batchPrompt'])('%s is exposed on the facade and the index', (name) => {
            expect(typeof stateEngine[name]).toBe('function');
            expect(stateEngine[name]).toBe(apiIndex[name]);
        });

        it('the write functions take (extensionId, instanceId, ...) first; the reads take no identity', () => {
            expect(stateEngine.assignBatch.toString()).toMatch(/^(?:function\s*\w*\s*)?\(\s*extensionId\s*,\s*instanceId\b/);
            expect(stateEngine.removeBatch.toString()).toMatch(/^(?:function\s*\w*\s*)?\(\s*extensionId\s*,\s*instanceId\b/);
            for (const name of ['getBatch', 'getBatches', 'batchPrompt']) expect(stateEngine[name].toString()).not.toMatch(/instanceId/);
        });

        it('the batch-name rule is internal - not on the facade or the index', () => {
            expect(stateEngine.normalizeBatchName).toBeUndefined();
            expect(apiIndex.normalizeBatchName).toBeUndefined();
        });
    });
});
