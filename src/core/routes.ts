import { Router, Request, Response, NextFunction } from 'express';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { walletService } from './wallet';
import { sessionService } from './session';
import { statsService } from './stats';
import { GATEWAY_FEE_BUFFER } from './gateway-utils';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { isAddress, isHex, verifyMessage, createPublicClient, http, formatUnits, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';

// Arc Testnet chain â€” imported from viem/chains (verified: exports chain ID 5042002)
// Per use-arc.md: "Arc Testnet is available by default in Viem â€” a custom chain definition is NEVER required."

const ARC_RPC_URL = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';

const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(ARC_RPC_URL)
});
const sessionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300, // limit each IP to 300 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

const coreRouter = Router();

const PORT = process.env.PORT || 7878;

// Routes 100% of the payment to the address provided via x-seller-address.
// Platform-specific routing logic (e.g. platform fee splits) is handled by the
// connector layer BEFORE calling this endpoint. The core is platform-agnostic.
coreRouter.get('/stream-access', (req: Request, res: Response, next: NextFunction) => {
    // 1. Identify the user
    const userId = req.headers['x-user-id'] as string;

    // 2. The connector or client provides the destination address.
    //    No routing decisions are made here â€” the core trusts the header.
    const sellerAddress = req.headers['x-seller-address'] as string;

    console.log(`[Routes-DEBUG] GET /stream-access. x-user-id: ${userId}, x-seller-address: ${sellerAddress}`);

    if (!sellerAddress) {
        console.error(`[Routes-ERROR] GET /stream-access failed: Missing x-seller-address header.`);
        return res.status(400).json({ error: 'Missing x-seller-address header' });
    }

    // 3. Create dynamic middleware for this specific request and recipient
    const dynamicGateway = createGatewayMiddleware({
        sellerAddress,
        facilitatorUrl: 'https://gateway-api-testnet.circle.com',
        networks: ['eip155:5042002'], // Arc Testnet
    });

    // 4. Resolve the dynamic rate from the active session
    let ratePerSecond = 0.0001; // default fallback
    if (userId) {
        const userRate = sessionService.getRateForUser(userId);
        if (userRate !== null) {
            ratePerSecond = userRate;
        } else {
            console.warn(`[Routes-WARN] GET /stream-access: No active rate found for user ${userId} in sessionService. Using fallback 0.0001.`);
        }
    } else {
        console.warn(`[Routes-WARN] GET /stream-access: No x-user-id header provided to /stream-access. Falling back to $0.0001.`);
    }

    const priceString = `$${ratePerSecond.toFixed(4)}`;
    console.log(`[Routes-DEBUG] GET /stream-access calling x402 middleware with price: ${priceString} and seller: ${sellerAddress}`);

    // 5. Execute middleware
    const priceMiddleware = dynamicGateway.require(priceString);
    priceMiddleware(req as any, res as any, (err?: any) => {
        if (err) {
            console.error(`[Routes-ERROR] GET /stream-access Middleware error:`, err.message || err);
            return next(err);
        }
        next();
    });
}, (req: Request & { payment?: Record<string, unknown> }, res: Response) => {
    console.log(`[x402] âœ… Payment verified. Payer: ${req.payment?.payer}, Amount: ${req.payment?.amount}`);
    
    // Record payment stats
    const userId = req.headers['x-user-id'] as string;
    const sellerAddress = req.headers['x-seller-address'] as string;
    const amount = Number(req.payment?.amount || 0);
    if (userId && sellerAddress && amount > 0) {
        statsService.recordPayment(userId, sellerAddress, amount);
    }

    res.json({ access: true, payment: req.payment });
});

// --- BUYER SIDE: Recover existing session ---
coreRouter.post('/recover-session', sessionLimiter, async (req: Request, res: Response) => {
    const { returnAddress, signature } = req.body;
    
    if (!returnAddress || !signature) {
        return res.status(400).json({ error: 'Missing returnAddress or signature' });
    }
    
    if (!isAddress(returnAddress)) {
        return res.status(400).json({ error: 'Invalid returnAddress' });
    }

    try {
        const isValid = await verifyMessage({ 
            address: returnAddress, 
            message: 'Login to Tessera', 
            signature 
        });

        if (!isValid) {
            return res.status(401).json({ error: 'Invalid signature. Ownership of address not proven.' });
        }

        const session = walletService.getSessionByReturnAddress(returnAddress);
        if (session) {
            console.log(`[Core] â™»ï¸ Recovered existing session for ${returnAddress}`);
            return res.json({ 
                status: 'recovered', 
                userId: session.userId, 
                privateKey: session.record.privateKey 
            });
        }

        return res.status(404).json({ error: 'No active session found for this address.' });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] âŒ Recovery failed:`, err.message);
        return res.status(500).json({ error: 'Signature verification failed' });
    }
});

// Circle SDK and CCTP routes have been moved to src/core/circle-routes.ts
// and are mounted on /api/core in server.ts.


// --- BUYER SIDE: Register session, deposit to Gateway, and pay for access ---
coreRouter.post('/register-session', sessionLimiter, async (req: Request, res: Response) => {
    const { userId, privateKey, returnAddress, sellerAddress, ratePerSecond } = req.body;

    if (!userId || !privateKey || !returnAddress) {
        console.error(`[Core] âŒ /register-session missing fields. userId: ${userId}, privateKey: ${privateKey}, returnAddress: ${returnAddress}`);
        return res.status(400).json({ error: 'Missing userId, privateKey, or returnAddress' });
    }

    if (!isHex(privateKey)) {
        return res.status(400).json({ error: 'Invalid privateKey format' });
    }

    if (!isAddress(returnAddress)) {
        return res.status(400).json({ error: 'Invalid returnAddress' });
    }

    // Removed strict hasActiveSession check to allow wallet registration BEFORE the video starts playing.
    // The user will only be billed once they actually play the video and join activeSessions.

    const stringifyBigInt = (_key: string, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value;

    try {
        // 1. Create GatewayClient with the ephemeral wallet's private key
        const gatewayClient = new GatewayClient({
            privateKey: privateKey as `0x${string}`,
            chain: 'arcTestnet',
            rpcUrl: ARC_RPC_URL,
        });

        // 2. Check current balances (with retry since blockchain indexers may lag)
        let balances = await gatewayClient.getBalances();
        console.log(`\n[Core] ðŸ’° Initial Ephemeral wallet balance: ${balances.wallet.formatted} USDC`);

        let gatewayBalanceNum = Number(balances.gateway.formattedAvailable);
        let walletUsdc = Number(balances.wallet.formatted);
        const minWalletBalance = Number(process.env.MIN_WALLET_BALANCE || '0.01');
        const minGatewayBalance = typeof ratePerSecond === 'number' ? ratePerSecond : 0.01;

        if (gatewayBalanceNum < minGatewayBalance && walletUsdc < minWalletBalance) {
            console.log(`[Core] ⏳ Waiting for ephemeral wallet to receive funds...`);
            let attempts = 0;
            while (attempts < 12 && walletUsdc < minWalletBalance) {
                await new Promise(resolve => setTimeout(resolve, 1500));
                balances = await gatewayClient.getBalances();
                walletUsdc = Number(balances.wallet.formatted);
                attempts++;
            }
            console.log(`[Core] 💰 Final Ephemeral wallet balance: ${walletUsdc} USDC`);
        }

        // If the user already has enough balance in the Gateway, skip the deposit phase!
        let skippedDeposit = false;
        let depositTxHash = 'skipped';
        let depositedAmount = '0';

        if (gatewayBalanceNum >= minGatewayBalance) {
            console.log(`[Core] ⏩ User already has ${gatewayBalanceNum} USDC in Gateway. Skipping deposit phase.`);
            skippedDeposit = true;
        } else {
            if (walletUsdc < minWalletBalance) {
                return res.status(400).json({ error: 'Ephemeral wallet has insufficient USDC balance.' });
            }

            // 3. Deposit to Gateway
            const retainedGasAmount = Number(process.env.RETAINED_GAS_AMOUNT || '0.01');
            const depositAmount = Math.max(0, walletUsdc - retainedGasAmount).toFixed(2);
            console.log(`[Core] 💳 Depositing ${depositAmount} USDC to Circle Gateway...`);

            const depositResult = await gatewayClient.deposit(depositAmount);
            depositTxHash = depositResult.depositTxHash;
            depositedAmount = depositResult.formattedAmount;
            
            console.log(`[Core] ✅ Deposit confirmed! Tx: ${depositTxHash}`);

            // Wait for deposit to reflect in Gateway balance (max 15s to fit within Nginx proxy timeouts)
            console.log(`[Core] ⏳ Waiting for deposit to reflect in Gateway balance...`);
            let attempts = 0;
            const expectedMinBalance = gatewayBalanceNum + Number(depositAmount);
            let gatewayUpdated = false;

            while (attempts < 10) {
                balances = await gatewayClient.getBalances();
                gatewayBalanceNum = Number(balances.gateway.formattedAvailable);
                if (gatewayBalanceNum >= expectedMinBalance) {
                    console.log(`[Core] ✅ Gateway balance updated! (${gatewayBalanceNum} USDC)`);
                    gatewayUpdated = true;
                    break;
                }
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 1500));
            }

            if (!gatewayUpdated) {
                return res.status(500).json({ error: 'Timeout waiting for deposit to reflect in Gateway.' });
            }
        }

        // 4. Verify gateway connection and balance (free)
        console.log(`[Core] ðŸ” Verifying gateway connection (free)...`);
        const finalBalances = await gatewayClient.getBalances();
        console.log(`[Core] âœ… Gateway verified! Balance: ${finalBalances.gateway.formattedAvailable} USDC`);

        // 5. Register the session key for future settlement
        walletService.registerSessionKey(userId, privateKey, returnAddress);

        return res.setHeader('Content-Type', 'application/json').send(
            JSON.stringify({
                status: 'session_registered',
                deposit: {
                    txHash: depositTxHash,
                    amount: depositedAmount,
                },
                payment: {
                    amount: '0.0000',
                    transaction: 'free-handshake',
                },
                remainingBalance: finalBalances.gateway.formattedAvailable,
            }, stringifyBigInt)
        );
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] âŒ Failed:`, err.message);
        return res.status(500).json({ error: err.message });
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
        return res.json({ status: 'session_ended' });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] âŒ /end-session failed:`, err.message);
        return res.status(500).json({ error: 'Failed to end session' });
    }
});

// --- BUYER SIDE: Cash-Out (Manual Withdrawal) ---
coreRouter.post('/cash-out', async (req: Request, res: Response) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    try {
        // Stop billing first if active
        if (sessionService.hasActiveSession(userId)) {
            await sessionService.recordPartAndSettle(userId);
        }

        const sessionRecord = walletService.getSessionRecord(userId);
        const gatewayClient = new GatewayClient({
            privateKey: sessionRecord.privateKey as `0x${string}`,
            chain: 'arcTestnet',
            rpcUrl: ARC_RPC_URL,
        });

        const balances = await gatewayClient.getBalances();
        const availableMicro = parseUnits(balances.gateway.formattedAvailable, 6);

        // Reserve a flat gas buffer (~0.005 USDC) for the Arc network withdrawal tx.
        // We do NOT take any percentage â€” the Gateway charges 0% commission.
        if (availableMicro <= GATEWAY_FEE_BUFFER) {
            walletService.clearSession(userId);
            return res.json({ status: 'cashed_out', amount: '0', message: 'Balance too low to withdraw.' });
        }

        const withdrawAmount = formatUnits(availableMicro - GATEWAY_FEE_BUFFER, 6);
        console.log(`[Core] ðŸ§¹ Cashing out ${withdrawAmount} USDC to ${sessionRecord.returnAddress}...`);

        try {
            const withdrawResult = await gatewayClient.withdraw(withdrawAmount, {
                recipient: sessionRecord.returnAddress as `0x${string}`,
            });

            walletService.clearSession(userId);
            console.log(`[Core] ✅ Cash-out complete! Tx: ${withdrawResult.mintTxHash}`);

            return res.json({ 
                status: 'cashed_out', 
                amount: withdrawResult.formattedAmount,
                txHash: withdrawResult.mintTxHash
            });
        } catch (withdrawError) {
            const err = withdrawError instanceof Error ? withdrawError : new Error(String(withdrawError));
            const txHashMatch = err.message.match(/0x[a-fA-F0-9]{64}/);
            if (txHashMatch) {
                const txHash = txHashMatch[0];
                console.log(`[Core] ⚠️ Cash-out SDK failed but tx submitted: ${txHash}. Checking receipt...`);
                try {
                    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
                    if (receipt && receipt.status === 'success') {
                        console.log(`[Core] ✅ Cash-out verified on-chain: ${txHash}`);
                        walletService.clearSession(userId);
                        return res.json({
                            status: 'cashed_out',
                            amount: withdrawAmount,
                            txHash: txHash
                        });
                    }
                } catch (receiptErr) {
                    console.error(`[Core] Failed to verify receipt for cash-out ${txHash}:`, receiptErr);
                }
            }
            throw withdrawError;
        }
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] ❌ /cash-out failed:`, err.message);
        return res.status(500).json({ error: 'Failed to cash out' });
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
            rpcUrl: ARC_RPC_URL,
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
    const { userId, expectFunds } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    try {
        if (!walletService.hasSessionRecord(userId)) {
            return res.status(404).json({ error: 'Session not found' });
        }
        const sessionRecord = walletService.getSessionRecord(userId);
        const gatewayClient = new GatewayClient({
            privateKey: sessionRecord.privateKey as `0x${string}`,
            chain: 'arcTestnet',
            rpcUrl: ARC_RPC_URL,
        });
        
        let balances = await gatewayClient.getBalances();
        let walletBalance = Number(balances.wallet.formatted);
        const RETAINED_GAS_AMOUNT = Number(process.env.RETAINED_GAS_AMOUNT || 0.01);

        if (expectFunds && walletBalance <= RETAINED_GAS_AMOUNT) {
            console.log(`[Core] ⏳ Waiting for top-up funds to arrive in ephemeral wallet...`);
            let attempts = 0;
            while (attempts < 15 && walletBalance <= RETAINED_GAS_AMOUNT) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                balances = await gatewayClient.getBalances();
                walletBalance = Number(balances.wallet.formatted);
                attempts++;
            }
            console.log(`[Core] 💰 Ephemeral wallet balance after wait: ${walletBalance} USDC`);
        }

        // How much to deposit to gateway? Everything minus gas buffer
        const depositAmount = Math.max(0, walletBalance - RETAINED_GAS_AMOUNT);

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

// NOTE: Creator withdrawal routes (/creator/*) and seller admin routes (/seller/*)
// have been moved to the PeerTube connector: src/connectors/peertube/creator-routes.ts
// They are served under /api/connectors/peertube/creator/* and /api/connectors/peertube/seller/*

// --- Tip: Off-chain payment from viewer's Arc Gateway to creator (100% — no platform split) ---
coreRouter.post('/tip', sessionLimiter, async (req: Request, res: Response) => {
    const { userId, creatorWallet, amount } = req.body;

    if (!userId || !creatorWallet || !amount) {
        return res.status(400).json({ error: 'Missing userId, creatorWallet, or amount' });
    }

    try {
        const gatewayClient = sessionService.getGatewayClientForUser(userId);
        if (!gatewayClient) {
            return res.status(404).json({ error: 'No active session found for this user.' });
        }

        // The GatewayClient calls /tip-access on the same server via localhost.
        // PUBLIC_URL is not needed — Circle never makes inbound callbacks.
        const sidecarUrl = `http://localhost:${PORT}`;

        // Pay via the /tip-access endpoint — routes 100% to creator, no platform split
        await gatewayClient.pay<{ success: boolean }>(
            `${sidecarUrl}/api/core/tip-access`,
            { headers: { 'x-tip-amount': amount, 'x-seller-address': creatorWallet } }
        );

        console.log(`[Core] ❤️ Tip of ${amount} USDC sent from ${userId} to ${creatorWallet}`);
        return res.json({ status: 'success', amount, creatorWallet });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.message.includes('402') || err.message.toLowerCase().includes('insufficient') || err.message.toLowerCase().includes('settlement failed')) {
            return res.status(402).json({ error: 'Insufficient gateway balance. Please top up.' });
        }
        console.error(`[Core] ❌ Tip failed:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});




// --- Tip-Access: x402 gate that routes 100% to the address in x-seller-address ---
coreRouter.get('/tip-access', (req: Request, res: Response, next: NextFunction) => {
    const creatorAddress = req.headers['x-seller-address'] as string;
    if (!creatorAddress) {
        return res.status(400).json({ error: 'Missing x-seller-address header' });
    }
    const tipAmount = req.headers['x-tip-amount'] as string || '0.10';

    const tipGateway = createGatewayMiddleware({
        sellerAddress: creatorAddress,  // 100% to creator — no random split
        facilitatorUrl: 'https://gateway-api-testnet.circle.com',
        networks: ['eip155:5042002'],
    });

    const priceMiddleware = tipGateway.require(`$${parseFloat(tipAmount).toFixed(4)}`);
    priceMiddleware(req as any, res as any, next);
}, (req: Request, res: Response) => {
    res.json({ success: true });
});

// --- CLIENT SIDE: Check Native Balance of any Wallet ---
coreRouter.get('/wallet-balance', async (req: Request, res: Response) => {
    const address = req.query.address as string;
    if (!address) {
        return res.status(400).json({ error: 'Missing address' });
    }

    try {
        const balance = await publicClient.getBalance({
            address: address as `0x${string}`
        });
        const formatted = formatUnits(balance, 18);
        return res.json({ balance: parseFloat(formatted) });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] ❌ Failed to fetch balance for ${address}:`, err.message);
        return res.status(500).json({ error: 'Failed to fetch balance' });
    }
});

export default coreRouter;
