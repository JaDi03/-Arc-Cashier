import { Router, Request, Response, NextFunction } from 'express';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { walletService } from './wallet';
import { sessionService } from './session';
import { statsService } from './stats';
import { GATEWAY_FEE_BUFFER } from './gateway-utils';
import creatorRouter from './creator-routes';
import { verifyCircleWalletOwnership } from './circle-routes';
import { addressesEqual, isValidPrivateKeyHex, isValidViewerUserId } from './session-key-auth';
import { verifyIngestSignature } from './security/verify-ingest-signature';
import rateLimit from 'express-rate-limit';
import { isAddress, isHex, verifyMessage, createPublicClient, http, formatUnits, parseUnits } from 'viem';
import { arcTestnet } from 'viem/chains';

const ARC_RPC_URL = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';

const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(ARC_RPC_URL)
});

const sessionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

/** Stricter limit: sync-session returns a private key after Circle auth. */
const syncSessionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many session sync requests, please try again later.' }
});

const coreRouter = Router();

const PORT = process.env.PORT || 7878;
const SIDECAR_URL = `http://localhost:${PORT}`;

// ─── x402 Payment Gate ───────────────────────────────────────────────────────

coreRouter.get('/stream-access', (req: Request, res: Response, next: NextFunction) => {
    const userId = req.headers['x-user-id'] as string;
    const sellerAddress = req.headers['x-seller-address'] as string;

    if (!sellerAddress) {
        return res.status(400).json({ error: 'Missing x-seller-address header' });
    }

    const dynamicGateway = createGatewayMiddleware({
        sellerAddress,
        facilitatorUrl: 'https://gateway-api-testnet.circle.com',
        networks: ['eip155:5042002'],
    });

    let ratePerSecond = 0.0001;
    if (userId) {
        const userRate = sessionService.getRateForUser(userId);
        if (userRate !== null) ratePerSecond = userRate;
    }

    const priceMiddleware = dynamicGateway.require(`$${ratePerSecond.toFixed(4)}`);
    priceMiddleware(req as any, res as any, (err?: any) => {
        if (err) return next(err);
        next();
    });
}, (req: Request & { payment?: Record<string, unknown> }, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const sellerAddress = req.headers['x-seller-address'] as string;
    // x402-batching parsePrice stores amount in micro-USDC (1e6 = $1).
    const amountMicro = Number(req.payment?.amount || 0);
    const amountUsdc = amountMicro / 1e6;
    if (userId && sellerAddress && amountUsdc > 0) {
        try {
            statsService.recordPayment(userId, sellerAddress, amountUsdc);
        } catch (err) {
            // Settlement already completed in x402 middleware. Stats must never turn a paid tick into HTTP 500.
            console.error('[Core] Failed to record payment stats after settle:', err);
        }
    }
    res.json({ access: true, payment: req.payment });
});

// ─── v1 ingest: sessions/start|stop (HMAC TESSERA_INGEST_SECRET) ─────────────
// Tips stay unsigned (viewer Gateway session).

coreRouter.post('/v1/sessions/start', sessionLimiter, verifyIngestSignature, (req: Request, res: Response) => {
    const { userId, resourceId, ratePerSecond, payoutAddress, splits, metadata } = req.body;

    if (!userId || !resourceId || ratePerSecond === undefined || ratePerSecond === null || !payoutAddress) {
        return res.status(400).json({ error: 'Missing userId, resourceId, ratePerSecond, or payoutAddress' });
    }
    if (!isAddress(payoutAddress)) {
        return res.status(400).json({ error: 'Invalid payoutAddress' });
    }
    if (splits !== undefined) {
        if (!Array.isArray(splits)) return res.status(400).json({ error: 'splits must be an array' });
        for (const split of splits) {
            if (!split || typeof split.address !== 'string' || !isAddress(split.address))
                return res.status(400).json({ error: `Invalid split address: ${split?.address}` });
            if (typeof split.fraction !== 'number' || split.fraction < 0 || split.fraction > 1)
                return res.status(400).json({ error: `Invalid split fraction: ${split?.fraction}` });
        }
    }

    try {
        sessionService.recordJoin(userId, { resourceId: String(resourceId), ratePerSecond: String(ratePerSecond), payoutAddress, splits, metadata });
        return res.json({ status: 'session_started', sessionId: userId });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] ❌ /v1/sessions/start failed for ${userId}:`, err.message);
        return res.status(400).json({ error: err.message });
    }
});

coreRouter.post('/v1/sessions/stop', sessionLimiter, verifyIngestSignature, async (req: Request, res: Response) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    try {
        await sessionService.recordPartAndSettle(userId);
        return res.json({ status: 'session_stopped' });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] ❌ /v1/sessions/stop failed for ${userId}:`, err.message);
        return res.status(500).json({ error: 'Failed to stop session' });
    }
});

coreRouter.post('/v1/tips', sessionLimiter, async (req: Request, res: Response) => {
    const { userId, payoutAddress, amount } = req.body;

    if (!userId || !payoutAddress || !amount) return res.status(400).json({ error: 'Missing userId, payoutAddress, or amount' });
    if (!isAddress(payoutAddress)) return res.status(400).json({ error: 'Invalid payoutAddress' });

    try {
        const gatewayClient = sessionService.getGatewayClientForUser(userId);
        if (!gatewayClient) return res.status(404).json({ error: 'No active session found for this user.' });

        await gatewayClient.pay<{ success: boolean }>(
            `${SIDECAR_URL}/api/core/tip-access`,
            { headers: { 'x-tip-amount': amount, 'x-seller-address': payoutAddress } }
        );

        console.log(`[Core] ❤️ Tip of ${amount} USDC from ${userId} → ${payoutAddress}`);
        return res.json({ status: 'success', amount, payoutAddress });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.message.includes('402') || err.message.toLowerCase().includes('insufficient')) {
            return res.status(402).json({ error: 'Insufficient gateway balance. Please top up.' });
        }
        console.error(`[Core] ❌ Tip failed:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ─── Buyer-side routes ────────────────────────────────────────────────────────

coreRouter.post('/recover-session', sessionLimiter, async (req: Request, res: Response) => {
    const { returnAddress, signature } = req.body;
    if (!returnAddress || !signature) return res.status(400).json({ error: 'Missing returnAddress or signature' });
    if (!isAddress(returnAddress)) return res.status(400).json({ error: 'Invalid returnAddress' });

    try {
        const isValid = await verifyMessage({ address: returnAddress, message: 'Login to Tessera', signature });
        if (!isValid) return res.status(401).json({ error: 'Invalid signature. Ownership of address not proven.' });

        const session = walletService.getSessionByReturnAddress(returnAddress);
        if (session) {
            return res.json({ status: 'recovered', userId: session.userId, privateKey: session.record.privateKey });
        }
        return res.status(404).json({ error: 'No active session found for this address.' });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return res.status(500).json({ error: 'Signature verification failed' });
    }
});

/**
 * Return the canonical ephemeral privateKey for a viewer after proving Circle
 * UCW ownership. Never accepts userId alone.
 */
coreRouter.post('/sync-session', syncSessionLimiter, async (req: Request, res: Response) => {
    const { userId, userToken, returnAddress } = req.body;

    if (!userId || !userToken || !returnAddress) {
        return res.status(400).json({ error: 'Missing userId, userToken, or returnAddress' });
    }
    if (!isValidViewerUserId(userId)) {
        return res.status(400).json({ error: 'Invalid userId' });
    }
    if (!isAddress(returnAddress)) {
        return res.status(400).json({ error: 'Invalid returnAddress' });
    }
    if (typeof userToken !== 'string' || userToken.length < 20 || userToken.length > 8192) {
        return res.status(400).json({ error: 'Invalid userToken' });
    }

    try {
        const ownership = await verifyCircleWalletOwnership(String(userToken), returnAddress);
        if (ownership === 'unauthorized') {
            return res.status(401).json({ error: 'Circle session does not own this wallet.' });
        }
        if (ownership === 'error') {
            return res.status(503).json({ error: 'Unable to verify Circle wallet ownership. Try again.' });
        }

        if (!walletService.hasSessionRecord(userId)) {
            return res.status(404).json({ error: 'No active session found for this user.' });
        }

        const record = walletService.getSessionRecord(userId);
        if (!addressesEqual(record.returnAddress, returnAddress)) {
            return res.status(401).json({ error: 'Return address does not match existing session.' });
        }

        return res.json({ status: 'synced', privateKey: record.privateKey });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error('[Core] sync-session failed:', err.message);
        return res.status(500).json({ error: 'Failed to sync session' });
    }
});

coreRouter.post('/register-session', sessionLimiter, async (req: Request, res: Response) => {
    const { userId, privateKey, returnAddress, ratePerSecond, userToken } = req.body;

    if (!userId || !privateKey || !returnAddress || !userToken) {
        return res.status(400).json({ error: 'Missing userId, privateKey, returnAddress, or userToken' });
    }
    if (!isValidViewerUserId(userId)) {
        return res.status(400).json({ error: 'Invalid userId' });
    }
    if (!isValidPrivateKeyHex(privateKey) || !isHex(privateKey)) {
        return res.status(400).json({ error: 'Invalid privateKey format' });
    }
    if (!isAddress(returnAddress)) return res.status(400).json({ error: 'Invalid returnAddress' });
    if (typeof userToken !== 'string' || userToken.length < 20 || userToken.length > 8192) {
        return res.status(400).json({ error: 'Invalid userToken' });
    }

    const stringifyBigInt = (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value;

    try {
        const ownership = await verifyCircleWalletOwnership(String(userToken), returnAddress);
        if (ownership === 'unauthorized') {
            return res.status(401).json({ error: 'Circle session does not own this wallet.' });
        }
        if (ownership === 'error') {
            return res.status(503).json({ error: 'Unable to verify Circle wallet ownership. Try again.' });
        }

        // Canonical key wins: never orphan Gateway funds by overwriting with a new ephemeral.
        let privateKeyToUse = privateKey as `0x${string}`;
        if (walletService.hasSessionRecord(userId)) {
            const existing = walletService.getSessionRecord(userId);
            if (!addressesEqual(existing.returnAddress, returnAddress)) {
                return res.status(401).json({ error: 'Return address does not match existing session.' });
            }
            if (existing.privateKey.toLowerCase() !== privateKeyToUse.toLowerCase()) {
                console.log(`[Core] Reusing canonical ephemeral for ${userId}; ignoring client key.`);
            }
            privateKeyToUse = existing.privateKey as `0x${string}`;
        }

        const gatewayClient = new GatewayClient({ privateKey: privateKeyToUse, chain: 'arcTestnet', rpcUrl: ARC_RPC_URL });
        let balances = await gatewayClient.getBalances();
        let gatewayBalanceNum = Number(balances.gateway.formattedAvailable);
        let walletUsdc = Number(balances.wallet.formatted);
        const minWalletBalance = Number(process.env.MIN_WALLET_BALANCE || '0.01');
        const minGatewayBalance = typeof ratePerSecond === 'number' ? ratePerSecond : 0.01;

        if (gatewayBalanceNum < minGatewayBalance && walletUsdc < minWalletBalance) {
            let attempts = 0;
            while (attempts < 12 && walletUsdc < minWalletBalance) {
                await new Promise(resolve => setTimeout(resolve, 1500));
                balances = await gatewayClient.getBalances();
                walletUsdc = Number(balances.wallet.formatted);
                attempts++;
            }
        }

        let depositTxHash = 'skipped';
        let depositedAmount = '0';

        if (gatewayBalanceNum >= minGatewayBalance) {
            console.log(`[Core] ⏩ Gateway already funded (${gatewayBalanceNum} USDC). Skipping deposit.`);
        } else {
            if (walletUsdc < minWalletBalance) return res.status(400).json({ error: 'Ephemeral wallet has insufficient USDC balance.' });

            const retainedGasAmount = Number(process.env.RETAINED_GAS_AMOUNT || '0.01');
            const depositAmount = Math.max(0, walletUsdc - retainedGasAmount).toFixed(6);
            const depositResult = await gatewayClient.deposit(depositAmount);
            depositTxHash = depositResult.depositTxHash;
            depositedAmount = depositResult.formattedAmount;

            let attempts = 0;
            const expectedMinBalance = gatewayBalanceNum + Number(depositAmount);
            while (attempts < 10) {
                balances = await gatewayClient.getBalances();
                gatewayBalanceNum = Number(balances.gateway.formattedAvailable);
                if (gatewayBalanceNum >= expectedMinBalance) break;
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
            if (attempts >= 10) return res.status(500).json({ error: 'Timeout waiting for deposit to reflect in Gateway.' });
        }

        const finalBalances = await gatewayClient.getBalances();
        walletService.registerSessionKey(userId, privateKeyToUse, returnAddress);

        return res.setHeader('Content-Type', 'application/json').send(
            JSON.stringify({
                status: 'session_registered',
                deposit: { txHash: depositTxHash, amount: depositedAmount },
                remainingBalance: finalBalances.gateway.formattedAvailable,
                privateKey: privateKeyToUse,
            }, stringifyBigInt)
        );
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return res.status(500).json({ error: err.message });
    }
});

coreRouter.post('/end-session', async (req: Request, res: Response) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    try {
        await sessionService.recordPartAndSettle(userId);
        return res.json({ status: 'session_ended' });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return res.status(500).json({ error: 'Failed to end session' });
    }
});

coreRouter.post('/cash-out', async (req: Request, res: Response) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    try {
        if (sessionService.hasActiveSession(userId)) await sessionService.recordPartAndSettle(userId);

        const sessionRecord = walletService.getSessionRecord(userId);
        const gatewayClient = new GatewayClient({ privateKey: sessionRecord.privateKey as `0x${string}`, chain: 'arcTestnet', rpcUrl: ARC_RPC_URL });
        const balances = await gatewayClient.getBalances();
        const availableMicro = parseUnits(balances.gateway.formattedAvailable, 6);

        if (availableMicro <= GATEWAY_FEE_BUFFER) {
            walletService.clearSession(userId);
            return res.json({ status: 'cashed_out', amount: '0', message: 'Balance too low to withdraw.' });
        }

        const withdrawAmount = formatUnits(availableMicro - GATEWAY_FEE_BUFFER, 6);
        const withdrawResult = await gatewayClient.withdraw(withdrawAmount, { recipient: sessionRecord.returnAddress as `0x${string}` });
        walletService.clearSession(userId);
        return res.json({ status: 'cashed_out', amount: withdrawResult.formattedAmount, txHash: withdrawResult.mintTxHash });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return res.status(500).json({ error: 'Failed to cash out' });
    }
});

coreRouter.get('/session-status', (req: Request, res: Response) => {
    const userId = req.query.userId as string;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    return walletService.hasSessionRecord(userId)
        ? res.status(200).json({ status: 'active' })
        : res.status(404).json({ error: 'No active session key found' });
});

coreRouter.get('/session-balance', async (req: Request, res: Response) => {
    const userId = req.query.userId as string;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    try {
        if (!walletService.hasSessionRecord(userId)) return res.status(404).json({ error: 'Session not found' });
        const sessionRecord = walletService.getSessionRecord(userId);
        const gatewayClient = new GatewayClient({ privateKey: sessionRecord.privateKey as `0x${string}`, chain: 'arcTestnet', rpcUrl: ARC_RPC_URL });
        const balances = await gatewayClient.getBalances();
        return res.json({ gatewayAvailable: balances.gateway.formattedAvailable, walletBalance: balances.wallet.formatted });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return res.status(500).json({ error: 'Failed to fetch balance' });
    }
});

coreRouter.post('/topup-session', sessionLimiter, async (req: Request, res: Response) => {
    const { userId, expectFunds } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    try {
        if (!walletService.hasSessionRecord(userId)) return res.status(404).json({ error: 'Session not found' });
        const sessionRecord = walletService.getSessionRecord(userId);
        const gatewayClient = new GatewayClient({ privateKey: sessionRecord.privateKey as `0x${string}`, chain: 'arcTestnet', rpcUrl: ARC_RPC_URL });
        let balances = await gatewayClient.getBalances();
        let walletBalance = Number(balances.wallet.formatted);
        const RETAINED_GAS_AMOUNT = Number(process.env.RETAINED_GAS_AMOUNT || 0.01);

        if (expectFunds && walletBalance <= RETAINED_GAS_AMOUNT) {
            let attempts = 0;
            while (attempts < 15 && walletBalance <= RETAINED_GAS_AMOUNT) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                balances = await gatewayClient.getBalances();
                walletBalance = Number(balances.wallet.formatted);
                attempts++;
            }
        }

        const depositAmount = Math.max(0, walletBalance - RETAINED_GAS_AMOUNT);
        if (depositAmount > 0.001) {
            await gatewayClient.deposit(depositAmount.toFixed(6));
            return res.json({ status: 'success', deposited: depositAmount.toFixed(6) });
        }
        return res.status(400).json({ error: 'Insufficient wallet balance for top-up' });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return res.status(500).json({ error: err.message });
    }
});

coreRouter.get('/tip-access', (req: Request, res: Response, next: NextFunction) => {
    const creatorAddress = req.headers['x-seller-address'] as string;
    if (!creatorAddress) return res.status(400).json({ error: 'Missing x-seller-address header' });
    const tipAmount = req.headers['x-tip-amount'] as string || '0.10';

    const tipGateway = createGatewayMiddleware({ sellerAddress: creatorAddress, facilitatorUrl: 'https://gateway-api-testnet.circle.com', networks: ['eip155:5042002'] });
    const priceMiddleware = tipGateway.require(`$${parseFloat(tipAmount).toFixed(4)}`);
    priceMiddleware(req as any, res as any, next);
}, (req: Request, res: Response) => {
    res.json({ success: true });
});

coreRouter.get('/wallet-balance', async (req: Request, res: Response) => {
    const address = req.query.address as string;
    if (!address) return res.status(400).json({ error: 'Missing address' });
    try {
        const balance = await publicClient.getBalance({ address: address as `0x${string}` });
        return res.json({ balance: parseFloat(formatUnits(balance, 18)) });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch balance' });
    }
});

// Creator earnings: Gateway balance + MetaMask BurnIntent withdraw (platform-agnostic).
coreRouter.use(creatorRouter);

export default coreRouter;
