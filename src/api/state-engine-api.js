// State Engine — Public API façade

import * as ns from './namespace-manager.js';
import * as presets from './preset-api.js';
import * as vars from './variable-api.js';
import * as events from './event-api.js';
import * as ext from './extension-registry.js';
import * as deps from './dependency-graph.js';
import * as indep from './independent-presets.js';

export const stateEngine = {
    ...ns,
    ...presets,
    ...vars,
    ...events,
    ...ext,
    ...deps,
    ...indep,
};
