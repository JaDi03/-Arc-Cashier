import * as fs from 'fs';
import * as path from 'path';

export interface CreatorProfile {
    creatorId: string;
    payoutAddress: string;
    platformFee: number; // e.g., 0.10 for 10% of each payment routed to the platform admin
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'creators.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Creator Service (PeerTube connector)
 *
 * Manages per-creator profiles including their payout address and the
 * platform fee rate configured by the PeerTube instance admin.
 *
 * platformFee is the fraction of each payment routed to the admin wallet
 * (SELLER_ADDRESS) to cover instance hosting costs. This concept only exists
 * in PeerTube — in Owncast the operator IS the creator, so no split is needed.
 */
export class CreatorService {
    private creators = new Map<string, CreatorProfile>();

    constructor() {
        this.loadDb();
    }

    private loadDb() {
        if (fs.existsSync(DB_PATH)) {
            try {
                const data = fs.readFileSync(DB_PATH, 'utf-8');
                const parsed = JSON.parse(data);
                for (const [key, value] of Object.entries(parsed)) {
                    this.creators.set(key, value as CreatorProfile);
                }
                console.log(`[PeerTube] 🧑‍🎨 Loaded ${this.creators.size} creator profiles.`);
            } catch (e) {
                console.error('[PeerTube] Error loading creators DB:', e);
            }
        } else {
            // Seed a default mock creator for testing
            this.registerCreator('demo-creator', '0x2222222222222222222222222222222222222222', 0.10);
        }
    }

    private saveDb() {
        try {
            const obj = Object.fromEntries(this.creators);
            fs.writeFileSync(DB_PATH, JSON.stringify(obj, null, 2));
        } catch (e) {
            console.error('[PeerTube] Error saving creators DB:', e);
        }
    }

    public registerCreator(creatorId: string, payoutAddress: string, platformFee: number = 0.10): void {
        this.creators.set(creatorId, {
            creatorId,
            payoutAddress,
            platformFee,
        });
        this.saveDb();
    }

    public getCreatorByAddress(address: string): CreatorProfile | null {
        for (const profile of this.creators.values()) {
            if (profile.payoutAddress.toLowerCase() === address.toLowerCase()) {
                return profile;
            }
        }
        return null;
    }
}

export const creatorService = new CreatorService();
