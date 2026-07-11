import { describe, it, expect, beforeEach, vi } from 'vitest';
import peertubeRouter from './webhooks';
import { sessionService } from '../../core/session';
import { Request, Response } from 'express';
import crypto from 'crypto';

process.env.PEERTUBE_WEBHOOK_SECRET = 'test-secret';

describe('PeerTube Webhook Rate Billing', () => {
    let webhookHandler: any;

    beforeEach(() => {
        vi.clearAllMocks();
        // Find the POST /webhook handler in the router stack
        const layer = peertubeRouter.stack.find(s => s.route && s.route.path === '/webhook');
        webhookHandler = layer?.route?.stack[layer.route.stack.length - 1]?.handle;
    });

    const createMockReqRes = (payload: Record<string, any>) => {
        const rawBody = Buffer.from(JSON.stringify(payload));
        const signature = crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');

        const req = {
            headers: {
                'x-peertube-signature': signature,
            },
            rawBody,
            ip: '127.0.0.1',
        } as unknown as Request;

        let statusCode = 200;
        const res = {
            status: (code: number) => {
                statusCode = code;
                return res;
            },
            json: () => res,
        } as unknown as Response;

        return { req, res };
    };

    it('verifies that ratePerSecond = 0 (free video) does not start a billing loop', async () => {
        const spyJoin = vi.spyOn(sessionService, 'recordJoin').mockImplementation(() => {});

        const { req, res } = createMockReqRes({
            event: 'viewer_joined',
            userId: 'user_free_rate_test',
            videoId: 'video123',
            instanceUrl: 'http://localhost:9000',
            ratePerSecond: 0,
            timestamp: Date.now(),
            nonce: 'nonce-' + Math.random(),
            creatorAddress: '0x1234567890123456789012345678901234567890',
        });

        await webhookHandler(req, res);

        // It should NOT call recordJoin
        expect(spyJoin).not.toHaveBeenCalled();
    });

    it('verifies that tesseraMode = free (even with a non-zero rate) does not start a billing loop', async () => {
        const spyJoin = vi.spyOn(sessionService, 'recordJoin').mockImplementation(() => {});

        const { req, res } = createMockReqRes({
            event: 'viewer_joined',
            userId: 'user_free_mode_test',
            videoId: 'video123',
            instanceUrl: 'http://localhost:9000',
            ratePerSecond: 0.001, // fallback rate sent by older plugin versions
            tesseraMode: 'free',
            timestamp: Date.now(),
            nonce: 'nonce-' + Math.random(),
            creatorAddress: '0x1234567890123456789012345678901234567890',
        });

        await webhookHandler(req, res);

        // It should NOT call recordJoin
        expect(spyJoin).not.toHaveBeenCalled();
    });

    it('verifies that pay-per-second mode with a valid rate correctly starts the billing loop', async () => {
        const spyJoin = vi.spyOn(sessionService, 'recordJoin').mockImplementation(() => {});

        const { req, res } = createMockReqRes({
            event: 'viewer_joined',
            userId: 'user_premium_test',
            videoId: 'video123',
            instanceUrl: 'http://localhost:9000',
            ratePerSecond: 0.0002,
            tesseraMode: 'pay-per-second',
            timestamp: Date.now(),
            nonce: 'nonce-' + Math.random(),
            creatorAddress: '0x1234567890123456789012345678901234567890',
        });

        await webhookHandler(req, res);

        // It SHOULD call recordJoin with correct rate 0.0002
        expect(spyJoin).toHaveBeenCalled();
        const callArgs = spyJoin.mock.calls[0];
        expect(callArgs[2]).toBe(0.0002);
    });
});
