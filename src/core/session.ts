import { GatewayClient } from '@circle-fin/x402-batching/client';
import { walletService } from './wallet';

/**
 * Streaming Session Management Service
 * Uses Circle Gateway for real settlement and refunds.
 */
export class SessionService {
    private activeSessions = new Map<string, { joinedAt: number, ratePerSecond: number, creatorAddress?: string, videoId?: string }>();
    private gatewayClients = new Map<string, GatewayClient>();
    private settlementLocks = new Set<string>();
    private paymentInterval: ReturnType<typeof setInterval> | null = null;
    private readonly PAYMENT_INTERVAL_MS = 1000; // 1 second

    constructor() {
        this.startPaymentLoop();
    }

    private startPaymentLoop() {
        if (this.paymentInterval) return;
        this.paymentInterval = setInterval(async () => {
            if (this.activeSessions.size === 0) return;
            
            console.log(`[Session] ⏱️ Running continuous payment loop for ${this.activeSessions.size} active sessions...`);
            for (const [userId] of this.activeSessions) {
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
                    if (sessionData?.creatorAddress) {
                        headers['x-seller-address'] = sessionData.creatorAddress;
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
                    console.log(`[Session] ✅ Periodic payment successful for ${userId}: ${payResult.formattedAmount} USDC`);
                } catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    // Ignore errors silently for missing session records as they might have just disconnected
                    if (!err.message.includes('No session key found')) {
                        console.error(`[Session] ❌ Periodic payment failed for ${userId}: ${err.message}`);
                    }
                }
            }
        }, this.PAYMENT_INTERVAL_MS);
    }

    public recordJoin(userId: string, videoId?: string, ratePerSecond: number = 0.0001, creatorAddress?: string): void {
        this.activeSessions.set(userId, { joinedAt: Date.now(), ratePerSecond, creatorAddress, videoId });
        console.log(`[Session] 🟢 Session started for user: ${userId} on video: ${videoId || 'unknown'} at rate $${ratePerSecond}/s (Creator: ${creatorAddress || 'Default Admin'})`);
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
        return this.gatewayClients.get(userId) || null;
    }
}

export const sessionService = new SessionService();
