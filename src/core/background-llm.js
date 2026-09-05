// State Engine — background (invisible) LLM generation for prompted variables

import { LOG_PREFIX } from './settings-core.js';

export async function callBackgroundLLM(context, settings, messages, maxTokens) {
    const profileId = settings.connectionProfileId;
    if (profileId) {
        const svc = context.ConnectionManagerRequestService;
        if (svc && typeof svc.sendRequest === 'function') {
            try {
                const result = await svc.sendRequest(profileId, messages, maxTokens, { extractData: true, stream: false });
                const text = extractTextFromServiceResult(result);
                if (text) return text;
                console.warn(LOG_PREFIX, 'connection profile request returned no usable text, falling back to the active connection', result);
            } catch (err) {
                console.warn(LOG_PREFIX, 'connection profile request failed, falling back to the active connection', err);
            }
        } else {
            console.warn(LOG_PREFIX, 'ConnectionManagerRequestService.sendRequest unavailable, falling back to the active connection');
        }
    }
    return await context.generateRaw({ prompt: messages, responseLength: maxTokens });
}

export function extractTextFromServiceResult(result) {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object') {
        if (typeof result.content === 'string') return result.content;
        if (typeof result.text === 'string') return result.text;
        if (Array.isArray(result.choices) && result.choices[0]) {
            const choice = result.choices[0];
            if (typeof choice.message?.content === 'string') return choice.message.content;
            if (typeof choice.text === 'string') return choice.text;
        }
    }
    return '';
}
