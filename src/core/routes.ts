import { Router, Request, Response } from 'express';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { walletService } from './wallet';
import { sessionService } from './session';
const coreRouter = Router();

// Seller address - the stream creator's address where payments are received
const SELLER_ADDRESS = process.env.SELLER_ADDRESS || '0x0000000000000000000000000000000000000001';
const PORT = process.env.PORT || 3000;

// --- SELLER SIDE: Protect stream access with x402 ---
const gateway = createGatewayMiddleware({
    sellerAddress: SELLER_ADDRESS,
    facilitatorUrl: 'https://gateway-api-testnet.circle.com',
    networks: ['eip155:5042002'], // Arc Testnet
});

// This endpoint costs $0.0001 to access. Circle Gateway handles verification + settlement.
coreRouter.get('/stream-access', gateway.require('$0.0001'), (req: any, res: Response) => {
    console.log(`[x402] ✅ Payment verified. Payer: ${req.payment?.payer}, Amount: ${req.payment?.amount}`);
    res.json({ access: true, payment: req.payment });
});

// --- BUYER SIDE: Register session, deposit to Gateway, and pay for access ---
coreRouter.post('/register-session', async (req: Request, res: Response) => {
    const { userId, privateKey, returnAddress } = req.body;

    if (!userId || !privateKey || !returnAddress) {
        return res.status(400).json({ error: 'Missing userId, privateKey, or returnAddress' });
    }

    if (!sessionService.hasActiveSession(userId)) {
        return res.status(400).json({ error: 'Bloqueado: Owncast aún no confirma que estás en el stream.' });
    }

    const stringifyBigInt = (_key: string, value: any) =>
        typeof value === 'bigint' ? value.toString() : value;

    try {
        // 1. Create GatewayClient with the ephemeral wallet's private key
        const gatewayClient = new GatewayClient({
            privateKey: privateKey as `0x${string}`,
            chain: 'arcTestnet',
        });

        // 2. Check current balances
        const balances = await gatewayClient.getBalances();
        console.log(`\n[Core] 💰 Ephemeral wallet balance: ${balances.wallet.formatted} USDC`);
        console.log(`[Core] 💰 Gateway balance: ${balances.gateway.formattedAvailable} USDC`);

        const walletUsdc = Number(balances.wallet.formatted);

        if (walletUsdc < 0.01) {
            return res.status(400).json({ error: 'Ephemeral wallet has insufficient USDC balance.' });
        }

        // 3. Deposit to Gateway — leave 0.10 USDC for gas (approve tx + deposit tx)
        const depositAmount = Math.max(0, walletUsdc - 0.10).toFixed(2);
        console.log(`[Core] 💳 Depositing ${depositAmount} USDC to Circle Gateway...`);

        const depositResult = await gatewayClient.deposit(depositAmount);
        console.log(`[Core] ✅ Deposit confirmed!`);
        console.log(`[Core]    Approval Tx: ${depositResult.approvalTxHash || 'skipped'}`);
        console.log(`[Core]    Deposit Tx:  ${depositResult.depositTxHash}`);
        console.log(`[Core]    Amount:      ${depositResult.formattedAmount} USDC`);

        // 4. Pay for stream access via x402 (gasless off-chain signature!)
        console.log(`[Core] 🔓 Paying for stream access via x402...`);
        const payResult = await gatewayClient.pay<{ access: boolean }>(
            `http://localhost:${PORT}/api/core/stream-access`
        );
        console.log(`[Core] ✅ Stream access granted!`);
        console.log(`[Core]    Paid: ${payResult.formattedAmount} USDC`);
        console.log(`[Core]    Settlement Tx: ${payResult.transaction}`);

        // 5. Register the session key for future settlement
        walletService.registerSessionKey(userId, privateKey, returnAddress);

        // 6. Check remaining Gateway balance
        const finalBalances = await gatewayClient.getBalances();
        console.log(`[Core] 💰 Remaining Gateway balance: ${finalBalances.gateway.formattedAvailable} USDC`);

        return res.setHeader('Content-Type', 'application/json').send(
            JSON.stringify({
                status: 'session_registered',
                deposit: {
                    txHash: depositResult.depositTxHash,
                    amount: depositResult.formattedAmount,
                },
                payment: {
                    amount: payResult.formattedAmount,
                    transaction: payResult.transaction,
                },
                remainingBalance: finalBalances.gateway.formattedAvailable,
            }, stringifyBigInt)
        );
    } catch (error: any) {
        console.error(`[Core] ❌ Failed:`, error.message);
        return res.status(500).json({ error: error.message });
    }
});

// --- CLIENT SIDE: Explicitly end session and refund ---
coreRouter.post('/end-session', async (req: Request, res: Response) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    try {
        await sessionService.recordPartAndSettle(userId);
        return res.status(200).json({ status: 'Refund processed successfully.' });
    } catch (error: any) {
        console.error(`[Core] ❌ Failed to end session manually:`, error.message);
        return res.status(500).json({ error: error.message });
    }
});

// --- CLIENT SIDE: Check Session Status ---
coreRouter.get('/session-status', (req: Request, res: Response) => {
    const userId = req.query.userId as string;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    if (walletService.hasSessionRecord(userId)) {
        return res.status(200).json({ status: 'active' });
    } else {
        return res.status(404).json({ error: 'No active session key found' });
    }
});

// --- SELLER SIDE: Admin Routes ---
coreRouter.get('/seller/balance', async (req: Request, res: Response) => {
    try {
        const sellerKey = process.env.SELLER_PRIVATE_KEY;
        if (!sellerKey) return res.status(500).json({ error: 'SELLER_PRIVATE_KEY not configured.' });

        const sellerClient = new GatewayClient({
            chain: 'arcTestnet',
            privateKey: sellerKey as `0x${string}`,
        });

        const balances = await sellerClient.getBalances();
        return res.json({ 
            status: 'success', 
            gatewayBalance: balances.gateway.formattedAvailable,
            walletBalance: balances.wallet.formatted
        });
    } catch (error: any) {
        return res.status(500).json({ error: error.message });
    }
});

coreRouter.post('/seller/withdraw', async (req: Request, res: Response) => {
    try {
        const sellerKey = process.env.SELLER_PRIVATE_KEY;
        if (!sellerKey) {
            return res.status(500).json({ error: 'SELLER_PRIVATE_KEY not configured.' });
        }

        const sellerClient = new GatewayClient({
            chain: 'arcTestnet',
            privateKey: sellerKey as `0x${string}`,
        });

        const balances = await sellerClient.getBalances();
        const available = Number(balances.gateway.formattedAvailable);
        
        if (available <= 0) {
            return res.json({ status: 'no_funds', balance: balances.gateway.formattedAvailable });
        }

        // Withdraw everything
        const withdrawResult = await sellerClient.withdraw(balances.gateway.formattedAvailable);
        
        return res.json({
            status: 'success',
            withdrawnAmount: withdrawResult.formattedAmount,
            txHash: withdrawResult.mintTxHash
        });
    } catch (error: any) {
        console.error(`[Core] ❌ Seller withdrawal failed:`, error.message);
        return res.status(500).json({ error: error.message });
    }
});

export default coreRouter;
