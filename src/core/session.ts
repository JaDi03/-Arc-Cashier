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
        const joinedTime = this.activeSessions.get(userId);

        if (!joinedTime) {
            console.warn(`[Session] ⚠️ User ${userId} parted, but no join record found. Ignoring.`);
            return;
        }

        this.activeSessions.delete(userId);

        const durationSeconds = Math.ceil((Date.now() - joinedTime) / 1000);
        console.log(`[Session] 🔴 User ${userId} parted. Watch time: ${durationSeconds}s.`);

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
                // Withdraw remaining Gateway balance back to user's original wallet
                console.log(`[Session] 🧹 Withdrawing ${availableFormatted} USDC back to ${sessionRecord.returnAddress}...`);

                const withdrawResult = await gatewayClient.withdraw(availableFormatted, {
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
