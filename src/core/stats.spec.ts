import { describe, it, expect, beforeEach, vi } from 'vitest';
import { statsService, normalizeStatsEntry } from './stats';
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
        vi.spyOn(statsService as any, 'saveStats').mockImplementation(() => {});
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

    it('normalizes legacy VideoStats entries without crashing', () => {
        const legacyKey = 'f125803e-ce45-455a-8916-8ca803fe7f3e';
        ;(statsService as any).stats = {
            [legacyKey]: {
                videoId: legacyKey,
                creatorAddress: '0x5cCA6233A071314c60EF2243D2CF68802aAF6F19',
                displayAdminAddress: '0xcB0140bDB76F0a7B578D08DfF076718b2779bcd5',
                creatorEarned: 0.01,
                displayAdminEarned: 0.001,
                originAdminEarned: 0,
            },
        };

        vi.mocked(sessionService.getSession).mockReturnValue({
            resourceId: legacyKey,
            payoutAddress: '0x5cCA6233A071314c60EF2243D2CF68802aAF6F19',
            splits: [],
        } as any);

        expect(() => {
            statsService.recordPayment(
                'arc_mlbogxpfyg',
                '0x5cCA6233A071314c60EF2243D2CF68802aAF6F19',
                0.0001
            );
        }).not.toThrow();

        const result = statsService.getStatsByResource(legacyKey);
        expect(result?.earnings['0x5cca6233a071314c60ef2243d2cf68802aaf6f19']).toBeCloseTo(0.0101);
        expect(result?.earnings['0xcb0140bdb76f0a7b578d08dff076718b2779bcd5']).toBeCloseTo(0.001);

        const rows = statsService.getEarningsByAddress('0xcB0140bDB76F0a7B578D08DfF076718b2779bcd5');
        expect(rows).toEqual([{ resourceId: legacyKey, amount: 0.001 }]);
    });

    it('normalizeStatsEntry maps legacy role counters into earnings', () => {
        const normalized = normalizeStatsEntry('vid_1', {
            videoId: 'vid_1',
            creatorAddress: '0xAAA',
            displayAdminAddress: '0xBBB',
            creatorEarned: 1.5,
            displayAdminEarned: 0.2,
        });
        expect(normalized).toEqual({
            resourceId: 'vid_1',
            earnings: {
                '0xaaa': 1.5,
                '0xbbb': 0.2,
            },
        });
    });
});
