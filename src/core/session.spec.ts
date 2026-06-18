import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionService } from './session';
import { walletService } from './wallet';

// Mock the walletService
vi.mock('./wallet', () => ({
    walletService: {
        getSessionRecord: vi.fn(),
        clearSession: vi.fn(),
    }
}));

// Mock the GatewayClient
vi.mock('@circle-fin/x402-batching/client', () => {
    return {
        GatewayClient: class {
            async getBalances() {
                return { gateway: { formattedAvailable: '0.005' } };
            }
            async withdraw() {
                return { formattedAmount: '0.00495', mintTxHash: '0xabc123' };
            }
        }
    };
});

describe('SessionService', () => {
    let sessionService: SessionService;

    beforeEach(() => {
        sessionService = new SessionService();
        vi.clearAllMocks();
    });

    it('should record a join and allow parting without deleting the session key', async () => {
        const userId = 'user_test_1';
        
        sessionService.recordJoin(userId);
        expect(sessionService.hasActiveSession(userId)).toBe(true);

        await sessionService.recordPartAndSettle(userId);
        
        expect(sessionService.hasActiveSession(userId)).toBe(false);
        // Ensure walletService.clearSession was NOT called, preserving the funds
        expect(walletService.clearSession).not.toHaveBeenCalled();
    });

    it('should handle parting without an active session gracefully', async () => {
        const userId = 'unknown_user';
        
        // Part without joining
        await sessionService.recordPartAndSettle(userId);

        expect(sessionService.hasActiveSession(userId)).toBe(false);
    });
});
