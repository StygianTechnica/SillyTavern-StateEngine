// State Engine — slash command registration

import { buildManagerModal } from '../../manager-modal.js';
import { LOG_PREFIX } from '../core/settings-core.js';
import { runPromptedStateUpdate } from '../core/prompted-engine.js';

export function registerSlashCommand() {
    // Best-effort: slash command registration APIs vary a little between
    // SillyTavern versions, so this is wrapped defensively and never blocks
    // the rest of the extension from loading if it fails.
    try {
        const context = SillyTavern.getContext();
        if (!context.SlashCommandParser || !context.SlashCommand?.fromProps) return;
        context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
            name: 'state-run',
            callback: async () => {
                await runPromptedStateUpdate('manual-all');
                return '';
            },
            helpString: 'Force State Engine to run all prompted variable updates right now.',
        }));
        context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
            name: 'state-manager',
            callback: async () => {
                buildManagerModal();
                return '';
            },
            helpString: 'Open the State Engine Manager (tabbed interface for presets, variables, triggers, and world info).',
        }));
    } catch (err) {
        console.warn(LOG_PREFIX, 'slash command registration skipped', err);
    }
}
