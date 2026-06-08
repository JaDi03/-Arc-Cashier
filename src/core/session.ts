import { GatewayClient } from '@circle-fin/x402-batching/client';
import { walletService } from './wallet';

/**
 * Streaming Session Management Service
 * Uses Circle Gateway for real settlement and refunds.
 */
export class SessionService {
    private activeSessions = new Map<string, number>();
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
                    const sessionRecord = walletService.getSessionRecord(userId);
                    const gatewayClient = new GatewayClient({
                        privateKey: sessionRecord.privateKey as `0x${string}`,
                        chain: 'arcTestnet',
                    });
                    
                    const PORT = process.env.PORT || 3000;
                    const sidecarUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
                    const payResult = await gatewayClient.pay<{ access: boolean }>(
                        `${sidecarUrl}/api/core/stream-access`
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

    public recordJoin(userId: string): void {
        this.activeSessions.set(userId, Date.now());
        console.log(`[Session] 🟢 Session started for user: ${userId}`);
    }

    public hasActiveSession(userId: string): boolean {
        return this.activeSessions.has(userId);
    }

    public async recordPartAndSettle(userId: string): Promise<void> {
        if (this.settlementLocks.has(userId)) {
            console.log(`[Session] 🔒 Settlement already in progress for ${userId}, skipping.`);
            return;
        }
        this.settlementLocks.add(userId);

        try {
            const joinedTime = this.activeSessions.get(userId);

            if (joinedTime) {
                this.activeSessions.delete(userId);
                const durationSeconds = Math.ceil((Date.now() - joinedTime) / 1000);
                console.log(`[Session] 🔴 User ${userId} parted. Watch time: ${durationSeconds}s.`);
            } else {
                console.warn(`[Session] ⚠️ User ${userId} requested settlement, but no active session found. Assuming 0s watch time.`);
            }

            // Get the user's session record (ephemeral key + return address)
            const sessionRecord = walletService.getSessionRecord(userId);

            // Create GatewayClient with the ephemeral key
            const gatewayClient = new GatewayClient({
                privateKey: sessionRecord.privateKey as `0x${string}`,
                chain: 'arcTestnet',
            });

            // Check remaining Gateway balance
            const balances = await gatewayClient.getBalances();
            const availableFormatted = balances.gateway.formattedAvailable;
            const available = Number(availableFormatted);

            console.log(`[Session] 💰 Remaining Gateway balance: ${availableFormatted} USDC`);

            if (available > 0.001) {
                // Subtract Gateway withdrawal fee (~0.5%) to avoid "Insufficient balance" error
                const withdrawAmount = (available * 0.99).toFixed(6);

                // Withdraw remaining Gateway balance back to user's original wallet
                console.log(`[Session] 🧹 Withdrawing ${withdrawAmount} USDC (of ${availableFormatted} available) back to ${sessionRecord.returnAddress}...`);

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
            console.log(`[Session] 🧹 Cleared ephemeral keys and locks from memory for ${userId}`);
        }
    }
}

export const sessionService = new SessionService();
