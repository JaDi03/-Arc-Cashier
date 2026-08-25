/**
 * Stdio JSON-RPC metered proxy: sits between an MCP client and a child MCP
 * server. Discovery traffic (initialize, tools/list, ping, notifications)
 * passes through untouched. tools/call is metered per second in USDC through
 * Tessera Core, and a watchdog aborts hung calls and cuts billing.
 *
 * Transport is newline-delimited JSON-RPC 2.0 over stdio, as used by the MCP
 * stdio transport. The proxy is payload-agnostic: it never inspects tool
 * arguments or results.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import type { Readable, Writable } from 'stream';
import { TesseraIngestClient } from './ingest';
import { ToolMeter } from './meter';
import {
    TESSERA_RPC_ERRORS,
    type IdentifyResult,
    type JsonRpcId,
    type McpToolCallParams,
    type ProviderConfig,
    type TargetCommand,
} from './types';

export interface ProxyIo {
    input: Readable;
    output: Writable;
}

interface PendingEntry {
    id: JsonRpcId;
    metered: boolean;
    userId?: string;
    tool?: string;
    generation: number;
}

/** Spawns a target command. Strings go through a shell (npx/uvx shims); objects spawn directly. */
export function resolveTarget(target: string | TargetCommand): { command: string; args: string[]; useShell: boolean } {
    if (typeof target === 'string') {
        const trimmed = target.trim();
        if (!trimmed) throw new Error('targetCommand string is empty');
        return { command: trimmed, args: [], useShell: true };
    }
    if (!target.command) throw new Error('targetCommand.command is required');
    return { command: target.command, args: target.args ?? [], useShell: false };
}

export class McpMeteredProxy {
    private readonly meter: ToolMeter;
    private readonly pending = new Map<string, PendingEntry>();
    private child: ChildProcess | null = null;
    private generation = 0;
    private shuttingDown = false;
    private identifiedUserId: string | null = null;
    /** Raw initialize line to replay on every respawned child. */
    private replayInitializeLine: string | null = null;
    private readonly replayNotifications = new Map<string, string>();
    /** id of the replayed initialize whose response must be swallowed. */
    private swallowInitializeId: JsonRpcId | null = null;

    constructor(
        private readonly config: ProviderConfig,
        private readonly io: ProxyIo = { input: process.stdin, output: process.stdout }
    ) {
        this.meter = new ToolMeter(new TesseraIngestClient(config.tesseraBaseUrl, config.ingestSecret), {
            payoutAddress: config.payoutAddress,
            ratePerSecond: config.ratePerSecond,
            splits: config.splits,
        });
    }

    start(): void {
        this.spawnChild();
        createInterface({ input: this.io.input }).on('line', (line) => this.handleClientLine(line));
    }

    /** Kills the child and closes any open billing session. */
    stop(): void {
        this.shuttingDown = true;
        for (const entry of this.pending.values()) {
            if (entry.metered && entry.userId) void this.meter.finish(entry.userId);
        }
        this.pending.clear();
        this.child?.kill();
        this.child = null;
    }

    // ─── Child lifecycle ─────────────────────────────────────────────────────

    private spawnChild(): void {
        const gen = ++this.generation;
        const { command, args, useShell } = resolveTarget(this.config.targetCommand);
        const child = spawn(command, args, { shell: useShell, stdio: ['pipe', 'pipe', 'pipe'] });
        this.child = child;

        child.stdin?.on('error', (err: Error) => {
            if (!this.shuttingDown) console.error(`[Tessera MCP] Child stdin error: ${err.message}`);
        });
        if (child.stdout) {
            createInterface({ input: child.stdout }).on('line', (line) => this.handleChildLine(line));
        }
        child.stderr?.on('data', (chunk: Buffer) => {
            process.stderr.write(`[mcp-child] ${chunk}`);
        });
        child.on('error', (err: Error) => {
            console.error(`[Tessera MCP] Failed to spawn target MCP server: ${err.message}`);
        });
        child.on('exit', (code, signal) => {
            if (this.shuttingDown || gen !== this.generation) return;
            console.error(`[Tessera MCP] Child MCP server exited (code=${code} signal=${signal}); restarting.`);
            this.failPendingGeneration(gen, -32603, 'MCP server exited unexpectedly and is being restarted.');
            setTimeout(() => {
                if (!this.shuttingDown) this.spawnChild();
            }, 300);
        });

        // A respawned child has not seen the handshake: replay initialize
        // (swallowing its duplicate response) and every notification so far.
        if (gen > 1) {
            if (this.replayInitializeLine) {
                try {
                    const parsed = JSON.parse(this.replayInitializeLine) as { id?: JsonRpcId };
                    if (parsed.id !== undefined && parsed.id !== null) this.swallowInitializeId = parsed.id;
                } catch {
                    // Keep the line even if it is not parseable here; the child decides.
                }
                this.writeToChild(this.replayInitializeLine);
            }
            for (const line of this.replayNotifications.values()) this.writeToChild(line);
        }
    }

    private writeToChild(line: string): void {
        if (!this.child?.stdin?.writable) {
            console.error('[Tessera MCP] Child stdin unavailable; dropping message.');
            return;
        }
        this.child.stdin.write(`${line}\n`);
    }

    private writeLine(line: string): void {
        this.io.output.write(`${line}\n`);
    }

    private writeRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
        const error: Record<string, unknown> = { code, message };
        if (data !== undefined) error.data = data;
        this.writeLine(JSON.stringify({ jsonrpc: '2.0', id, error }));
    }

    // ─── Client → child ──────────────────────────────────────────────────────

    private handleClientLine(raw: string): void {
        const line = raw.trim();
        if (!line) return;

        let msg: unknown;
        try {
            msg = JSON.parse(line);
        } catch {
            console.error('[Tessera MCP] Dropping non-JSON line from client.');
            return;
        }
        if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
            this.writeToChild(line); // Batches and odd frames pass through unmetered.
            return;
        }

        const request = msg as { id?: JsonRpcId; method?: string; params?: unknown };
        if (request.method === undefined) {
            this.writeToChild(line); // A response from the client side (rare); pass through.
            return;
        }

        if (request.method === 'tessera/identify' && request.id !== undefined && request.id !== null) {
            this.handleIdentify(request.id, request.params);
            return;
        }

        if (request.method === 'tools/call' && request.id !== undefined && request.id !== null) {
            void this.handleMeteredCall(request.id, request.params, line);
            return;
        }

        if (request.method === 'initialize') {
            this.replayInitializeLine = line;
        } else if (request.id === undefined || request.id === null) {
            this.replayNotifications.set(request.method, line);
        }

        if (request.id !== undefined && request.id !== null) {
            this.pending.set(String(request.id), { id: request.id, metered: false, generation: this.generation });
        }
        this.writeToChild(line);
    }

    private handleIdentify(id: JsonRpcId, params: unknown): void {
        const userId = (params as { userId?: unknown } | undefined)?.userId;
        if (typeof userId !== 'string' || userId.length < 7 || userId.length > 256) {
            this.writeRpcError(id, -32602, 'tessera/identify requires a valid userId (7-256 chars).');
            return;
        }
        this.identifiedUserId = userId;
        const result: IdentifyResult = {
            userId,
            payoutAddress: this.config.payoutAddress,
            ratePerSecond: this.config.ratePerSecond,
            watchdogTimeoutMs: this.config.watchdogTimeoutMs,
            network: 'arc-testnet',
            currency: 'USDC',
        };
        this.writeLine(JSON.stringify({ jsonrpc: '2.0', id, result }));
        console.log(`[Tessera MCP] Consumer identified: ${userId}`);
    }

    private async handleMeteredCall(id: JsonRpcId, params: unknown, line: string): Promise<void> {
        if (!this.identifiedUserId) {
            this.writeRpcError(
                id,
                TESSERA_RPC_ERRORS.IDENTIFY_REQUIRED,
                'Consumer identity missing: send tessera/identify before tools/call.'
            );
            return;
        }
        if (this.hasMeteredInFlight()) {
            this.writeRpcError(
                id,
                TESSERA_RPC_ERRORS.CALL_IN_FLIGHT,
                'Another metered tool call is in flight; one billing session per consumer at a time.'
            );
            return;
        }

        const userId = this.identifiedUserId;
        const tool = (params as McpToolCallParams | undefined)?.name ?? 'unknown';

        try {
            await this.meter.begin(userId, tool);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.writeRpcError(id, -32603, `Failed to open billing session: ${message}`);
            return;
        }

        this.pending.set(String(id), { id, metered: true, userId, tool, generation: this.generation });
        this.meter.armWatchdog(userId, this.config.watchdogTimeoutMs, () => this.onWatchdogFire(userId, tool, id));
        this.writeToChild(line);
        console.log(`[Tessera MCP] Metered call started: ${tool} for ${userId}`);
    }

    private hasMeteredInFlight(): boolean {
        for (const entry of this.pending.values()) {
            if (entry.metered) return true;
        }
        return false;
    }

    /** Billing was already cut by the meter; abort transport and restart the child. */
    private onWatchdogFire(userId: string, tool: string, id: JsonRpcId): void {
        const oldGen = this.generation;
        this.child?.kill();
        this.spawnChild();

        for (const [key, entry] of this.pending) {
            if (entry.generation > oldGen) continue;
            if (entry.metered && entry.id === id) {
                this.writeRpcError(
                    id,
                    TESSERA_RPC_ERRORS.WATCHDOG_TIMEOUT,
                    `Tool "${tool}" timed out after ${this.config.watchdogTimeoutMs}ms; billing was stopped at the timeout.`,
                    { tool, timeoutMs: this.config.watchdogTimeoutMs }
                );
            } else {
                this.writeRpcError(entry.id, -32603, 'MCP server was restarted after a watchdog timeout.');
            }
            this.pending.delete(key);
        }
        console.error(`[Tessera MCP] Watchdog fired on "${tool}": billing cut, child restarted.`);
    }

    private failPendingGeneration(generation: number, code: number, message: string): void {
        for (const [key, entry] of this.pending) {
            if (entry.generation !== generation) continue;
            if (entry.metered && entry.userId) void this.meter.finish(entry.userId);
            this.writeRpcError(entry.id, code, message);
            this.pending.delete(key);
        }
    }

    // ─── Child → client ──────────────────────────────────────────────────────

    private handleChildLine(raw: string): void {
        const line = raw.trim();
        if (!line) return;

        let msg: unknown;
        try {
            msg = JSON.parse(line);
        } catch {
            console.error('[Tessera MCP] Dropping non-JSON line from child.');
            return;
        }
        if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
            this.writeLine(line);
            return;
        }

        const message = msg as { id?: JsonRpcId; method?: string };
        const hasId = message.id !== undefined && message.id !== null;

        if (!hasId) {
            this.writeLine(line); // Server notification (progress, etc.).
            return;
        }

        // Swallow the duplicate initialize response from a respawned child.
        if (
            this.swallowInitializeId !== null &&
            String(this.swallowInitializeId) === String(message.id) &&
            message.method === undefined
        ) {
            this.swallowInitializeId = null;
            return;
        }

        if (message.method !== undefined) {
            this.writeLine(line); // Server-to-client request (sampling, roots, ...).
            return;
        }

        const entry = this.pending.get(String(message.id));
        if (!entry) return; // Late response after a timeout or restart: drop it.

        this.pending.delete(String(message.id));
        if (entry.metered && entry.userId) {
            this.meter.disarmWatchdog(entry.userId);
            void this.meter.finish(entry.userId).then(() => this.writeLine(line));
            console.log(`[Tessera MCP] Metered call settled: ${entry.tool} for ${entry.userId}`);
        } else {
            this.writeLine(line);
        }
    }
}
