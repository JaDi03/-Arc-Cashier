import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const REPLAY_WINDOW_MS = 60_000;
const usedNonces = new Map<string, number>();

setInterval(() => {
    const now = Date.now();
    for (const [nonce, seenAt] of usedNonces) {
        if (now - seenAt > REPLAY_WINDOW_MS) usedNonces.delete(nonce);
    }
}, REPLAY_WINDOW_MS);

/**
 * HMAC-SHA256 for POST /api/core/v1/sessions/start|stop.
 * Env: TESSERA_INGEST_SECRET
 * Headers: X-Tessera-Timestamp, X-Tessera-Nonce, X-Tessera-Signature
 * Payload: `${timestamp}.${nonce}.${rawBody}`
 */
export function verifyIngestSignature(req: Request, res: Response, next: NextFunction): void {
    const secret = process.env.TESSERA_INGEST_SECRET;
    if (!secret) {
        console.error('[Security] TESSERA_INGEST_SECRET is not set — rejecting ingest requests.');
        res.status(500).json({ error: 'Ingest is not configured (TESSERA_INGEST_SECRET missing)' });
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

    usedNonces.set(nonce, ts);
    next();
}
