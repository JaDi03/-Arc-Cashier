import { Router, type Express } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { isAddress } from 'viem';
import { verifyConnectorSignature } from '../core/security/verify-connector-signature';
import type { Connector, ConnectorConfig, Split } from '../core/types';
import peertubeAdminRouter from './peertube-admin-routes';

const CONNECTOR_NAME = 'peertube';
const CORE_PORT = process.env.PORT || '7878';
const CORE_BASE_URL = `http://localhost:${CORE_PORT}`;

/** Docker image has dist/ui (Dockerfile copies it); local npm start may only have src/ui. */
function resolveUiAssetsDir(): string {
    const distUi = path.join(process.cwd(), 'dist', 'ui');
    const srcUi = path.join(process.cwd(), 'src', 'ui');
    if (fs.existsSync(distUi)) return distUi;
    if (fs.existsSync(srcUi)) return srcUi;
    return path.join(__dirname, '..', 'ui');
}

interface PeerTubeWebhookPayload {
    event?: 'viewer_joined' | 'viewer_left';
    userId?: string;
    videoId?: string;
    instanceUrl?: string;
    ratePerSecond?: number;
    creatorAddress?: string;
    creatorWallet?: string;
    tesseraMode?: 'free' | 'pay-per-second';
    adminWallet?: string;
    displayFee?: number;
    originFee?: number;
    originInstanceUrl?: string;
    isLocal?: boolean;
}

/**
 * Queries the remote PeerTube instance's Tessera plugin to get its admin
 * wallet and origin fee, returning a Split. Returns null on any failure
 * (missing plugin, network error, invalid wallet) — the local creator then
 * keeps 100% of the remainder.
 */
async function resolveFederationOriginSplit(originInstanceUrl: string): Promise<Split | null> {
    try {
        const pluginInfoRes = await fetch(
            `${originInstanceUrl}/api/v1/plugins/peertube-plugin-tessera`,
            { signal: AbortSignal.timeout(3000) }
        );
        if (!pluginInfoRes.ok) {
            console.log(`[PeerTube] Remote ${originInstanceUrl} has no Tessera plugin (HTTP ${pluginInfoRes.status}). Origin split skipped.`);
            return null;
        }

        const pluginInfo = await pluginInfoRes.json() as { plugin?: { version?: string }, version?: string };
        const version = pluginInfo?.plugin?.version ?? pluginInfo?.version;
        if (!version) return null;

        const infoRes = await fetch(
            `${originInstanceUrl}/plugins/peertube-plugin-tessera/${version}/router/instance-info`,
            { signal: AbortSignal.timeout(3000) }
        );
        if (!infoRes.ok) return null;

        const remoteData = await infoRes.json() as { adminWallet?: string; originFee?: number };
        if (!remoteData.adminWallet || !isAddress(remoteData.adminWallet)) return null;

        const originFee = remoteData.originFee !== undefined ? Number(remoteData.originFee) : 0.10;
        console.log(`[PeerTube] Federated origin: wallet ${remoteData.adminWallet} | originFee ${originFee}`);

        return {
            address: remoteData.adminWallet.trim(),
            fraction: originFee,
            label: 'host',
        };
    } catch (err) {
        console.warn(`[PeerTube] Federation lookup failed for ${originInstanceUrl}:`, err instanceof Error ? err.message : String(err));
        return null;
    }
}

const peertubeConnector: Connector = {
    name: 'PeerTube',

    register(app: Express, config: ConnectorConfig): void {
        // Bridge legacy env so existing installs keep working after flatten.
        if (!process.env.TESSERA_CONNECTOR_SECRET_PEERTUBE && process.env.PEERTUBE_WEBHOOK_SECRET) {
            process.env.TESSERA_CONNECTOR_SECRET_PEERTUBE = process.env.PEERTUBE_WEBHOOK_SECRET;
            console.log('[PeerTube] Bridged PEERTUBE_WEBHOOK_SECRET → TESSERA_CONNECTOR_SECRET_PEERTUBE');
        }

        const uiDir = resolveUiAssetsDir();
        console.log(`[PeerTube] Serving UI assets from ${uiDir}`);
        app.use('/peertube-assets', express.static(uiDir));

        // Webhook only: Tessera HMAC on POST /webhook.
        // Do not router.use(HMAC) here: Express still enters this router for
        // /admin/* and /creator/stats and would reject Bearer-only plugin calls.
        const webhookRouter = Router();

        webhookRouter.post('/webhook', verifyConnectorSignature(CONNECTOR_NAME), async (req, res) => {
            const payload = req.body as PeerTubeWebhookPayload;

            if (!payload.event || !payload.userId) {
                return res.status(400).json({ error: 'Missing required fields: event, userId' });
            }

            if (payload.event === 'viewer_joined') {
                if (payload.tesseraMode === 'free') {
                    console.log(`[PeerTube] Free video for user ${payload.userId}. Skipping billing.`);
                    return res.json({ status: 'ok', billed: false });
                }

                const resolvedCreatorAddress = (payload.creatorAddress || payload.creatorWallet || '').trim();
                if (!resolvedCreatorAddress || !isAddress(resolvedCreatorAddress)) {
                    console.warn(`[PeerTube] Invalid or missing creator wallet for user ${payload.userId}`);
                    return res.status(400).json({ error: 'Missing or invalid creatorAddress/creatorWallet' });
                }

                const splits: Split[] = [];

                const displayAdminAddress = payload.adminWallet || process.env.TESSERA_ADMIN_WALLET || process.env.SELLER_ADDRESS;
                if (displayAdminAddress && isAddress(displayAdminAddress)) {
                    splits.push({
                        address: displayAdminAddress,
                        fraction: payload.displayFee !== undefined ? Number(payload.displayFee) : Number(process.env.TESSERA_DISPLAY_FEE || 0.10),
                        label: 'display',
                    });
                }

                if (payload.isLocal === false && payload.originInstanceUrl) {
                    console.log(`[PeerTube] Federated play from: ${payload.originInstanceUrl}. Looking up remote plugin...`);
                    const originSplit = await resolveFederationOriginSplit(payload.originInstanceUrl);
                    if (originSplit) splits.push(originSplit);
                }

                const rate = payload.ratePerSecond !== undefined ? Number(payload.ratePerSecond) : (config.ratePerSecond ?? 0.0001);

                console.log(`[PeerTube] Starting session for user: ${payload.userId}. Payee: ${resolvedCreatorAddress}`);

                const startRes = await fetch(`${CORE_BASE_URL}/api/core/v1/sessions/start`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: payload.userId,
                        resourceId: payload.videoId || 'unknown',
                        ratePerSecond: rate.toString(),
                        payoutAddress: resolvedCreatorAddress,
                        splits,
                        metadata: payload.instanceUrl ? { instanceUrl: payload.instanceUrl } : undefined,
                    }),
                });

                if (!startRes.ok) {
                    const errBody = await startRes.json().catch(() => ({}));
                    console.error(`[PeerTube] Core rejected session start:`, errBody);
                    return res.status(502).json({ error: 'Core rejected session start' });
                }
            } else if (payload.event === 'viewer_left') {
                fetch(`${CORE_BASE_URL}/api/core/v1/sessions/stop`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: payload.userId }),
                }).catch((err) => console.error(`[PeerTube] Failed to stop session for ${payload.userId}:`, err));
            } else {
                console.warn(`[PeerTube] Unknown event received: ${payload.event}`);
            }

            return res.json({ status: 'ok' });
        });

        app.use(`/api/connectors/${CONNECTOR_NAME}`, webhookRouter);
        // Admin + creator/stats: Bearer auth (no Tessera HMAC middleware)
        app.use(`/api/connectors/${CONNECTOR_NAME}`, peertubeAdminRouter);
    },
};

export default peertubeConnector;
