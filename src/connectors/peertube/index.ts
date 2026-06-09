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
 * DOES NOT require a reverse proxy to inject the paywall UI. It simply
 * serves the paywall assets so the plugin can embed them.
 */
const peertubeConnector: Connector = {
    name: 'PeerTube',

    register(app: express.Express, config: ConnectorConfig): void {
        // 1. Serve static paywall assets for the PeerTube plugin to consume
        // Using the same public assets directory structure as Owncast for reuse
        const owncastPublicPath = path.join(__dirname, '..', 'owncast', 'public');
        app.use('/peertube-assets', express.static(owncastPublicPath));

        // 2. Register webhook handler
        app.use('/api/connectors/peertube', peertubeRouter);
        
        // Note: No proxy injection needed. The proxy is marked as (Optional) in the guide.
    },
};

export default peertubeConnector;
