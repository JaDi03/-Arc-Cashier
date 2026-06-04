import { GatewayClient } from '@circle-fin/x402-batching/client';
import { walletService } from './wallet';

/**
 * Streaming Session Management Service
 * Uses Circle Gateway for real settlement and refunds.
 */
export class SessionService {
    private activeSessions = new Map<string, number>();

    public recordJoin(userId: string): void {
        this.activeSessions.set(userId, Date.now());
        console.log(`[Session] 🟢 Session started for user: ${userId}`);
    }

    public async recordPartAndSettle(userId: string): Promise<void> {
        let durationSeconds = 0;
        const joinedTime = this.activeSessions.get(userId);

        if (joinedTime) {
            this.activeSessions.delete(userId);
            durationSeconds = Math.ceil((Date.now() - joinedTime) / 1000);
            console.log(`[Session] 🔴 User ${userId} parted. Watch time: ${durationSeconds}s.`);
        } else {
            console.warn(`[Session] ⚠️ User ${userId} requested settlement, but no active session found. Assuming 0s watch time.`);
        }

        try {
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
        } catch (error: any) {
            console.error(`[Session] ❌ Failed to process session close for ${userId}: ${error.message}`);
        }
    }
}

export const sessionService = new SessionService();
