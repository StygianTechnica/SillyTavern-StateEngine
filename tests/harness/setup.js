// Vitest setup: runs before every test file.
//
// context.js must stay the first import - it defines `window`, which the
// real src/core/settings-core.js (imported via settings.js) touches at load.
import context, { installContext, resetContext } from './context.js';
import settings from './settings.js';
import { beforeEach, vi } from 'vitest';

installContext();

// Core modules replaced with harness mocks (vi.mock in a setup file applies
// to every test file). Paths are relative to THIS file.
vi.mock('../../src/core/preset-manager.js', () => import('./preset-manager.mock.js'));
vi.mock('../../src/core/chat-state.js', () => import('./chat-state.mock.js'));
vi.mock('../../src/core/calculated-engine.js', () => import('./calculated-engine.mock.js'));
vi.mock('../../src/core/macro-registration.js', () => import('./macro-registration.mock.js'));
vi.mock('../../src/events/event-engine.js', () => import('./event-engine.mock.js'));

beforeEach(() => {
    resetContext();
    settings.reset(); // fresh settings blob + built-in `se` namespace registered
    globalThis.__seCalcErrors?.clear();
    globalThis.__seRegisteredMacros?.clear();
    // The API layer console.warn()s on every deliberate failure path (that is
    // its "log, don't throw" convention) - silenced so output stays readable,
    // but still a spy, so a test can assert on it.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.clearAllMocks(); // clears call history only, keeps the mocks' implementations
});

export { context };
