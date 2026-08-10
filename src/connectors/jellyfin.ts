import { Router, type Express } from 'express';
import express from 'express';
import path from 'path';
import { isAddress } from 'viem';
import { verifyConnectorSignature } from '../core/security/verify-connector-signature';
import type { Connector, ConnectorConfig, Split } from '../core/types';

const CONNECTOR_NAME = 'jellyfin';
const CORE_PORT = process.env.PORT || '7878';
const CORE_BASE_URL = `http://localhost:${CORE_PORT}`;

interface JellyfinWebhookNotification {
    NotificationType?: string;
    Event?: string;
    PlaySessionId?: string;
    Id?: string;
    ItemId?: string;
    DeviceId?: string;
    UserId?: string;
    User?: { Id?: string };
    Item?: { Name?: string; Tags?: string[] };
    Session?: { Id?: string; PlayState?: { IsPaused?: boolean } };
    ratePerSecond?: number;
    creatorAddress?: string;
    creatorWallet?: string;
    tesseraMode?: 'free' | 'pay-per-second';
    tags?: string[];
}

const jellyfinConnector: Connector = {
    name: 'Jellyfin',

    register(app: Express, config: ConnectorConfig): void {
        app.use('/jellyfin-assets', express.static(path.join(__dirname, '..', 'ui')));

        const router = Router();
        router.use(verifyConnectorSignature(CONNECTOR_NAME));

        router.post('/webhook', async (req, res) => {
            const body = req.body as JellyfinWebhookNotification;

            const notificationType = body.NotificationType || body.Event;
            const playSessionId = body.PlaySessionId
                || body.Session?.Id
                || body.Id
                || (body.DeviceId ? `${body.UserId}-${body.DeviceId}` : undefined);
            const userId = body.UserId || body.User?.Id;
            const itemId = body.ItemId || body.Id || 'unknown';
            const itemName = body.Item?.Name || 'Jellyfin Media';
            const tags = body.tags || body.Item?.Tags || [];

            if (!playSessionId || !userId) {
                return res.status(400).json({ error: 'Missing required playSessionId or userId' });
            }

            const sessionId = `jellyfin-${playSessionId}`;

            switch (notificationType) {
                case 'PlaybackStart': {
                    const isFree = body.tesseraMode === 'free'
                        || tags.includes('tessera:free')
                        || tags.includes('tessera-free');

                    if (isFree) {
                        console.log(`[Jellyfin] Free video PlaybackStart — session: ${sessionId}, item: "${itemName}"`);
                        return res.json({ status: 'ok', event: 'PlaybackStart', sessionId, billed: false });
                    }

                    const resolvedCreatorAddress = (
                        body.creatorAddress
                        || body.creatorWallet
                        || process.env.TESSERA_CREATOR_WALLET
                        || process.env.SELLER_ADDRESS
                        || ''
                    ).trim();

                    if (!resolvedCreatorAddress || !isAddress(resolvedCreatorAddress)) {
                        console.warn(`[Jellyfin] Missing or invalid creator wallet for session ${sessionId}`);
                        return res.status(400).json({ error: 'Missing or invalid creatorAddress/creatorWallet' });
                    }

                    const splits: Split[] = [];
                    const displayAdminAddress = process.env.TESSERA_ADMIN_WALLET || process.env.SELLER_ADDRESS;
                    if (displayAdminAddress && isAddress(displayAdminAddress) && displayAdminAddress.toLowerCase() !== resolvedCreatorAddress.toLowerCase()) {
                        splits.push({
                            address: displayAdminAddress,
                            fraction: Number(process.env.TESSERA_DISPLAY_FEE || 0.10),
                            label: 'display-admin',
                        });
                    }

                    const rate = body.ratePerSecond !== undefined
                        ? Number(body.ratePerSecond)
                        : (config.ratePerSecond ?? 0.0001);

                    console.log(`[Jellyfin] Starting session: ${sessionId} for user: ${userId}, item: "${itemName}"`);

                    const startRes = await fetch(`${CORE_BASE_URL}/api/core/v1/sessions/start`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            userId,
                            resourceId: itemId,
                            ratePerSecond: rate.toString(),
                            payoutAddress: resolvedCreatorAddress,
                            splits,
                            metadata: { itemName, sessionId },
                        }),
                    });

                    if (!startRes.ok) {
                        const errBody = await startRes.json().catch(() => ({}));
                        console.error(`[Jellyfin] Core rejected session start:`, errBody);
                        return res.status(502).json({ error: 'Core rejected session start' });
                    }

                    return res.json({ status: 'ok', event: 'PlaybackStart', sessionId, billed: true });
                }

                case 'PlaybackProgress': {
                    const isPaused = body.Session?.PlayState?.IsPaused ?? false;
                    console.log(`[Jellyfin] PlaybackProgress — session: ${sessionId}, paused: ${isPaused}`);
                    return res.json({ status: 'ok', event: 'PlaybackProgress', isPaused });
                }

                case 'PlaybackStop': {
                    console.log(`[Jellyfin] PlaybackStop — stopping session for user: ${userId}`);

                    fetch(`${CORE_BASE_URL}/api/core/v1/sessions/stop`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId }),
                    }).catch((err) => console.error(`[Jellyfin] Failed to stop session for ${userId}:`, err));

                    return res.json({ status: 'ok', event: 'PlaybackStop' });
                }

                default: {
                    console.log(`[Jellyfin] Event ignored: ${notificationType}`);
                    return res.json({ status: 'ignored', notificationType });
                }
            }
        });

        app.use(`/api/connectors/${CONNECTOR_NAME}`, router);
    },
};

export default jellyfinConnector;
