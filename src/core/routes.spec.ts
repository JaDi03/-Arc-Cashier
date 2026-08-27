import { describe, it, expect, beforeEach, vi } from 'vitest';
import instanceInfoRouter from './instance-info';
import coreRouter from './routes';
import { statsService } from './stats';
import { walletService } from './wallet';
import { sessionService } from './session';
import * as circleRoutes from './circle-routes';
import { Request, Response } from 'express';
import * as fs from 'fs';

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        existsSync: vi.fn(),
        readFileSync: vi.fn(),
    };
});

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

describe('Instance Info Endpoint', () => {
    let handler: any;

    beforeEach(() => {
        vi.clearAllMocks();
        const layer = instanceInfoRouter.stack.find(s => s.route && s.route.path === '/instance-info');
        handler = layer?.route?.stack[layer.route.stack.length - 1]?.handle;
    });

    it('should return 503 if no admin wallet is configured anywhere', async () => {
        vi.spyOn(fs, 'existsSync').mockReturnValue(false);
        delete process.env.TESSERA_ADMIN_WALLET;
        delete process.env.SELLER_ADDRESS;

        const req = {} as unknown as Request;
        let statusCode = 0;
        let responseJson: any = null;
        const res = {
            status: (code: number) => {
                statusCode = code;
                return res;
            },
            json: (data: any) => {
                responseJson = data;
                return res;
            }
        } as unknown as Response;

        await handler(req, res);
        expect(statusCode).toBe(503);
        expect(responseJson.error).toContain('Admin wallet address is missing');
    });

    it('should return settings from JSON file if it exists', async () => {
        vi.spyOn(fs, 'existsSync').mockReturnValue(true);
        vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
            adminWallet: '0x1111222233334444555566667777888899990000',
            displayFee: 0.20,
            originFee: 0.10
        }));

        const req = {} as unknown as Request;
        let responseJson: any = null;
        const res = {
            json: (data: any) => {
                responseJson = data;
                return res;
            }
        } as unknown as Response;

        await handler(req, res);
        expect(responseJson.adminWallet).toBe('0x1111222233334444555566667777888899990000');
        expect(responseJson.displayFee).toBe(0.20);
        expect(responseJson.originFee).toBe(0.10);
    });

    it('should fallback to env variables if JSON file does not exist', async () => {
        vi.spyOn(fs, 'existsSync').mockReturnValue(false);
        process.env.TESSERA_ADMIN_WALLET = '0x9999999999999999999999999999999999999999';
        process.env.TESSERA_DISPLAY_FEE = '0.30';

        const req = {} as unknown as Request;
        let responseJson: any = null;
        const res = {
            json: (data: any) => {
                responseJson = data;
                return res;
            }
        } as unknown as Response;

        await handler(req, res);
        expect(responseJson.adminWallet).toBe('0x9999999999999999999999999999999999999999');
        expect(responseJson.displayFee).toBe(0.30);
    });
});

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

describe('POST /v1/tips', () => {
    const returnAddress = '0x1111222233334444555566667777888899990000';
    const payoutAddress = '0x2222333344445555666677778888999900001111';
    const privateKey = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
    const tipBody = {
        userId: 'social:abc',
        payoutAddress,
        amount: '0.100000',
        userToken: 'x'.repeat(40),
        returnAddress,
    };
    let handler: any;

    beforeEach(() => {
        vi.clearAllMocks();
        handler = getRouteHandler('/v1/tips');
    });

    it('rejects missing Circle proof fields', async () => {
        const { res, getStatus, getJson } = mockRes();
        await handler({
            body: { userId: 'social:abc', payoutAddress, amount: '0.100000' },
        } as Request, res);
        expect(getStatus()).toBe(400);
        expect(getJson().error).toMatch(/Missing/);
    });

    it('rejects when Circle ownership fails', async () => {
        vi.spyOn(circleRoutes, 'verifyCircleWalletOwnership').mockResolvedValue('unauthorized');
        const { res, getStatus } = mockRes();
        await handler({ body: tipBody } as Request, res);
        expect(getStatus()).toBe(401);
    });

    it('rejects when no Gateway session exists', async () => {
        vi.spyOn(circleRoutes, 'verifyCircleWalletOwnership').mockResolvedValue('ok');
        vi.spyOn(walletService, 'hasSessionRecord').mockReturnValue(false);
        const { res, getStatus } = mockRes();
        await handler({ body: tipBody } as Request, res);
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
        await handler({ body: tipBody } as Request, res);
        expect(getStatus()).toBe(401);
    });

    it('pays after Circle ownership proof and matching session', async () => {
        const pay = vi.fn().mockResolvedValue({ success: true });
        vi.spyOn(circleRoutes, 'verifyCircleWalletOwnership').mockResolvedValue('ok');
        vi.spyOn(walletService, 'hasSessionRecord').mockReturnValue(true);
        vi.spyOn(walletService, 'getSessionRecord').mockReturnValue({
            privateKey,
            returnAddress,
        } as any);
        vi.spyOn(sessionService, 'getGatewayClientForUser').mockReturnValue({ pay } as any);
        const { res, getStatus, getJson } = mockRes();
        await handler({ body: tipBody } as Request, res);
        expect(getStatus()).toBe(200);
        expect(getJson()).toEqual({ status: 'success', amount: '0.100000', payoutAddress });
        expect(pay).toHaveBeenCalledTimes(1);
    });
});

describe('POST /cash-out', () => {
    let handler: any;

    beforeEach(() => {
        vi.clearAllMocks();
        handler = getRouteHandler('/cash-out');
    });

    it('rejects missing Circle proof fields', async () => {
        const { res, getStatus, getJson } = mockRes();
        await handler({ body: { userId: 'social:abc' }, headers: {} } as Request, res);
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
                returnAddress: '0x1111222233334444555566667777888899990000',
            },
            headers: {},
        } as Request, res);
        expect(getStatus()).toBe(401);
    });
});

describe('POST /session-balance', () => {
    let handler: any;

    beforeEach(() => {
        vi.clearAllMocks();
        handler = getRouteHandler('/session-balance');
    });

    it('rejects missing Circle proof fields', async () => {
        const { res, getStatus, getJson } = mockRes();
        await handler({ body: { userId: 'social:abc' }, headers: {} } as Request, res);
        expect(getStatus()).toBe(400);
        expect(getJson().error).toMatch(/Missing/);
    });
});

describe('POST /v1/sessions/start', () => {
    const payoutAddress = '0x1111222233334444555566667777888899990000';
    let handler: any;

    beforeEach(() => {
        vi.clearAllMocks();
        handler = getRouteHandler('/v1/sessions/start');
    });

    it('starts a human session without an agent funding check', async () => {
        const join = vi.spyOn(sessionService, 'recordJoin').mockImplementation(() => {});
        const { res, getStatus, getJson } = mockRes();
        await handler({
            body: {
                userId: 'email:viewer@example.com',
                resourceId: 'video-1',
                ratePerSecond: '0.000100',
                payoutAddress,
            },
        } as Request, res);
        expect(getStatus()).toBe(200);
        expect(getJson()).toEqual({ status: 'session_started', sessionId: 'email:viewer@example.com' });
        expect(join).toHaveBeenCalledTimes(1);
    });

    it('returns 402 when an agent session is not funded', async () => {
        vi.spyOn(walletService, 'isSessionUnfunded').mockReturnValue(true);
        const join = vi.spyOn(sessionService, 'recordJoin').mockImplementation(() => {});
        const { res, getStatus, getJson } = mockRes();
        await handler({
            body: {
                userId: 'agent:0x1111222233334444555566667777888899990000',
                resourceId: 'deep_web_research',
                ratePerSecond: '0.002',
                payoutAddress,
            },
        } as Request, res);
        expect(getStatus()).toBe(402);
        expect(getJson().error).toMatch(/not funded/i);
        expect(join).not.toHaveBeenCalled();
    });
});
