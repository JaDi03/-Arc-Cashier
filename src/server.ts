import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import coreRouter from './core/routes';
import circleRouter from './core/circle-routes';
import { sessionService } from './core/session';

function resolveUiAssetsDir(): string {
    const distUi = path.join(process.cwd(), 'dist', 'ui');
    const srcUi = path.join(process.cwd(), 'src', 'ui');
    if (fs.existsSync(distUi)) return distUi;
    if (fs.existsSync(srcUi)) return srcUi;
    return path.join(__dirname, 'ui');
}

export async function createServer() {
    const app = express();

    // nginx / plugin relay sets X-Forwarded-For; required by express-rate-limit.
    app.set('trust proxy', 1);

    const QUIET_PATHS = [
        '/stream-access',
        '/session-status',
        '/session-balance',
    ];
    app.use((req, res, next) => {
        const quiet = QUIET_PATHS.some((p) => req.url.includes(p));
        if (!quiet) {
            const safeUrl = req.url.replace(
                /([?&]address=)0x[a-fA-F0-9]{40}/g,
                '$1[redacted]'
            );
            console.log(`[API] ${req.method} ${safeUrl}`);
        }
        next();
    });

    app.use(cors());

    app.use('/api/core', express.json({
        verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
            req.rawBody = buf;
        }
    }));

    app.use('/assets', express.static(resolveUiAssetsDir()));

    app.use('/api/core', coreRouter);
    app.use('/api/core', circleRouter);

    app.get('/health', async (_req, res) => {
        try {
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
        } catch {
            res.status(503).json({
                status: 'degraded',
                gateway: 'unreachable',
                activeSessions: sessionService.getActiveSessionCount()
            });
        }
    });

    return app;
}
