import express from 'express';
import cors from 'cors';
import path from 'path';
import coreRouter from './core/routes';
import { sessionService } from './core/session';
import type { Connector, ConnectorConfig } from './core/types';

/**
 * Connector Registry
 * Maps connector names to their module paths.
 * When adding a new connector, register it here.
 */
const CONNECTOR_REGISTRY: Record<string, () => Promise<{ default: Connector }>> = {
    owncast: () => import('./connectors/owncast'),
    peertube: () => import('./connectors/peertube'),
};

export async function createServer(connectors: ConnectorConfig[]) {
    const app = express();

    // Logging middleware MUST be first to catch everything
    app.use((req, res, next) => {
        if (req.url.includes('/stream-access')) {
            console.log(`[API] ${req.method} ${req.url} | Headers: ${JSON.stringify(req.headers)}`);
            const originalJson = res.json;
            res.json = function (body) {
                console.log(`[API-DEBUG] Response (Status ${res.statusCode}):`, JSON.stringify(body));
                return originalJson.call(this, body);
            };
        } else {
            console.log(`[API] ${req.method} ${req.url}`);
        }
        next();
    });

    // Base middlewares
    app.use(cors());

    // Only parse JSON for our own API routes, NOT globally
    app.use('/api/core', express.json());
    // Attach rawBody for connectors (required for PeerTube HMAC signature verification)
    app.use('/api/connectors', express.json({
        verify: (req: any, res, buf) => {
            req.rawBody = buf;
        }
    }));

    // 1. Register Core Engine routes (agnostic to platforms)
    app.use('/api/core', coreRouter);



    // 3. Dynamically load and register connectors from config
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
    app.get('/health', async (req, res) => {
        try {
            // Basic connectivity check to Circle API (with 3 second timeout)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            
            const gatewayHealth = await fetch('https://api-testnet.circle.com/ping', { 
                signal: controller.signal 
            }).catch(() => ({ ok: false }));
            
            clearTimeout(timeoutId);

            res.json({ 
                status: 'healthy', 
                version: '1.0.0',
                gateway: gatewayHealth.ok ? 'connected' : 'degraded',
                activeSessions: sessionService.getActiveSessionCount(),
            });
        } catch (error) {
            res.status(503).json({ 
                status: 'degraded', 
                gateway: 'unreachable',
                activeSessions: sessionService.getActiveSessionCount()
            });
        }
    });

    return app;
}
