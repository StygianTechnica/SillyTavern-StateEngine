// State Engine — background (invisible) LLM generation for prompted variables

import { LOG_PREFIX } from './settings-core.js';

export async function callBackgroundLLM(context, settings, messages, maxTokens) {
    if (settings.stateEngineModel) {
        const overrideResult = await callWithStateEngineOverride(context, settings, messages, maxTokens);
        if (overrideResult !== null) return overrideResult;
    }

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

// Looks up the Connection Profile matching settings.stateEngineBackend +
// settings.stateEngineModel and routes the request through it, so State
// Engine background calls can use a different backend/model than chat.
// Returns null (not a string) when the override cannot be applied, so the
// caller falls back to the existing connectionProfileId/chat-model path.
async function callWithStateEngineOverride(context, settings, messages, maxTokens) {
    const svc = context.ConnectionManagerRequestService;
    if (!svc || typeof svc.getSupportedProfiles !== 'function' || typeof svc.sendRequest !== 'function') {
        console.warn(LOG_PREFIX, 'ConnectionManagerRequestService unavailable, cannot apply State Engine model override');
        return null;
    }

    let profiles = [];
    try {
        profiles = svc.getSupportedProfiles() || [];
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not read connection profiles for State Engine model override', err);
        return null;
    }

    const match = profiles.find((p) => p
        && (p.api || 'unknown') === (settings.stateEngineBackend || 'unknown')
        && (p.model || p.name || p.id) === settings.stateEngineModel);

    if (!match) {
        console.warn(LOG_PREFIX, `no connection profile found for State Engine backend "${settings.stateEngineBackend}" / model "${settings.stateEngineModel}", falling back`);
        return null;
    }

    const overrideMaxTokens = settings.stateEngineMaxTokens ?? maxTokens;
    const overrideOptions = { extractData: true, stream: false };
    if (settings.stateEngineTemperature !== null && settings.stateEngineTemperature !== undefined) {
        overrideOptions.temperature = settings.stateEngineTemperature;
    }

    try {
        const result = await svc.sendRequest(match.id, messages, overrideMaxTokens, overrideOptions);
        const text = extractTextFromServiceResult(result);
        if (text) return text;
        console.warn(LOG_PREFIX, 'State Engine model override request returned no usable text, falling back', result);
    } catch (err) {
        console.warn(LOG_PREFIX, 'State Engine model override request failed, falling back', err);
    }
    return null;
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
