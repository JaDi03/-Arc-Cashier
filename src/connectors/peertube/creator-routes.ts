import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { statsService } from '../../core/stats';
import { formatUnits, parseUnits } from 'viem';
import {
    buildGatewayMintTransaction,
    computeCreatorWithdrawAmount,
    createCreatorBurnIntent,
    getCreatorGatewayBalance,
    isValidEvmAddress,
    submitCreatorWithdraw,
    BURN_INTENT_EIP712_DOMAIN,
    BURN_INTENT_EIP712_TYPES,
    type CreatorBurnIntent,
} from './gateway-creator';

/**
 * PeerTube Creator & Seller Routes
 *
 * These routes are registered under /api/connectors/peertube/ and handle
 * the PeerTube-specific withdrawal flows:
 *
 * Creator routes (/creator/*):
 *   - Creators withdraw their Gateway balance using their own MetaMask wallet.
 *   - Uses BurnIntent + EIP-712: the sidecar never holds creator private keys.
 *   - Each creator accumulated their balance via the platform fee split applied
 *     by the connector's webhook layer before the payment hits the core.
 *
 * Seller/Admin routes (/seller/*):
 *   - The PeerTube instance admin withdraws the platform fee portion (SELLER_ADDRESS).
 *   - Protected by PEERTUBE_WEBHOOK_SECRET — only callable from the PeerTube plugin.
 */
const creatorRouter = Router();

// ---------------------------------------------------------------------------
// CREATOR: Per-creator Gateway balance (MetaMask / EOA wallets)
// ---------------------------------------------------------------------------

creatorRouter.get('/creator/balance', async (req: Request, res: Response) => {
    const address = (req.query.address as string || '').trim();
    if (!address || !isValidEvmAddress(address)) {
        return res.status(400).json({ error: 'Missing or invalid address' });
    }

    try {
        const balances = await getCreatorGatewayBalance(address as `0x${string}`);
        return res.json({
            status: 'success',
            address,
            gatewayAvailable: balances.formattedAvailable,
            gatewayWithdrawable: balances.formattedWithdrawable,
            gatewayTotal: balances.formattedTotal,
        });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[PeerTube] ❌ Creator balance fetch failed for ${address}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// CREATOR: Prepare withdrawal — builds BurnIntent for MetaMask EIP-712 signing
// ---------------------------------------------------------------------------

creatorRouter.post('/creator/prepare-withdraw', async (req: Request, res: Response) => {
    const address = (req.body?.address as string || '').trim();
    if (!address || !isValidEvmAddress(address)) {
        return res.status(400).json({ error: 'Missing or invalid address' });
    }

    try {
        const balances = await getCreatorGatewayBalance(address as `0x${string}`);
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
            address as `0x${string}`,
            withdrawAmount,
        );

        return res.json({
            status: 'ready',
            address,
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
        console.error(`[PeerTube] ❌ Creator prepare-withdraw failed for ${address}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// CREATOR: Complete withdrawal — submits signed BurnIntent to Gateway
// ---------------------------------------------------------------------------

creatorRouter.post('/creator/complete-withdraw', async (req: Request, res: Response) => {
    const address = (req.body?.address as string || '').trim();
    const signature = req.body?.signature as string;
    const burnIntent = req.body?.burnIntent as CreatorBurnIntent;

    if (!address || !isValidEvmAddress(address)) {
        return res.status(400).json({ error: 'Missing or invalid address' });
    }
    if (!signature || !burnIntent?.spec) {
        return res.status(400).json({ error: 'Missing burnIntent or signature' });
    }

    // Verify the burn intent belongs to the claimed address
    const { pad } = await import('viem');
    const normalizeHex = (value: string) => value.toLowerCase();
    const depositor = normalizeHex(String(burnIntent.spec.sourceDepositor));
    const signer   = normalizeHex(String(burnIntent.spec.sourceSigner));
    const expected = normalizeHex(pad(address as `0x${string}`, { size: 32 }));

    if (depositor !== expected || signer !== expected) {
        return res.status(400).json({ error: 'Burn intent does not match creator address' });
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
            address as `0x${string}`,
        );

        return res.json({
            status: 'ready_to_mint',
            transferId: attestationResult.transferId,
            txRequest,
        });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[PeerTube] ❌ Creator complete-withdraw failed for ${address}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// SELLER / ADMIN: Platform fee wallet balance & withdrawal
// The platform admin collects the platformFee portion applied by the connector.
// Protected by PEERTUBE_WEBHOOK_SECRET — only the PeerTube plugin can call this.
// ---------------------------------------------------------------------------

function verifySellerAuth(req: Request, res: Response): boolean {
    const secret = process.env.PEERTUBE_WEBHOOK_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

function getAdminWallet(): string {
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
        console.error('[Tessera-CreatorRoutes] Error reading admin wallet:', err);
    }
    return adminWallet;
}

creatorRouter.get('/admin/balance', async (req: Request, res: Response) => {
    if (!verifySellerAuth(req, res)) return;

    const adminAddress = getAdminWallet();
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
        console.error(`[PeerTube] ❌ Admin balance fetch failed for ${adminAddress}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

creatorRouter.post('/admin/prepare-withdraw', async (req: Request, res: Response) => {
    if (!verifySellerAuth(req, res)) return;

    const adminAddress = getAdminWallet();
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
        console.error(`[PeerTube] ❌ Admin prepare-withdraw failed for ${adminAddress}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

creatorRouter.post('/admin/complete-withdraw', async (req: Request, res: Response) => {
    if (!verifySellerAuth(req, res)) return;

    const adminAddress = getAdminWallet();
    const signature = req.body?.signature as string;
    const burnIntent = req.body?.burnIntent as CreatorBurnIntent;

    if (!adminAddress || !isValidEvmAddress(adminAddress)) {
        return res.status(400).json({ error: 'Admin wallet address is not configured or invalid' });
    }
    if (!signature || !burnIntent?.spec) {
        return res.status(400).json({ error: 'Missing burnIntent or signature' });
    }

    // Verify the burn intent belongs to the admin address
    const { pad } = await import('viem');
    const normalizeHex = (value: string) => value.toLowerCase();
    const depositor = normalizeHex(String(burnIntent.spec.sourceDepositor));
    const signer   = normalizeHex(String(burnIntent.spec.sourceSigner));
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
        console.error(`[PeerTube] ❌ Admin complete-withdraw failed for ${adminAddress}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// STATS: Stats retrieval routes
// ---------------------------------------------------------------------------

creatorRouter.get('/creator/stats', async (req: Request, res: Response) => {
    const address = (req.query.address as string || '').trim();
    if (!address || !isValidEvmAddress(address)) {
        return res.status(400).json({ error: 'Missing or invalid address' });
    }

    try {
        const stats = statsService.getCreatorStats(address);
        return res.json({
            status: 'success',
            stats,
        });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return res.status(500).json({ error: err.message });
    }
});

creatorRouter.get('/admin/stats', async (req: Request, res: Response) => {
    if (!verifySellerAuth(req, res)) return;

    try {
        const stats = statsService.getAdminStats();
        return res.json({
            status: 'success',
            stats,
        });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return res.status(500).json({ error: err.message });
    }
});

export default creatorRouter;
