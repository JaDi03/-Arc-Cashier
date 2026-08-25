/**
 * Consumer client for autonomous agents (OpenClaw, Hermes, Eliza, or any
 * script): connects to a metered MCP server, identifies itself, and signs
 * per-second Gateway ticks with its own key while tools execute.
 *
 * Agents hold plain EVM keys (no Circle browser login), so ticks are signed
 * client-side via x402 against the sidecar's /api/core/stream-access and
 * settled to the provider's payout address at the session rate. The local
 * BudgetGuard hard-caps total spend: when the budget is exhausted the tick
 * loop stops signing and the call is aborted — no signed tick, no charge.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import crypto from 'crypto';
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { isValidPrivateKeyHex } from '../core/session-key-auth';
import { resolveTarget } from './proxy';
import {
    SessionState,
    type ConsumerConfig,
    type IdentifyResult,
    type JsonRpcResponse,
    type McpToolCallResult,
    type McpToolInfo,
    type TargetCommand,
} from './types';

const DEFAULT_RPC_URL = 'https://rpc.testnet.arc.network';
/** USDC kept on the ephemeral wallet so deposit/withdraw can pay Arc gas. */
const RETAINED_GAS_USDC = 0.01;

export class BudgetExceededError extends Error {
    constructor(
        public readonly label: string,
        public readonly spentUsdc: number,
        public readonly maxBudgetUsdc: number
    ) {
        super(`Budget cap reached for ${label}: spent ${spentUsdc} of ${maxBudgetUsdc} USDC.`);
        this.name = 'BudgetExceededError';
    }
}

/** Local spend ledger. The consumer never signs a tick it cannot afford. */
export class BudgetGuard {
    private spentUsdc = 0;

    constructor(public readonly maxBudgetUsdc: number) {
        if (!(maxBudgetUsdc > 0)) throw new Error('maxBudgetUsdc must be > 0');
    }

    get spent(): number {
        return this.spentUsdc;
    }

    get remaining(): number {
        return Math.max(0, this.maxBudgetUsdc - this.spentUsdc);
    }

    record(amountUsdc: number): void {
        if (!(amountUsdc >= 0)) throw new Error('amountUsdc must be >= 0');
        this.spentUsdc += amountUsdc;
    }

    canAfford(nextUsdc: number): boolean {
        return this.spentUsdc + nextUsdc <= this.maxBudgetUsdc + 1e-9;
    }

    assertCanAfford(nextUsdc: number, label: string): void {
        if (!this.canAfford(nextUsdc)) {
            throw new BudgetExceededError(label, this.spentUsdc, this.maxBudgetUsdc);
        }
    }
}

interface RpcWaiter {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
}

export class TesseraMcpConsumer {
    public readonly userId: string;
    public readonly budget: BudgetGuard;

    private readonly config: ConsumerConfig & { rpcUrl: string; tickIntervalMs: number };
    private readonly gateway: GatewayClient;
    private readonly waiters = new Map<string, RpcWaiter>();
    private child: ChildProcess | null = null;
    private rpcId = 0;
    private identifyInfo: IdentifyResult | null = null;
    private toolsCache: McpToolInfo[] = [];
    private state: SessionState = SessionState.IDLE;
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private callDeadline: ReturnType<typeof setTimeout> | null = null;

    constructor(config: ConsumerConfig) {
        if (!isValidPrivateKeyHex(config.agentPrivateKey)) {
            throw new Error('agentPrivateKey must be a 0x-prefixed 32-byte hex string.');
        }
        this.config = {
            ...config,
            rpcUrl: config.rpcUrl ?? DEFAULT_RPC_URL,
            tickIntervalMs: config.tickIntervalMs ?? 1000,
        };
        this.budget = new BudgetGuard(config.maxBudgetUsdc);
        this.userId = `arc_mcp_${crypto.randomBytes(10).toString('hex')}`;
        this.gateway = new GatewayClient({
            privateKey: config.agentPrivateKey,
            chain: 'arcTestnet',
            rpcUrl: this.config.rpcUrl,
        });
    }

    get tools(): readonly McpToolInfo[] {
        return this.toolsCache;
    }

    get spentUsdc(): number {
        return this.budget.spent;
    }

    get remainingUsdc(): number {
        return this.budget.remaining;
    }

    get sessionState(): SessionState {
        return this.state;
    }

    /** Spawns the metered MCP server and runs the MCP + Tessera handshake. */
    async connect(command: string | TargetCommand): Promise<void> {
        if (this.child) throw new Error('Already connected: call disconnect() first.');

        const { command: cmd, args: cmdArgs, useShell } = resolveTarget(command);
        const child = spawn(cmd, cmdArgs, { shell: useShell, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;

        child.stdin?.on('error', (err: Error) => console.error(`[Tessera MCP] Server stdin error: ${err.message}`));
        if (child.stdout) {
            createInterface({ input: child.stdout }).on('line', (line) => this.handleServerLine(line));
        }
        child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[mcp-server] ${chunk}`));

        const init = await this.rpc('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'tessera-mcp-consumer', version: '1.3.1' },
        });
        if (init.error) throw new Error(`MCP initialize failed: ${init.error.message}`);

        this.notify('notifications/initialized', {});

        const listed = await this.rpc('tools/list', {});
        if (listed.error) throw new Error(`tools/list failed: ${listed.error.message}`);
        this.toolsCache = ((listed.result as { tools?: McpToolInfo[] } | undefined)?.tools ?? []).filter(
            (tool) => typeof tool?.name === 'string'
        );

        const identified = await this.rpc('tessera/identify', { userId: this.userId });
        if (identified.error) {
            throw new Error(`tessera/identify failed (is this a Tessera-metered MCP server?): ${identified.error.message}`);
        }
        this.identifyInfo = identified.result as IdentifyResult;

        try {
            await this.ensureFunded();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[Tessera MCP] Gateway funding check failed: ${message}`);
        }

        this.state = SessionState.IDLE;
    }

    /**
     * Deposits wallet USDC into Gateway when the available Gateway balance is
     * below budget. Deposit is capped at maxBudgetUsdc so exposure is bounded.
     */
    async ensureFunded(): Promise<void> {
        const balances = await this.gateway.getBalances();
        const gatewayAvailable = Number(balances.gateway.formattedAvailable);
        if (gatewayAvailable >= this.config.maxBudgetUsdc) return;

        const walletUsdc = Number(balances.wallet.formatted);
        const target = Math.min(
            this.config.depositUsdc ?? this.config.maxBudgetUsdc,
            Math.max(0, walletUsdc - RETAINED_GAS_USDC)
        );
        if (target < 0.001) {
            throw new Error(
                `Agent wallet balance too low to fund Gateway (wallet ${walletUsdc} USDC, ` +
                `gateway ${gatewayAvailable} USDC). Fund the wallet on Arc testnet first.`
            );
        }
        await this.gateway.deposit(target.toFixed(6));
    }

    /**
     * Calls a paid tool. Signs one Gateway tick per elapsed second of
     * execution (sub-second execution costs nothing, matching media
     * sessions). Aborts locally when the budget cap or the call deadline is
     * hit. One metered call at a time.
     */
    async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
        if (!this.identifyInfo || !this.child) {
            throw new Error('Not connected: call connect() before callTool().');
        }
        if (this.state === SessionState.METERING || this.state === SessionState.PAUSED) {
            throw new Error('Another metered tool call is in flight.');
        }
        const rate = this.identifyInfo.ratePerSecond;
        if (rate > 0) this.budget.assertCanAfford(rate, `tool call "${name}"`);

        this.state = SessionState.METERING;
        const startedAt = Date.now();
        let ticksSent = 0;
        let tickFailures = 0;
        const rpcId = ++this.rpcId;
        const key = String(rpcId);
        let settled = false;

        const cleanup = () => {
            if (this.tickTimer) clearInterval(this.tickTimer);
            if (this.callDeadline) clearTimeout(this.callDeadline);
            this.tickTimer = null;
            this.callDeadline = null;
        };

        try {
            const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
                this.waiters.set(key, { resolve, reject });

                // Per-second tick signing, one per elapsed second of execution.
                this.tickTimer = setInterval(() => {
                    void (async () => {
                        try {
                            const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
                            if (elapsedSeconds <= ticksSent) return;
                            if (rate > 0 && !this.budget.canAfford(rate)) {
                                this.haltForBudget(rpcId, name);
                                return;
                            }
                            if (rate > 0) {
                                const paid = await this.gateway.pay<{ access: boolean }>(
                                    `${this.config.tesseraBaseUrl}/api/core/stream-access`,
                                    { headers: { 'x-user-id': this.userId, 'x-seller-address': this.identifyInfo!.payoutAddress } }
                                );
                                this.budget.record(Number(paid.formattedAmount ?? rate));
                            }
                            ticksSent = elapsedSeconds;
                            tickFailures = 0;
                        } catch (error) {
                            tickFailures++;
                            const message = error instanceof Error ? error.message : String(error);
                            console.error(`[Tessera MCP] Tick failed for "${name}": ${message}`);
                            if (tickFailures >= 2) this.haltForBudget(rpcId, name, 'repeated tick failures');
                        }
                    })();
                }, this.config.tickIntervalMs);

                const budgetCeilingMs =
                    rate > 0 ? Math.ceil((this.budget.remaining / rate) * 1000) + 2000 : 60_000;
                const deadlineMs = this.config.callTimeoutMs ?? budgetCeilingMs;
                this.callDeadline = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    this.state = SessionState.TIMEOUT;
                    this.waiters.delete(key);
                    this.notify('notifications/cancelled', { requestId: rpcId });
                    cleanup();
                    reject(new Error(`Tool "${name}" exceeded the ${deadlineMs}ms call deadline; tick signing stopped.`));
                }, deadlineMs);

                this.send({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } });
            });

            settled = true;
            if (response.error) {
                throw new Error(`Tool "${name}" failed: ${response.error.message}`);
            }
            return response.result as McpToolCallResult;
        } finally {
            settled = true;
            cleanup();
            if (this.state === SessionState.METERING || this.state === SessionState.PAUSED) {
                this.state = SessionState.STOPPED;
            }
        }
    }

    /** Stops signing ticks and asks the server to cancel the in-flight call. */
    private haltForBudget(rpcId: number, tool: string, reason = 'budget cap reached'): void {
        if (this.state !== SessionState.METERING) return;
        this.state = SessionState.PAUSED;
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.tickTimer = null;
        this.notify('notifications/cancelled', { requestId: rpcId });
        console.error(`[Tessera MCP] Halting "${tool}": ${reason}. No further ticks will be signed.`);
    }

    private handleServerLine(raw: string): void {
        const line = raw.trim();
        if (!line) return;
        let msg: unknown;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        if (typeof msg !== 'object' || msg === null) return;
        const message = msg as { id?: number | string };
        if (message.id === undefined || message.id === null) return;

        const waiter = this.waiters.get(String(message.id));
        if (waiter) {
            this.waiters.delete(String(message.id));
            waiter.resolve(msg as JsonRpcResponse);
        }
    }

    private async rpc(method: string, params: unknown): Promise<JsonRpcResponse> {
        const id = ++this.rpcId;
        return new Promise<JsonRpcResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.waiters.delete(String(id));
                reject(new Error(`Timed out waiting for ${method} response.`));
            }, 10_000);
            this.waiters.set(String(id), {
                resolve: (response) => {
                    clearTimeout(timeout);
                    resolve(response);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
            });
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    private notify(method: string, params: unknown): void {
        this.send({ jsonrpc: '2.0', method, params });
    }

    private send(message: Record<string, unknown>): void {
        if (!this.child?.stdin?.writable) {
            console.error('[Tessera MCP] Server stdin unavailable; dropping message.');
            return;
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    async disconnect(): Promise<void> {
        this.state = SessionState.IDLE;
        if (this.tickTimer) clearInterval(this.tickTimer);
        if (this.callDeadline) clearTimeout(this.callDeadline);
        this.tickTimer = null;
        this.callDeadline = null;
        this.child?.kill();
        this.child = null;
        this.identifyInfo = null;
        this.waiters.clear();
    }
}
