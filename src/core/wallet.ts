import type { Hex } from 'viem';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SessionRecord {
    privateKey: Hex;
    returnAddress: string;
    sourceChain?: string;
    /** Agent sessions only: true until /agent/fund-session deposits into Gateway. */
    pending?: boolean;
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
            // Atomic write: write to a temp file in the same directory, then
            // rename() over the real path. rename() is atomic on POSIX
            // filesystems, so a process crash mid-write can never leave
            // sessions.json truncated/corrupted — readers always see either
            // the complete old file or the complete new file.
            const tmpPath = `${DB_PATH}.tmp-${process.pid}-${Date.now()}`;
            fs.writeFileSync(tmpPath, encrypted, 'utf-8');
            fs.renameSync(tmpPath, DB_PATH);
        } catch (e: any) {
            console.error('[Wallet] Error saving DB:', e.message || e);
        }
    }

    /**
     * Registers an ephemeral Gateway key and return address for a user.
     * Pass pending=true for agent sessions that still need /agent/fund-session.
     */
    public registerSessionKey(userId: string, privateKey: string, returnAddress: string, sourceChain?: string, pending = false): void {
        const record: SessionRecord = {
            privateKey: privateKey as Hex,
            returnAddress,
            sourceChain,
        };
        if (pending) record.pending = true;
        this.sessionRecords.set(userId, record);
        this.saveDb();
        console.log(`[Wallet] Ephemeral key registered for user: ${userId}${pending ? ' (pending funds)' : ''}`);
    }

    /**
     * Clears the pending flag after a successful Gateway deposit.
     */
    public markSessionFunded(userId: string): void {
        const record = this.getSessionRecord(userId);
        if (!record.pending) return;
        delete record.pending;
        this.sessionRecords.set(userId, record);
        this.saveDb();
    }

    /**
     * True when no record exists, or the record is still waiting for Gateway deposit.
     */
    public isSessionUnfunded(userId: string): boolean {
        if (!this.hasSessionRecord(userId)) return true;
        return this.getSessionRecord(userId).pending === true;
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
