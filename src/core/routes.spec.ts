import { describe, it, expect, beforeEach, vi } from 'vitest';
import instanceInfoRouter from './instance-info';
import { Request, Response } from 'express';
import * as fs from 'fs';

vi.mock('fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
}));

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
        expect(responseJson.originFee).toBe(0.10); // default fallback
    });
});
