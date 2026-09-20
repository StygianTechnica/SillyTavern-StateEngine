// State Engine — world / lorebook name normalisation
//
// One tiny module with no imports, so anything (conditions, bindings, bundles)
// can use it without creating an import cycle.

// The world/book name an entry (or a caller's { world }) belongs to:
// world, else book, else folder, else "default". Every key State Engine builds
// from a lorebook name goes through this.
export function normalizeWorldName(entry) {
    return entry?.world || entry?.book || entry?.folder || 'default';
}
