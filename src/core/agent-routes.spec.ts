import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import { walletService } from './wallet';

const mockGetBalances = vi.fn();
const mockDeposit = vi.fn();

vi.mock('@circle-fin/x402-batching/client', () => ({
    GatewayClient: class {
        getBalances = mockGetBalances;
        deposit = mockDeposit;
    },
}));

let agentRouter: any;
let buildAgentChallengeMessage: (address: string, nonce: string, expiresAt: number) => string;

beforeAll(async () => {
    const mod = await import('./agent-routes');
    agentRouter = mod.default;
    buildAgentChallengeMessage = mod.buildAgentChallengeMessage;
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
        setHeader: () => res,
        send: (raw: string) => {
            responseJson = JSON.parse(raw);
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
    const layer = agentRouter.stack.find((s: any) => s.route && s.route.path === path);
    return layer?.route?.stack[layer.route.stack.length - 1]?.handle;
}

describe('agent challenge message', () => {
    it('includes chain, address, nonce, and expiry', () => {
        const message = buildAgentChallengeMessage(
            '0x1111222233334444555566667777888899990000',
            'nonce-1',
            Date.parse('2026-01-01T00:00:00.000Z'),
        );
        expect(message).toContain('Tessera agent session');
        expect(message).toContain('Chain: ARC-TESTNET');
        expect(message).toContain('Address: 0x1111222233334444555566667777888899990000');
        expect(message).toContain('Nonce: nonce-1');
        expect(message).toContain('Expires: 2026-01-01T00:00:00.000Z');
    });
});

describe('POST /agent/challenge', () => {
    it('rejects invalid address', async () => {
        const handler = getRouteHandler('/agent/challenge');
        const { res, getStatus, getJson } = mockRes();
        await handler({ body: { address: 'not-an-address' } } as Request, res);
        expect(getStatus()).toBe(400);
        expect(getJson().error).toMatch(/address/i);
    });

    it('returns a signable message and agent userId', async () => {
        const handler = getRouteHandler('/agent/challenge');
        const address = '0x1111222233334444555566667777888899990000';
        const { res, getStatus, getJson } = mockRes();
        await handler({ body: { address } } as Request, res);
        expect(getStatus()).toBe(200);
        expect(getJson().status).toBe('challenge');
        expect(getJson().userId).toBe(`agent:${getAddress(address)}`);
        expect(getJson().message).toContain('Tessera agent session');
        expect(getJson().signCommand).toContain('circle wallet sign message');
    });
});

describe('POST /agent/begin-session', () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const address = account.address;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a bad signature', async () => {
        const challengeHandler = getRouteHandler('/agent/challenge');
        const beginHandler = getRouteHandler('/agent/begin-session');
        await challengeHandler({ body: { address } } as Request, mockRes().res);
        const { res, getStatus } = mockRes();
        await beginHandler({
            body: { address, signature: '0x' + 'ab'.repeat(65) },
        } as Request, res);
        expect(getStatus()).toBe(401);
    });

    it('registers a pending session after a valid EOA signature', async () => {
        const challengeHandler = getRouteHandler('/agent/challenge');
        const beginHandler = getRouteHandler('/agent/begin-session');
        const challengeRes = mockRes();
        await challengeHandler({ body: { address } } as Request, challengeRes.res);
        const message = challengeRes.getJson().message as string;
        const signature = await account.signMessage({ message });

        vi.spyOn(walletService, 'hasSessionRecord').mockReturnValue(false);
        const registerSpy = vi.spyOn(walletService, 'registerSessionKey').mockImplementation(() => {});

        const { res, getStatus, getJson } = mockRes();
        await beginHandler({ body: { address, signature } } as Request, res);
        expect(getStatus()).toBe(200);
        expect(getJson().status).toBe('awaiting_funds');
        expect(getJson().userId).toBe(`agent:${address}`);
        expect(getJson().ephemeralAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(registerSpy).toHaveBeenCalled();
        expect(registerSpy.mock.calls[0][4]).toBe(true);
    });
});

describe('POST /agent/fund-session', () => {
    it('returns 404 when begin-session was not called', async () => {
        const privateKey = generatePrivateKey();
        const account = privateKeyToAccount(privateKey);
        const address = account.address;
        const challengeHandler = getRouteHandler('/agent/challenge');
        const fundHandler = getRouteHandler('/agent/fund-session');
        const challengeRes = mockRes();
        await challengeHandler({ body: { address } } as Request, challengeRes.res);
        const signature = await account.signMessage({ message: challengeRes.getJson().message });
        vi.spyOn(walletService, 'hasSessionRecord').mockReturnValue(false);
        const { res, getStatus } = mockRes();
        await fundHandler({ body: { address, signature } } as Request, res);
        expect(getStatus()).toBe(404);
    });
});
