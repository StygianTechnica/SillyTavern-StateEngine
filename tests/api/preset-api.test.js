import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import { addPresetToChat, deletePreset as deletePresetCore } from '../../src/core/preset-manager.js';
import { refreshVariableMacros } from '../../src/core/macro-registration.js';
import { deleteVariableValueEverywhere } from '../../src/core/chat-state.js';

const extensionId = 'se';
let instanceId;

beforeEach(() => {
    instanceId = ensureInstanceId();
});

describe('preset-api (identity-enforced)', () => {
    it('the harness replaced the core modules with mocks', () => {
        expect(vi.isMockFunction(addPresetToChat)).toBe(true);
        expect(vi.isMockFunction(refreshVariableMacros)).toBe(true);
    });

    describe('createPreset', () => {
        it('creates a preset stamped with its namespace', () => {
            const created = stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Demo', description: 'd', triggers: ['user'] });
            expect(created).toMatchObject({ name: 'Demo', namespace: 'se', description: 'd', triggers: ['user'] });
            expect(settings.get().presets[created.id].namespace).toBe('se');
        });

        it('persists to settings', () => {
            stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Demo' });
            expect(context.saveSettingsDebounced).toHaveBeenCalled();
        });

        it('rejects a duplicate (namespace, name) - the pair is the address', () => {
            stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Demo' });
            expect(stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Demo' })).toBeNull();
            expect(stateEngine.listPresets(extensionId, instanceId, 'se')).toHaveLength(1);
        });

        it('returns null (not a throw) when the caller is authorized but the def is incomplete', () => {
            expect(stateEngine.createPreset(extensionId, instanceId, { namespace: 'se' })).toBeNull();
        });
    });

    describe('updatePreset', () => {
        it('patches fields and renames through the core renamePreset', () => {
            stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Old' });
            const updated = stateEngine.updatePreset(extensionId, instanceId, 'se', 'Old', { name: 'New', description: 'x' });
            expect(updated).toMatchObject({ name: 'New', description: 'x' });
            expect(stateEngine.listPresets(extensionId, instanceId, 'se').map((p) => p.name)).toEqual(['New']);
        });

        it('refuses to move a preset to another namespace via patch', () => {
            stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Stay' });
            const updated = stateEngine.updatePreset(extensionId, instanceId, 'se', 'Stay', { namespace: 'other' });
            expect(updated.namespace).toBe('se');
        });

        it('rejects a rename that would collide with an existing preset', () => {
            stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'A' });
            stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'B' });
            expect(stateEngine.updatePreset(extensionId, instanceId, 'se', 'A', { name: 'B' })).toBeNull();
        });

        it('returns null for a preset that does not exist', () => {
            expect(stateEngine.updatePreset(extensionId, instanceId, 'se', 'Missing', {})).toBeNull();
        });
    });

    describe('activatePreset / deactivatePreset', () => {
        it('binds and unbinds the preset for a chat via the core add/remove', () => {
            const { id } = stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Demo' });

            expect(stateEngine.activatePreset(extensionId, instanceId, 'chat-1', 'se', 'Demo')).toBe(true);
            expect(settings.get().chatPresetBindings['chat-1'].presetIds).toContain(id);

            expect(stateEngine.deactivatePreset(extensionId, instanceId, 'chat-1', 'se', 'Demo')).toBe(true);
            expect(settings.get().chatPresetBindings['chat-1'].presetIds).not.toContain(id);
        });

        it('activation triggers seeding and a macro refresh (delegated, not reimplemented)', () => {
            stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Demo' });
            stateEngine.activatePreset(extensionId, instanceId, 'chat-1', 'se', 'Demo');
            expect(refreshVariableMacros).toHaveBeenCalled();
        });

        it('returns false for a missing preset or missing chat', () => {
            expect(stateEngine.activatePreset(extensionId, instanceId, 'chat-1', 'se', 'Missing')).toBe(false);
            stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Demo' });
            expect(stateEngine.activatePreset(extensionId, instanceId, '', 'se', 'Demo')).toBe(false);
        });
    });

    describe('deletePreset', () => {
        it('removes the preset, clears its variables\' stored values, and refreshes macros', () => {
            stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Demo' });
            stateEngine.createVariable(extensionId, instanceId, { namespace: 'se', presetName: 'Demo', name: 'hp', type: 'number', defaultValue: 3 });
            vi.clearAllMocks();

            expect(stateEngine.deletePreset(extensionId, instanceId, 'se', 'Demo')).toBe(true);

            expect(deletePresetCore).toHaveBeenCalledTimes(1);
            expect(deleteVariableValueEverywhere).toHaveBeenCalledWith('se__hp');
            expect(refreshVariableMacros).toHaveBeenCalled();
            expect(stateEngine.listPresets(extensionId, instanceId, 'se')).toEqual([]);
        });

        it('returns false for a missing preset', () => {
            expect(stateEngine.deletePreset(extensionId, instanceId, 'se', 'Missing')).toBe(false);
        });
    });

    describe('listPresets', () => {
        it('returns only the given namespace\'s presets', () => {
            registerNamespaces('pp');
            const ppId = ensureInstanceId();
            stateEngine.createPreset(extensionId, instanceId, { namespace: 'se', name: 'Mine' });
            stateEngine.createPreset('pp', ppId, { namespace: 'pp', name: 'Theirs' });

            expect(stateEngine.listPresets(extensionId, instanceId, 'se').map((p) => p.name)).toEqual(['Mine']);
            expect(stateEngine.listPresets('pp', ppId, 'pp').map((p) => p.name)).toEqual(['Theirs']);
        });
    });
});
