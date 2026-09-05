// State Engine — reserved variable name checks

// Known SillyTavern built-in variables and reserved names
const SILLYTAVERN_RESERVED_VARS = new Set([
    // Built-in SillyTavern character/chat variables
    'charname', 'char_name', 'user', 'user_name', 'bot_name', 'bot',
    'time', 'date', 'timestamp', 'year', 'month', 'day', 'hour', 'minute', 'second',
    'idle_duration', 'gmtime', 'lastmessage', 'lastsender', 'lastchar',
    'version', 'model', 'current_date', 'current_time',
    'random', 'randomfrom', 'dice',
    'counter', 'pos', 'iscreator', 'isgroup',
    'avatar', 'char', 'me', 'you', 'them',
    // Common extensions might use these
    'groupdesc', 'groupchat', 'group_name', 'group', 'members',
]);

export function isReservedVariable(name) {
    try {
        // Check against known built-in SillyTavern variables (case-insensitive)
        if (SILLYTAVERN_RESERVED_VARS.has(name.toLowerCase())) {
            return true;
        }

        // Also check if SillyTavern has this as a stored variable already
        const context = SillyTavern.getContext();
        if (context?.chat) {
            // Check chat variables
            const chatVars = context.chat.mes || [];
            if (chatVars.some && typeof chatVars === 'object') {
                // If it looks like there's a variable storage, check it
                if (context.chat.mesVariables && context.chat.mesVariables[name]) {
                    return true;
                }
            }
        }

        // Check if getvar macro exists with this name already (from SillyTavern's system)
        // This is harder to detect without direct API access, so we rely on the list above
        return false;
    } catch (e) {
        // If we can't check, assume it's not reserved (fail open)
        return false;
    }
}
