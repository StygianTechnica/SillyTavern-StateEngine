// State Engine — connection profile selection

import { LOG_PREFIX, getSettings } from '../core/settings-core.js';

// Every SillyTavern connection profile as [{ id, name }], or [] when the
// service isn't available. Pure (no DOM) - shared by the two dropdown
// populators below and by the independent-preset editor (1.29, whose "model"
// field is built directly into the row's template HTML at render time, the
// same way the variable editor's calendar/itemType selects already are,
// rather than populated afterward like the two jQuery-based ones here).
export function listConnectionProfiles() {
    try {
        const context = SillyTavern.getContext();
        const svc = context.ConnectionManagerRequestService;
        if (svc && typeof svc.getSupportedProfiles === 'function') {
            return svc.getSupportedProfiles() || [];
        }
        if (context.extensionSettings?.connectionManager?.profiles) {
            return context.extensionSettings.connectionManager.profiles;
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not read connection profiles', err);
    }
    return [];
}

export function populateConnectionProfileDropdown() {
    const $select = $('#se_connection_profile');
    if (!$select.length) return;

    const settings = getSettings();
    const current = settings.connectionProfileId || '';
    const profiles = listConnectionProfiles();

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
// State Engine background-call connection profile override
// ---------------------------------------------------------------------------

export function populateStateEngineProfileDropdown() {
    const $select = $('#se_state_engine_profile');
    if (!$select.length) return;

    const settings = getSettings();
    const current = settings.stateEngineProfileId || '';
    const profiles = listConnectionProfiles();

    $select.empty();
    $select.append($('<option></option>').val('').text('Use chat model'));
    for (const profile of profiles) {
        if (!profile || !profile.id) continue;
        $select.append($('<option></option>').val(profile.id).text(profile.name || profile.id));
    }
    if (current && !profiles.some((p) => p.id === current)) {
        $select.append($('<option></option>').val(current).text(`(not found) ${current}`));
    }
    $select.val(current);
}
