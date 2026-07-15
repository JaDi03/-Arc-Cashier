import { describe, it, expect, beforeEach, vi } from 'vitest';
import { statsService } from './stats';
import { sessionService } from './session';

vi.mock('./session', () => {
    return {
        sessionService: {
            getSession: vi.fn(),
        },
    };
});

describe('StatsService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Clear internal stats map
        (statsService as any).stats = {};
    });

    it('records payment ticks correctly by role', () => {
        const mockSession = {
            videoId: 'video_123',
            creatorAddress: '0xCreator',
            displayAdminAddress: '0xDisplay',
            originAdminAddress: '0xOrigin',
        };

        vi.mocked(sessionService.getSession).mockReturnValue(mockSession as any);

        // Record creator payment
        statsService.recordPayment('user_1', '0xCreator', 0.0001);
        // Record display admin payment
        statsService.recordPayment('user_1', '0xDisplay', 0.0001);
        // Record origin admin payment
        statsService.recordPayment('user_1', '0xOrigin', 0.0001);

        const creatorStats = statsService.getCreatorStats('0xCreator');
        expect(creatorStats).toEqual([{ videoId: 'video_123', amount: 0.0001 }]);

        const adminStats = statsService.getAdminStats();
        expect(adminStats).toEqual([{ videoId: 'video_123', displayAmount: 0.0001, originAmount: 0.0001 }]);
    });
});
