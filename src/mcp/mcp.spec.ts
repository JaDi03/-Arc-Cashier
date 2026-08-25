/**
 * Vitest suite for the Tessera MCP connector.
 *
 * Runs the real proxy against fixture MCP servers (child processes) with the
 * Tessera Core HTTP API mocked at the fetch boundary. The HMAC assertions
 * recompute signatures exactly as the sidecar verifier does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import { createInterface } from 'readline';
import type { ChildProcess } from 'child_process';
import path from 'path';
import crypto from 'crypto';
import { McpMeteredProxy } from './proxy';
import { TesseraIngestClient } from './ingest';
import { TesseraMcpConsumer, BudgetGuard, BudgetExceededError } from './consumer';
import { TESSERA_RPC_ERRORS, type IdentifyResult, type ProviderConfig } from './types';

const ECHO_FIXTURE = path.join(__dirname, 'fixtures', 'echo-mcp.mjs');
const HANG_FIXTURE = path.join(__dirname, 'fixtures', 'hang-mcp.mjs');

const SECRET = 'test-ingest-secret';
const BASE = 'http://127.0.0.1:7878';
const PAYOUT = '0x1234567890AbCdEf1234567890aBcDeF12345678';

interface CapturedCall {
    url: string;
    headers: Record<string, string>;
    body: string;
}

const captured: CapturedCall[] = [];

beforeEach(() => {
    captured.length = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown, init?: { headers?: unknown; body?: unknown }) => {
            captured.push({
                url: String(url),
                headers: (init?.headers ?? {}) as Record<string, string>,
                body: String(init?.body ?? ''),
            });
            return { ok: true, status: 200, json: async () => ({ status: 'ok' }), text: async () => '' };
        })
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

interface RpcMsg {
    jsonrpc?: string;
    id?: number | string;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

interface Harness {
    proxy: McpMeteredProxy;
    send: (msg: unknown) => void;
    waitFor: (id: number | string, timeoutMs?: number) => Promise<RpcMsg>;
    stop: () => void;
}

function startProxy(overrides: Partial<ProviderConfig> = {}): Harness {
    const input = new PassThrough();
    const output = new PassThrough();

    const config: ProviderConfig = {
        payoutAddress: PAYOUT,
        ratePerSecond: 0.001,
        watchdogTimeoutMs: 5000,
        targetCommand: { command: process.execPath, args: [ECHO_FIXTURE] },
        tesseraBaseUrl: BASE,
        ingestSecret: SECRET,
        ...overrides,
    };

    const proxy = new McpMeteredProxy(config, { input, output });
    proxy.start();

    const lines: RpcMsg[] = [];
    const waiters = new Map<string, (msg: RpcMsg) => void>();
    const rl = createInterface({ input: output });
    rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: RpcMsg;
        try {
            msg = JSON.parse(trimmed) as RpcMsg;
        } catch {
            return;
        }
        lines.push(msg);
        const waiter = waiters.get(String(msg.id));
        if (waiter) {
            waiters.delete(String(msg.id));
            waiter(msg);
        }
    });

    return {
        proxy,
        send: (msg) => input.write(`${JSON.stringify(msg)}\n`),
        waitFor: (id, timeoutMs = 5000) =>
            new Promise<RpcMsg>((resolve, reject) => {
                const existing = lines.find((m) => String(m.id) === String(id));
                if (existing) return resolve(existing);
                const timer = setTimeout(
                    () => reject(new Error(`Timed out waiting for response id=${id}`)),
                    timeoutMs
                );
                waiters.set(String(id), (msg) => {
                    clearTimeout(timer);
                    resolve(msg);
                });
            }),
        stop: () => {
            proxy.stop();
            input.end();
            output.end();
            rl.close();
        },
    };
}

const initializeParams = {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0.0.0' },
};

describe('MCP metered proxy', () => {
    it('passes discovery traffic through without touching billing', async () => {
        const h = startProxy();
        try {
            h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initializeParams });
            const init = await h.waitFor(1);
            expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('echo-mcp');

            h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
            const listed = await h.waitFor(2);
            expect((listed.result as { tools: Array<{ name: string }> }).tools[0].name).toBe('echo');

            expect(captured.filter((c) => c.url.includes('/api/core/v1/sessions/'))).toHaveLength(0);
        } finally {
            h.stop();
        }
    });

    it('rejects unmetered tools/call that arrives before tessera/identify', async () => {
        const h = startProxy();
        try {
            h.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: {} } });
            const err = await h.waitFor(5);
            expect(err.error?.code).toBe(TESSERA_RPC_ERRORS.IDENTIFY_REQUIRED);
            expect(captured.filter((c) => c.url.includes('/api/core/v1/sessions/'))).toHaveLength(0);
        } finally {
            h.stop();
        }
    });

    it('meters tools/call: HMAC sessions/start before execution, sessions/stop after', async () => {
        const h = startProxy();
        try {
            h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initializeParams });
            await h.waitFor(1);

            h.send({ jsonrpc: '2.0', id: 10, method: 'tessera/identify', params: { userId: 'arc_mcp_consumer01' } });
            const ident = await h.waitFor(10);
            expect(ident.result).toMatchObject({
                userId: 'arc_mcp_consumer01',
                payoutAddress: PAYOUT,
                ratePerSecond: 0.001,
                network: 'arc-testnet',
                currency: 'USDC',
            });

            h.send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'echo', arguments: { hello: 'world' } } });
            const resp = await h.waitFor(11);
            expect(resp.error).toBeUndefined();
            const content = (resp.result as { content: Array<{ text: string }> }).content;
            expect(JSON.parse(content[0].text)).toEqual({ hello: 'world' });

            const start = captured.find((c) => c.url.endsWith('/sessions/start'));
            const stop = captured.find((c) => c.url.endsWith('/sessions/stop'));
            expect(start).toBeDefined();
            expect(stop).toBeDefined();

            const startBody = JSON.parse(start!.body);
            expect(startBody).toMatchObject({
                userId: 'arc_mcp_consumer01',
                resourceId: 'mcp:echo',
                ratePerSecond: '0.001000',
                payoutAddress: PAYOUT,
            });

            // The signature must match what the sidecar verifier recomputes.
            const { 'X-Tessera-Timestamp': ts, 'X-Tessera-Nonce': nonce, 'X-Tessera-Signature': sig } = start!.headers;
            expect(TesseraIngestClient.sign(SECRET, ts, nonce, start!.body)).toBe(sig);

            expect(JSON.parse(stop!.body)).toEqual({ userId: 'arc_mcp_consumer01' });
        } finally {
            h.stop();
        }
    });

    it('watchdog cuts billing, aborts the hung call, and restarts the child', async () => {
        const h = startProxy({
            watchdogTimeoutMs: 300,
            targetCommand: { command: process.execPath, args: [HANG_FIXTURE] },
        });
        try {
            h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initializeParams });
            await h.waitFor(1);

            h.send({ jsonrpc: '2.0', id: 20, method: 'tessera/identify', params: { userId: 'arc_mcp_hangtest01' } });
            await h.waitFor(20);

            h.send({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'hang', arguments: {} } });
            const err = await h.waitFor(21, 8000);
            expect(err.error?.code).toBe(TESSERA_RPC_ERRORS.WATCHDOG_TIMEOUT);
            expect((err.error?.data as { tool: string }).tool).toBe('hang');

            // Billing was cut exactly once around the hung call.
            const starts = captured.filter((c) => c.url.endsWith('/sessions/start'));
            const stops = captured.filter((c) => c.url.endsWith('/sessions/stop'));
            expect(starts).toHaveLength(1);
            expect(stops).toHaveLength(1);

            // The respawned child answers discovery again (initialize replayed, duplicate response swallowed).
            h.send({ jsonrpc: '2.0', id: 22, method: 'tools/list' });
            const listed = await h.waitFor(22, 8000);
            expect((listed.result as { tools: Array<{ name: string }> }).tools[0].name).toBe('hang');
        } finally {
            h.stop();
        }
    }, 15000);
});

describe('consumer budget enforcement', () => {
    it('BudgetGuard never affords a tick past the cap', () => {
        const guard = new BudgetGuard(0.002);
        guard.record(0.001);
        expect(guard.canAfford(0.001)).toBe(true);
        guard.record(0.001);
        expect(guard.canAfford(0.001)).toBe(false);
        expect(() => guard.assertCanAfford(0.001, 'tool "echo"')).toThrowError(BudgetExceededError);
        expect(guard.remaining).toBe(0);
    });

    it('callTool refuses to start when the remaining budget cannot cover one tick', async () => {
        const key = `0x${crypto.randomBytes(32).toString('hex')}` as `0x${string}`;
        const consumer = new TesseraMcpConsumer({ agentPrivateKey: key, maxBudgetUsdc: 0.001, tesseraBaseUrl: BASE });

        await expect(consumer.callTool('echo')).rejects.toThrow(/Not connected/);

        // Simulate a completed handshake without spawning a server.
        const internals = consumer as unknown as { identifyInfo: IdentifyResult | null; child: ChildProcess | null };
        internals.identifyInfo = {
            userId: consumer.userId,
            payoutAddress: PAYOUT,
            ratePerSecond: 0.001,
            watchdogTimeoutMs: 5000,
            network: 'arc-testnet',
            currency: 'USDC',
        };
        internals.child = { kill: () => undefined } as unknown as ChildProcess;
        consumer.budget.record(0.001);

        await expect(consumer.callTool('echo')).rejects.toThrowError(BudgetExceededError);
        expect(consumer.remainingUsdc).toBe(0);
    });
});

describe('resolveTarget', () => {
    it('runs string commands through a shell and object commands directly', async () => {
        const { resolveTarget } = await import('./proxy');
        expect(resolveTarget('npx -y @modelcontextprotocol/server-puppeteer')).toEqual({
            command: 'npx -y @modelcontextprotocol/server-puppeteer',
            args: [],
            useShell: true,
        });
        expect(resolveTarget({ command: 'node', args: ['server.js'] })).toEqual({
            command: 'node',
            args: ['server.js'],
            useShell: false,
        });
    });
});
