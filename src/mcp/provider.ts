/**
 * Provider entrypoint: wrap any stdio MCP server with per-second USDC billing.
 *
 * CLI usage (target command after `--`):
 *   node dist/mcp/provider.js -- npx -y @modelcontextprotocol/server-puppeteer
 *
 * Configuration comes from environment variables (never hardcoded):
 *   TESSERA_MCP_PAYOUT_ADDRESS     payee USDC address on Arc
 *   TESSERA_MCP_RATE_PER_SECOND    USDC per second of tool execution
 *   TESSERA_MCP_WATCHDOG_TIMEOUT_MS  hang cutoff (default 30000)
 *   TESSERA_BASE_URL               sidecar origin (default http://127.0.0.1:7878)
 *   TESSERA_INGEST_SECRET          same secret as the sidecar's .env
 *   TESSERA_MCP_TARGET_COMMAND     alternative to the `--` argv form
 */

import { isAddress } from 'viem';
import { McpMeteredProxy, type ProxyIo } from './proxy';
import type { ProviderConfig } from './types';

export function loadProviderConfigFromEnv(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    const payoutAddress = overrides.payoutAddress ?? process.env.TESSERA_MCP_PAYOUT_ADDRESS ?? '';
    const ratePerSecond = Number(
        overrides.ratePerSecond ?? process.env.TESSERA_MCP_RATE_PER_SECOND ?? '0'
    );
    const watchdogTimeoutMs = Number(
        overrides.watchdogTimeoutMs ?? process.env.TESSERA_MCP_WATCHDOG_TIMEOUT_MS ?? 30_000
    );
    const tesseraBaseUrl =
        overrides.tesseraBaseUrl ?? process.env.TESSERA_BASE_URL ?? 'http://127.0.0.1:7878';
    const ingestSecret = overrides.ingestSecret ?? process.env.TESSERA_INGEST_SECRET ?? '';
    const targetCommand = overrides.targetCommand ?? process.env.TESSERA_MCP_TARGET_COMMAND ?? '';

    if (!isAddress(payoutAddress)) {
        throw new Error('TESSERA_MCP_PAYOUT_ADDRESS must be a valid EVM address (Arc USDC payee).');
    }
    if (!Number.isFinite(ratePerSecond) || ratePerSecond < 0) {
        throw new Error('TESSERA_MCP_RATE_PER_SECOND must be a number >= 0.');
    }
    if (!Number.isFinite(watchdogTimeoutMs) || watchdogTimeoutMs < 100) {
        throw new Error('TESSERA_MCP_WATCHDOG_TIMEOUT_MS must be a number >= 100.');
    }
    if (!ingestSecret) {
        throw new Error('TESSERA_INGEST_SECRET is required (same value as the Tessera sidecar).');
    }
    if (typeof targetCommand !== 'string' || !targetCommand.trim()) {
        throw new Error('targetCommand is required: pass it as `-- <command>` or TESSERA_MCP_TARGET_COMMAND.');
    }

    return {
        payoutAddress,
        ratePerSecond,
        watchdogTimeoutMs,
        targetCommand,
        tesseraBaseUrl,
        ingestSecret,
        splits: overrides.splits,
    };
}

export function createMeteredProxy(config: ProviderConfig, io?: ProxyIo): McpMeteredProxy {
    const proxy = new McpMeteredProxy(config, io ?? { input: process.stdin, output: process.stdout });
    proxy.start();
    return proxy;
}

export async function runProviderCli(): Promise<void> {
    const argv = process.argv.slice(2);
    const separator = argv.indexOf('--');
    const targetFromArgv = separator >= 0 ? argv.slice(separator + 1).join(' ').trim() : '';
    const target =
        targetFromArgv || process.env.TESSERA_MCP_TARGET_COMMAND || '';

    if (!target) {
        console.error(
            'Usage: node dist/mcp/provider.js -- <mcp-server-command>\n' +
            'Example: node dist/mcp/provider.js -- npx -y @modelcontextprotocol/server-puppeteer'
        );
        process.exit(1);
    }

    const config = loadProviderConfigFromEnv({ targetCommand: target });
    const proxy = new McpMeteredProxy(config);
    proxy.start();
    console.log(
        `[Tessera MCP] Metering "${target}" at ${config.ratePerSecond} USDC/s -> ${config.payoutAddress}` +
        ` (watchdog ${config.watchdogTimeoutMs}ms)`
    );

    const shutdown = () => {
        proxy.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    void runProviderCli();
}
