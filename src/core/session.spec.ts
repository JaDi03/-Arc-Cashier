import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionService } from './session';
import { walletService } from './wallet';

vi.mock('./wallet', () => ({
    walletService: {
        getSessionRecord: vi.fn(),
        clearSession: vi.fn(),
    }
}));

vi.mock('@circle-fin/x402-batching/client', () => ({
    GatewayClient: class {
        async getBalances() {
            return { gateway: { formattedAvailable: '0.005' } };
        }
        async withdraw() {
            return { formattedAmount: '0.00495', mintTxHash: '0xabc123' };
        }
    }
}));

const BASE_REQUEST = {
    resourceId: 'video_test',
    ratePerSecond: '0.0001',
    payoutAddress: '0x000000000000000000000000000000000000dead',
    splits: [],
};

describe('SessionService', () => {
    let sessionService: SessionService;

    beforeEach(() => {
        sessionService = new SessionService();
        vi.clearAllMocks();
    });

    it('records a join and allows parting without clearing the session key', async () => {
        const userId = 'user_test_1';

        sessionService.recordJoin(userId, BASE_REQUEST);
        expect(sessionService.hasActiveSession(userId)).toBe(true);

        await sessionService.recordPartAndSettle(userId);

        expect(sessionService.hasActiveSession(userId)).toBe(false);
        expect(walletService.clearSession).not.toHaveBeenCalled();
    });

    it('handles parting without an active session gracefully', async () => {
        await sessionService.recordPartAndSettle('unknown_user');
        expect(sessionService.hasActiveSession('unknown_user')).toBe(false);
    });

    it('throws on invalid payoutAddress', () => {
        expect(() =>
            sessionService.recordJoin('user_bad', { ...BASE_REQUEST, payoutAddress: 'not-an-address' })
        ).toThrow('Invalid payoutAddress');
    });

    it('throws when split fractions sum to > 1', () => {
        expect(() =>
            sessionService.recordJoin('user_bad', {
                ...BASE_REQUEST,
                splits: [
                    { address: '0x000000000000000000000000000000000000beef', fraction: 0.7 },
                    { address: '0x000000000000000000000000000000000000cafe', fraction: 0.5 },
                ],
            })
        ).toThrow('fractions sum to');
    });
});
