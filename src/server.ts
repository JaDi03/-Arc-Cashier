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

    // Base middlewares
    app.use(cors());
    app.use(bodyParser.json());

    // Logging middleware
    app.use((req, res, next) => {
        console.log(`[API] ${req.method} ${req.url}`);
        next();
    });

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
        } catch (error: any) {
            console.error(`[Engine] ❌ Failed to load connector "${config.name}":`, error.message);
        }
    }

    // Healthcheck
    app.get('/health', (req, res) => {
        res.json({ status: 'healthy', version: '1.0.0' });
    });

    return app;
}
