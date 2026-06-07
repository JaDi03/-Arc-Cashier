import type { Hex } from 'viem';

export interface SessionRecord {
    privateKey: Hex;
    returnAddress: string;
}

/**
 * Wallet Abstraction Service
 * Manages the custody of ephemeral Session Keys delegated by the viewers.
 * 
 * In production, this should be backed by a secure vault (e.g., AWS KMS, HashiCorp Vault).
 * For the demo, keys are stored in memory and destroyed when the process exits.
 */
export class WalletService {
    private sessionRecords = new Map<string, SessionRecord>();

    /**
     * Registers a funded ephemeral key and return address for a user.
     */
    public registerSessionKey(userId: string, privateKey: string, returnAddress: string): void {
        this.sessionRecords.set(userId, {
            privateKey: privateKey as Hex,
            returnAddress,
        });
        console.log(`[Wallet] 🔐 Ephemeral Key registered for user: ${userId}`);
    }

    /**
     * Retrieves the session record for a specific user.
     * Throws if no session exists (user never funded).
     */
    public getSessionRecord(userId: string): SessionRecord {
        const record = this.sessionRecords.get(userId);
        if (!record) {
            throw new Error(`No session key found for user ${userId}. User must fund a session key via the Lobby.`);
        }
        return record;
    }

    /**
     * Removes a session record after settlement is complete.
     */
    public clearSession(userId: string): void {
        this.sessionRecords.delete(userId);
    }

    /**
     * Checks if a session record exists for a user.
     */
    public hasSessionRecord(userId: string): boolean {
        return this.sessionRecords.has(userId);
    }
}

export const walletService = new WalletService();
