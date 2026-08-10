import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const REPLAY_WINDOW_MS = 60_000;

// Single shared cache across all connector instances  simpler to reason about
// than per-connector state and prevents nonce reuse even if two connectors
// share the same secret by misconfiguration.
const usedNonces = new Map<string, number>();

setInterval(() => {
    const now = Date.now();
    for (const [nonce, seenAt] of usedNonces) {
        if (now - seenAt > REPLAY_WINDOW_MS) usedNonces.delete(nonce);
    }
}, REPLAY_WINDOW_MS);

/**
 * HMAC-SHA256 authentication middleware for Tessera connectors.
 * Secret source: TESSERA_CONNECTOR_SECRET_<CONNECTOR_NAME_UPPERCASE>
 * Requires req.rawBody (Buffer) populated by server.ts before this middleware.
 *
 * Required headers: X-Tessera-Timestamp · X-Tessera-Nonce · X-Tessera-Signature
 */
export function verifyConnectorSignature(connectorName: string) {
    const envVar = `TESSERA_CONNECTOR_SECRET_${connectorName.toUpperCase()}`;

    return (req: Request, res: Response, next: NextFunction): void => {
        const secret = process.env[envVar];
        if (!secret) {
            console.error(`[Security] ${envVar} is not set — rejecting all requests to "${connectorName}".`);
            res.status(500).json({ error: `Connector "${connectorName}" is not configured with a secret` });
            return;
        }

        const timestamp = req.headers['x-tessera-timestamp'] as string | undefined;
        const nonce = req.headers['x-tessera-nonce'] as string | undefined;
        const signature = req.headers['x-tessera-signature'] as string | undefined;
        const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

        if (!timestamp || !nonce || !signature || !rawBody) {
            res.status(401).json({ error: 'Missing required signature headers' });
            return;
        }

        const ts = Number(timestamp);
        if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
            res.status(401).json({ error: 'Expired or invalid timestamp' });
            return;
        }

        if (usedNonces.has(nonce)) {
            res.status(401).json({ error: 'Duplicate nonce' });
            return;
        }

        const expected = Buffer.from(
            crypto.createHmac('sha256', secret)
                .update(`${timestamp}.${nonce}.${rawBody.toString('utf8')}`)
                .digest('hex'),
            'utf8'
        );
        const provided = Buffer.from(signature, 'utf8');

        if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
            res.status(401).json({ error: 'Invalid signature' });
            return;
        }

        // Mark nonce used only after all checks pass  never consume replay budget on a rejection.
        usedNonces.set(nonce, ts);
        next();
    };
}
