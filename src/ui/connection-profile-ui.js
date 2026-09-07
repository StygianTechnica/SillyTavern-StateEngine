// State Engine — connection profile selection

import { LOG_PREFIX, getSettings } from '../core/settings-core.js';

export function populateConnectionProfileDropdown() {
    const $select = $('#se_connection_profile');
    if (!$select.length) return;

    const context = SillyTavern.getContext();
    const settings = getSettings();
    const current = settings.connectionProfileId || '';

    let profiles = [];
    try {
        const svc = context.ConnectionManagerRequestService;
        if (svc && typeof svc.getSupportedProfiles === 'function') {
            profiles = svc.getSupportedProfiles() || [];
        } else if (context.extensionSettings?.connectionManager?.profiles) {
            profiles = context.extensionSettings.connectionManager.profiles;
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not read connection profiles', err);
    }

    $select.empty();
    $select.append($('<option></option>').val('').text('Use currently active connection'));
    for (const profile of profiles) {
        if (!profile || !profile.id) continue;
        $select.append($('<option></option>').val(profile.id).text(profile.name || profile.id));
    }
    if (current && !profiles.some((p) => p.id === current)) {
        $select.append($('<option></option>').val(current).text(`(not found) ${current}`));
    }
    $select.val(current);
}

// ---------------------------------------------------------------------------
// State Engine background-call model/backend override
//
// SillyTavern does not expose a generic "list all backends" / "list all
// models for a backend" API to extensions. The only backend+model pairings
// visible here are the ones already saved as Connection Profiles, so that's
// what these dropdowns are built from (same data source as the connection
// profile dropdown above).
// ---------------------------------------------------------------------------

function getStateEngineProfilesByBackend() {
    const context = SillyTavern.getContext();
    const backends = new Map(); // backend -> [{ model, profileId }]

    let profiles = [];
    try {
        const svc = context.ConnectionManagerRequestService;
        if (svc && typeof svc.getSupportedProfiles === 'function') {
            profiles = svc.getSupportedProfiles() || [];
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not read connection profiles for State Engine model override', err);
    }

    for (const profile of profiles) {
        if (!profile || !profile.id) continue;
        const backend = profile.api || 'unknown';
        if (!backends.has(backend)) backends.set(backend, []);
        backends.get(backend).push({
            model: profile.model || profile.name || profile.id,
            profileId: profile.id,
        });
    }

    return backends;
}

export function populateStateEngineBackendDropdown() {
    const $select = $('#se_state_engine_backend');
    if (!$select.length) return;

    const settings = getSettings();
    const current = settings.stateEngineBackend || '';
    const backends = getStateEngineProfilesByBackend();

    $select.empty();
    $select.append($('<option></option>').val('').text('Use chat model'));
    for (const backend of backends.keys()) {
        $select.append($('<option></option>').val(backend).text(backend));
    }
    if (current && !backends.has(current)) {
        $select.append($('<option></option>').val(current).text(`(not found) ${current}`));
    }
    $select.val(current);

    populateStateEngineModelDropdown(current);
}

export function populateStateEngineModelDropdown(backend) {
    const $select = $('#se_state_engine_model');
    if (!$select.length) return;

    const settings = getSettings();
    const current = settings.stateEngineModel || '';
    const backends = getStateEngineProfilesByBackend();
    const entries = backends.get(backend || '') || [];

    $select.empty();
    $select.append($('<option></option>').val('').text('Use chat model'));
    for (const entry of entries) {
        $select.append($('<option></option>').val(entry.model).text(entry.model));
    }
    if (current && !entries.some((e) => e.model === current)) {
        $select.append($('<option></option>').val(current).text(`(not found) ${current}`));
    }
    $select.val(current);
}
