import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mockCircleClient = {
    getWalletTokenBalance: vi.fn(),
    estimateTransferFee: vi.fn(),
    createTransaction: vi.fn(),
    getUserChallenge: vi.fn(),
    listWallets: vi.fn(),
    createUserPinWithWallets: vi.fn(),
};

vi.mock('@circle-fin/user-controlled-wallets', () => ({
    initiateUserControlledWalletsClient: () => mockCircleClient,
}));

let circleRouter: any;
let findUsdcTokenBalance: any;
let isValidEvmAddress: any;
let parseExternalWithdrawAmount: any;
let ARC_TESTNET_USDC_ADDRESS: string;

beforeAll(async () => {
    const mod = await import('./circle-routes');
    circleRouter = mod.default;
    findUsdcTokenBalance = mod.findUsdcTokenBalance;
    isValidEvmAddress = mod.isValidEvmAddress;
    parseExternalWithdrawAmount = mod.parseExternalWithdrawAmount;
    ARC_TESTNET_USDC_ADDRESS = mod.ARC_TESTNET_USDC_ADDRESS;
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
    const layer = circleRouter.stack.find((s: any) => s.route && s.route.path === path);
    return layer?.route?.stack[layer.route.stack.length - 1]?.handle;
}

const USDC_TOKEN_ID = 'token-usdc-id';
const OTHER_TOKEN_ID = 'token-other-id';

function usdcBalanceRow(amount: string) {
    return {
        amount,
        token: {
            id: USDC_TOKEN_ID,
            symbol: 'USDC',
            tokenAddress: ARC_TESTNET_USDC_ADDRESS,
        },
    };
}

describe('external withdraw helpers', () => {
    it('validates EVM addresses', () => {
        expect(isValidEvmAddress('0x1111222233334444555566667777888899990000')).toBe(true);
        expect(isValidEvmAddress('0x123')).toBe(false);
        expect(isValidEvmAddress('not-an-address')).toBe(false);
    });

    it('parses positive decimal amounts only', () => {
        expect(parseExternalWithdrawAmount('1.25')).toEqual({ ok: true, amount: '1.25', value: 1.25 });
        expect(parseExternalWithdrawAmount('0')).toEqual({ ok: false, error: 'Withdraw amount must be greater than zero' });
        expect(parseExternalWithdrawAmount('-1')).toEqual({ ok: false, error: 'Invalid withdraw amount' });
        expect(parseExternalWithdrawAmount('1e2')).toEqual({ ok: false, error: 'Invalid withdraw amount' });
    });

    it('selects USDC by symbol and never falls back to tokens[0]', () => {
        const rows = [
            { amount: '9', token: { id: OTHER_TOKEN_ID, symbol: 'ETH', tokenAddress: '0xeeee' } },
            usdcBalanceRow('2.5'),
        ];
        const found = findUsdcTokenBalance(rows);
        expect(found?.token?.id).toBe(USDC_TOKEN_ID);
        expect(findUsdcTokenBalance([rows[0]])).toBeNull();
    });

    it('selects USDC by Arc Testnet token address when symbol is missing', () => {
        const found = findUsdcTokenBalance([
            {
                amount: '1',
                token: { id: USDC_TOKEN_ID, tokenAddress: ARC_TESTNET_USDC_ADDRESS },
            },
        ]);
        expect(found?.token?.id).toBe(USDC_TOKEN_ID);
    });
});

describe('POST /circle/quote-external-withdraw', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects invalid destination', async () => {
        const handler = getRouteHandler('/circle/quote-external-withdraw');
        const { res, getStatus, getJson } = mockRes();
        await handler({ body: { userToken: 't', walletId: 'w', destinationAddress: 'bad', amount: '1' } } as Request, res);
        expect(getStatus()).toBe(400);
        expect(getJson().error).toContain('destination');
        expect(mockCircleClient.getWalletTokenBalance).not.toHaveBeenCalled();
    });

    it('rejects amount above USDC balance', async () => {
        const handler = getRouteHandler('/circle/quote-external-withdraw');
        mockCircleClient.getWalletTokenBalance.mockResolvedValue({
            data: { tokenBalances: [usdcBalanceRow('0.5')] },
        });
        const { res, getStatus, getJson } = mockRes();
        await handler({
            body: {
                userToken: 't',
                walletId: 'w',
                destinationAddress: '0x1111222233334444555566667777888899990000',
                amount: '1',
            },
        } as Request, res);
        expect(getStatus()).toBe(400);
        expect(getJson().error).toContain('Insufficient USDC');
        expect(mockCircleClient.estimateTransferFee).not.toHaveBeenCalled();
    });

    it('quotes HIGH fee for a valid USDC transfer', async () => {
        const handler = getRouteHandler('/circle/quote-external-withdraw');
        mockCircleClient.getWalletTokenBalance.mockResolvedValue({
            data: {
                tokenBalances: [
                    { amount: '99', token: { id: OTHER_TOKEN_ID, symbol: 'ETH' } },
                    usdcBalanceRow('5'),
                ],
            },
        });
        mockCircleClient.estimateTransferFee.mockResolvedValue({
            data: {
                high: { networkFee: '0.001' },
                medium: { networkFee: '0.0005' },
                low: { networkFee: '0.0001' },
            },
        });
        const { res, getStatus, getJson } = mockRes();
        await handler({
            body: {
                userToken: 't',
                walletId: 'w',
                destinationAddress: '0x1111222233334444555566667777888899990000',
                amount: '1.5',
            },
        } as Request, res);
        expect(getStatus()).toBe(200);
        expect(mockCircleClient.estimateTransferFee).toHaveBeenCalledWith({
            userToken: 't',
            walletId: 'w',
            tokenId: USDC_TOKEN_ID,
            destinationAddress: '0x1111222233334444555566667777888899990000',
            amount: ['1.5'],
        });
        expect(getJson()).toMatchObject({
            network: 'ARC-TESTNET',
            token: 'USDC',
            amount: '1.5',
            usdcBalance: '5',
            feeLevel: 'HIGH',
            estimatedFee: { networkFee: '0.001' },
        });
    });
});

describe('POST /circle/prepare-external-withdraw', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('creates a transfer challenge with destination, amount, and USDC tokenId', async () => {
        const handler = getRouteHandler('/circle/prepare-external-withdraw');
        mockCircleClient.getWalletTokenBalance.mockResolvedValue({
            data: { tokenBalances: [usdcBalanceRow('3')] },
        });
        mockCircleClient.createTransaction.mockResolvedValue({
            data: { challengeId: 'challenge-xyz' },
        });
        const { res, getStatus, getJson } = mockRes();
        await handler({
            body: {
                userToken: 't',
                walletId: 'w',
                destinationAddress: '0xaaaabbbbccccddddeeeeffff0000111122223333',
                amount: '2',
            },
        } as Request, res);
        expect(getStatus()).toBe(200);
        expect(getJson().challengeId).toBe('challenge-xyz');
        expect(mockCircleClient.createTransaction).toHaveBeenCalledWith(expect.objectContaining({
            userToken: 't',
            walletId: 'w',
            tokenId: USDC_TOKEN_ID,
            destinationAddress: '0xaaaabbbbccccddddeeeeffff0000111122223333',
            amounts: ['2'],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
        }));
    });
});

const DEPOSIT_EPHEMERAL_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('POST /circle/prepare-deposit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('creates a USDC transfer even when another token has a larger balance', async () => {
        const handler = getRouteHandler('/circle/prepare-deposit');
        mockCircleClient.getWalletTokenBalance.mockResolvedValue({
            data: {
                tokenBalances: [
                    { amount: '99', token: { id: OTHER_TOKEN_ID, symbol: 'ETH' } },
                    usdcBalanceRow('5'),
                ],
            },
        });
        mockCircleClient.createTransaction.mockResolvedValue({
            data: { challengeId: 'deposit-challenge' },
        });
        const { res, getStatus, getJson } = mockRes();
        await handler({
            body: {
                userToken: 't',
                walletId: 'w',
                depositAmount: '1.5',
                ephemeralPk: DEPOSIT_EPHEMERAL_PK,
            },
        } as Request, res);
        expect(getStatus()).toBe(200);
        expect(getJson().challengeId).toBe('deposit-challenge');
        expect(mockCircleClient.createTransaction).toHaveBeenCalledWith(expect.objectContaining({
            userToken: 't',
            walletId: 'w',
            tokenId: USDC_TOKEN_ID,
            amounts: ['1.5'],
            fee: { type: 'level', config: { feeLevel: 'HIGH' } },
        }));
        expect(mockCircleClient.createTransaction.mock.calls[0][0].tokenId).not.toBe(OTHER_TOKEN_ID);
    });

    it('rejects when the wallet has no USDC', async () => {
        const handler = getRouteHandler('/circle/prepare-deposit');
        mockCircleClient.getWalletTokenBalance.mockResolvedValue({
            data: { tokenBalances: [{ amount: '9', token: { id: OTHER_TOKEN_ID, symbol: 'ETH' } }] },
        });
        const { res, getStatus, getJson } = mockRes();
        await handler({
            body: {
                userToken: 't',
                walletId: 'w',
                depositAmount: '1',
                ephemeralPk: DEPOSIT_EPHEMERAL_PK,
            },
        } as Request, res);
        expect(getStatus()).toBe(400);
        expect(getJson().error).toBe('USDC token not found in wallet');
        expect(mockCircleClient.createTransaction).not.toHaveBeenCalled();
    });

    it('rejects amount above USDC balance', async () => {
        const handler = getRouteHandler('/circle/prepare-deposit');
        mockCircleClient.getWalletTokenBalance.mockResolvedValue({
            data: { tokenBalances: [usdcBalanceRow('0.5')] },
        });
        const { res, getStatus, getJson } = mockRes();
        await handler({
            body: {
                userToken: 't',
                walletId: 'w',
                depositAmount: '1',
                ephemeralPk: DEPOSIT_EPHEMERAL_PK,
            },
        } as Request, res);
        expect(getStatus()).toBe(400);
        expect(getJson().error).toContain('Insufficient USDC');
        expect(mockCircleClient.createTransaction).not.toHaveBeenCalled();
    });
});

describe('POST /circle/get-wallet', () => {
    it('does not create a Circle wallet for agent userIds', async () => {
        const handler = getRouteHandler('/circle/get-wallet');
        const { res, getStatus, getJson } = mockRes();
        await handler({
            body: {
                userId: 'agent:0x1111222233334444555566667777888899990000',
                userToken: 'x'.repeat(40),
            },
        } as Request, res);
        expect(getStatus()).toBe(400);
        expect(getJson().error).toMatch(/Agent Stack/i);
        expect(mockCircleClient.listWallets).not.toHaveBeenCalled();
        expect(mockCircleClient.createUserPinWithWallets).not.toHaveBeenCalled();
    });
});
