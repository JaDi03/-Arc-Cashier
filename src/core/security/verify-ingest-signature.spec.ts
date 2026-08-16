import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { verifyIngestSignature } from './verify-ingest-signature';
import coreRouter from '../routes';

const SECRET = 'test-ingest-secret';

function sign(timestamp: string, nonce: string, body: string): string {
    return crypto.createHmac('sha256', SECRET).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

function mockRes() {
    let statusCode = 200;
    let responseJson: { error?: string } | null = null;
    const res = {
        status: (code: number) => {
            statusCode = code;
            return res;
        },
        json: (data: { error?: string }) => {
            responseJson = data;
            return res;
        },
    } as unknown as Response;
    return {
        res,
        getStatus: () => statusCode,
        getJson: () => responseJson,
    };
}

function signedRequest(overrides?: {
    timestamp?: string;
    nonce?: string;
    signature?: string;
    body?: string;
    omitRawBody?: boolean;
}): Request {
    const body = overrides?.body ?? '{"userId":"email:a@b.c"}';
    const timestamp = overrides?.timestamp ?? String(Date.now());
    const nonce = overrides?.nonce ?? crypto.randomUUID();
    const signature = overrides?.signature ?? sign(timestamp, nonce, body);
    const req = {
        headers: {
            'x-tessera-timestamp': timestamp,
            'x-tessera-nonce': nonce,
            'x-tessera-signature': signature,
        },
    } as unknown as Request & { rawBody?: Buffer };
    if (!overrides?.omitRawBody) {
        req.rawBody = Buffer.from(body, 'utf8');
    }
    return req;
}

function routeHandleNames(path: string): string[] {
    const layer = (coreRouter.stack as Array<{ route?: { path?: string; stack?: Array<{ handle?: { name?: string } }> } }>)
        .find((s) => s.route && s.route.path === path);
    return (layer?.route?.stack || []).map((s) => s.handle?.name || '');
}

describe('verifyIngestSignature', () => {
    const previousSecret = process.env.TESSERA_INGEST_SECRET;

    beforeEach(() => {
        process.env.TESSERA_INGEST_SECRET = SECRET;
    });

    afterEach(() => {
        if (previousSecret === undefined) {
            delete process.env.TESSERA_INGEST_SECRET;
        } else {
            process.env.TESSERA_INGEST_SECRET = previousSecret;
        }
    });

    it('rejects when TESSERA_INGEST_SECRET is missing', () => {
        delete process.env.TESSERA_INGEST_SECRET;
        const next = vi.fn() as NextFunction;
        const { res, getStatus, getJson } = mockRes();
        verifyIngestSignature(signedRequest(), res, next);
        expect(getStatus()).toBe(500);
        expect(getJson()?.error).toContain('TESSERA_INGEST_SECRET');
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects missing signature headers or raw body', () => {
        const next = vi.fn() as NextFunction;
        const { res, getStatus, getJson } = mockRes();
        verifyIngestSignature(signedRequest({ omitRawBody: true }), res, next);
        expect(getStatus()).toBe(401);
        expect(getJson()?.error).toBe('Missing required signature headers');
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects an expired timestamp', () => {
        const next = vi.fn() as NextFunction;
        const { res, getStatus, getJson } = mockRes();
        const timestamp = String(Date.now() - 120_000);
        const nonce = crypto.randomUUID();
        const body = '{"userId":"email:a@b.c"}';
        verifyIngestSignature(signedRequest({
            timestamp,
            nonce,
            signature: sign(timestamp, nonce, body),
            body,
        }), res, next);
        expect(getStatus()).toBe(401);
        expect(getJson()?.error).toBe('Expired or invalid timestamp');
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects an invalid HMAC', () => {
        const next = vi.fn() as NextFunction;
        const { res, getStatus, getJson } = mockRes();
        verifyIngestSignature(signedRequest({ signature: '0'.repeat(64) }), res, next);
        expect(getStatus()).toBe(401);
        expect(getJson()?.error).toBe('Invalid signature');
        expect(next).not.toHaveBeenCalled();
    });

    it('calls next for a valid HMAC', () => {
        const next = vi.fn() as NextFunction;
        const { res, getStatus } = mockRes();
        verifyIngestSignature(signedRequest(), res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(getStatus()).toBe(200);
    });

    it('rejects a replayed nonce', () => {
        const nonce = crypto.randomUUID();
        const body = '{"userId":"email:a@b.c"}';
        const timestamp = String(Date.now());
        const signature = sign(timestamp, nonce, body);
        const first = mockRes();
        const second = mockRes();
        const next = vi.fn() as NextFunction;
        verifyIngestSignature(signedRequest({ timestamp, nonce, signature, body }), first.res, next);
        verifyIngestSignature(signedRequest({ timestamp, nonce, signature, body }), second.res, next);
        expect(first.getStatus()).toBe(200);
        expect(next).toHaveBeenCalledTimes(1);
        expect(second.getStatus()).toBe(401);
        expect(second.getJson()?.error).toBe('Duplicate nonce');
    });
});

describe('ingest HMAC wiring', () => {
    it('guards sessions/start and sessions/stop, not tips', () => {
        expect(routeHandleNames('/v1/sessions/start')).toContain('verifyIngestSignature');
        expect(routeHandleNames('/v1/sessions/stop')).toContain('verifyIngestSignature');
        expect(routeHandleNames('/v1/tips')).not.toContain('verifyIngestSignature');
    });
});
