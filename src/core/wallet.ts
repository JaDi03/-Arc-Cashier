import type { Hex } from 'viem';
import * as fs from 'fs';
import * as path from 'path';

export interface SessionRecord {
    privateKey: Hex;
    returnAddress: string;
    sourceChain?: string;
}

const DB_PATH = path.resolve(process.cwd(), 'sessions.json');

/**
 * Wallet Abstraction Service
 * Manages the custody of ephemeral Session Keys delegated by the viewers.
 * 
 * In production, this should be backed by a secure vault (e.g., AWS KMS, HashiCorp Vault) and a real database.
 * For the hackathon, keys are stored in a local JSON file to persist across restarts.
 */
export class WalletService {
    private sessionRecords = new Map<string, SessionRecord>();

    constructor() {
        this.loadDb();
    }

    private loadDb() {
        if (fs.existsSync(DB_PATH)) {
            try {
                const data = fs.readFileSync(DB_PATH, 'utf-8');
                const parsed = JSON.parse(data);
                for (const [key, value] of Object.entries(parsed)) {
                    this.sessionRecords.set(key, value as SessionRecord);
                }
                console.log(`[Wallet] 📁 Loaded ${this.sessionRecords.size} sessions from DB.`);
            } catch (e) {
                console.error('[Wallet] Error loading DB:', e);
            }
        }
    }

    private saveDb() {
        try {
            const obj = Object.fromEntries(this.sessionRecords);
            fs.writeFileSync(DB_PATH, JSON.stringify(obj, null, 2));
        } catch (e) {
            console.error('[Wallet] Error saving DB:', e);
        }
    }

    /**
     * Registers a funded ephemeral key and return address for a user.
     */
    public registerSessionKey(userId: string, privateKey: string, returnAddress: string, sourceChain?: string): void {
        this.sessionRecords.set(userId, {
            privateKey: privateKey as Hex,
            returnAddress,
            sourceChain
        });
        this.saveDb();
        console.log(`[Wallet] 🔐 Ephemeral Key registered for user: ${userId}`);
    }

    /**
     * Retrieves the session record for a specific user.
     * Throws if no session exists.
     */
    public getSessionRecord(userId: string): SessionRecord {
        const record = this.sessionRecords.get(userId);
        if (!record) {
            throw new Error(`No session key found for user ${userId}.`);
        }
        return record;
    }

    /**
     * Finds a session by the user's return address (MetaMask address).
     */
    public getSessionByReturnAddress(returnAddress: string): { userId: string, record: SessionRecord } | null {
        for (const [userId, record] of this.sessionRecords.entries()) {
            if (record.returnAddress.toLowerCase() === returnAddress.toLowerCase()) {
                return { userId, record };
            }
        }
        return null;
    }

    /**
     * Removes a session record after settlement is complete.
     */
    public clearSession(userId: string): void {
        this.sessionRecords.delete(userId);
        this.saveDb();
    }

    /**
     * Checks if a session record exists for a user.
     */
    public hasSessionRecord(userId: string): boolean {
        return this.sessionRecords.has(userId);
    }
}

export const walletService = new WalletService();
