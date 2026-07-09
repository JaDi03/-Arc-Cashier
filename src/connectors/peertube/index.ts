import express from 'express';
import path from 'path';
import peertubeRouter from './webhooks';
import creatorRouter from './creator-routes';
import type { Connector, ConnectorConfig } from '../../core/types';

/**
 * PeerTube Connector
 *
 * Integrates with PeerTube via a custom plugin.
 * The PeerTube plugin sends signed webhooks to this connector, which
 * translates them into sessionService.recordJoin() / recordPartAndSettle() calls.
 *
 * Platform-specific logic that does NOT belong in the core lives here:
 *   - Platform fee split (deterministic tick-based routing: creator vs. admin wallet)
 *   - Creator balance queries and MetaMask-signed withdrawals (EIP-712 BurnIntent)
 *   - Admin/seller balance and withdrawal (PEERTUBE_WEBHOOK_SECRET protected)
 *
 * Unlike Owncast, PeerTube natively supports plugins, so this connector
 * does NOT require a reverse proxy. It simply serves the shared paywall
 * UI assets from src/ui/ so the PeerTube plugin can embed them.
 */
const peertubeConnector: Connector = {
    name: 'PeerTube',

    register(app: express.Express, config: ConnectorConfig): void {
        // 1. Serve shared paywall UI assets from the platform-agnostic src/ui/ directory
        app.use('/peertube-assets', express.static(path.join(__dirname, '..', '..', 'ui')));

        // 2. Register webhook handler (viewer_joined / viewer_left)
        app.use('/api/connectors/peertube', peertubeRouter);

        // 3. Register PeerTube-specific creator & seller routes
        //    These were previously (incorrectly) in the core.
        //    Endpoints: /api/connectors/peertube/creator/* and /api/connectors/peertube/seller/*
        app.use('/api/connectors/peertube', creatorRouter);

        // Note: No proxy injection needed. The PeerTube plugin handles UI embedding directly.
    },
};

export default peertubeConnector;
