import { Router, type Request, type Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { formatUnits, parseUnits, pad } from 'viem';
import { statsService } from '../core/stats';
import {
    BURN_INTENT_EIP712_DOMAIN,
    BURN_INTENT_EIP712_TYPES,
    buildGatewayMintTransaction,
    computeCreatorWithdrawAmount,
    createCreatorBurnIntent,
    getCreatorGatewayBalance,
    isValidEvmAddress,
    submitCreatorWithdraw,
    type CreatorBurnIntent,
} from '../core/creator-gateway';

/**
 * Thin PeerTube admin + creator/stats routes under /api/connectors/peertube.
 * Creator balance/withdraw live on /api/core/creator/* (platform-agnostic).
 * Auth: Bearer token matching TESSERA_CONNECTOR_SECRET_PEERTUBE
 * (fallback: PEERTUBE_WEBHOOK_SECRET for legacy .env).
 */
const adminRouter = Router();

function connectorSecret(): string | undefined {
    return process.env.TESSERA_CONNECTOR_SECRET_PEERTUBE || process.env.PEERTUBE_WEBHOOK_SECRET;
}

function verifySellerAuth(req: Request, res: Response): boolean {
    const secret = connectorSecret();
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

/**
 * Admin wallet source of truth is the PeerTube plugin dashboard.
 * Authenticated relays pass it as ?address= / body.address.
 * Env and data/instance-settings.json remain fallbacks only.
 */
function getAdminWallet(req?: Request): string {
    const fromRequest = (
        (typeof req?.query?.address === 'string' ? req.query.address : '') ||
        (typeof req?.body?.address === 'string' ? req.body.address : '')
    ).trim();
    if (fromRequest && isValidEvmAddress(fromRequest)) {
        return fromRequest;
    }

    const DATA_DIR = path.resolve(process.cwd(), 'data');
    const SETTINGS_PATH = path.join(DATA_DIR, 'instance-settings.json');
    let adminWallet = process.env.TESSERA_ADMIN_WALLET || process.env.SELLER_ADDRESS || '';
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
            const data = JSON.parse(raw);
            if (data.adminWallet) {
                adminWallet = data.adminWallet.trim();
            }
        }
    } catch (err) {
        console.error('[PeerTube-Admin] Error reading admin wallet:', err);
    }
    return adminWallet;
}

adminRouter.get('/admin/balance', async (req: Request, res: Response) => {
    if (!verifySellerAuth(req, res)) return;

    const adminAddress = getAdminWallet(req);
    if (!adminAddress || !isValidEvmAddress(adminAddress)) {
        return res.status(400).json({ error: 'Admin wallet address is not configured or invalid' });
    }

    try {
        const balances = await getCreatorGatewayBalance(adminAddress as `0x${string}`);
        return res.json({
            status: 'success',
            address: adminAddress,
            available: balances.formattedAvailable,
            withdrawable: balances.formattedWithdrawable,
            total: balances.formattedTotal,
        });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[PeerTube-Admin] Balance fetch failed for ${adminAddress}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

adminRouter.post('/admin/prepare-withdraw', async (req: Request, res: Response) => {
    if (!verifySellerAuth(req, res)) return;

    const adminAddress = getAdminWallet(req);
    if (!adminAddress || !isValidEvmAddress(adminAddress)) {
        return res.status(400).json({ error: 'Admin wallet address is not configured or invalid' });
    }

    try {
        const balances = await getCreatorGatewayBalance(adminAddress as `0x${string}`);
        const withdrawMicro = computeCreatorWithdrawAmount(balances.availableMicro);

        if (withdrawMicro <= parseUnits('0.001', 6)) {
            return res.json({
                status: 'no_funds',
                gatewayAvailable: balances.formattedAvailable,
                gatewayWithdrawable: balances.formattedWithdrawable,
                message: 'Balance too low to withdraw.',
            });
        }

        const withdrawAmount = formatUnits(withdrawMicro, 6);
        const { burnIntent, formattedAmount } = createCreatorBurnIntent(
            adminAddress as `0x${string}`,
            withdrawAmount,
        );

        return res.json({
            status: 'ready',
            address: adminAddress,
            amount: formattedAmount,
            burnIntent: JSON.parse(JSON.stringify(burnIntent, (_k, v) =>
                typeof v === 'bigint' ? v.toString() : v
            )),
            typedData: {
                domain: BURN_INTENT_EIP712_DOMAIN,
                types: BURN_INTENT_EIP712_TYPES,
                primaryType: 'BurnIntent',
                message: JSON.parse(JSON.stringify(burnIntent, (_k, v) =>
                    typeof v === 'bigint' ? v.toString() : v
                )),
            },
        });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[PeerTube-Admin] prepare-withdraw failed for ${adminAddress}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

adminRouter.post('/admin/complete-withdraw', async (req: Request, res: Response) => {
    if (!verifySellerAuth(req, res)) return;

    const adminAddress = getAdminWallet(req);
    const signature = req.body?.signature as string;
    const burnIntent = req.body?.burnIntent as CreatorBurnIntent;

    if (!adminAddress || !isValidEvmAddress(adminAddress)) {
        return res.status(400).json({ error: 'Admin wallet address is not configured or invalid' });
    }
    if (!signature || !burnIntent?.spec) {
        return res.status(400).json({ error: 'Missing burnIntent or signature' });
    }

    const normalizeHex = (value: string) => value.toLowerCase();
    const depositor = normalizeHex(String(burnIntent.spec.sourceDepositor));
    const signer = normalizeHex(String(burnIntent.spec.sourceSigner));
    const expected = normalizeHex(pad(adminAddress as `0x${string}`, { size: 32 }));

    if (depositor !== expected || signer !== expected) {
        return res.status(400).json({ error: 'Burn intent does not match admin address' });
    }

    try {
        const normalizedIntent: CreatorBurnIntent = {
            maxBlockHeight: BigInt(burnIntent.maxBlockHeight),
            maxFee: BigInt(burnIntent.maxFee),
            spec: {
                ...burnIntent.spec,
                value: BigInt(burnIntent.spec.value),
            },
        };

        const attestationResult = await submitCreatorWithdraw(
            normalizedIntent,
            signature as `0x${string}`,
        );

        const txRequest = buildGatewayMintTransaction(
            attestationResult.attestation,
            attestationResult.operatorSignature,
            adminAddress as `0x${string}`,
        );

        return res.json({
            status: 'ready_to_mint',
            transferId: attestationResult.transferId,
            txRequest,
        });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[PeerTube-Admin] complete-withdraw failed for ${adminAddress}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

adminRouter.get('/creator/stats', async (req: Request, res: Response) => {
    const address = (req.query.address as string || '').trim();
    if (!address || !isValidEvmAddress(address)) {
        return res.status(400).json({ error: 'Missing or invalid address' });
    }

    try {
        const stats = statsService.getEarningsByAddress(address);
        return res.json({ status: 'success', stats });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return res.status(500).json({ error: err.message });
    }
});

adminRouter.get('/admin/stats', async (req: Request, res: Response) => {
    if (!verifySellerAuth(req, res)) return;

    try {
        const adminAddress = getAdminWallet(req);
        const stats = adminAddress
            ? statsService.getEarningsByAddress(adminAddress)
            : [];
        return res.json({ status: 'success', stats });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return res.status(500).json({ error: err.message });
    }
});

export default adminRouter;
