import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import { recalculateAllForChat, recalculateDependents, evaluateCalculatedVariable } from '../../src/core/calculated-engine.js';
import { setVar } from '../../src/core/chat-state.js';

// getDependencies()/getDependents() are read-only introspection helpers that
// do NOT take (extensionId, instanceId) - they are outside the four modules
// the identity change covered (dependency-graph.js was deliberately left
// unguarded). Identity is only used here to BUILD the fixtures.
const extensionId = 'se';
let instanceId;

const ref = (variableName) => ({ namespace: 'se', presetName: 'Demo', variableName });
const create = (def) => stateEngine.createVariable(extensionId, instanceId, { namespace: 'se', presetName: 'Demo', ...def });

beforeEach(() => {
    instanceId = ensureInstanceId();
    stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Demo' });
    stateEngine.activatePreset(extensionId, instanceId, 'chat-1', 'se', 'Demo');
    create({ name: 'a', type: 'number', defaultValue: 3 });
    create({ name: 'b', type: 'number', defaultValue: 4 });
    create({ name: 'sum', type: 'calculated', expression: 'se__a + se__b' });
    create({ name: 'dbl', type: 'calculated', expression: 'se__a * 2' });
});

describe('dependency-graph', () => {
    describe('getDependencies', () => {
        it('returns the expression-derived dependency names', () => {
            expect(stateEngine.getDependencies(ref('sum')).sort()).toEqual(['se__a', 'se__b']);
            expect(stateEngine.getDependencies(ref('dbl'))).toEqual(['se__a']);
        });

        it('returns [] for a non-calculated variable', () => {
            expect(stateEngine.getDependencies(ref('a'))).toEqual([]);
        });

        it('returns a copy - mutating it does not change the stored definition', () => {
            stateEngine.getDependencies(ref('sum')).push('tampered');
            expect(stateEngine.getDependencies(ref('sum'))).toHaveLength(2);
        });

        it('returns [] for unknown or malformed refs instead of throwing', () => {
            expect(stateEngine.getDependencies(ref('ghost'))).toEqual([]);
            expect(stateEngine.getDependencies(undefined)).toEqual([]);
            expect(stateEngine.getDependencies({ namespace: 'se' })).toEqual([]);
        });
    });

    describe('getDependents', () => {
        it('finds every variable whose dependencies include the target', () => {
            const names = stateEngine.getDependents({ namespace: 'se', variableName: 'a' }).map((d) => d.name).sort();
            expect(names).toEqual(['se__dbl', 'se__sum']);
        });

        it('finds only the one that actually depends on it', () => {
            expect(stateEngine.getDependents({ namespace: 'se', variableName: 'b' }).map((d) => d.name)).toEqual(['se__sum']);
        });

        it('returns [] when nothing depends on the variable', () => {
            expect(stateEngine.getDependents({ namespace: 'se', variableName: 'sum' })).toEqual([]);
        });

        it('stays scoped to the given namespace even if another namespace references the same name', () => {
            registerNamespaces('pp');
            stateEngine.createPreset('pp', instanceId, { namespace: 'pp', name: 'Theirs' });
            stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Theirs', name: 'x', type: 'number' });
            const sneaky = stateEngine.createVariable('pp', instanceId, { namespace: 'pp', presetName: 'Theirs', name: 'y', type: 'calculated', expression: 'pp__x + 1' });
            // Force a cross-namespace reference directly into the stored definition
            // (the API refuses to create one - this simulates corrupted/foreign data).
            sneaky.dependencies = ['se__a'];

            expect(stateEngine.getDependents({ namespace: 'se', variableName: 'a' }).map((d) => d.name).sort()).toEqual(['se__dbl', 'se__sum']);
        });

        it('returns [] for a malformed ref', () => {
            expect(stateEngine.getDependents(undefined)).toEqual([]);
            expect(stateEngine.getDependents({ namespace: 'se' })).toEqual([]);
        });
    });

    describe('read-only guarantee', () => {
        it('never recalculates, evaluates, or writes a value', () => {
            vi.clearAllMocks();
            const before = JSON.stringify(settings.snapshot());

            stateEngine.getDependencies(ref('sum'));
            stateEngine.getDependents({ namespace: 'se', variableName: 'a' });

            expect(recalculateAllForChat).not.toHaveBeenCalled();
            expect(recalculateDependents).not.toHaveBeenCalled();
            expect(evaluateCalculatedVariable).not.toHaveBeenCalled();
            expect(setVar).not.toHaveBeenCalled();
            expect(JSON.stringify(settings.snapshot())).toBe(before);
        });
    });
});
