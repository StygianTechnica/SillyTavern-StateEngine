// The settings drawer's inputs must exist in settings.html. A drawer clean-up
// once removed "History messages sent" and "Max response length" while their
// settings and handlers stayed - everyone was fixed at the defaults with no
// way to change them, and nothing noticed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'settings.html'), 'utf8');

const SETTING_INPUTS = [
    'se_enabled', 'se_wand_visible', 'se_show_tracker_panel',
    'se_state_engine_profile', 'se_state_engine_temperature', 'se_state_engine_max_tokens',
    'se_context_count', 'se_response_length', 'se_max_prompt_history', 'se_max_message_length',
    'se_max_prompted_variable_chars',
    'se_prompted_header', 'se_prompted_header_reset', 'se_prompted_variable_rules', 'se_prompted_variable_rules_reset',
];

describe('settings drawer inputs', () => {
    it.each(SETTING_INPUTS)('%s is in settings.html', (id) => {
        expect(html).toContain(`id="${id}"`);
    });
});
