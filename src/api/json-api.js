// JSON API
//
// Reading JSON out of a model's answer the forgiving way State Engine's own
// prompted updates do (src/ui/formatting-utils.js), for extensions that
// make their own model calls (Scenario Builder's generation, for one):
// code fences and chatter around the JSON, notes and comments between
// values, bare words as values, missing commas, missing closing brackets,
// and an answer cut off before its end (the finished values are kept).
//
//   parseModelJson(text)       -> the object, or null
//   parseModelJsonArray(text)  -> the top-level list, or null
//
// Pure functions - no caller identity, nothing stored, nothing logged
// beyond State Engine's own warnings about what it had to repair.

import { extractJsonObject, extractJsonArray } from '../ui/formatting-utils.js';

export function parseModelJson(text) {
    return extractJsonObject(text);
}

export function parseModelJsonArray(text) {
    return extractJsonArray(text);
}
