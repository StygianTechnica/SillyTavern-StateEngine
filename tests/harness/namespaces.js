// Namespace ownership for tests - the REAL ownsNamespace()/registerExtension()
// (same reasoning as instance.js: ownership checks are what identity tests
// exercise, so they must not be mocked). The built-in `se` namespace is
// registered by settings.reset(); registerNamespaces() adds more.

import { ownsNamespace } from '../../src/api/namespace-manager.js';
import { registerExtension } from '../../src/api/extension-registry.js';

export function registerNamespaces(...names) {
    for (const namespace of names) registerExtension({ namespace });
}

export { ownsNamespace };
export default ownsNamespace;
