import * as fs from 'fs';
import * as path from 'path';
import { sessionService } from './session';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STATS_PATH = path.join(DATA_DIR, 'earnings-stats.json');

export interface VideoStats {
    videoId: string;
    creatorAddress?: string;
    displayAdminAddress?: string;
    originAdminAddress?: string;
    creatorEarned: number;
    displayAdminEarned: number;
    originAdminEarned: number;
}

export class StatsService {
    private stats: Record<string, VideoStats> = {};

    constructor() {
        this.loadStats();
    }

    private loadStats() {
        try {
            if (fs.existsSync(STATS_PATH)) {
                const raw = fs.readFileSync(STATS_PATH, 'utf-8');
                this.stats = JSON.parse(raw);
            }
        } catch (err) {
            console.error('[Stats] ⚠️ Failed to load earnings-stats.json:', err);
        }
    }

    private saveStats() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            fs.writeFileSync(STATS_PATH, JSON.stringify(this.stats, null, 2), 'utf-8');
        } catch (err) {
            console.error('[Stats] ⚠️ Failed to save earnings-stats.json:', err);
        }
    }

    public recordPayment(userId: string, sellerAddress: string, amount: number) {
        const session = sessionService.getSession(userId);
        if (!session) {
            return;
        }

        const videoId = session.videoId || 'unknown';
        const sellerLower = sellerAddress.toLowerCase();

        // Initialize video stats if they don't exist
        if (!this.stats[videoId]) {
            this.stats[videoId] = {
                videoId,
                creatorAddress: session.creatorAddress,
                displayAdminAddress: session.displayAdminAddress,
                originAdminAddress: session.originAdminAddress,
                creatorEarned: 0,
                displayAdminEarned: 0,
                originAdminEarned: 0
            };
        }

        const videoStats = this.stats[videoId];

        // Dynamically sync/update addresses in case they changed
        if (session.creatorAddress) videoStats.creatorAddress = session.creatorAddress;
        if (session.displayAdminAddress) videoStats.displayAdminAddress = session.displayAdminAddress;
        if (session.originAdminAddress) videoStats.originAdminAddress = session.originAdminAddress;

        // Detect role of the seller address
        if (session.creatorAddress && sellerLower === session.creatorAddress.toLowerCase()) {
            videoStats.creatorEarned += amount;
        } else if (session.displayAdminAddress && sellerLower === session.displayAdminAddress.toLowerCase()) {
            videoStats.displayAdminEarned += amount;
        } else if (session.originAdminAddress && sellerLower === session.originAdminAddress.toLowerCase()) {
            videoStats.originAdminEarned += amount;
        } else {
            // Fallback to creator if address matches none (safety fallback)
            videoStats.creatorEarned += amount;
        }

        this.saveStats();
    }

    public getCreatorStats(address: string): Array<{ videoId: string, amount: number }> {
        const lowerAddr = address.toLowerCase();
        const results: Array<{ videoId: string, amount: number }> = [];

        for (const key of Object.keys(this.stats)) {
            const videoStats = this.stats[key];
            if (videoStats.creatorAddress && videoStats.creatorAddress.toLowerCase() === lowerAddr) {
                results.push({
                    videoId: videoStats.videoId,
                    amount: videoStats.creatorEarned
                });
            }
        }
        return results;
    }

    public getAdminStats(): Array<{ videoId: string, displayAmount: number, originAmount: number }> {
        const results: Array<{ videoId: string, displayAmount: number, originAmount: number }> = [];
        for (const key of Object.keys(this.stats)) {
            const videoStats = this.stats[key];
            if (videoStats.displayAdminEarned > 0 || videoStats.originAdminEarned > 0) {
                results.push({
                    videoId: videoStats.videoId,
                    displayAmount: videoStats.displayAdminEarned,
                    originAmount: videoStats.originAdminEarned
                });
            }
        }
        return results;
    }
}

export const statsService = new StatsService();
