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
