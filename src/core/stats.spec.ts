import { describe, it, expect, beforeEach, vi } from 'vitest';
import { statsService } from './stats';
import { sessionService } from './session';

vi.mock('./session', () => ({
    sessionService: {
        getSession: vi.fn(),
    },
}));

describe('StatsService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (statsService as any).stats = {};
    });

    it('accumulates earnings per address per resource', () => {
        const mockSession = {
            resourceId: 'video_123',
            payoutAddress: '0xCreator',
            splits: [],
        };

        vi.mocked(sessionService.getSession).mockReturnValue(mockSession as any);

        statsService.recordPayment('user_1', '0xCreator', 0.0001);
        statsService.recordPayment('user_1', '0xDisplay', 0.0001);
        statsService.recordPayment('user_1', '0xCreator', 0.0001);

        const result = statsService.getStatsByResource('video_123');
        expect(result?.earnings['0xcreator']).toBeCloseTo(0.0002);
        expect(result?.earnings['0xdisplay']).toBeCloseTo(0.0001);
    });

    it('getEarningsByAddress returns only matching resources', () => {
        const mockSession = { resourceId: 'vid_abc', payoutAddress: '0xAddr', splits: [] };
        vi.mocked(sessionService.getSession).mockReturnValue(mockSession as any);

        statsService.recordPayment('user_1', '0xAddr', 0.005);

        const rows = statsService.getEarningsByAddress('0xAddr');
        expect(rows).toEqual([{ resourceId: 'vid_abc', amount: 0.005 }]);
    });
});
