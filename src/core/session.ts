import { GatewayClient } from '@circle-fin/x402-batching/client';
import { walletService } from './wallet';

const ARC_RPC_URL = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc-node.thecanteenapp.com';

// The payment loop always calls itself via localhost. The GatewayClient (x402 buyer)
// sends a payment to /api/core/stream-access, which runs in the same process.
// Circle's Gateway never makes inbound callbacks — so no public URL is ever needed here.
const PORT = process.env.PORT || 7878;
const SIDECAR_URL = `http://localhost:${PORT}`;

/**
 * Streaming Session Management Service
 * Uses Circle Gateway for real settlement and refunds.
 */
export class SessionService {
    private activeSessions = new Map<string, {
        joinedAt: number;
        ratePerSecond: number;
        creatorAddress?: string;
        displayAdminAddress?: string;
        displayFee: number;
        originAdminAddress?: string;
        originFee: number;
        tickCount: number;
        videoId?: string;
    }>();
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
                                    rpcUrl: ARC_RPC_URL,
                                });
                                this.gatewayClients.set(userId, gatewayClient);
                            }
                            const sessionData = this.activeSessions.get(userId);
                            const headers: Record<string, string> = { 'x-user-id': userId };
                            if (sessionData) {
                                // Prevent billing ahead of actual elapsed time (latency/jitter buffer)
                                const elapsedSeconds = Math.floor((Date.now() - sessionData.joinedAt) / 1000);
                                if (sessionData.tickCount >= elapsedSeconds) {
                                    return;
                                }

                                sessionData.tickCount++;

                                const TICK_CYCLE = 10;
                                const posInCycle = sessionData.tickCount % TICK_CYCLE;

                                let dSlots = Math.round(sessionData.displayFee * TICK_CYCLE);
                                let oSlots = Math.round(sessionData.originFee * TICK_CYCLE);

                                // Ensure at least 1 slot (10%) is reserved for the creator (capping admin fees at 90%)
                                if (dSlots + oSlots > 9) {
                                    const scale = 9 / (dSlots + oSlots);
                                    dSlots = Math.round(dSlots * scale);
                                    oSlots = Math.round(oSlots * scale);
                                    if (dSlots + oSlots > 9) {
                                        dSlots = 9 - oSlots;
                                    }
                                }

                                // Creator-first ordering: creator fills the opening slots of every cycle.
                                // Admin fees are placed at the END of the cycle so that short sessions
                                // always benefit the creator rather than the platform admins.
                                const creatorSlots = TICK_CYCLE - dSlots - oSlots;
                                let payoutAddress = sessionData.creatorAddress;
                                if (posInCycle >= creatorSlots && posInCycle < creatorSlots + dSlots && sessionData.displayAdminAddress) {
                                    payoutAddress = sessionData.displayAdminAddress;
                                } else if (posInCycle >= creatorSlots + dSlots && sessionData.originAdminAddress) {
                                    payoutAddress = sessionData.originAdminAddress;
                                }

                                if (payoutAddress) {
                                    headers['x-seller-address'] = payoutAddress;
                                }
                            }
                            if (sessionData?.videoId) {
                                headers['x-video-id'] = sessionData.videoId;
                            }

                            console.log(`[Session-Loop-DEBUG] Ticking payment for ${userId}. URL: ${SIDECAR_URL}/api/core/stream-access | Headers: ${JSON.stringify(headers)}`);
                            
                            const payResult = await gatewayClient.pay<{ access: boolean }>(
                                `${SIDECAR_URL}/api/core/stream-access`,
                                { headers }
                            );
                            console.log(`[Session] - Periodic payment successful for ${userId}: ${payResult.formattedAmount} USDC`);
                        } catch (error: any) {
                            const errMsg = error.response?.data?.error 
                                || error.response?.data 
                                || error.message 
                                || String(error);
                            const status = error.response?.status || 'N/A';
                            console.error(`[Session-Loop-ERROR] Periodic payment failed for ${userId} (Status ${status}):`, errMsg);
                            if (error.response?.data) {
                                console.error(`[Session-Loop-ERROR] Response payload:`, JSON.stringify(error.response.data));
                            }
                        }
                    }));
                }
            } finally {
                this.isProcessingLoop = false;
            }
        }, this.PAYMENT_INTERVAL_MS);
    }

    public recordJoin(
        userId: string,
        videoId?: string,
        ratePerSecond: number = 0.0001,
        creatorAddress?: string,
        displayAdminAddress?: string,
        displayFee: number = 0,
        originAdminAddress?: string,
        originFee: number = 0
    ): void {
        this.activeSessions.set(userId, {
            joinedAt: Date.now(),
            ratePerSecond,
            creatorAddress,
            displayAdminAddress,
            displayFee,
            originAdminAddress,
            originFee,
            tickCount: 0,
            videoId
        });

        const displayPct = (displayFee * 100).toFixed(0);
        const originPct = (originFee * 100).toFixed(0);

        let splitDesc = '100% → creator';
        if (displayAdminAddress && originAdminAddress) {
            splitDesc = `${displayPct}% → display admin | ${originPct}% → origin admin | remainder → creator`;
        } else if (displayAdminAddress) {
            splitDesc = `${displayPct}% → display admin | remainder → creator`;
        } else if (originAdminAddress) {
            splitDesc = `${originPct}% → origin admin | remainder → creator`;
        }

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
                    rpcUrl: ARC_RPC_URL,
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
