import { describe, it, expect, beforeEach } from 'vitest';
import { WalletService } from './wallet';
import * as fs from 'fs';
import * as path from 'path';

// Mock environmental variable
process.env.MASTER_KEY = 'test-fallback-master-key-32-chars-long';

const DB_PATH = path.resolve(process.cwd(), 'data', 'sessions.json');

describe('WalletService', () => {
    let walletService: WalletService;

    beforeEach(() => {
        // Ensure clean test state by removing db file before each test
        if (fs.existsSync(DB_PATH)) {
            try {
                fs.unlinkSync(DB_PATH);
            } catch (_) {
                // Ignore if file does not exist
            }
        }
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

    it('should write encrypted data to disk', () => {
        const userId = 'user_encrypt_test';
        walletService.registerSessionKey(userId, '0xabcdef', '0x123456');

        const fileContent = fs.readFileSync(DB_PATH, 'utf-8');
        expect(fileContent.startsWith('{')).toBe(false);
        expect(fileContent.includes('0xabcdef')).toBe(false);
    });

    it('should migrate unencrypted database file automatically', () => {
        const plainData = {
            migrated_user: {
                privateKey: '0x999999',
                returnAddress: '0x888888'
            }
        };
        fs.writeFileSync(DB_PATH, JSON.stringify(plainData, null, 2), 'utf-8');

        // Re-instantiate service to trigger migration on loadDb
        const newService = new WalletService();
        const record = newService.getSessionRecord('migrated_user');
        expect(record.privateKey).toBe('0x999999');

        const fileContent = fs.readFileSync(DB_PATH, 'utf-8');
        expect(fileContent.startsWith('{')).toBe(false);
    });
});
