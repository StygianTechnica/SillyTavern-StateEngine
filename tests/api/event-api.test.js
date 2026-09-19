import context from '../harness/context.js';
import settings from '../harness/settings.js';
import ensureInstanceId from '../harness/instance.js';
import { registerNamespaces } from '../harness/namespaces.js';
import { stateEngine } from '../../src/api/index.js';
import { dispatchNamespacedEvent } from '../../src/events/event-engine.js';

const extensionId = 'se';
let instanceId;

beforeEach(() => {
    instanceId = ensureInstanceId();
});

describe('event-api (identity-enforced)', () => {
    describe('registerEventSource', () => {
        it('returns the namespace-qualified event name and stores its metadata', () => {
            const name = stateEngine.registerEventSource(extensionId, instanceId, { namespace: 'se', eventName: 'combatTick', description: 'tick' });
            expect(name).toBe('se.combatTick');
            expect(settings.get().eventSources['se.combatTick']).toMatchObject({ namespace: 'se', eventName: 'se.combatTick', description: 'tick' });
            expect(context.saveSettingsDebounced).toHaveBeenCalled();
        });

        it('returns null (not a throw) for an authorized caller with an incomplete info object', () => {
            expect(stateEngine.registerEventSource(extensionId, instanceId, { namespace: 'se' })).toBeNull();
        });
    });

    describe('fireEvent', () => {
        it('dispatches through the event-engine and reaches a real listener on the bus', () => {
            const heard = vi.fn();
            context.eventSource.on('se.combatTick', heard);

            expect(stateEngine.fireEvent(extensionId, instanceId, 'chat-1', 'se.combatTick')).toBe(true);

            expect(dispatchNamespacedEvent).toHaveBeenCalledWith('chat-1', 'se.combatTick');
            expect(heard).toHaveBeenCalledWith('chat-1');
        });

        it('only the matching event name reaches a listener', () => {
            const other = vi.fn();
            context.eventSource.on('se.other', other);
            stateEngine.fireEvent(extensionId, instanceId, 'chat-1', 'se.combatTick');
            expect(other).not.toHaveBeenCalled();
        });

        it('does not require the event to have been registered first - only its namespace prefix is validated', () => {
            expect(stateEngine.fireEvent(extensionId, instanceId, 'chat-1', 'se.neverRegistered')).toBe(true);
        });

        it('does not dispatch anything when identity is rejected', () => {
            registerNamespaces('pp');
            expect(() => stateEngine.fireEvent('pp', instanceId, 'chat-1', 'se.combatTick')).toThrow("Extension 'pp' does not own namespace 'se'");
            expect(dispatchNamespacedEvent).not.toHaveBeenCalled();
        });

        it('takes the target namespace from the event-name prefix', () => {
            registerNamespaces('pp');
            expect(stateEngine.fireEvent('pp', instanceId, 'chat-1', 'pp.rollDice')).toBe(true);
            expect(dispatchNamespacedEvent).toHaveBeenCalledWith('chat-1', 'pp.rollDice');
        });

        it('rejects an event name with no namespace prefix (nothing to authorize against)', () => {
            expect(() => stateEngine.fireEvent(extensionId, instanceId, 'chat-1', 'noPrefix')).toThrow(/no target namespace/);
            expect(dispatchNamespacedEvent).not.toHaveBeenCalled();
        });
    });
});
