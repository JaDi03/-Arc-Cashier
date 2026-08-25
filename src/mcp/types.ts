/**
 * Types for the Tessera MCP connector: JSON-RPC 2.0 envelopes, MCP tool
 * payloads, provider/consumer configuration, and session lifecycle states.
 */

import type { Split } from '../core/types';

// ─── JSON-RPC 2.0 ────────────────────────────────────────────────────────────

export type JsonRpcId = number | string;

export interface JsonRpcErrorObject {
    code: number;
    message: string;
    data?: unknown;
}

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: JsonRpcId;
    method: string;
    params?: unknown;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: JsonRpcId;
    result?: unknown;
    error?: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

/**
 * Custom JSON-RPC error codes used by the connector, inside the reserved
 * server range (-32000 to -32099).
 */
export const TESSERA_RPC_ERRORS = {
    /** Watchdog fired: the tool hung, billing was cut, the call was aborted. */
    WATCHDOG_TIMEOUT: -32001,
    /** A metered tools/call arrived before tessera/identify. */
    IDENTIFY_REQUIRED: -32002,
    /** Another metered tools/call is already in flight for this consumer. */
    CALL_IN_FLIGHT: -32003,
} as const;

// ─── MCP payload subset used by the connector ────────────────────────────────

export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

export interface McpToolCallParams {
    name: string;
    arguments?: Record<string, unknown>;
    /** Optional Tessera consumer identity; used by the direct-SDK wrapper. */
    _meta?: { tesseraUserId?: string } & Record<string, unknown>;
}

export interface McpToolContentBlock {
    type: string;
    [key: string]: unknown;
}

export interface McpToolCallResult {
    content: McpToolContentBlock[];
    isError?: boolean;
    [key: string]: unknown;
}

// ─── Provider: tool host monetizing an MCP server ────────────────────────────

export interface TargetCommand {
    command: string;
    args?: string[];
}

export interface ProviderConfig {
    /** Payee USDC address on Arc receiving per-second tool earnings. */
    payoutAddress: string;
    /** USDC per second of tool execution, e.g. 0.001. */
    ratePerSecond: number;
    /** Abort metered calls that hang longer than this. */
    watchdogTimeoutMs: number;
    /**
     * MCP server to wrap. A string runs through a shell (supports
     * `npx -y ...`); a TargetCommand object spawns directly without a shell.
     */
    targetCommand: string | TargetCommand;
    /** Tessera sidecar origin, e.g. http://127.0.0.1:7878. */
    tesseraBaseUrl: string;
    /** Same value as TESSERA_INGEST_SECRET on the sidecar. */
    ingestSecret: string;
    /** Optional revenue splits per second, same semantics as media sessions. */
    splits?: Split[];
}

// ─── Consumer: autonomous agent paying per second ────────────────────────────

export interface ConsumerConfig {
    /** EVM private key (or Circle agent-wallet key) that signs Gateway ticks. Never logged. */
    agentPrivateKey: `0x${string}`;
    /** Hard cap on total USDC this consumer will ever pay through its tick loop. */
    maxBudgetUsdc: number;
    /** Tessera sidecar origin that settles ticks (/api/core/stream-access). */
    tesseraBaseUrl: string;
    /** Arc JSON-RPC endpoint. Default: public Arc testnet RPC. */
    rpcUrl?: string;
    /** Optional one-time Gateway deposit when the balance is below budget. */
    depositUsdc?: number;
    /** Tick cadence while a tool executes. Default 1000ms. */
    tickIntervalMs?: number;
    /** Per-call wall-clock cap. Defaults to the budget-derived ceiling. */
    callTimeoutMs?: number;
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

export enum SessionState {
    /** Connected, no metered call running. */
    IDLE = 'IDLE',
    /** A tool call is executing and ticks are being signed. */
    METERING = 'METERING',
    /** Tick signing halted (budget exhausted); the call is being aborted. */
    PAUSED = 'PAUSED',
    /** Call ended and the billing session was closed. */
    STOPPED = 'STOPPED',
    /** Watchdog or local deadline fired; billing was cut at the timeout. */
    TIMEOUT = 'TIMEOUT',
}

/** Result of the tessera/identify handshake exposed by the provider proxy. */
export interface IdentifyResult {
    userId: string;
    payoutAddress: string;
    ratePerSecond: number;
    watchdogTimeoutMs: number;
    network: 'arc-testnet';
    currency: 'USDC';
}
