import { GatewayClient } from '@circle-fin/x402-batching/client';
import { isAddress } from 'viem';
import { walletService } from './wallet';
import type { Split, StartSessionRequest } from './types';

const ARC_RPC_URL = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';

const PORT = process.env.PORT || 7878;
const SIDECAR_URL = `http://localhost:${PORT}`;

const TICK_CYCLE = 10;
// Reserve at least 1 slot per cycle (10%) for the primary payee, no matter how
// many splits are configured or how large their fractions are.
const MAX_SPLIT_SLOTS = TICK_CYCLE - 1;

interface ResolvedSplit extends Split {
    /** Precomputed slot count out of TICK_CYCLE, normalized so total split slots never exceed MAX_SPLIT_SLOTS. */
    slots: number;
}

interface ActiveSessionData {
    joinedAt: number;
    ratePerSecond: number;
    payoutAddress: string;
    splits: ResolvedSplit[];
    tickCount: number;
    resourceId?: string;
}

/**
 * Normalizes connector-supplied splits into precomputed tick-cycle slot counts.
 * Guarantees the primary payee always receives at least one slot per cycle.
 * Throws if split fractions sum to > 1.
 */
function normalizeSplitsIntoSlots(splits: Split[]): ResolvedSplit[] {
    const totalFraction = splits.reduce((sum, split) => sum + split.fraction, 0);
    if (totalFraction > 1) {
        throw new Error(`Invalid splits: fractions sum to ${totalFraction}, must be <= 1`);
    }

    let rawSlots = splits.map((split) => Math.round(split.fraction * TICK_CYCLE));
    let totalSlots = rawSlots.reduce((sum, slots) => sum + slots, 0);

    if (totalSlots > MAX_SPLIT_SLOTS) {
        const scale = MAX_SPLIT_SLOTS / totalSlots;
        rawSlots = rawSlots.map((slots) => Math.round(slots * scale));
        totalSlots = rawSlots.reduce((sum, slots) => sum + slots, 0);

        let excess = totalSlots - MAX_SPLIT_SLOTS;
        for (let i = rawSlots.length - 1; i >= 0 && excess > 0; i--) {
            const reducible = Math.min(rawSlots[i], excess);
            rawSlots[i] -= reducible;
            excess -= reducible;
        }
    }

    return splits.map((split, i) => ({ ...split, slots: rawSlots[i] }));
}

/**
 * Returns the payout address for a given tick.
 * Primary payee fills the opening slots; splits are placed at the end of the
 * cycle so short sessions always benefit the primary payee first.
 */
function resolvePayoutForTick(session: ActiveSessionData, tickCount: number): string {
    const posInCycle = tickCount % TICK_CYCLE;
    const totalSplitSlots = session.splits.reduce((sum, split) => sum + split.slots, 0);
    const primarySlots = TICK_CYCLE - totalSplitSlots;

    if (posInCycle < primarySlots) {
        return session.payoutAddress;
    }

    let cursor = primarySlots;
    for (const split of session.splits) {
        if (posInCycle >= cursor && posInCycle < cursor + split.slots) {
            return split.address;
        }
        cursor += split.slots;
    }

    return session.payoutAddress;
}

export class SessionService {
    private activeSessions = new Map<string, ActiveSessionData>();
    private gatewayClients = new Map<string, GatewayClient>();
    private settlementLocks = new Set<string>();
    private paymentInterval: ReturnType<typeof setInterval> | null = null;
    private isProcessingLoop = false;
    private readonly PAYMENT_INTERVAL_MS = 1000;

    constructor() {
        this.startPaymentLoop();
    }

    private startPaymentLoop() {
        if (this.paymentInterval) return;
        this.paymentInterval = setInterval(async () => {
            if (this.activeSessions.size === 0) return;
            if (this.isProcessingLoop) {
                console.warn('[Session] Previous payment loop still running. Skipping tick.');
                return;
            }

            this.isProcessingLoop = true;

            try {
                const userIds = Array.from(this.activeSessions.keys());
                const chunkSize = 10;
                for (let i = 0; i < userIds.length; i += chunkSize) {
                    const chunk = userIds.slice(i, i + chunkSize);
                    await Promise.allSettled(chunk.map(async (userId) => {
                        try {
                            let gatewayClient = this.gatewayClients.get(userId);
                            if (!gatewayClient) {
                                const sessionRecord = walletService.getSessionRecord(userId);
                                gatewayClient = new GatewayClient({
                                    privateKey: sessionRecord.privateKey as `0x${string}`,
                                    chain: 'arcTestnet',
                                    rpcUrl: ARC_RPC_URL,
                                });
                                this.gatewayClients.set(userId, gatewayClient);
                            }
                            const sessionData = this.activeSessions.get(userId);
                            const headers: Record<string, string> = { 'x-user-id': userId };
                            let payeeSuffix = '????';
                            let payeeLabel = 'unknown';
                            if (sessionData) {
                                const elapsedSeconds = Math.floor((Date.now() - sessionData.joinedAt) / 1000);
                                if (sessionData.tickCount >= elapsedSeconds) return;

                                sessionData.tickCount++;
                                const payoutAddress = resolvePayoutForTick(sessionData, sessionData.tickCount);
                                headers['x-seller-address'] = payoutAddress;
                                if (sessionData.resourceId) headers['x-resource-id'] = sessionData.resourceId;

                                payeeSuffix = payoutAddress.slice(-6);
                                const payeeLower = payoutAddress.toLowerCase();
                                payeeLabel =
                                    payeeLower === sessionData.payoutAddress.toLowerCase()
                                        ? 'creator'
                                        : (sessionData.splits.find((s) => s.address.toLowerCase() === payeeLower)?.label ?? 'split');
                            }

                            const payResult = await gatewayClient.pay<{ access: boolean }>(
                                `${SIDECAR_URL}/api/core/stream-access`,
                                { headers }
                            );
                            console.log(
                                `[Session] Payment ok for ${userId}: ${payResult.formattedAmount} USDC -> ...${payeeSuffix} (${payeeLabel})`
                            );
                        } catch (error: any) {
                            const errMsg = error.response?.data?.error || error.response?.data || error.message || String(error);
                            console.error(`[Session] Payment failed for ${userId} (${error.response?.status ?? 'N/A'}):`, errMsg);
                        }
                    }));
                }
            } finally {
                this.isProcessingLoop = false;
            }
        }, this.PAYMENT_INTERVAL_MS);
    }

    /**
     * Starts billing a session. Throws on invalid input.
     * Callers (HTTP route handlers) translate thrown errors into 400 responses.
     */
    public recordJoin(userId: string, request: Omit<StartSessionRequest, 'userId'>): void {
        const rate = Number(request.ratePerSecond);
        if (!Number.isFinite(rate) || rate < 0) {
            throw new Error(`Invalid ratePerSecond: ${request.ratePerSecond}`);
        }
        if (!isAddress(request.payoutAddress)) {
            throw new Error(`Invalid payoutAddress: ${request.payoutAddress}`);
        }

        const rawSplits = request.splits ?? [];
        for (const split of rawSplits) {
            if (!isAddress(split.address)) throw new Error(`Invalid split address: ${split.address}`);
            if (split.fraction < 0 || split.fraction > 1) throw new Error(`Invalid split fraction: ${split.fraction}`);
        }

        const resolvedSplits = normalizeSplitsIntoSlots(rawSplits);

        this.activeSessions.set(userId, {
            joinedAt: Date.now(),
            ratePerSecond: rate,
            payoutAddress: request.payoutAddress,
            splits: resolvedSplits,
            tickCount: 0,
            resourceId: request.resourceId,
        });

        const splitDesc = resolvedSplits.length > 0
            ? resolvedSplits.map((s) => `${s.slots * 10}% → ${s.label ?? s.address}`).join(' | ') + ' | remainder → creator'
            : '100% → creator';

        console.log(`[Session] 🟢 Session started: ${userId} | resource: ${request.resourceId || 'unknown'} | $${rate}/s | ${splitDesc}`);
    }

    public hasActiveSession(userId: string): boolean {
        return this.activeSessions.has(userId);
    }

    public getActiveSessionCount(): number {
        return this.activeSessions.size;
    }

    public getRateForUser(userId: string): number | null {
        return this.activeSessions.get(userId)?.ratePerSecond ?? null;
    }

    public getSession(userId: string) {
        return this.activeSessions.get(userId);
    }

    public async recordPartAndSettle(userId: string): Promise<void> {
        if (this.settlementLocks.has(userId)) {
            console.log(`[Session] 🔒 Settlement already in progress for ${userId}, skipping.`);
            return;
        }
        this.settlementLocks.add(userId);

        try {
            const sessionData = this.activeSessions.get(userId);
            if (sessionData) {
                this.activeSessions.delete(userId);
                const durationSeconds = Math.ceil((Date.now() - sessionData.joinedAt) / 1000);
                console.log(`[Session] 🔴 User ${userId} parted. Watch time: ${durationSeconds}s.`);
            } else {
                console.warn(`[Session] ⚠️ No active session found for ${userId} on settlement.`);
            }

            this.gatewayClients.delete(userId);
            console.log(`[Session] ⏸️ Billing stopped for ${userId}. Funds remain in Gateway.`);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            console.error(`[Session] ❌ Failed to process session close for ${userId}: ${err.message}`);
        } finally {
            this.settlementLocks.delete(userId);
        }
    }

    public getGatewayClientForUser(userId: string): GatewayClient | null {
        let client = this.gatewayClients.get(userId) || null;
        if (!client) {
            try {
                const sessionRecord = walletService.getSessionRecord(userId);
                client = new GatewayClient({
                    privateKey: sessionRecord.privateKey as `0x${string}`,
                    chain: 'arcTestnet',
                    rpcUrl: ARC_RPC_URL,
                });
                this.gatewayClients.set(userId, client);
            } catch (_) {
                // No session record — return null silently.
            }
        }
        return client;
    }
}

export const sessionService = new SessionService();
