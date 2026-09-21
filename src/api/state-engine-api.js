// State Engine — Public API façade

import * as ns from './namespace-manager.js';
import * as presets from './preset-api.js';
import * as vars from './variable-api.js';
import * as events from './event-api.js';
import * as ext from './extension-registry.js';
import * as reg from './extension-registration.js';
import * as cap from './capability-graph.js';
import * as batching from './batching.js';
import * as deps from './dependency-graph.js';
import * as indep from './independent-presets.js';
import * as notifications from './notification-api.js';

export const stateEngine = {
    ...ns,
    ...presets,
    ...vars,
    ...events,
    ...ext,
    ...reg,
    ...cap,
    ...batching,
    ...deps,
    ...indep,
    ...notifications,
};
