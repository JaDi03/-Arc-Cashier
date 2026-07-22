/**
 * circle-routes.ts
 *
 * Circle SDK and CCTP routes, extracted from core/routes.ts.
 *
 * Responsibility: everything related to Circle User-Controlled Wallets and
 * the Cross-Chain Transfer Protocol (CCTP) bridge to Arc Testnet.
 *
 * External paths (unchanged after extraction):
 *   POST /api/core/circle/get-token
 *   POST /api/core/circle/get-wallet
 *   POST /api/core/circle/prepare-deposit
 *   POST /api/core/circle/poll-challenge
 *   POST /api/core/circle/cctp-finalize
 *   GET  /api/core/circle/cctp-status/:jobId
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import {
    isAddress,
    createWalletClient,
    createPublicClient,
    http,
    encodeFunctionData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Arc Testnet CCTP contracts (verified from docs.arc.network official docs)
const ARC_MESSAGE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as `0x${string}`;

// Iris attestation API (testnet)
const IRIS_API_BASE = 'https://iris-api-sandbox.circle.com/v2/messages';

const ARC_RPC_URL = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';

// ---------------------------------------------------------------------------
// Circle SDK client
// ---------------------------------------------------------------------------

const circleClient = initiateUserControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY || ''
});

// Arc Testnet public client — used for CCTP mint transaction receipt polling
const arcPublicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(ARC_RPC_URL)
});

// ---------------------------------------------------------------------------
// Per-userId lock to prevent concurrent createWallet calls from creating
// duplicate wallets. When the client retries get-wallet before Circle has
// indexed the first wallet, this lock returns 'indexing' instead of calling
// createWallet a second time.
// ---------------------------------------------------------------------------
const walletCreationLocks = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// Rate limiter (same settings as the core router)
// ---------------------------------------------------------------------------
const circleRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

// ---------------------------------------------------------------------------
// CCTP job store (in-memory, auto-pruned after 30 minutes)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// CCTP background finalizer
// Polls Iris for the cross-chain attestation, then submits the receiveMessage
// transaction to the Arc Testnet MessageTransmitter contract.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const circleRouter = Router();

// --- BUYER SIDE (Web2): Initialize Circle User + Session Token ---
// Creates the user in Circle if not exists, then returns a 60-min session token.
circleRouter.post('/circle/get-token', circleRateLimiter, async (req: Request, res: Response) => {
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
        console.error(`[Circle] ❌ Failed to generate token:`, error?.response?.data || error.message);
        return res.status(500).json({ error: 'Failed to generate Circle session token' });
    }
});

// --- BUYER SIDE (Web2): Get or Create Circle SCA Wallet ---
// Returns the walletId and address of the user's SCA on Arc Testnet.
// Also bootstraps wallet creation (returns challengeId if first-time user).
circleRouter.post('/circle/get-wallet', circleRateLimiter, async (req: Request, res: Response) => {
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
            console.log(`[Circle] 👛 Existing SCA wallet found for ${userId}: ${arcWallet.address}`);
            return res.json({
                status: 'existing',
                walletId: arcWallet.id,
                walletAddress: arcWallet.address
            });
        }

        // Wallet exists but is still being initialized on Circle's side.
        // Return 'indexing' so the client waits and retries instead of
        // triggering a second createWallet call that would create a duplicate.
        const pendingWallet = existingWallets.find(
            (w: any) => w.state === 'PENDING' || w.state === 'CREATING' || w.state === 'PENDING_BLOCKCHAIN'
        );
        if (pendingWallet) {
            console.log(`[Circle] ⏳ Wallet pending for ${userId} (state: ${pendingWallet.state}) — waiting for indexing.`);
            return res.json({ status: 'indexing' });
        }

        // Lock guard: if another request is already creating a wallet for this userId,
        // return 'indexing' immediately to prevent a second createWallet call.
        if (walletCreationLocks.has(userId)) {
            console.log(`[Circle] 🔒 Wallet creation already in progress for ${userId} — returning indexing.`);
            return res.json({ status: 'indexing' });
        }
        // Acquire lock. Auto-release after 60s as a failsafe.
        const lockTimer = setTimeout(() => walletCreationLocks.delete(userId), 60_000);
        walletCreationLocks.set(userId, lockTimer);

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
                console.log(`[Circle] ♻️ Error 155106: User already initialized. Re-fetching existing wallets for ${userId}.`);
                const retryRes = await circleClient.listWallets({
                    userToken,
                    blockchain: 'ARC-TESTNET' as any,
                });
                const retryWallet = (retryRes.data?.wallets || []).find((w: any) => w.state === 'LIVE');
                if (retryWallet) {
                    console.log(`[Circle] 👛 Wallet found on retry for ${userId}: ${retryWallet.address}`);
                    return res.json({
                        status: 'existing',
                        walletId: retryWallet.id,
                        walletAddress: retryWallet.address
                    });
                }
                return res.json({ status: 'indexing' });
            } else if (err?.message?.includes('PIN')) {
                console.log(`[Circle] 🔑 User needs PIN setup. Issuing createUserPinWithWallets challenge.`);
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

        console.log(`[Circle] 🆕 Wallet creation challenge issued for ${userId}`);
        return res.json({
            status: 'needs_creation',
            challengeId
        });
    } catch (error: any) {
        // Always release the lock on error so the user can retry
        if (walletCreationLocks.has(userId)) {
            clearTimeout(walletCreationLocks.get(userId));
            walletCreationLocks.delete(userId);
        }
        console.error(`[Circle] ❌ Failed to get/create wallet:`, error?.response?.data || error.message);
        return res.status(500).json({ error: 'Failed to get or create Circle wallet', debugError: error.message, debugData: error?.response?.data });
    }
});

// --- BUYER SIDE (Web2): Prepare Gateway Deposit Challenge ---
// Creates a USDC transfer UserOperation from the SCA to the GatewayClient
// and returns a challengeId for the user to sign via the Circle SDK.
circleRouter.post('/circle/prepare-deposit', circleRateLimiter, async (req: Request, res: Response) => {
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

        console.log(`[Circle] 💳 Deposit challenge created for wallet ${walletId}`);
        return res.json({
            challengeId: transferRes.data?.challengeId
        });
    } catch (error: any) {
        console.error(`[Circle] ❌ Failed to prepare deposit:`, error?.response?.data || error.message);
        return res.status(500).json({ error: 'Failed to prepare deposit challenge' });
    }
});

// --- BUYER SIDE (Web2): Poll Challenge Status ---
circleRouter.post('/circle/poll-challenge', circleRateLimiter, async (req: Request, res: Response) => {
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
        console.error(`[Circle] ❌ Failed to poll challenge:`, error?.response?.data || error.message);
        return res.status(500).json({ error: 'Failed to poll challenge' });
    }
});

// --- BUYER SIDE (Web2): Finalize CCTP Bridge ---
// Triggers the background CCTP attestation check and Arc minting.
// Returns a jobId immediately — poll /cctp-status/:jobId for progress.
circleRouter.post('/circle/cctp-finalize', circleRateLimiter, async (req: Request, res: Response) => {
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

        void executeCctpFinalizationInBackground(jobId, Number(sourceDomain), transactionHash, recipientAddress, sellerKey);

        return res.status(202).json({ jobId, status: 'pending' });
    } catch (error: any) {
        console.error(`[CCTP] - Failed to trigger finalize job:`, error?.message || error);
        return res.status(500).json({ error: 'Failed to initiate CCTP finalization' });
    }
});

// --- Returns the status of a specific CCTP finalization job ---
circleRouter.get('/circle/cctp-status/:jobId', circleRateLimiter, (req: Request, res: Response) => {
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

export default circleRouter;
