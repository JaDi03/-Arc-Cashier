/**
 * Helpers for viewer session-key auth (ephemeral sync / register).
 * Pure checks only — Circle ownership lives in circle-routes.
 */

export function isValidViewerUserId(userId: unknown): userId is string {
    if (typeof userId !== 'string') return false;
    if (userId.length < 7 || userId.length > 256) return false;
    if (userId.startsWith('email:')) return userId.length > 'email:'.length;
    if (userId.startsWith('social:')) return userId.length > 'social:'.length;
    if (userId.startsWith('arc_')) return userId.length > 'arc_'.length;
    return false;
}

export function addressesEqual(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}

export function isValidPrivateKeyHex(privateKey: unknown): privateKey is `0x${string}` {
    return typeof privateKey === 'string' && /^0x[0-9a-fA-F]{64}$/.test(privateKey);
}
