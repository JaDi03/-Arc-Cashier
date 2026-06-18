import { GatewayClient } from '@circle-fin/x402-batching/client';
import { walletService } from './wallet';

/**
 * Streaming Session Management Service
 * Uses Circle Gateway for real settlement and refunds.
 */
export class SessionService {
    private activeSessions = new Map<string, { joinedAt: number, ratePerSecond: number }>();
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
                    
                    const PORT = process.env.PORT || 3000;
                    const sidecarUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
                    // Pass userId in the headers so the route knows who is paying and how much to charge
                    const payResult = await gatewayClient.pay<{ access: boolean }>(
                        `${sidecarUrl}/api/core/stream-access`,
                        {
                            headers: {
                                'x-user-id': userId
                            }
                        }
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

    public recordJoin(userId: string, ratePerSecond: number = 0.0001): void {
        this.activeSessions.set(userId, { joinedAt: Date.now(), ratePerSecond });
        console.log(`[Session] 🟢 Session started for user: ${userId} at rate $${ratePerSecond}/s`);
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
                console.warn(`[Session] ⚠️ User ${userId} requested settlement, but no active session found. Assuming 0s watch time.`);
            }

            // Get the user's session record
            const sessionRecord = walletService.getSessionRecord(userId);

            // Re-use GatewayClient if available, otherwise create it
            let gatewayClient = this.gatewayClients.get(userId);
            if (!gatewayClient) {
                gatewayClient = new GatewayClient({
                    privateKey: sessionRecord.privateKey as `0x${string}`,
                    chain: 'arcTestnet',
                });
            }

            // Check remaining Gateway balance
            const balances = await gatewayClient.getBalances();
            console.log(`[Session] 🔍 DEBUG Gateway Balances:`, balances.gateway);
            
            // Revert back to formattedAvailable for withdrawal until we understand why withdrawable is 0
            const withdrawableFormatted = balances.gateway.formattedAvailable;
            const withdrawable = Number(withdrawableFormatted);

            console.log(`[Session] 💰 Remaining Gateway withdrawable balance: ${withdrawableFormatted} USDC`);

            if (withdrawable > 0.001) {
                // Subtract Gateway withdrawal fee (~0.5%) to avoid "Insufficient balance" error
                const withdrawAmount = (withdrawable * 0.99).toFixed(6);

                // Withdraw remaining Gateway balance back to user's original wallet
                console.log(`[Session] 🧹 Withdrawing ${withdrawAmount} USDC (of ${withdrawableFormatted} withdrawable) back to ${sessionRecord.returnAddress}...`);

                const withdrawResult = await gatewayClient.withdraw(withdrawAmount, {
                    recipient: sessionRecord.returnAddress as `0x${string}`,
                });

                console.log(`[Session] ✅ Refund complete!`);
                console.log(`[Session]    Amount: ${withdrawResult.formattedAmount} USDC`);
                console.log(`[Session]    Tx: ${withdrawResult.mintTxHash}`);
            } else {
                console.log(`[Session] ℹ️ Gateway balance too low to refund.`);
            }
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            console.error(`[Session] ❌ Failed to process session close for ${userId}: ${err.message}`);
        } finally {
            walletService.clearSession(userId);
            this.settlementLocks.delete(userId);
            this.gatewayClients.delete(userId);
            console.log(`[Session] 🧹 Cleared ephemeral keys, clients and locks from memory for ${userId}`);
        }
    }
}

export const sessionService = new SessionService();
