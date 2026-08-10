/**
 * circle-routes.ts
 *
 * Circle SDK and CCTP routes, extracted from core/routes.ts.
 *
 * Responsibility: everything related to Circle User-Controlled Wallets.
 * Cross-chain payments are handled client-side via the Circle Forwarding Service.
 *
 * External paths:
 *   POST /api/core/circle/email-otp/request
 *   POST /api/core/circle/email-otp/refresh
 *   POST /api/core/circle/social/device-token
 *   POST /api/core/circle/get-wallet
 *   POST /api/core/circle/prepare-deposit
 *   POST /api/core/circle/poll-challenge
 *
 * Email OTP requires SMTP configured in the Circle Developer Console.
 * Circle sends the OTP via that SMTP; Tessera does not send mail itself.
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets';

// ---------------------------------------------------------------------------
// Circle SDK client
// ---------------------------------------------------------------------------

const circleClient = initiateUserControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY || ''
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
// Router
// ---------------------------------------------------------------------------
const circleRouter = Router();

circleRouter.get('/circle/app-id', circleRateLimiter, (_req: Request, res: Response) => {
    const appId = process.env.CIRCLE_APP_ID || '';
    if (!appId) return res.status(500).json({ error: 'CIRCLE_APP_ID not configured' });
    return res.json({
        appId,
        googleClientId: process.env.CIRCLE_GOOGLE_CLIENT_ID || '',
        facebookAppId: process.env.CIRCLE_FACEBOOK_APP_ID || '',
    });
});

// --- BUYER SIDE (Web2): Start Email OTP login ---
// Returns deviceToken / deviceEncryptionKey / otpToken for W3SSdk.verifyOtp().
circleRouter.post('/circle/email-otp/request', circleRateLimiter, async (req: Request, res: Response) => {
    const { email, deviceId } = req.body as { email?: string; deviceId?: string };

    if (!email || !deviceId) {
        return res.status(400).json({ error: 'Missing email or deviceId' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (!normalizedEmail.includes('@')) {
        return res.status(400).json({ error: 'Invalid email' });
    }

    try {
        const response = await circleClient.createDeviceTokenForEmailLogin({
            deviceId: String(deviceId),
            email: normalizedEmail,
            idempotencyKey: crypto.randomUUID(),
        });

        return res.json({
            deviceToken: response.data?.deviceToken,
            deviceEncryptionKey: response.data?.deviceEncryptionKey,
            otpToken: response.data?.otpToken,
            appId: process.env.CIRCLE_APP_ID,
            email: normalizedEmail,
        });
    } catch (error: any) {
        console.error(`[Circle] ❌ Email OTP request failed:`, error?.response?.data || error.message);
        return res.status(500).json({
            error: 'Failed to request email OTP. Confirm SMTP is configured in Circle Console.',
            debugError: error.message,
            debugData: error?.response?.data,
        });
    }
});

circleRouter.post('/circle/social/device-token', circleRateLimiter, async (req: Request, res: Response) => {
    const { deviceId } = req.body as { deviceId?: string };

    if (!deviceId) {
        return res.status(400).json({ error: 'Missing deviceId' });
    }

    try {
        const response = await circleClient.createDeviceTokenForSocialLogin({
            deviceId: String(deviceId),
            idempotencyKey: crypto.randomUUID(),
        });

        return res.json({
            deviceToken: response.data?.deviceToken,
            deviceEncryptionKey: response.data?.deviceEncryptionKey,
            appId: process.env.CIRCLE_APP_ID,
            googleClientId: process.env.CIRCLE_GOOGLE_CLIENT_ID || '',
            facebookAppId: process.env.CIRCLE_FACEBOOK_APP_ID || '',
        });
    } catch (error: any) {
        console.error(`[Circle] ❌ Social device token failed:`, error?.response?.data || error.message);
        return res.status(500).json({
            error: 'Failed to create social login device token',
            debugError: error.message,
            debugData: error?.response?.data,
        });
    }
});

circleRouter.post('/circle/email-otp/refresh', circleRateLimiter, async (req: Request, res: Response) => {
    const { userToken, refreshToken, deviceId } = req.body as {
        userToken?: string
        refreshToken?: string
        deviceId?: string
    };

    if (!userToken || !refreshToken || !deviceId) {
        return res.status(400).json({ error: 'Missing userToken, refreshToken, or deviceId' });
    }

    try {
        const response = await circleClient.refreshUserToken({
            userToken: String(userToken),
            refreshToken: String(refreshToken),
            deviceId: String(deviceId),
            idempotencyKey: crypto.randomUUID(),
        });
        return res.json({
            userToken: response.data?.userToken,
            encryptionKey: response.data?.encryptionKey,
            refreshToken: response.data?.refreshToken,
            appId: process.env.CIRCLE_APP_ID,
        });
    } catch (error: any) {
        console.error(`[Circle] ❌ Email OTP refresh failed:`, error?.response?.data || error.message);
        return res.status(401).json({
            error: 'Session expired. Sign in with email again.',
            debugError: error.message,
            debugData: error?.response?.data,
        });
    }
});

// --- BUYER SIDE (Web2): Get or Create Circle SCA Wallet ---
// Returns the walletId and address of the user's SCA on Arc Testnet.
// Also bootstraps wallet creation (returns challengeId if first-time user).
// Viewer auth is email OTP or social login only. Wallet creation is approved
// via the Circle confirmation UI (no PIN flow).
circleRouter.post('/circle/get-wallet', circleRateLimiter, async (req: Request, res: Response) => {
    const { userId, userToken } = req.body;

    if (!userId || !userToken) {
        return res.status(400).json({ error: 'Missing userId or userToken' });
    }

    // Viewer auth is email OTP or social login only. Wallet creation uses the
    // Circle initialization challenge (INITIALIZE), approved in the hosted UI.

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
            // First-time email/social users must run Circle's INITIALIZE challenge
            // (SDK name createUserPinWithWallets). It creates the wallet after the
            // hosted confirmation UI; there is no PIN step in this product.
            const createRes = await circleClient.createUserPinWithWallets({
                userToken,
                idempotencyKey: deterministicKey,
                blockchains: ['ARC-TESTNET' as any],
                accountType: 'SCA',
            });
            challengeId = createRes.data?.challengeId;
        } catch (err: any) {
            // Circle error 155106: "User already initialized"
            // Per Circle UCW docs: "Fetch existing wallets instead of creating"
            // This happens when the user completed initialization but the wallet hasn't indexed yet.
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
        const circleMessage = error?.response?.data?.message || error?.message || 'Failed to prepare deposit challenge';
        return res.status(500).json({ error: circleMessage });
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



/**
 * Prove that userToken controls a LIVE Arc SCA at returnAddress.
 * Used before returning or accepting session ephemeral keys.
 */
export async function verifyCircleWalletOwnership(
    userToken: string,
    returnAddress: string
): Promise<'ok' | 'unauthorized' | 'error'> {
    if (!userToken || !returnAddress) return 'unauthorized';
    try {
        const walletsRes = await circleClient.listWallets({
            userToken,
            blockchain: 'ARC-TESTNET' as any,
        });
        const wallets = walletsRes.data?.wallets || [];
        const target = returnAddress.toLowerCase();
        const owns = wallets.some(
            (w: { state?: string; address?: string }) =>
                w.state === 'LIVE'
                && typeof w.address === 'string'
                && w.address.toLowerCase() === target
        );
        return owns ? 'ok' : 'unauthorized';
    } catch (error: any) {
        const status = error?.response?.status ?? error?.status;
        if (status === 401 || status === 403) return 'unauthorized';
        console.error('[Circle] verifyCircleWalletOwnership failed:', error?.response?.data || error?.message || error);
        return 'error';
    }
}

export default circleRouter;
