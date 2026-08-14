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

/** Pre-universal-core shape (commit 9957984). Still present on some deployed disks. */
interface LegacyVideoStats {
    videoId?: string;
    creatorAddress?: string;
    displayAdminAddress?: string;
    originAdminAddress?: string;
    creatorEarned?: number;
    displayAdminEarned?: number;
    originAdminEarned?: number;
}

type RawStatsEntry = ResourceStats | LegacyVideoStats | Record<string, unknown>;

function isResourceStats(entry: unknown): entry is ResourceStats {
    if (!entry || typeof entry !== 'object') return false;
    const earnings = (entry as ResourceStats).earnings;
    return typeof earnings === 'object' && earnings !== null && !Array.isArray(earnings);
}

function addEarning(earnings: Record<string, number>, address: string | undefined, amount: number | undefined) {
    if (!address || typeof amount !== 'number' || !(amount > 0) || !Number.isFinite(amount)) return;
    const addrLower = address.toLowerCase();
    earnings[addrLower] = (earnings[addrLower] ?? 0) + amount;
}

/** Convert legacy VideoStats (or unknown) into ResourceStats. */
export function normalizeStatsEntry(key: string, raw: RawStatsEntry): ResourceStats {
    if (isResourceStats(raw)) {
        const earnings: Record<string, number> = {};
        for (const [addr, amt] of Object.entries(raw.earnings)) {
            if (typeof amt === 'number' && Number.isFinite(amt) && amt > 0) {
                earnings[addr.toLowerCase()] = (earnings[addr.toLowerCase()] ?? 0) + amt;
            }
        }
        return {
            resourceId: typeof raw.resourceId === 'string' && raw.resourceId ? raw.resourceId : key,
            earnings,
        };
    }

    const legacy = raw as LegacyVideoStats;
    const earnings: Record<string, number> = {};
    addEarning(earnings, legacy.creatorAddress, legacy.creatorEarned);
    addEarning(earnings, legacy.displayAdminAddress, legacy.displayAdminEarned);
    addEarning(earnings, legacy.originAdminAddress, legacy.originAdminEarned);

    return {
        resourceId: (typeof legacy.videoId === 'string' && legacy.videoId) ? legacy.videoId : key,
        earnings,
    };
}

export class StatsService {
    private stats: Record<string, ResourceStats> = {};

    constructor() {
        this.loadStats();
    }

    private loadStats() {
        try {
            if (fs.existsSync(STATS_PATH)) {
                const parsed = JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8')) as Record<string, RawStatsEntry>;
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    this.stats = {};
                    return;
                }
                let needsRewrite = false;
                const normalized: Record<string, ResourceStats> = {};
                for (const [key, raw] of Object.entries(parsed)) {
                    if (!isResourceStats(raw)) needsRewrite = true;
                    normalized[key] = normalizeStatsEntry(key, raw);
                }
                this.stats = normalized;
                if (needsRewrite) {
                    console.log('[Stats] Migrated legacy earnings-stats.json to ResourceStats schema');
                    this.saveStats();
                }
            }
        } catch (err) {
            console.error('[Stats] Failed to load earnings-stats.json:', err);
            this.stats = {};
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

    private ensureResourceEntry(key: string): ResourceStats {
        const existing = this.stats[key];
        if (isResourceStats(existing)) {
            return existing;
        }
        const normalized = existing
            ? normalizeStatsEntry(key, existing as RawStatsEntry)
            : { resourceId: key, earnings: {} };
        this.stats[key] = normalized;
        return normalized;
    }

    public recordPayment(userId: string, sellerAddress: string, amount: number) {
        const session = sessionService.getSession(userId);
        if (!session) return;
        if (!sellerAddress || typeof amount !== 'number' || !(amount > 0) || !Number.isFinite(amount)) return;

        const key = session.resourceId || 'unknown';
        const entry = this.ensureResourceEntry(key);
        const addrLower = sellerAddress.toLowerCase();
        entry.earnings[addrLower] = (entry.earnings[addrLower] ?? 0) + amount;

        this.saveStats();
    }

    public getStatsByResource(resourceId: string): ResourceStats | null {
        const entry = this.stats[resourceId];
        if (!entry) return null;
        return this.ensureResourceEntry(resourceId);
    }

    public getEarningsByAddress(address: string): Array<{ resourceId: string; amount: number }> {
        const addrLower = address.toLowerCase();
        return Object.keys(this.stats)
            .map((key) => this.ensureResourceEntry(key))
            .filter(s => addrLower in s.earnings)
            .map(s => ({ resourceId: s.resourceId, amount: s.earnings[addrLower] }));
    }
}

export const statsService = new StatsService();
