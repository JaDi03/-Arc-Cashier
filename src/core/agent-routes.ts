/**
 * Agent callers (Circle Agent Stack).
 *
 * Humans create Circle SCAs through circle-routes + the paywall (OTP / Google).
 * Agents create their wallet with Circle CLI on their side. Tessera never calls
 * createUserPinWithWallets for them. Ownership is a signed challenge
 * (`circle wallet sign message`).
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import {
    createPublicClient,
    getAddress,
    http,
    isAddress,
    verifyMessage,
    type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';
import { walletService } from './wallet';
import { addressesEqual, agentUserIdFromAddress } from './session-key-auth';

const ARC_RPC_URL = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(ARC_RPC_URL),
});

const agentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});

interface AgentChallenge {
    message: string;
    nonce: string;
    expiresAt: number;
}

const agentChallenges = new Map<string, AgentChallenge>();

export function buildAgentChallengeMessage(address: string, nonce: string, expiresAt: number): string {
    return [
        'Tessera agent session',
        'Chain: ARC-TESTNET',
        `Address: ${address}`,
        `Nonce: ${nonce}`,
        `Expires: ${new Date(expiresAt).toISOString()}`,
    ].join('\n');
}

async function verifyAgentSignature(
    address: `0x${string}`,
    message: string,
    signature: string,
): Promise<boolean> {
    try {
        const eoaOk = await verifyMessage({
            address,
            message,
            signature: signature as Hex,
        });
        if (eoaOk) return true;
    } catch {
        // SCA signatures fail ecrecover; fall through to ERC-1271.
    }
    try {
        return await publicClient.verifyMessage({
            address,
            message,
            signature: signature as Hex,
        });
    } catch {
        return false;
    }
}

function readChecksumAddress(raw: unknown): `0x${string}` | null {
    if (typeof raw !== 'string' || !isAddress(raw)) return null;
    return getAddress(raw);
}

async function requireValidChallenge(
    address: `0x${string}`,
    signature: unknown,
): Promise<{ ok: true; message: string } | { ok: false; status: number; error: string }> {
    if (typeof signature !== 'string' || !signature.startsWith('0x')) {
        return { ok: false, status: 400, error: 'Missing or invalid signature' };
    }
    const challenge = agentChallenges.get(address.toLowerCase());
    if (!challenge) {
        return { ok: false, status: 400, error: 'No challenge for this address. POST /agent/challenge first.' };
    }
    if (Date.now() > challenge.expiresAt) {
        agentChallenges.delete(address.toLowerCase());
        return { ok: false, status: 400, error: 'Challenge expired. Request a new one.' };
    }
    const valid = await verifyAgentSignature(address, challenge.message, signature);
    if (!valid) {
        return { ok: false, status: 401, error: 'Signature does not match this address.' };
    }
    return { ok: true, message: challenge.message };
}

const agentRouter = Router();

/**
 * POST /agent/challenge { address }
 * Returns a plaintext message for `circle wallet sign message`.
 */
agentRouter.post('/agent/challenge', agentLimiter, (req: Request, res: Response) => {
    const address = readChecksumAddress(req.body?.address);
    if (!address) {
        return res.status(400).json({ error: 'Missing or invalid address' });
    }
    const nonce = crypto.randomUUID();
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;
    const message = buildAgentChallengeMessage(address, nonce, expiresAt);
    agentChallenges.set(address.toLowerCase(), { message, nonce, expiresAt });
    return res.json({
        status: 'challenge',
        address,
        userId: agentUserIdFromAddress(address),
        nonce,
        expiresAt,
        message,
        signCommand: `circle wallet sign message ${JSON.stringify(message)} --address ${address} --chain ARC-TESTNET`,
    });
});

/**
 * POST /agent/begin-session { address, signature }
 * Tessera mints the ephemeral Gateway key. The agent must fund that address,
 * then call /agent/fund-session. Does not create a Circle wallet.
 */
agentRouter.post('/agent/begin-session', agentLimiter, async (req: Request, res: Response) => {
    const address = readChecksumAddress(req.body?.address);
    if (!address) {
        return res.status(400).json({ error: 'Missing or invalid address' });
    }
    const proof = await requireValidChallenge(address, req.body?.signature);
    if (!proof.ok) return res.status(proof.status).json({ error: proof.error });

    const userId = agentUserIdFromAddress(address);

    if (walletService.hasSessionRecord(userId)) {
        const existing = walletService.getSessionRecord(userId);
        if (!addressesEqual(existing.returnAddress, address)) {
            return res.status(401).json({ error: 'Return address does not match existing session.' });
        }
        const account = privateKeyToAccount(existing.privateKey);
        const funded = existing.pending !== true;
        return res.json({
            status: funded ? 'already_funded' : 'awaiting_funds',
            userId,
            returnAddress: address,
            ephemeralAddress: account.address,
        });
    }

    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    walletService.registerSessionKey(userId, privateKey, address, undefined, true);

    return res.json({
        status: 'awaiting_funds',
        userId,
        returnAddress: address,
        ephemeralAddress: account.address,
        fundHint: `circle wallet transfer ${account.address} --amount <usdc> --address ${address} --chain ARC-TESTNET`,
    });
});

/**
 * POST /agent/fund-session { address, signature }
 * Deposits ephemeral USDC into Gateway once the agent has transferred funds.
 */
agentRouter.post('/agent/fund-session', agentLimiter, async (req: Request, res: Response) => {
    const address = readChecksumAddress(req.body?.address);
    if (!address) {
        return res.status(400).json({ error: 'Missing or invalid address' });
    }
    const proof = await requireValidChallenge(address, req.body?.signature);
    if (!proof.ok) return res.status(proof.status).json({ error: proof.error });

    const userId = agentUserIdFromAddress(address);
    if (!walletService.hasSessionRecord(userId)) {
        return res.status(404).json({ error: 'No agent session. POST /agent/begin-session first.' });
    }
    const sessionRecord = walletService.getSessionRecord(userId);
    if (!addressesEqual(sessionRecord.returnAddress, address)) {
        return res.status(401).json({ error: 'Return address does not match existing session.' });
    }

    const stringifyBigInt = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

    try {
        const gatewayClient = new GatewayClient({
            privateKey: sessionRecord.privateKey,
            chain: 'arcTestnet',
            rpcUrl: ARC_RPC_URL,
        });
        let balances = await gatewayClient.getBalances();
        let gatewayBalanceNum = Number(balances.gateway.formattedAvailable);
        let walletUsdc = Number(balances.wallet.formatted);
        const minWalletBalance = Number(process.env.MIN_WALLET_BALANCE || '0.01');
        const minGatewayBalance = 0.01;

        if (gatewayBalanceNum >= minGatewayBalance) {
            walletService.markSessionFunded(userId);
            agentChallenges.delete(address.toLowerCase());
            return res.setHeader('Content-Type', 'application/json').send(
                JSON.stringify({
                    status: 'session_registered',
                    userId,
                    deposit: { txHash: 'skipped', amount: '0' },
                    remainingBalance: balances.gateway.formattedAvailable,
                }, stringifyBigInt),
            );
        }

        if (gatewayBalanceNum < minGatewayBalance && walletUsdc < minWalletBalance) {
            let attempts = 0;
            while (attempts < 12 && walletUsdc < minWalletBalance) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
                balances = await gatewayClient.getBalances();
                walletUsdc = Number(balances.wallet.formatted);
                attempts++;
            }
        }

        if (walletUsdc < minWalletBalance) {
            return res.status(400).json({
                error: 'Ephemeral wallet has insufficient USDC. Transfer USDC to ephemeralAddress first.',
            });
        }

        const retainedGasAmount = Number(process.env.RETAINED_GAS_AMOUNT || '0.01');
        const depositAmount = Math.max(0, walletUsdc - retainedGasAmount).toFixed(6);
        const depositResult = await gatewayClient.deposit(depositAmount);

        let attempts = 0;
        const expectedMinBalance = gatewayBalanceNum + Number(depositAmount);
        while (attempts < 10) {
            balances = await gatewayClient.getBalances();
            gatewayBalanceNum = Number(balances.gateway.formattedAvailable);
            if (gatewayBalanceNum >= expectedMinBalance) break;
            attempts++;
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (attempts >= 10) {
            return res.status(500).json({ error: 'Timeout waiting for deposit to reflect in Gateway.' });
        }

        const finalBalances = await gatewayClient.getBalances();
        walletService.markSessionFunded(userId);
        agentChallenges.delete(address.toLowerCase());

        return res.setHeader('Content-Type', 'application/json').send(
            JSON.stringify({
                status: 'session_registered',
                userId,
                deposit: { txHash: depositResult.depositTxHash, amount: depositResult.formattedAmount },
                remainingBalance: finalBalances.gateway.formattedAvailable,
            }, stringifyBigInt),
        );
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error('[Agent] fund-session failed:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

export default agentRouter;
