import express from 'express';
import path from 'path';
import peertubeRouter from './webhooks';
import type { Connector, ConnectorConfig } from '../../core/types';

/**
 * PeerTube Connector
 *
 * Integrates with PeerTube via a custom plugin.
 * The PeerTube plugin sends signed webhooks to this connector, which
 * translates them into sessionService.recordJoin() / recordPartAndSettle() calls.
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

        // 2. Register webhook handler
        app.use('/api/connectors/peertube', peertubeRouter);

        // Note: No proxy injection needed. The PeerTube plugin handles UI embedding directly.
    },
};

export default peertubeConnector;
