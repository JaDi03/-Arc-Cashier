import express from 'express';
import cors from 'cors';
import coreRouter from './core/routes';
import circleRouter from './core/circle-routes';
import instanceInfoRouter from './core/instance-info';
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

    // Trust the first proxy in the chain (nginx → PeerTube plugin relay → sidecar).
    // Required after Phase 3: all browser requests arrive via the plugin relay, which
    // causes nginx to set X-Forwarded-For. Without this, express-rate-limit throws
    // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request.
    app.set('trust proxy', 1);

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

    // 1b. Circle SDK + CCTP routes (extracted from core for separation of concerns)
    //     External paths remain unchanged: /api/core/circle/*
    app.use('/api/core', circleRouter);

    // 2. Register public Tessera identity endpoint (no auth — read by remote sidecars)
    //    Used by federated display instances to discover this sidecar's wallet and fees.
    app.use('/api/tessera', instanceInfoRouter);



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
