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
