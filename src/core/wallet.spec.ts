import { describe, it, expect, beforeEach } from 'vitest';
import { WalletService } from './wallet';

describe('WalletService', () => {
    let walletService: WalletService;

    beforeEach(() => {
        walletService = new WalletService();
    });

    it('should register and retrieve a session key', () => {
        const userId = 'user123';
        const privateKey = '0x123';
        const returnAddress = '0xabc';

        walletService.registerSessionKey(userId, privateKey, returnAddress);
        const record = walletService.getSessionRecord(userId);

        expect(record.privateKey).toBe(privateKey);
        expect(record.returnAddress).toBe(returnAddress);
    });

    it('should throw when retrieving a non-existent session key', () => {
        expect(() => walletService.getSessionRecord('unknown_user')).toThrow();
    });

    it('should clear a session', () => {
        const userId = 'user123';
        walletService.registerSessionKey(userId, '0x123', '0xabc');
        walletService.clearSession(userId);

        expect(() => walletService.getSessionRecord(userId)).toThrow();
    });
});
