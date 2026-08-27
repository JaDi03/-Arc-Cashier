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
 *   POST /api/core/circle/quote-external-withdraw
 *   POST /api/core/circle/prepare-external-withdraw
 *   POST /api/core/circle/poll-challenge
 *   POST /api/core/circle/auth/session
 *   POST /api/core/circle/auth/handoff
 *   POST /api/core/circle/auth/handoff/redeem
 *   DELETE /api/core/circle/auth/session
 *
 * Email OTP requires SMTP configured in the Circle Developer Console.
 * Circle sends the OTP via that SMTP; Tessera does not send mail itself.
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import { privateKeyToAccount } from 'viem/accounts';
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets';
import { isAgentUserId } from './session-key-auth';

// ---------------------------------------------------------------------------
// Circle SDK client
// ---------------------------------------------------------------------------

const circleClient = initiateUserControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY || ''
});

/** Arc Testnet native USDC (Circle docs / Tessera paywall). */
export const ARC_TESTNET_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const EXTERNAL_WITHDRAW_AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

export type CircleTokenBalanceRow = {
    amount?: string;
    token?: {
        id?: string;
        symbol?: string;
        tokenAddress?: string;
        name?: string;
    };
};

export function isValidEvmAddress(address: unknown): address is string {
    return typeof address === 'string' && EVM_ADDRESS_RE.test(address);
}

/**
 * Parse a positive decimal USDC amount string for external withdraw.
 * Rejects scientific notation, negatives, and empty values.
 */
export function parseExternalWithdrawAmount(raw: unknown): { ok: true; amount: string; value: number } | { ok: false; error: string } {
    if (typeof raw !== 'string' && typeof raw !== 'number') {
        return { ok: false, error: 'Invalid withdraw amount' };
    }
    const amount = String(raw).trim();
    if (!amount || !EXTERNAL_WITHDRAW_AMOUNT_RE.test(amount)) {
        return { ok: false, error: 'Invalid withdraw amount' };
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, error: 'Withdraw amount must be greater than zero' };
    }
    return { ok: true, amount, value };
}

/** Prefer USDC by symbol, then by known Arc Testnet USDC token address. Never tokens[0]. */
export function findUsdcTokenBalance(tokenBalances: CircleTokenBalanceRow[] | undefined | null): CircleTokenBalanceRow | null {
    const rows = Array.isArray(tokenBalances) ? tokenBalances : [];
    const bySymbol = rows.find((row) => (row.token?.symbol || '').toUpperCase() === 'USDC');
    if (bySymbol?.token?.id) return bySymbol;
    const target = ARC_TESTNET_USDC_ADDRESS.toLowerCase();
    const byAddress = rows.find((row) => (row.token?.tokenAddress || '').toLowerCase() === target);
    if (byAddress?.token?.id) return byAddress;
    return null;
}

type ExternalWithdrawResolved = {
    amount: string;
    amountValue: number;
    destinationAddress: string;
    tokenId: string;
    usdcBalance: string;
    usdcBalanceValue: number;
};

async function resolveExternalWithdrawRequest(body: {
    userToken?: unknown;
    walletId?: unknown;
    destinationAddress?: unknown;
    amount?: unknown;
}): Promise<{ ok: true; data: ExternalWithdrawResolved } | { ok: false; status: number; error: string }> {
    const { userToken, walletId, destinationAddress, amount: rawAmount } = body;
    if (!userToken || typeof userToken !== 'string' || !walletId || typeof walletId !== 'string') {
        return { ok: false, status: 400, error: 'Missing userToken or walletId' };
    }
    if (!isValidEvmAddress(destinationAddress)) {
        return { ok: false, status: 400, error: 'Invalid destination address' };
    }
    const parsed = parseExternalWithdrawAmount(rawAmount);
    if (!parsed.ok) {
        return { ok: false, status: 400, error: parsed.error };
    }

    const balancesRes = await circleClient.getWalletTokenBalance({
        walletId,
        userToken,
    });
    const usdc = findUsdcTokenBalance(balancesRes.data?.tokenBalances as CircleTokenBalanceRow[] | undefined);
    if (!usdc?.token?.id) {
        return { ok: false, status: 400, error: 'USDC token not found in wallet' };
    }
    const usdcBalance = String(usdc.amount ?? '0');
    const usdcBalanceValue = Number(usdcBalance);
    if (!Number.isFinite(usdcBalanceValue) || usdcBalanceValue < parsed.value) {
        return {
            ok: false,
            status: 400,
            error: `Insufficient USDC balance: wallet has ${usdcBalance}, requested ${parsed.amount}`,
        };
    }

    return {
        ok: true,
        data: {
            amount: parsed.amount,
            amountValue: parsed.value,
            destinationAddress,
            tokenId: usdc.token.id,
            usdcBalance,
            usdcBalanceValue,
        },
    };
}

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

// ---------------------------------------------------------------------------
// Persistent Circle session secrets remain httpOnly. The encryption key is
// delivered to the Web SDK only through a short-lived, one-time handoff.
// ---------------------------------------------------------------------------

const COOKIE_USER_TOKEN = 'tessera_circle_user_token';
const COOKIE_REFRESH_TOKEN = 'tessera_circle_refresh_token';
const COOKIE_HANDOFF = 'tessera_circle_handoff';
const LEGACY_COOKIE_ENCRYPTION_KEY = 'tessera_circle_encryption_key';
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 days
const HANDOFF_MAX_AGE_SEC = 2 * 60;

interface CircleAuthHandoff {
    userToken: string;
    encryptionKey: string;
    expiresAt: number;
}

const circleAuthHandoffs = new Map<string, CircleAuthHandoff>();

function circleCookieSecure(): boolean {
    if (process.env.COOKIE_SECURE === 'true') return true;
    if (process.env.COOKIE_SECURE === 'false') return false;
    const publicUrl = process.env.PUBLIC_URL || '';
    return process.env.NODE_ENV === 'production' || publicUrl.startsWith('https://');
}

function appendAuthCookie(res: Response, name: string, value: string, maxAge = COOKIE_MAX_AGE_SEC): void {
    res.append(
        'Set-Cookie',
        serializeCookie(name, value, {
            httpOnly: true,
            secure: circleCookieSecure(),
            sameSite: 'lax',
            path: '/',
            maxAge,
        }),
    );
}

function clearAuthCookie(res: Response, name: string): void {
    res.append(
        'Set-Cookie',
        serializeCookie(name, '', {
            httpOnly: true,
            secure: circleCookieSecure(),
            sameSite: 'lax',
            path: '/',
            maxAge: 0,
        }),
    );
}

function disableSensitiveResponseCaching(res: Response): void {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
}

function readAuthCookies(req: Request): {
    userToken: string | null;
    refreshToken: string | null;
} {
    const jar = parseCookie(req.headers.cookie || '');
    return {
        userToken: jar[COOKIE_USER_TOKEN] || null,
        refreshToken: jar[COOKIE_REFRESH_TOKEN] || null,
    };
}

function readHandoffId(req: Request): string | null {
    const jar = parseCookie(req.headers.cookie || '');
    return jar[COOKIE_HANDOFF] || null;
}

circleRouter.post('/circle/auth/session', circleRateLimiter, (req: Request, res: Response) => {
    const { userToken, refreshToken } = req.body as {
        userToken?: string;
        refreshToken?: string;
    };
    disableSensitiveResponseCaching(res);
    if (!userToken || !refreshToken) {
        return res.status(400).json({ error: 'Missing userToken or refreshToken' });
    }
    appendAuthCookie(res, COOKIE_USER_TOKEN, String(userToken));
    appendAuthCookie(res, COOKIE_REFRESH_TOKEN, String(refreshToken));
    clearAuthCookie(res, LEGACY_COOKIE_ENCRYPTION_KEY);
    return res.json({ ok: true });
});

circleRouter.post('/circle/auth/handoff', circleRateLimiter, (req: Request, res: Response) => {
    const { userToken, encryptionKey } = req.body as {
        userToken?: string;
        encryptionKey?: string;
    };
    const session = readAuthCookies(req);
    disableSensitiveResponseCaching(res);
    if (!userToken || !encryptionKey || session.userToken !== userToken) {
        return res.status(401).json({ error: 'Invalid Circle auth handoff' });
    }

    const now = Date.now();
    for (const [id, handoff] of circleAuthHandoffs) {
        if (handoff.expiresAt <= now) circleAuthHandoffs.delete(id);
    }

    const handoffId = crypto.randomUUID();
    circleAuthHandoffs.set(handoffId, {
        userToken: String(userToken),
        encryptionKey: String(encryptionKey),
        expiresAt: now + (HANDOFF_MAX_AGE_SEC * 1000),
    });
    appendAuthCookie(res, COOKIE_HANDOFF, handoffId, HANDOFF_MAX_AGE_SEC);
    return res.json({ ok: true });
});

circleRouter.post('/circle/auth/handoff/redeem', circleRateLimiter, (req: Request, res: Response) => {
    const handoffId = readHandoffId(req);
    disableSensitiveResponseCaching(res);
    clearAuthCookie(res, COOKIE_HANDOFF);
    if (!handoffId) {
        return res.status(404).json({ error: 'No Circle auth handoff' });
    }

    const handoff = circleAuthHandoffs.get(handoffId);
    circleAuthHandoffs.delete(handoffId);
    if (!handoff || handoff.expiresAt <= Date.now()) {
        return res.status(404).json({ error: 'Circle auth handoff expired' });
    }
    return res.json({
        userToken: handoff.userToken,
        encryptionKey: handoff.encryptionKey,
    });
});

circleRouter.delete('/circle/auth/session', circleRateLimiter, (req: Request, res: Response) => {
    const handoffId = readHandoffId(req);
    if (handoffId) circleAuthHandoffs.delete(handoffId);
    disableSensitiveResponseCaching(res);
    clearAuthCookie(res, COOKIE_USER_TOKEN);
    clearAuthCookie(res, COOKIE_REFRESH_TOKEN);
    clearAuthCookie(res, COOKIE_HANDOFF);
    clearAuthCookie(res, LEGACY_COOKIE_ENCRYPTION_KEY);
    return res.json({ ok: true });
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
        });
    }
});

circleRouter.post('/circle/email-otp/refresh', circleRateLimiter, async (req: Request, res: Response) => {
    const { deviceId } = req.body as {
        deviceId?: string
    };
    const { userToken, refreshToken } = readAuthCookies(req);
    disableSensitiveResponseCaching(res);

    if (!userToken || !refreshToken || !deviceId) {
        return res.status(401).json({ error: 'Circle session expired. Sign in again.' });
    }

    try {
        const response = await circleClient.refreshUserToken({
            userToken: String(userToken),
            refreshToken: String(refreshToken),
            deviceId: String(deviceId),
            idempotencyKey: crypto.randomUUID(),
        });
        const nextUserToken = response.data?.userToken;
        const nextEncryptionKey = response.data?.encryptionKey;
        const nextRefreshToken = response.data?.refreshToken || refreshToken;
        if (!nextUserToken || !nextEncryptionKey) {
            return res.status(401).json({ error: 'Circle session refresh returned incomplete credentials.' });
        }
        appendAuthCookie(res, COOKIE_USER_TOKEN, nextUserToken);
        appendAuthCookie(res, COOKIE_REFRESH_TOKEN, nextRefreshToken);
        clearAuthCookie(res, LEGACY_COOKIE_ENCRYPTION_KEY);
        return res.json({
            userToken: nextUserToken,
            encryptionKey: nextEncryptionKey,
            appId: process.env.CIRCLE_APP_ID,
        });
    } catch (error: any) {
        console.error(`[Circle] ❌ Email OTP refresh failed:`, error?.response?.data || error.message);
        return res.status(401).json({
            error: 'Session expired. Sign in with email again.',
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
    if (isAgentUserId(userId)) {
        return res.status(400).json({
            error: 'Agent wallets are created by Circle Agent Stack on the caller side. Tessera does not create them.',
        });
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
        return res.status(500).json({ error: 'Failed to get or create Circle wallet' });
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

        // Fetch token balances and transfer USDC only (never native / tokens[0]).
        const balancesRes = await circleClient.getWalletTokenBalance({
            walletId,
            userToken
        });
        const usdc = findUsdcTokenBalance(balancesRes.data?.tokenBalances as CircleTokenBalanceRow[] | undefined);
        if (!usdc?.token?.id) {
            return res.status(400).json({ error: 'USDC token not found in wallet' });
        }
        const usdcBalance = String(usdc.amount ?? '0');
        const requested = Number(depositAmount);
        if (!Number.isFinite(requested) || requested <= 0) {
            return res.status(400).json({ error: 'Invalid deposit amount' });
        }
        if (Number(usdcBalance) < requested) {
            return res.status(400).json({ error: `Insufficient USDC balance: wallet has ${usdcBalance}, requested ${depositAmount}` });
        }

        const transferRes = await circleClient.createTransaction({
            userToken,
            walletId,
            tokenId: usdc.token.id,
            idempotencyKey: crypto.randomUUID(),
            destinationAddress: ephemeralWalletAddress,
            amounts: [String(depositAmount)],
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

// --- BUYER SIDE (Web2): Quote UCW → external Arc address withdraw ---
// Same-chain Arc Testnet USDC only. Does not create a challenge.
circleRouter.post('/circle/quote-external-withdraw', circleRateLimiter, async (req: Request, res: Response) => {
    try {
        const resolved = await resolveExternalWithdrawRequest(req.body || {});
        if (!resolved.ok) {
            return res.status(resolved.status).json({ error: resolved.error });
        }
        const { userToken, walletId } = req.body;
        const feeRes = await circleClient.estimateTransferFee({
            userToken,
            walletId,
            tokenId: resolved.data.tokenId,
            destinationAddress: resolved.data.destinationAddress,
            amount: [resolved.data.amount],
        });
        const feeData = feeRes.data || {};
        return res.json({
            network: 'ARC-TESTNET',
            token: 'USDC',
            destinationAddress: resolved.data.destinationAddress,
            amount: resolved.data.amount,
            usdcBalance: resolved.data.usdcBalance,
            feeLevel: 'HIGH',
            estimatedFee: feeData.high || null,
            feeEstimates: {
                low: feeData.low || null,
                medium: feeData.medium || null,
                high: feeData.high || null,
            },
        });
    } catch (error: any) {
        console.error(`[Circle] ❌ Failed to quote external withdraw:`, error?.response?.data || error.message);
        const circleMessage = error?.response?.data?.message || error?.message || 'Failed to quote external withdraw';
        return res.status(500).json({ error: circleMessage });
    }
});

// --- BUYER SIDE (Web2): Prepare UCW → external Arc address withdraw challenge ---
circleRouter.post('/circle/prepare-external-withdraw', circleRateLimiter, async (req: Request, res: Response) => {
    try {
        const resolved = await resolveExternalWithdrawRequest(req.body || {});
        if (!resolved.ok) {
            return res.status(resolved.status).json({ error: resolved.error });
        }
        const { userToken, walletId } = req.body;
        const transferRes = await circleClient.createTransaction({
            userToken,
            walletId,
            tokenId: resolved.data.tokenId,
            idempotencyKey: crypto.randomUUID(),
            destinationAddress: resolved.data.destinationAddress,
            amounts: [resolved.data.amount],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
        });
        console.log(`[Circle] 📤 External withdraw challenge created for wallet ${walletId}`);
        return res.json({
            challengeId: transferRes.data?.challengeId,
            network: 'ARC-TESTNET',
            token: 'USDC',
            destinationAddress: resolved.data.destinationAddress,
            amount: resolved.data.amount,
        });
    } catch (error: any) {
        console.error(`[Circle] ❌ Failed to prepare external withdraw:`, error?.response?.data || error.message);
        const circleMessage = error?.response?.data?.message || error?.message || 'Failed to prepare external withdraw';
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
