import express from 'express';
import path from 'path';
import owncastRouter from './webhooks';
import { setupOwncastProxy } from './proxy';
import type { Connector, ConnectorConfig } from '../../core/types';

/**
 * Owncast Connector
 * 
 * Integrates with Owncast's webhook system to enable per-second billing.
 * Owncast emits USER_JOINED and USER_PARTED webhooks which this connector
 * translates into sessionService.recordJoin() / recordPartAndSettle() calls.
 * 
 * The connector also:
 * - Serves the paywall frontend assets (paywall.js, paywall.css)
 * - Sets up a reverse proxy that injects the paywall into Owncast's HTML
 */
const owncastConnector: Connector = {
    name: 'Owncast',

    register(app: express.Express, config: ConnectorConfig): void {
        // 1. Serve static paywall assets
        app.use('/owncast-assets', express.static(path.join(__dirname, 'public')));

        // 2. Register webhook handler
        app.use('/api/connectors/owncast', owncastRouter);

        // 3. Setup reverse proxy to Owncast (injects paywall.js into HTML)
        setupOwncastProxy(app, config.upstreamUrl);
    },
};

export default owncastConnector;
