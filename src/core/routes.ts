import { Router, Request, Response, NextFunction } from 'express';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { walletService } from './wallet';
import { sessionService } from './session';
import { GATEWAY_FEE_BUFFER } from './gateway-utils';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { isAddress, isHex, verifyMessage, createWalletClient, createPublicClient, http, encodeFunctionData, formatUnits, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets';

// Arc Testnet chain — imported from viem/chains (verified: exports chain ID 5042002)
// Per use-arc.md: "Arc Testnet is available by default in Viem — a custom chain definition is NEVER required."

// Arc Testnet CCTP contracts (verified from docs.arc.network official docs)
const ARC_MESSAGE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as `0x${string}`;

// Iris attestation API (testnet)
const IRIS_API_BASE = 'https://iris-api-sandbox.circle.com/v2/messages';

const circleClient = initiateUserControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY || ''
});

const sessionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300, // limit each IP to 300 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

const coreRouter = Router();

const PORT = process.env.PORT || 3000;

// Routes 100% of the payment to the address provided via x-seller-address.
// Platform-specific routing logic (e.g. platform fee splits) is handled by the
// connector layer BEFORE calling this endpoint. The core is platform-agnostic.
coreRouter.get('/stream-access', (req: Request, res: Response, next: NextFunction) => {
    // 1. Identify the user
    const userId = req.headers['x-user-id'] as string;

    // 2. The connector or client provides the destination address.
    //    No routing decisions are made here — the core trusts the header.
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
    console.log(`[x402] ✅ Payment verified. Payer: ${req.payment?.payer}, Amount: ${req.payment?.amount}`);
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
            console.log(`[Core] ♻️ Recovered existing session for ${returnAddress}`);
            return res.json({ 
                status: 'recovered', 
                userId: session.userId, 
                privateKey: session.record.privateKey 
            });
        }

        return res.status(404).json({ error: 'No active session found for this address.' });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[Core] ❌ Recovery failed:`, err.message);
        return res.status(500).json({ error: 'Signature verification failed' });
    }
});

// --- BUYER SIDE (Web2): Initialize Circle User + Session Token ---
// Creates the user in Circle if not exists, then returns a 60-min session token.
coreRouter.post('/circle/get-token', sessionLimiter, async (req: Request, res: Response) => {
    const { userId } = req.body;
    
    if (!userId) {
        return res.status(400).json({ error: 'Missing userId' });
    }

    try {
        // createUser is idempotent — safe to call even if the user already exists.
        await circleClient.createUser({ userId }).catch(() => {
            // Silently ignore if user already exists (Circle returns 409 Conflict)
        });

        const response = await circleClient.createUserToken({ userId });

        return res.json({
            userToken: response.data?.userToken,
            encryptionKey: response.data?.encryptionKey,
            appId: process.env.CIRCLE_APP_ID
        });
    } catch (error: any) {
        console.error(`[Core] ❌ Failed to generate Circle token:`, error?.response?.data || error.message);
        return res.status(500).json({ error: 'Failed to generate Circle session token' });
    }
});

// --- BUYER SIDE (Web2): Get or Create Circle SCA Wallet ---
// Returns the walletId and address of the user's SCA on Arc Testnet.
// Also bootstraps wallet creation (returns challengeId if first-time user).
coreRouter.post('/circle/get-wallet', sessionLimiter, async (req: Request, res: Response) => {
    const { userId, userToken } = req.body;

    if (!userId || !userToken) {
        return res.status(400).json({ error: 'Missing userId or userToken' });
    }

    try {
        // List existing wallets for this user on Arc Testnet
        // ARC-TESTNET is the verified blockchain ID string per Circle UCW docs (domain 26)
        const walletsRes = await circleClient.listWallets({
            userToken,
            blockchain: 'ARC-TESTNET' as any,
        });

        const existingWallets = walletsRes.data?.wallets || [];
        const arcWallet = existingWallets.find((w: any) => w.state === 'LIVE');

        if (arcWallet) {
            console.log(`[Core] 👛 Existing SCA wallet found for ${userId}: ${arcWallet.address}`);
            return res.json({
                status: 'existing',
                walletId: arcWallet.id,
                walletAddress: arcWallet.address
            });
        }

        let challengeId;
        try {
            // Derive a deterministic UUID v4-format string from userId via SHA-256.
            // Circle requires idempotencyKey to be a valid UUID — plain strings are rejected.
            // This is deterministic (same userId → same key) preventing duplicate wallet creation on retries.
            const userIdHash = crypto.createHash('sha256').update(`create-wallet-${userId}`).digest('hex');
            const deterministicKey = [
                userIdHash.slice(0, 8),
                userIdHash.slice(8, 12),
                '4' + userIdHash.slice(13, 16),
                ((parseInt(userIdHash[16], 16) & 0x3) | 0x8).toString(16) + userIdHash.slice(17, 20),
                userIdHash.slice(20, 32),
            ].join('-');
            const createRes = await circleClient.createWallet({
                userToken,
                idempotencyKey: deterministicKey,
                blockchains: ['ARC-TESTNET' as any],
                accountType: 'SCA',
            });
            challengeId = createRes.data?.challengeId;
        } catch (err: any) {
            // Circle error 155106: "User already initialized"
            // Per Circle UCW docs: "Fetch existing wallets instead of creating"
            // This happens when the user completed PIN setup but the wallet hasn't indexed yet.
            const errCode = err?.code ?? err?.response?.data?.code ?? err?.message;
            if (String(errCode).includes('155106') || err?.message?.includes('155106')) {
                console.log(`[Core] ♻️ Error 155106: User already initialized. Re-fetching existing wallets for ${userId}.`);
                const retryRes = await circleClient.listWallets({
                    userToken,
                    blockchain: 'ARC-TESTNET' as any,
                });
                const retryWallet = (retryRes.data?.wallets || []).find((w: any) => w.state === 'LIVE');
                if (retryWallet) {
                    console.log(`[Core] 👛 Wallet found on retry for ${userId}: ${retryWallet.address}`);
                    return res.json({
                        status: 'existing',
                        walletId: retryWallet.id,
                        walletAddress: retryWallet.address
                    });
                }
                // Wallet still not indexed — return a specific status so the frontend can retry
                return res.json({ status: 'indexing' });
            } else if (err?.message?.includes('PIN')) {
                console.log(`[Core] 🔑 User needs PIN setup. Issuing createUserPinWithWallets challenge.`);
                const pinRes = await circleClient.createUserPinWithWallets({
                    userToken,
                    blockchains: ['ARC-TESTNET' as any],
                    accountType: 'SCA',
                });
                challengeId = pinRes.data?.challengeId;
            } else {
                throw err;
            }
        }

        console.log(`[Core] 🆕 Wallet creation challenge issued for ${userId}`);
        return res.json({
            status: 'needs_creation',
            challengeId
        });
    } catch (error: any) {
        console.error(`[Core] ❌ Failed to get/create wallet:`, error?.response?.data || error.message);
        return res.status(500).json({ error: 'Failed to get or create Circle wallet', debugError: error.message, debugData: error?.response?.data });
    }
});

// --- BUYER SIDE (Web2): Prepare Gateway Deposit Challenge ---
// Creates a USDC transfer UserOperation from the SCA to the GatewayClient
// and returns a challengeId for the user to sign via the Circle SDK.
coreRouter.post('/circle/prepare-deposit', sessionLimiter, async (req: Request, res: Response) => {
    const { userToken, walletId, depositAmount, ephemeralPk } = req.body;

    if (!userToken || !walletId || !depositAmount || !ephemeralPk) {
        return res.status(400).json({ error: 'Missing userToken, walletId, depositAmount, or ephemeralPk' });
    }

    try {
        // Derive the ephemeral wallet address from the private key
        const account = privateKeyToAccount(ephemeralPk as `0x${string}`);
        const ephemeralWalletAddress = account.address;

        // Fetch token balance to get the correct tokenId (Circle API requires tokenId even for native tokens)
        const balancesRes = await circleClient.getWalletTokenBalance({
            walletId,
            userToken
        });
        
        // Find the token holding the funds (should be Native token or USDC)
        const tokens = balancesRes.data?.tokenBalances || [];
        const fundedToken = tokens.find((t: any) => parseFloat(t.amount) >= parseFloat(depositAmount)) || tokens[0];
        
        if (!fundedToken) {
            return res.status(400).json({ error: 'Wallet has no tokens' });
        }

        const transferRes = await circleClient.createTransaction({
            userToken,
            walletId,
            tokenId: fundedToken.token.id,
            idempotencyKey: crypto.randomUUID(),
            destinationAddress: ephemeralWalletAddress,
            amounts: [depositAmount],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } }
        });

        console.log(`[Core] 💳 Deposit challenge created for wallet ${walletId}`);
        return res.json({
            challengeId: transferRes.data?.challengeId
        });
    } catch (error: any) {
        console.error(`[Core] ❌ Failed to prepare deposit:`, error?.response?.data || error.message);
        return res.status(500).json({ error: 'Failed to prepare deposit challenge' });
    }
});


// --- BUYER SIDE (Web2): Poll Challenge Status ---
coreRouter.post('/circle/poll-challenge', sessionLimiter, async (req: Request, res: Response) => {
    const { userToken, challengeId } = req.body;
    
    if (!userToken || !challengeId) {
        return res.status(400).json({ error: 'Missing userToken or challengeId' });
    }

    try {
        const TERMINAL = new Set(['COMPLETE', 'FAILED', 'EXPIRED']);
        const response = await circleClient.getUserChallenge({ userToken, challengeId });
        const status = response.data?.challenge?.status;
        
        if (status && TERMINAL.has(status)) {
            return res.json({ 
                status, 
                walletAddress: (response.data?.challenge as any)?.walletAddress,
                txHash: (response.data?.challenge as any)?.txHash,
            });
        }
        
        return res.json({ status: status || 'PENDING' });
    } catch (error: any) {
        console.error(`[Core] ❌ Failed to poll challenge:`, error?.response?.data || error.message);
        return res.status(500).json({ error: 'Failed to poll challenge' });
    }
});

// --- BUYER SIDE (Web2): Finalize CCTP Bridge (Asynchronous Job System) ---
interface CctpJob {
    id: string;
    status: 'pending' | 'complete' | 'failed';
    mintTxHash?: string;
    error?: string;
    createdAt: number;
}

const cctpJobs = new Map<string, CctpJob>();

function pruneCctpJobs() {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    for (const [id, job] of cctpJobs.entries()) {
        if (now - job.createdAt > maxAge) {
            cctpJobs.delete(id);
        }
    }
}

async function executeCctpFinalizationInBackground(
    jobId: string,
    sourceDomain: number,
    transactionHash: string,
    recipientAddress: string,
    sellerKey: string
) {
    try {
        console.log(`[CCTP] - Background job ${jobId} started. Polling Iris for attestation. Source domain: ${sourceDomain}, Tx: ${transactionHash}`);
        const irisUrl = `${IRIS_API_BASE}/${sourceDomain}?transactionHash=${transactionHash}`;
        let attestation: { message: string; attestation: string } | null = null;

        for (let attempt = 0; attempt < 60; attempt++) { // 60 * 5s = 5 min max
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Exit early if the job was deleted from cache
            if (!cctpJobs.has(jobId)) {
                console.log(`[CCTP] - Background job ${jobId} was removed from memory. Stopping process.`);
                return;
            }

            try {
                const irisRes = await fetch(irisUrl);
                if (!irisRes.ok) {
                    console.log(`[CCTP] - Iris returned ${irisRes.status}, retrying...`);
                    continue;
                }
                const irisData = await irisRes.json() as { messages?: Array<{ status: string; message: string; attestation: string }> };
                const msg = irisData.messages?.[0];
                if (msg?.status === 'complete') {
                    attestation = { message: msg.message, attestation: msg.attestation };
                    console.log(`[CCTP] - Job ${jobId}: Attestation ready after ${attempt + 1} attempts.`);
                    break;
                }
                console.log(`[CCTP] - Job ${jobId} Attempt ${attempt + 1}: status = ${msg?.status ?? 'not found'}`);
            } catch (fetchErr) {
                console.warn(`[CCTP] - Job ${jobId} Iris fetch error (attempt ${attempt + 1}):`, fetchErr);
            }
        }

        if (!attestation) {
            console.error(`[CCTP] - Job ${jobId} failed: Attestation timed out.`);
            const job = cctpJobs.get(jobId);
            if (job) {
                job.status = 'failed';
                job.error = 'Attestation timed out';
            }
            return;
        }

        console.log(`[CCTP] - Job ${jobId}: Minting USDC on Arc Testnet for ${recipientAddress}...`);
        const account = privateKeyToAccount(sellerKey as `0x${string}`);
        const arcWalletClient = createWalletClient({
            account,
            chain: arcTestnet,
            transport: http(),
        });
        const arcPublicClient = createPublicClient({
            chain: arcTestnet,
            transport: http(),
        });

        const mintTxHash = await arcWalletClient.sendTransaction({
            to: ARC_MESSAGE_TRANSMITTER,
            data: encodeFunctionData({
                abi: [{
                    type: 'function',
                    name: 'receiveMessage',
                    stateMutability: 'nonpayable',
                    inputs: [
                        { name: 'message', type: 'bytes' },
                        { name: 'attestation', type: 'bytes' },
                    ],
                    outputs: [],
                }],
                functionName: 'receiveMessage',
                args: [
                    attestation.message as `0x${string}`,
                    attestation.attestation as `0x${string}`,
                ],
            }),
        });

        console.log(`[CCTP] - Job ${jobId}: Waiting for mint tx confirmation...`);
        await arcPublicClient.waitForTransactionReceipt({ hash: mintTxHash });
        console.log(`[CCTP] - Job ${jobId} completed successfully! USDC minted on Arc! Tx: ${mintTxHash}`);

        const job = cctpJobs.get(jobId);
        if (job) {
            job.status = 'complete';
            job.mintTxHash = mintTxHash;
        }
    } catch (error: any) {
        console.error(`[CCTP] - Job ${jobId} execution failed:`, error?.message || error);
        const job = cctpJobs.get(jobId);
        if (job) {
            job.status = 'failed';
            job.error = error?.message || 'unknown error';
        }
    }
}

// Triggers the background CCTP attestation check and Arc minting, returning a jobId immediately
coreRouter.post('/circle/cctp-finalize', sessionLimiter, async (req: Request, res: Response) => {
    const { sourceDomain, transactionHash, recipientAddress } = req.body;

    if (!sourceDomain && sourceDomain !== 0) {
        return res.status(400).json({ error: 'Missing sourceDomain' });
    }
    if (!transactionHash || !recipientAddress) {
        return res.status(400).json({ error: 'Missing transactionHash or recipientAddress' });
    }
    if (!isAddress(recipientAddress)) {
        return res.status(400).json({ error: 'Invalid recipientAddress' });
    }

    const sellerKey = process.env.SELLER_PRIVATE_KEY;
    if (!sellerKey) {
        return res.status(500).json({ error: 'Backend wallet not configured (SELLER_PRIVATE_KEY missing)' });
    }

    try {
        pruneCctpJobs();
        const jobId = crypto.randomUUID();
        cctpJobs.set(jobId, {
            id: jobId,
            status: 'pending',
            createdAt: Date.now()
        });

        // Trigger background polling and transaction submission
        void executeCctpFinalizationInBackground(jobId, Number(sourceDomain), transactionHash, recipientAddress, sellerKey);

        return res.status(202).json({ jobId, status: 'pending' });
    } catch (error: any) {
        console.error(`[CCTP] - Failed to trigger finalize job:`, error?.message || error);
        return res.status(500).json({ error: 'Failed to initiate CCTP finalization' });
    }
});

// Returns the status of a specific CCTP finalization job
coreRouter.get('/circle/cctp-status/:jobId', sessionLimiter, (req: Request, res: Response) => {
    const { jobId } = req.params;
    if (typeof jobId !== 'string') {
        return res.status(400).json({ error: 'Invalid jobId format' });
    }
    const job = cctpJobs.get(jobId);
    if (!job) {
        return res.status(404).json({ error: 'CCTP finalization job not found' });
    }
    return res.json(job);
});

// --- BUYER SIDE: Register session, deposit to Gateway, and pay for access ---
coreRouter.post('/register-session', sessionLimiter, async (req: Request, res: Response) => {
    const { userId, privateKey, returnAddress, sellerAddress } = req.body;

    if (!userId || !privateKey || !returnAddress) {
        console.error(`[Core] ❌ /register-session missing fields. userId: ${userId}, privateKey: ${privateKey}, returnAddress: ${returnAddress}`);
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
        });

        // 2. Check current balances (with retry since blockchain indexers may lag)
        let balances = await gatewayClient.getBalances();
        console.log(`\n[Core] 💰 Initial Ephemeral wallet balance: ${balances.wallet.formatted} USDC`);

        let gatewayBalanceNum = Number(balances.gateway.formattedAvailable);
        let walletUsdc = Number(balances.wallet.formatted);
        const minWalletBalance = Number(process.env.MIN_WALLET_BALANCE || '0.01');

        if (gatewayBalanceNum <= 0.01 && walletUsdc < minWalletBalance) {
            console.log(`[Core] ⏳ Waiting for ephemeral wallet to receive funds...`);
            let attempts = 0;
            while (attempts < 15 && walletUsdc < minWalletBalance) {
                await new Promise(resolve => setTimeout(resolve, 2000));
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

        if (gatewayBalanceNum > 0.01) {
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

            // Wait for deposit to reflect in Gateway balance
            console.log(`[Core] ⏳ Waiting for deposit to reflect in Gateway balance...`);
            let attempts = 0;
            const expectedMinBalance = gatewayBalanceNum + Number(depositAmount);
            let gatewayUpdated = false;

            while (attempts < 30) {
                balances = await gatewayClient.getBalances();
                gatewayBalanceNum = Number(balances.gateway.formattedAvailable);
                if (gatewayBalanceNum >= expectedMinBalance) {
                    console.log(`[Core] ✅ Gateway balance updated! (${gatewayBalanceNum} USDC)`);
                    gatewayUpdated = true;
                    break;
                }
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            if (!gatewayUpdated) {
                return res.status(500).json({ error: 'Timeout waiting for deposit to reflect in Gateway.' });
            }
        }

        // 4. Verify gateway connection and balance (free)
        console.log(`[Core] 🔍 Verifying gateway connection (free)...`);
        const finalBalances = await gatewayClient.getBalances();
        console.log(`[Core] ✅ Gateway verified! Balance: ${finalBalances.gateway.formattedAvailable} USDC`);

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
        console.error(`[Core] ❌ Failed:`, err.message);
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
        console.error(`[Core] ❌ /end-session failed:`, err.message);
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
        });

        const balances = await gatewayClient.getBalances();
        const availableMicro = parseUnits(balances.gateway.formattedAvailable, 6);

        // Reserve a flat gas buffer (~0.005 USDC) for the Arc network withdrawal tx.
        // We do NOT take any percentage — the Gateway charges 0% commission.
        if (availableMicro <= GATEWAY_FEE_BUFFER) {
            walletService.clearSession(userId);
            return res.json({ status: 'cashed_out', amount: '0', message: 'Balance too low to withdraw.' });
        }

        const withdrawAmount = formatUnits(availableMicro - GATEWAY_FEE_BUFFER, 6);
        console.log(`[Core] 🧹 Cashing out ${withdrawAmount} USDC to ${sessionRecord.returnAddress}...`);

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

        const sidecarUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

        // Pay via the /tip-access endpoint — routes 100% to creator, no platform split
        await gatewayClient.pay<{ success: boolean }>(
            `${sidecarUrl}/api/core/tip-access`,
            { headers: { 'x-tip-amount': amount, 'x-seller-address': creatorWallet } }
        );

        console.log(`[Core] ❤️ Tip of ${amount} USDC sent from ${userId} to ${creatorWallet}`);
        return res.json({ status: 'success', amount, creatorWallet });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.message.includes('402') || err.message.toLowerCase().includes('insufficient')) {
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

export default coreRouter;
