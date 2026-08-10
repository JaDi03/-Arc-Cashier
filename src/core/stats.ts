import * as fs from 'fs';
import * as path from 'path';
import { sessionService } from './session';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STATS_PATH = path.join(DATA_DIR, 'earnings-stats.json');

export interface ResourceStats {
    resourceId: string;
    /** Total earned per payout address (address → USDC amount). */
    earnings: Record<string, number>;
}

export class StatsService {
    private stats: Record<string, ResourceStats> = {};

    constructor() {
        this.loadStats();
    }

    private loadStats() {
        try {
            if (fs.existsSync(STATS_PATH)) {
                this.stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8'));
            }
        } catch (err) {
            console.error('[Stats] Failed to load earnings-stats.json:', err);
        }
    }

    private saveStats() {
        try {
            if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(STATS_PATH, JSON.stringify(this.stats, null, 2), 'utf-8');
        } catch (err) {
            console.error('[Stats] Failed to save earnings-stats.json:', err);
        }
    }

    public recordPayment(userId: string, sellerAddress: string, amount: number) {
        const session = sessionService.getSession(userId);
        if (!session) return;

        const key = session.resourceId || 'unknown';
        if (!this.stats[key]) {
            this.stats[key] = { resourceId: key, earnings: {} };
        }

        const addrLower = sellerAddress.toLowerCase();
        this.stats[key].earnings[addrLower] = (this.stats[key].earnings[addrLower] ?? 0) + amount;

        this.saveStats();
    }

    public getStatsByResource(resourceId: string): ResourceStats | null {
        return this.stats[resourceId] ?? null;
    }

    public getEarningsByAddress(address: string): Array<{ resourceId: string; amount: number }> {
        const addrLower = address.toLowerCase();
        return Object.values(this.stats)
            .filter(s => addrLower in s.earnings)
            .map(s => ({ resourceId: s.resourceId, amount: s.earnings[addrLower] }));
    }
}

export const statsService = new StatsService();
