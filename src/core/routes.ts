import { Router, Request, Response, NextFunction } from 'express';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { walletService } from './wallet';
import { sessionService } from './session';
import rateLimit from 'express-rate-limit';
import { isAddress, isHex } from 'viem';

const sessionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // limit each IP to 20 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

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

// This endpoint uses dynamic pricing based on the session's active rate. Circle Gateway handles verification + settlement.
coreRouter.get('/stream-access', (req: Request, res: Response, next: NextFunction) => {
    // 1. Identify the user from the custom header set by session.ts
    const userId = req.headers['x-user-id'] as string;
    
    // 2. Resolve the dynamic rate
    let ratePerSecond = 0.0001; // default fallback
    if (userId) {
        const userRate = sessionService.getRateForUser(userId);
        if (userRate !== null) {
            ratePerSecond = userRate;
        }
    } else {
        console.warn(`[Core] ⚠️ No x-user-id header provided to /stream-access. Falling back to $0.0001.`);
    }

    const priceString = `$${ratePerSecond.toFixed(4)}`;

    // 3. Create a dynamic middleware for this specific price and execute it
    const dynamicMiddleware = gateway.require(priceString);
    dynamicMiddleware(req as any, res as any, next);
}, (req: Request & { payment?: Record<string, unknown> }, res: Response) => {
    console.log(`[x402] ✅ Payment verified. Payer: ${req.payment?.payer}, Amount: ${req.payment?.amount}`);
    res.json({ access: true, payment: req.payment });
});

// --- BUYER SIDE: Register session, deposit to Gateway, and pay for access ---
coreRouter.post('/register-session', sessionLimiter, async (req: Request, res: Response) => {
    const { userId, privateKey, returnAddress } = req.body;

    if (!userId || !privateKey || !returnAddress) {
        return res.status(400).json({ error: 'Missing userId, privateKey, or returnAddress' });
    }

    if (!isHex(privateKey)) {
        return res.status(400).json({ error: 'Invalid privateKey format' });
    }

    if (!isAddress(returnAddress)) {
        return res.status(400).json({ error: 'Invalid returnAddress' });
    }

    if (!sessionService.hasActiveSession(userId)) {
        return res.status(400).json({ error: 'Blocked: The platform has not yet confirmed that you are in the stream.' });
    }

    const stringifyBigInt = (_key: string, value: unknown) =>
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

        const minWalletBalance = Number(process.env.MIN_WALLET_BALANCE || '0.01');
        if (walletUsdc < minWalletBalance) {
            return res.status(400).json({ error: 'Ephemeral wallet has insufficient USDC balance.' });
        }

        // 3. Deposit to Gateway — leave gas fee amount in wallet (approve tx + deposit tx)
        const retainedGasAmount = Number(process.env.RETAINED_GAS_AMOUNT || '0.10');
        const depositAmount = Math.max(0, walletUsdc - retainedGasAmount).toFixed(2);
        console.log(`[Core] 💳 Depositing ${depositAmount} USDC to Circle Gateway...`);

        const depositResult = await gatewayClient.deposit(depositAmount);
        console.log(`[Core] ✅ Deposit confirmed!`);
        console.log(`[Core]    Approval Tx: ${depositResult.approvalTxHash || 'skipped'}`);
        console.log(`[Core]    Deposit Tx:  ${depositResult.depositTxHash}`);
        console.log(`[Core]    Amount:      ${depositResult.formattedAmount} USDC`);

        // 3.5 Wait for deposit to reflect in Gateway balance
        console.log(`[Core] ⏳ Waiting for deposit to reflect in Gateway balance...`);
        let currentGatewayBalance = Number(balances.gateway.formattedAvailable);
        const expectedMinBalance = currentGatewayBalance + Number(depositAmount);
        
        let attempts = 0;
        const maxAttempts = 30; // 30 attempts * 2 seconds = 60 seconds
        let gatewayUpdated = false;

        while (attempts < maxAttempts) {
            const currentBalances = await gatewayClient.getBalances();
            const newGatewayBalance = Number(currentBalances.gateway.formattedAvailable);
            
            if (newGatewayBalance >= expectedMinBalance) {
                console.log(`[Core] ✅ Gateway balance updated successfully! (${newGatewayBalance} USDC)`);
                gatewayUpdated = true;
                break;
            }
            
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 2000)); // wait 2s
        }

        if (!gatewayUpdated) {
            return res.status(500).json({ error: 'Timeout waiting for deposit to reflect in Gateway. Transaction might be delayed.' });
        }

        // 4. Pay for stream access via x402 (gasless off-chain signature!)
        console.log(`[Core] 🔓 Paying for stream access via x402...`);
        const sidecarUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
        const payResult = await gatewayClient.pay<{ access: boolean }>(
            `${sidecarUrl}/api/core/stream-access`
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
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] ❌ Failed:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// --- CLIENT SIDE: Explicitly end session and refund ---
coreRouter.post('/end-session', sessionLimiter, async (req: Request, res: Response) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    try {
        await sessionService.recordPartAndSettle(userId);
        return res.status(200).json({ status: 'Refund processed successfully.' });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] ❌ Failed to end session manually:`, err.message);
        return res.status(500).json({ error: err.message });
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

// --- CLIENT SIDE: Check Session Balance ---
coreRouter.get('/session-balance', async (req: Request, res: Response) => {
    const userId = req.query.userId as string;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    try {
        if (!walletService.hasSessionRecord(userId)) {
            return res.status(404).json({ error: 'Session not found' });
        }
        const sessionRecord = walletService.getSessionRecord(userId);
        const gatewayClient = new GatewayClient({
            privateKey: sessionRecord.privateKey as `0x${string}`,
            chain: 'arcTestnet',
        });
        const balances = await gatewayClient.getBalances();
        res.json({
            gatewayAvailable: balances.gateway.formattedAvailable,
            gatewayWithdrawable: balances.gateway.formattedAvailable,
            walletBalance: balances.wallet.formatted,
        });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] ❌ Failed to fetch balance for ${userId}:`, err.message);
        res.status(500).json({ error: 'Failed to fetch balance' });
    }
});

// --- CLIENT SIDE: Top-Up Session ---
coreRouter.post('/topup-session', sessionLimiter, async (req: Request, res: Response) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    try {
        if (!walletService.hasSessionRecord(userId)) {
            return res.status(404).json({ error: 'Session not found' });
        }
        const sessionRecord = walletService.getSessionRecord(userId);
        const gatewayClient = new GatewayClient({
            privateKey: sessionRecord.privateKey as `0x${string}`,
            chain: 'arcTestnet',
        });
        
        const balances = await gatewayClient.getBalances();
        const walletBalance = Number(balances.wallet.formatted);
        const RETAINED_GAS_AMOUNT = Number(process.env.RETAINED_GAS_AMOUNT || 0.1);

        // How much to deposit to gateway? Everything minus gas buffer
        let depositAmount = walletBalance;
        if (walletBalance > RETAINED_GAS_AMOUNT) {
            depositAmount = walletBalance - RETAINED_GAS_AMOUNT;
        }

        if (depositAmount > 0.001) {
            console.log(`[Core] 💸 Top-up detected! Depositing ${depositAmount.toFixed(6)} USDC to Gateway...`);
            await gatewayClient.deposit(depositAmount.toFixed(6));
            return res.json({ status: 'success', deposited: depositAmount.toFixed(6) });
        } else {
            return res.status(400).json({ error: 'Insufficient wallet balance for top-up' });
        }
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] ❌ Failed to process top-up for ${userId}:`, err.message);
        return res.status(500).json({ error: err.message });
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
            gatewayWithdrawable: balances.gateway.formattedAvailable,
            walletBalance: balances.wallet.formatted
        });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return res.status(500).json({ error: err.message });
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
        const withdrawable = Number(balances.gateway.formattedAvailable);
        
        if (withdrawable <= 0) {
            return res.json({ status: 'no_funds', balance: balances.gateway.formattedAvailable });
        }

        // Withdraw everything
        const withdrawResult = await sellerClient.withdraw(balances.gateway.formattedAvailable);
        
        return res.json({
            status: 'success',
            withdrawnAmount: withdrawResult.formattedAmount,
            txHash: withdrawResult.mintTxHash
        });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] ❌ Seller withdrawal failed:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

export default coreRouter;
