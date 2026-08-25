/**
 * HMAC-signed client for the Tessera Core ingest routes
 * (POST /api/core/v1/sessions/start and /sessions/stop).
 *
 * The signature scheme mirrors src/core/security/verify-ingest-signature.ts
 * exactly: hex HMAC-SHA256 over `${timestamp}.${nonce}.${rawBody}` with the
 * shared ingest secret, sent as X-Tessera-* headers.
 */

import crypto from 'crypto';
import type { StartSessionRequest, StopSessionRequest } from '../core/types';

export class TesseraIngestClient {
    private readonly baseUrl: string;
    private readonly secret: string;

    constructor(baseUrl: string, ingestSecret: string) {
        if (!baseUrl) throw new Error('tesseraBaseUrl is required');
        if (!ingestSecret) throw new Error('ingestSecret is required');
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.secret = ingestSecret;
    }

    /** Computes the exact signature the sidecar verifier expects. */
    static sign(secret: string, timestamp: string, nonce: string, rawBody: string): string {
        return crypto
            .createHmac('sha256', secret)
            .update(`${timestamp}.${nonce}.${rawBody}`)
            .digest('hex');
    }

    private async post(path: string, payload: Record<string, unknown>): Promise<unknown> {
        const rawBody = JSON.stringify(payload);
        const timestamp = String(Date.now());
        const nonce = crypto.randomUUID();
        const signature = TesseraIngestClient.sign(this.secret, timestamp, nonce, rawBody);

        const res = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Tessera-Timestamp': timestamp,
                'X-Tessera-Nonce': nonce,
                'X-Tessera-Signature': signature,
            },
            body: rawBody,
        });

        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Tessera ingest ${path} failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
        }
        return res.json();
    }

    async startSession(req: StartSessionRequest): Promise<unknown> {
        return this.post('/api/core/v1/sessions/start', req as unknown as Record<string, unknown>);
    }

    async stopSession(req: StopSessionRequest): Promise<unknown> {
        return this.post('/api/core/v1/sessions/stop', req as unknown as Record<string, unknown>);
    }
}
