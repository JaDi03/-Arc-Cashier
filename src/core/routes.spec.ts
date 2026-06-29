import { describe, it, expect, beforeEach, vi } from 'vitest';
import coreRouter from './routes';
import { Request, Response } from 'express';

// Mock environmental variable
process.env.SELLER_PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.MASTER_KEY = 'test-fallback-master-key-32-chars-long';

describe('CCTP Async Endpoints', () => {
    let finalizeHandler: any;
    let statusHandler: any;

    beforeEach(() => {
        vi.clearAllMocks();
        // Find the route handlers in Express router stack
        const finalizeLayer = coreRouter.stack.find(s => s.route && s.route.path === '/circle/cctp-finalize');
        const statusLayer = coreRouter.stack.find(s => s.route && s.route.path === '/circle/cctp-status/:jobId');

        // Extract the last handler in the route execution stack (bypasses rate limiters)
        finalizeHandler = finalizeLayer?.route?.stack[finalizeLayer.route.stack.length - 1]?.handle;
        statusHandler = statusLayer?.route?.stack[statusLayer.route.stack.length - 1]?.handle;
    });

    it('should fail with 400 if sourceDomain or required fields are missing', async () => {
        const req = {
            body: {
                transactionHash: '0x123',
                recipientAddress: '0xabc'
            }
        } as unknown as Request;

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

        await finalizeHandler(req, res);
        expect(statusCode).toBe(400);
        expect(responseJson.error).toContain('Missing sourceDomain');
    });

    it('should return 202 Accepted and a jobId for valid requests', async () => {
        const req = {
            body: {
                sourceDomain: 0,
                transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
                recipientAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
            }
        } as unknown as Request;

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

        await finalizeHandler(req, res);
        expect(statusCode).toBe(202);
        expect(responseJson.jobId).toBeDefined();
        expect(responseJson.status).toBe('pending');

        // Query status endpoint for the newly created job
        const reqStatus = {
            params: { jobId: responseJson.jobId }
        } as unknown as Request;

        let statusResponseJson: any = null;
        const resStatus = {
            json: (data: any) => {
                statusResponseJson = data;
                return resStatus;
            }
        } as unknown as Response;

        await statusHandler(reqStatus, resStatus);
        expect(statusResponseJson.id).toBe(responseJson.jobId);
        expect(statusResponseJson.status).toBe('pending');
    });

    it('should return 404 for non-existent jobIds', async () => {
        const reqStatus = {
            params: { jobId: 'non-existent-uuid' }
        } as unknown as Request;

        let statusCode = 0;
        let responseJson: any = null;
        const resStatus = {
            status: (code: number) => {
                statusCode = code;
                return resStatus;
            },
            json: (data: any) => {
                responseJson = data;
                return resStatus;
            }
        } as unknown as Response;

        await statusHandler(reqStatus, resStatus);
        expect(statusCode).toBe(404);
        expect(responseJson.error).toContain('job not found');
    });
});
