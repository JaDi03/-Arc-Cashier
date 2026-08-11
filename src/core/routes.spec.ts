import { describe, it, expect, beforeEach, vi } from 'vitest';
import coreRouter from './routes';
import { statsService } from './stats';
import { walletService } from './wallet';
import * as circleRoutes from './circle-routes';
import { Request, Response } from 'express';

function mockRes() {
    let statusCode = 200;
    let responseJson: any = null;
    const res = {
        status: (code: number) => {
            statusCode = code;
            return res;
        },
        json: (data: any) => {
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

function getRouteHandler(path: string) {
    const layer = coreRouter.stack.find((s: any) => s.route && s.route.path === path);
    // Last handle is the route handler (after rate-limit middleware).
    return layer?.route?.stack[layer.route.stack.length - 1]?.handle;
}

describe('Stream Access Endpoint', () => {
    let successHandler: any;

    beforeEach(() => {
        vi.clearAllMocks();
        const layer = coreRouter.stack.find(s => s.route && s.route.path === '/stream-access');
        successHandler = layer?.route?.stack[layer.route.stack.length - 1]?.handle;
    });

    it('should call statsService.recordPayment on success callback with headers and payment info', () => {
        const spyRecord = vi.spyOn(statsService, 'recordPayment').mockImplementation(() => {});

        const req = {
            headers: {
                'x-user-id': 'user_123',
                'x-seller-address': '0xSeller',
            },
            payment: {
                payer: '0xPayer',
                // x402 parsePrice: $0.0005 → 500 micro-USDC
                amount: 500,
            }
        } as unknown as Request;

        const res = {
            json: vi.fn(),
        } as unknown as Response;

        successHandler(req, res);

        expect(spyRecord).toHaveBeenCalledWith('user_123', '0xSeller', 0.0005);
        expect(res.json).toHaveBeenCalledWith({
            access: true,
            payment: (req as any).payment,
        });
    });

    it('should still return access true when recordPayment throws after settle', () => {
        vi.spyOn(statsService, 'recordPayment').mockImplementation(() => {
            throw new TypeError("Cannot read properties of undefined (reading '0xseller')");
        });

        const req = {
            headers: {
                'x-user-id': 'user_123',
                'x-seller-address': '0xSeller',
            },
            payment: {
                payer: '0xPayer',
                amount: 100,
            }
        } as unknown as Request;

        const res = {
            json: vi.fn(),
        } as unknown as Response;

        expect(() => successHandler(req, res)).not.toThrow();
        expect(res.json).toHaveBeenCalledWith({
            access: true,
            payment: (req as any).payment,
        });
    });
});

describe('sync-session Endpoint', () => {
    const returnAddress = '0x1111222233334444555566667777888899990000';
    const privateKey = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
    let handler: any;

    beforeEach(() => {
        vi.clearAllMocks();
        handler = getRouteHandler('/sync-session');
    });

    it('rejects missing fields', async () => {
        const { res, getStatus, getJson } = mockRes();
        await handler({ body: {} } as Request, res);
        expect(getStatus()).toBe(400);
        expect(getJson().error).toMatch(/Missing/);
    });

    it('rejects when Circle ownership fails', async () => {
        vi.spyOn(circleRoutes, 'verifyCircleWalletOwnership').mockResolvedValue('unauthorized');
        const { res, getStatus } = mockRes();
        await handler({
            body: {
                userId: 'social:abc',
                userToken: 'x'.repeat(40),
                returnAddress,
            },
        } as Request, res);
        expect(getStatus()).toBe(401);
    });

    it('rejects when no session exists', async () => {
        vi.spyOn(circleRoutes, 'verifyCircleWalletOwnership').mockResolvedValue('ok');
        vi.spyOn(walletService, 'hasSessionRecord').mockReturnValue(false);
        const { res, getStatus } = mockRes();
        await handler({
            body: {
                userId: 'social:abc',
                userToken: 'x'.repeat(40),
                returnAddress,
            },
        } as Request, res);
        expect(getStatus()).toBe(404);
    });

    it('rejects returnAddress mismatch against stored session', async () => {
        vi.spyOn(circleRoutes, 'verifyCircleWalletOwnership').mockResolvedValue('ok');
        vi.spyOn(walletService, 'hasSessionRecord').mockReturnValue(true);
        vi.spyOn(walletService, 'getSessionRecord').mockReturnValue({
            privateKey,
            returnAddress: '0x9999999999999999999999999999999999999999',
        } as any);
        const { res, getStatus } = mockRes();
        await handler({
            body: {
                userId: 'social:abc',
                userToken: 'x'.repeat(40),
                returnAddress,
            },
        } as Request, res);
        expect(getStatus()).toBe(401);
    });

    it('returns canonical privateKey after Circle ownership proof', async () => {
        vi.spyOn(circleRoutes, 'verifyCircleWalletOwnership').mockResolvedValue('ok');
        vi.spyOn(walletService, 'hasSessionRecord').mockReturnValue(true);
        vi.spyOn(walletService, 'getSessionRecord').mockReturnValue({
            privateKey,
            returnAddress,
        } as any);
        const { res, getStatus, getJson } = mockRes();
        await handler({
            body: {
                userId: 'social:abc',
                userToken: 'x'.repeat(40),
                returnAddress,
            },
        } as Request, res);
        expect(getStatus()).toBe(200);
        expect(getJson()).toEqual({ status: 'synced', privateKey });
    });
});
