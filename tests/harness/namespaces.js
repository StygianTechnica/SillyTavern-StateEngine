// Namespace ownership for tests - the REAL ownsNamespace()/createNamespace()
// (same reasoning as instance.js: ownership checks are what identity tests
// exercise, so they must not be mocked). The built-in `se` namespace is
// registered by settings.reset(); registerNamespaces() claims more, each one
// owned by an extension whose id equals its namespace.

import { ownsNamespace, createNamespace } from '../../src/api/namespace-manager.js';
import { ensureInstanceId } from '../../src/api/identity.js';

export function registerNamespaces(...names) {
    for (const namespace of names) createNamespace(namespace, ensureInstanceId(), namespace);
}

export { ownsNamespace };
export default ownsNamespace;
