import type { Hex } from 'viem';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SessionRecord {
    privateKey: Hex;
    returnAddress: string;
    sourceChain?: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'sessions.json');

// Ensure data directory exists (important on first run with a fresh volume)
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getEncryptionKey(): Buffer {
    let masterKey = process.env.MASTER_KEY;
    if (!masterKey) {
        if (process.env.NODE_ENV === 'test') {
            masterKey = 'test-fallback-master-key-32-chars-long';
        } else {
            throw new Error('MASTER_KEY environment variable is not defined.');
        }
    }
    // Derive a secure 32-byte key using Scrypt
    return crypto.scryptSync(masterKey, 'tessera-salt', 32);
}

function encrypt(text: string): string {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12); // standard 12-byte IV for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(encryptedText: string): string {
    const key = getEncryptionKey();
    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted data format.');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

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
        // Enforce presence of MASTER_KEY on startup to prevent running insecurely, except in test env
        if (!process.env.MASTER_KEY && process.env.NODE_ENV !== 'test') {
            throw new Error('FATAL - MASTER_KEY environment variable is not defined. Active session keys cannot be loaded or saved safely.');
        }
        this.loadDb();
    }

    private loadDb() {
        if (fs.existsSync(DB_PATH)) {
            try {
                const rawData = fs.readFileSync(DB_PATH, 'utf-8').trim();
                if (!rawData) return;

                let dataToParse = rawData;
                let needsReencryption = false;

                if (rawData.startsWith('{')) {
                    // Backwards compatibility: migration of plain JSON to encrypted
                    console.log('[Wallet] - Found unencrypted database file. Migrating to encrypted format...');
                    needsReencryption = true;
                } else {
                    dataToParse = decrypt(rawData);
                }

                const parsed = JSON.parse(dataToParse);
                for (const [key, value] of Object.entries(parsed)) {
                    this.sessionRecords.set(key, value as SessionRecord);
                }
                console.log(`[Wallet] - Loaded ${this.sessionRecords.size} sessions from DB.`);

                if (needsReencryption) {
                    this.saveDb();
                }
            } catch (e: any) {
                console.error('[Wallet] Error loading DB:', e.message || e);
            }
        }
    }

    private saveDb() {
        try {
            const obj = Object.fromEntries(this.sessionRecords);
            const plainText = JSON.stringify(obj, null, 2);
            const encrypted = encrypt(plainText);
            fs.writeFileSync(DB_PATH, encrypted, 'utf-8');
        } catch (e: any) {
            console.error('[Wallet] Error saving DB:', e.message || e);
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
