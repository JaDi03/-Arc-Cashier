import { describe, it, expect } from 'vitest';
import {
    addressesEqual,
    agentUserIdFromAddress,
    isAgentUserId,
    isValidPrivateKeyHex,
    isValidViewerUserId,
    parseAgentAddress,
} from './session-key-auth';

describe('session-key-auth', () => {
    it('accepts email/social/legacy viewer userIds', () => {
        expect(isValidViewerUserId('email:a@b.com')).toBe(true);
        expect(isValidViewerUserId('social:104083036205001006721')).toBe(true);
        expect(isValidViewerUserId('arc_mlbogxpfyg')).toBe(true);
    });

    it('accepts agent userIds with an EVM address', () => {
        const addr = '0x1111222233334444555566667777888899990000';
        expect(isAgentUserId(`agent:${addr}`)).toBe(true);
        expect(isValidViewerUserId(`agent:${addr}`)).toBe(true);
        expect(parseAgentAddress(`agent:${addr}`)).toBe(addr);
        expect(agentUserIdFromAddress(addr)).toBe(`agent:${addr}`);
    });

    it('rejects invalid userIds', () => {
        expect(isValidViewerUserId('')).toBe(false);
        expect(isValidViewerUserId('user')).toBe(false);
        expect(isValidViewerUserId('email:')).toBe(false);
        expect(isValidViewerUserId('agent_abc')).toBe(false);
        expect(isValidViewerUserId('agent:0x123')).toBe(false);
        expect(isAgentUserId('email:a@b.com')).toBe(false);
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
