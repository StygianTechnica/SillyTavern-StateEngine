// State Engine — display/text formatting helpers

export function stripHtml(str) {
    return String(str ?? '').replace(/<[^>]*>/g, '').trim();
}

export function extractJsonObject(text) {
    if (!text) return null;
    let s = String(text).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) return null;
    const candidate = s.slice(first, last + 1);
    try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        return null;
    } catch {
        return null;
    }
}

export function describeConstraint(def) {
    if (def.type === 'number') {
        const parts = [];
        if (def.min !== '' && def.min !== null && def.min !== undefined) parts.push(`min ${def.min}`);
        if (def.max !== '' && def.max !== null && def.max !== undefined) parts.push(`max ${def.max}`);
        return `number${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    if (def.type === 'boolean') return 'true or false';
    if (def.type === 'enum') return `one of: ${def.enumValues.join(', ')}`;
    if (def.type === 'array') {
        const itemType = def.itemType || 'any';
        let desc = `array of ${itemType}`;
        if (itemType === 'enum') {
            const allowed = Array.isArray(def.itemEnumValues) ? def.itemEnumValues : [];
            desc += ` (each item one of: ${allowed.join(', ')})`;
        }
        const constraints = [];
        if (Number.isFinite(def.maxLength)) constraints.push(`max ${def.maxLength} items`);
        if (def.unique) constraints.push('unique items');
        if (def.sorted) constraints.push('sorted');
        if (constraints.length) desc += ` (${constraints.join(', ')})`;
        const ops = ['push', 'unshift', 'pop', 'shift', 'rotate', 'clear'];
        if (itemType === 'enum') ops.push('toggle');
        desc += `. Reply with EITHER a full replacement array (e.g. ["a","b"]) OR an operation object `
            + `{"op": one of [${ops.map(o => `"${o}"`).join(', ')}], "value": <the item, required for push/unshift/toggle, ignored otherwise>} `
            + `- never mix the two formats, and never output anything besides the JSON value for this key`;
        return desc;
    }
    return 'text';
}

// function categoryLabel(cat) {
//     if (cat === 'counter') return 'Counter';
//     if (cat === 'cycling') return 'Cycling';
//     if (cat === 'prompted') return 'Prompted';
//     return 'Manual';
// }

export function typeLabel(type) {
    if (type === 'number') return 'Number';
    if (type === 'boolean') return 'True/False';
    if (type === 'enum') return 'Choice';
    if (type === 'array') return 'Array';
    return 'Text';
}

export function formatValueForDisplay(value) {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return `[${value.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(', ')}]`;
    }
    if (value === '' || value === undefined || value === null) return '—';
    return String(value);
}
