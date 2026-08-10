import { describe, it, expect } from 'vitest';
import {
    addressesEqual,
    isValidPrivateKeyHex,
    isValidViewerUserId,
} from './session-key-auth';

describe('session-key-auth', () => {
    it('accepts email/social/legacy viewer userIds', () => {
        expect(isValidViewerUserId('email:a@b.com')).toBe(true);
        expect(isValidViewerUserId('social:104083036205001006721')).toBe(true);
        expect(isValidViewerUserId('arc_mlbogxpfyg')).toBe(true);
    });

    it('rejects invalid userIds', () => {
        expect(isValidViewerUserId('')).toBe(false);
        expect(isValidViewerUserId('user')).toBe(false);
        expect(isValidViewerUserId('email:')).toBe(false);
        expect(isValidViewerUserId(null)).toBe(false);
    });

    it('compares addresses case-insensitively', () => {
        expect(addressesEqual(
            '0xAbcDef0123456789AbcDef0123456789AbcDef01',
            '0xabcdef0123456789abcdef0123456789abcdef01'
        )).toBe(true);
        expect(addressesEqual(
            '0xAbcDef0123456789AbcDef0123456789AbcDef01',
            '0x1111111111111111111111111111111111111111'
        )).toBe(false);
    });

    it('validates private key hex', () => {
        expect(isValidPrivateKeyHex(
            '0x' + 'ab'.repeat(32)
        )).toBe(true);
        expect(isValidPrivateKeyHex('0xabc')).toBe(false);
        expect(isValidPrivateKeyHex('not-a-key')).toBe(false);
    });
});
