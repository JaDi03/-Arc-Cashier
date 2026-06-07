import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionService } from './session';
import { walletService } from './wallet';
import { GatewayClient } from '@circle-fin/x402-batching/client';

// Mock the walletService
vi.mock('./wallet', () => ({
    walletService: {
        getSessionRecord: vi.fn(),
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

    it('should record a join and allow parting and settlement', async () => {
        const userId = 'user_test_1';
        
        // Mock wallet setup
        vi.mocked(walletService.getSessionRecord).mockReturnValue({
            privateKey: '0x123',
            returnAddress: '0xabc'
        });

        sessionService.recordJoin(userId);
        await sessionService.recordPartAndSettle(userId);
        
        // Expect that walletService was called to get the key
        expect(walletService.getSessionRecord).toHaveBeenCalledWith(userId);
    });

    it('should handle parting without an active session gracefully', async () => {
        const userId = 'unknown_user';
        
        vi.mocked(walletService.getSessionRecord).mockReturnValue({
            privateKey: '0x123',
            returnAddress: '0xabc'
        });

        // Part without joining
        await sessionService.recordPartAndSettle(userId);

        expect(walletService.getSessionRecord).toHaveBeenCalledWith(userId);
    });
});
