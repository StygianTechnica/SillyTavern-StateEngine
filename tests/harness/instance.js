// Instance identity for tests.
//
// Deliberately the REAL ensureInstanceId() from src/api/identity.js, not a
// mock: identity validation is the unit under test in identity.test.js, and a
// mocked token check would make every identity assertion vacuous. What the
// harness fakes is everything the real function reads (the settings blob and
// context) - see settings.js / context.js.

import { ensureInstanceId } from '../../src/api/identity.js';

export { ensureInstanceId };
export default ensureInstanceId;
