import { Router, type Request, type Response } from 'express';
import { formatUnits, parseUnits, pad } from 'viem';
import { statsService } from './stats';
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
} from './creator-gateway';

/**
 * Creator earnings (MetaMask / EIP-712 BurnIntent) + earnings stats.
 *   GET  /api/core/creator/balance?address=
 *   POST /api/core/creator/prepare-withdraw  { address }
 *   POST /api/core/creator/complete-withdraw { address, burnIntent, signature }
 *   GET  /api/core/creator/stats?address=
 */
const creatorRouter = Router();

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
        console.error(`[Creator] Balance fetch failed for ${address}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

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
        console.error(`[Creator] prepare-withdraw failed for ${address}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

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

    const normalizeHex = (value: string) => value.toLowerCase();
    const depositor = normalizeHex(String(burnIntent.spec.sourceDepositor));
    const signer = normalizeHex(String(burnIntent.spec.sourceSigner));
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
        console.error(`[Creator] complete-withdraw failed for ${address}:`, err.message);
        return res.status(500).json({ error: err.message });
    }
});

creatorRouter.get('/creator/stats', async (req: Request, res: Response) => {
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

export default creatorRouter;
