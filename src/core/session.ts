import { GatewayClient } from '@circle-fin/x402-batching/client';
import { walletService } from './wallet';

/**
 * Streaming Session Management Service
 * Uses Circle Gateway for real settlement and refunds.
 */
export class SessionService {
    private activeSessions = new Map<string, { joinedAt: number, ratePerSecond: number, creatorAddress?: string, adminAddress?: string, platformFee: number, tickCount: number, videoId?: string }>();
    private gatewayClients = new Map<string, GatewayClient>();
    private settlementLocks = new Set<string>();
    private paymentInterval: ReturnType<typeof setInterval> | null = null;
    private isProcessingLoop = false;
    private readonly PAYMENT_INTERVAL_MS = 1000; // 1 second

    constructor() {
        this.startPaymentLoop();
    }

    private startPaymentLoop() {
        if (this.paymentInterval) return;
        this.paymentInterval = setInterval(async () => {
            if (this.activeSessions.size === 0) return;
            if (this.isProcessingLoop) {
                console.warn('[Session] - Previous payment loop execution is still running. Skipping this tick to prevent overlap.');
                return;
            }

            this.isProcessingLoop = true;
            console.log(`[Session] - Running continuous payment loop for ${this.activeSessions.size} active sessions...`);
            
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
                                });
                                this.gatewayClients.set(userId, gatewayClient);
                            }
                            const sessionData = this.activeSessions.get(userId);
                            const headers: Record<string, string> = { 'x-user-id': userId };
                            if (sessionData) {
                                // Deterministic fee split: every Nth tick goes to admin, rest to creator.
                                // N = round(1 / platformFee), e.g. every 10th tick for a 10% fee.
                                // This guarantees an exact proportional split on every session,
                                // unlike a per-session dice roll which can be wildly unfair.
                                sessionData.tickCount++;
                                const adminInterval = sessionData.platformFee > 0
                                    ? Math.round(1 / sessionData.platformFee)
                                    : 0;
                                const routeToAdmin = adminInterval > 0
                                    && !!sessionData.adminAddress
                                    && sessionData.tickCount % adminInterval === 0;

                                const payoutAddress = routeToAdmin
                                    ? sessionData.adminAddress
                                    : sessionData.creatorAddress;

                                if (payoutAddress) {
                                    headers['x-seller-address'] = payoutAddress;
                                }
                            }
                            if (sessionData?.videoId) {
                                headers['x-video-id'] = sessionData.videoId;
                            }

                            const PORT = process.env.PORT || 3000;
                            const sidecarUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
                            const payResult = await gatewayClient.pay<{ access: boolean }>(
                                `${sidecarUrl}/api/core/stream-access`,
                                { headers }
                            );
                            console.log(`[Session] - Periodic payment successful for ${userId}: ${payResult.formattedAmount} USDC`);
                        } catch (error: any) {
                            const errMsg = error.response?.data?.error 
                                || error.response?.data 
                                || error.message 
                                || String(error);
                            // Ignore errors silently for missing session records as they might have just disconnected
                            if (!String(errMsg).includes('No session key found')) {
                                console.error(`[Session] - Periodic payment failed for ${userId}:`, errMsg);
                                if (error.response?.data) {
                                    console.error(`[Session] - Error details:`, JSON.stringify(error.response.data));
                                }
                            }
                        }
                    }));
                }
            } finally {
                this.isProcessingLoop = false;
            }
        }, this.PAYMENT_INTERVAL_MS);
    }

    public recordJoin(userId: string, videoId?: string, ratePerSecond: number = 0.0001, creatorAddress?: string, adminAddress?: string, platformFee: number = 0): void {
        this.activeSessions.set(userId, { joinedAt: Date.now(), ratePerSecond, creatorAddress, adminAddress, platformFee, tickCount: 0, videoId });
        const adminInterval = platformFee > 0 ? Math.round(1 / platformFee) : 0;
        const splitDesc = adminAddress && adminInterval > 0
            ? `every tick → creator, every ${adminInterval}th tick → admin (${(platformFee * 100).toFixed(0)}%)`
            : `100% → creator (no admin configured)`;
        console.log(`[Session] 🟢 Session started for user: ${userId} | video: ${videoId || 'unknown'} | $${ratePerSecond}/s | ${splitDesc}`);
    }

    public hasActiveSession(userId: string): boolean {
        return this.activeSessions.has(userId);
    }

    public getActiveSessionCount(): number {
        return this.activeSessions.size;
    }

    public getRateForUser(userId: string): number | null {
        const session = this.activeSessions.get(userId);
        return session ? session.ratePerSecond : null;
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
                console.warn(`[Session] ⚠️ User ${userId} requested settlement, but no active session found.`);
            }

            // DO NOT automatically withdraw funds. The user must manually cash-out via /cash-out.
            // DO NOT clear the session record. It must persist so they can return later.
            
            this.gatewayClients.delete(userId);
            console.log(`[Session] ⏸️ Billing stopped for ${userId}. Funds remain in Gateway.`);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            console.error(`[Session] ❌ Failed to process session close for ${userId}: ${err.message}`);
        } finally {
            this.settlementLocks.delete(userId);
        }
    }
    /** Returns the GatewayClient for a user if they have an active session, or null. */
    public getGatewayClientForUser(userId: string): GatewayClient | null {
        let client = this.gatewayClients.get(userId) || null;
        if (!client) {
            try {
                const sessionRecord = walletService.getSessionRecord(userId);
                client = new GatewayClient({
                    privateKey: sessionRecord.privateKey as `0x${string}`,
                    chain: 'arcTestnet',
                });
                this.gatewayClients.set(userId, client);
            } catch (_) {
                // Ignore and return null if no session record exists
            }
        }
        return client;
    }
}

export const sessionService = new SessionService();
