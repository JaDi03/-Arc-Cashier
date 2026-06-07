import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import coreRouter from './core/routes';
import type { Connector, ConnectorConfig } from './core/types';

/**
 * Connector Registry
 * Maps connector names to their module paths.
 * When adding a new connector, register it here.
 */
const CONNECTOR_REGISTRY: Record<string, () => Promise<{ default: Connector }>> = {
    owncast: () => import('./connectors/owncast'),
};

export async function createServer(connectors: ConnectorConfig[]) {
    const app = express();

    // Logging middleware MUST be first to catch everything
    app.use((req, res, next) => {
        console.log(`[API] ${req.method} ${req.url}`);
        next();
    });

    // Base middlewares
    app.use(cors());

    // Only parse JSON for our own API routes, NOT globally
    app.use('/api/core', bodyParser.json());
    app.use('/api/connectors', bodyParser.json());

    // 1. Register Core Engine routes (agnostic to platforms)
    app.use('/api/core', coreRouter);

    // 2. Dynamically load and register connectors from config
    for (const config of connectors) {
        const loader = CONNECTOR_REGISTRY[config.name];
        if (!loader) {
            console.error(`[Engine] ❌ Unknown connector: "${config.name}". Skipping.`);
            continue;
        }

        try {
            const module = await loader();
            const connector = module.default;
            connector.register(app, config);
            console.log(`[Engine] 🔌 Connector "${connector.name}" registered (upstream: ${config.upstreamUrl})`);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            console.error(`[Engine] ❌ Failed to load connector "${config.name}":`, err.message);
        }
    }

    // Healthcheck
    app.get('/health', (req, res) => {
        res.json({ status: 'healthy', version: '1.0.0' });
    });

    return app;
}
