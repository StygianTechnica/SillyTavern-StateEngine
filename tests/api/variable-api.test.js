import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { stateEngine } from '../../src/api/index.js';
import { getVar, setVar, deleteVariableValueEverywhere } from '../../src/core/chat-state.js';
import { recalculateDependents } from '../../src/core/calculated-engine.js';
import { refreshVariableMacros } from '../../src/core/macro-registration.js';

const extensionId = 'se';
let instanceId;

const api = {
    createVariable: (def) => stateEngine.createVariable(extensionId, instanceId, def),
    updateVariable: (ref, patch) => stateEngine.updateVariable(extensionId, instanceId, ref, patch),
    deleteVariable: (ref) => stateEngine.deleteVariable(extensionId, instanceId, ref),
    getVariable: (ref) => stateEngine.getVariable(extensionId, instanceId, ref),
    listVariables: (preset) => stateEngine.listVariables(extensionId, instanceId, 'se', preset),
};
const ref = (variableName, presetName = 'Demo') => ({ namespace: 'se', presetName, variableName });
const plain = (name, extra = {}) => ({ namespace: 'se', presetName: 'Demo', name, type: 'number', defaultValue: 3, ...extra });
const calc = (name, expression, extra = {}) => ({ namespace: 'se', presetName: 'Demo', name, type: 'calculated', expression, ...extra });

beforeEach(() => {
    instanceId = ensureInstanceId();
    stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Demo' });
    // Must be active for the current chat before anything is seeded/evaluated there.
    stateEngine.activatePreset(extensionId, instanceId, 'chat-1', 'se', 'Demo');
});

describe('variable-api (identity-enforced)', () => {
    describe('createVariable', () => {
        it('stores the namespace-qualified name (se__hp) - "__", never "." (a dot breaks the expression DSL)', () => {
            const def = api.createVariable(plain('hp'));
            expect(def.name).toBe('se__hp');
            expect(def.name).not.toContain('.');
        });

        it('seeds the isolated store and mirrors into the macro store', () => {
            api.createVariable(plain('hp'));
            expect(getVar('chat-1', 'se__hp').value).toBe(3);
            expect(context.variables.local.get('se__hp')).toBe(3);
            expect(refreshVariableMacros).toHaveBeenCalled();
        });

        it('rejects a name collision and creates nothing extra', () => {
            api.createVariable(plain('hp'));
            expect(api.createVariable(plain('hp'))).toBeNull();
            expect(api.listVariables('Demo')).toHaveLength(1);
        });

        it('rejects def.value outright (a value is never set through a definition)', () => {
            expect(api.createVariable(plain('hp', { value: 99 }))).toBeNull();
            expect(api.getVariable(ref('hp'))).toBeUndefined();
        });

        it('returns null when the preset does not exist', () => {
            expect(api.createVariable(plain('hp', { presetName: 'Nope' }))).toBeNull();
        });
    });

    describe('calculated variables', () => {
        beforeEach(() => {
            api.createVariable(plain('a', { defaultValue: 3 }));
            api.createVariable(plain('b', { defaultValue: 4 }));
        });

        it('derives dependencies from the expression - none supplied by the caller', () => {
            const def = api.createVariable(calc('sum', 'se__a + se__b'));
            expect([...def.dependencies].sort()).toEqual(['se__a', 'se__b']);
        });

        it('evaluates on creation (real expression parser, mocked store)', () => {
            api.createVariable(calc('sum', 'se__a + se__b'));
            expect(getVar('chat-1', 'se__sum').value).toBe(7);
        });

        it('overrides a wrong caller-supplied dependencies array with the expression-derived set', () => {
            const def = api.createVariable(calc('dbl', 'se__a * 2', { dependencies: ['se__b', 'bogus'] }));
            expect(def.dependencies).toEqual(['se__a']);
        });

        it('rejects a dependency that lives in a different preset, creating nothing', () => {
            stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Other' });
            api.createVariable(plain('outside', { presetName: 'Other' }));

            expect(api.createVariable(calc('bad', 'se__outside + 1'))).toBeNull();
            expect(api.getVariable(ref('bad'))).toBeUndefined();
        });

        it('rejects a dependency that does not exist anywhere', () => {
            expect(api.createVariable(calc('bad', 'se__ghost + 1'))).toBeNull();
        });

        it('rejects a syntactically invalid expression', () => {
            expect(api.createVariable(calc('bad', 'se__a + + +'))).toBeNull();
            expect(api.getVariable(ref('bad'))).toBeUndefined();
        });

        it('cascades when a dependency changes', () => {
            api.createVariable(calc('sum', 'se__a + se__b'));
            setVar('chat-1', 'se__a', 10, { name: 'se__a', type: 'number' });
            recalculateDependents('chat-1', 'se__a');
            expect(getVar('chat-1', 'se__sum').value).toBe(14);
        });

        it('updateVariable re-derives dependencies and re-evaluates when the expression changes', () => {
            api.createVariable(calc('sum', 'se__a + se__b'));
            const updated = api.updateVariable(ref('sum'), { expression: 'se__a - se__b' });
            expect([...updated.dependencies].sort()).toEqual(['se__a', 'se__b']);
            expect(getVar('chat-1', 'se__sum').value).toBe(-1);
        });

        it('updateVariable drops a dependency the new expression no longer uses', () => {
            api.createVariable(calc('x', 'se__a + se__b'));
            const updated = api.updateVariable(ref('x'), { expression: 'se__a * 5' });
            expect(updated.dependencies).toEqual(['se__a']);
        });

        it('a non-expression patch leaves dependencies untouched', () => {
            api.createVariable(calc('sum', 'se__a + se__b'));
            const updated = api.updateVariable(ref('sum'), { label: 'Total' });
            expect(updated.label).toBe('Total');
            expect(updated.dependencies).toHaveLength(2);
        });

        it('updateVariable rejects an invalid new expression and leaves the old one in place', () => {
            api.createVariable(calc('sum', 'se__a + se__b'));
            expect(api.updateVariable(ref('sum'), { expression: 'se__ghost' })).toBeNull();
            expect(api.getVariable(ref('sum')).expression).toBe('se__a + se__b');
        });

        it('exposes validateCalculatedDefinition / applyCalculatedDefinition (identity-checked)', () => {
            const ok = stateEngine.validateCalculatedDefinition(extensionId, instanceId, { type: 'calculated', expression: 'se__a + 1', namespace: 'se', presetName: 'Demo' });
            expect(ok).toEqual({ ok: true, deps: ['se__a'] });

            const notCalc = stateEngine.validateCalculatedDefinition(extensionId, instanceId, { type: 'number', namespace: 'se', presetName: 'Demo' });
            expect(notCalc.ok).toBe(false);
        });
    });

    describe('updateVariable', () => {
        it('rejects patch.value and leaves the stored value alone', () => {
            api.createVariable(plain('hp'));
            expect(api.updateVariable(ref('hp'), { value: 999 })).toBeNull();
            expect(getVar('chat-1', 'se__hp').value).toBe(3);
        });

        it('resets the stored value when the type changes (definition replaced, not mutated in place)', () => {
            api.createVariable(plain('hp'));
            api.updateVariable(ref('hp'), { type: 'string', defaultValue: 'none' });
            expect(getVar('chat-1', 'se__hp').value).toBe('none');
        });

        it('renames within the same namespace and rejects a colliding rename', () => {
            api.createVariable(plain('a'));
            api.createVariable(plain('b'));
            expect(api.updateVariable(ref('a'), { name: 'b' })).toBeNull();
            expect(api.updateVariable(ref('a'), { name: 'c' }).name).toBe('se__c');
        });

        it('returns null for a variable that does not exist', () => {
            expect(api.updateVariable(ref('ghost'), {})).toBeNull();
        });
    });

    describe('deleteVariable / getVariable / listVariables', () => {
        it('deleteVariable removes the definition and clears its stored value everywhere', () => {
            api.createVariable(plain('hp'));
            expect(api.deleteVariable(ref('hp'))).toBe(true);
            expect(deleteVariableValueEverywhere).toHaveBeenCalledWith('se__hp');
            expect(context.variables.local.has('se__hp')).toBe(false);
            expect(api.getVariable(ref('hp'))).toBeUndefined();
        });

        it('deleteVariable returns false for a missing variable', () => {
            expect(api.deleteVariable(ref('ghost'))).toBe(false);
        });

        it('getVariable returns the definition; listVariables returns them all', () => {
            api.createVariable(plain('a'));
            api.createVariable(plain('b'));
            expect(api.getVariable(ref('a')).name).toBe('se__a');
            expect(api.listVariables('Demo').map((v) => v.name).sort()).toEqual(['se__a', 'se__b']);
            expect(api.listVariables('Nope')).toEqual([]);
        });
    });

    it('persists definitions to settings', () => {
        api.createVariable(plain('hp'));
        const preset = Object.values(settings.snapshot().presets).find((p) => p.name === 'Demo');
        expect(Object.values(preset.variables).map((v) => v.name)).toEqual(['se__hp']);
    });
});
