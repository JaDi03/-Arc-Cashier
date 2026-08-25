/**
 * Public API of the Tessera MCP connector.
 *
 * - Provider: wrap any stdio MCP server with per-second USDC billing
 *   (createMeteredProxy, McpMeteredProxy, loadProviderConfigFromEnv).
 * - Consumer: autonomous agents pay per second with their own key, under a
 *   hard budget cap (TesseraMcpConsumer, BudgetGuard).
 * - Direct SDK: meter an in-process handler (withTesseraMeter).
 */

export * from './types';
export { TesseraIngestClient } from './ingest';
export { ToolMeter } from './meter';
export type { ToolMeterOptions } from './meter';
export { McpMeteredProxy, resolveTarget } from './proxy';
export type { ProxyIo } from './proxy';
export { createMeteredProxy, loadProviderConfigFromEnv, runProviderCli } from './provider';
export { TesseraMcpConsumer, BudgetGuard, BudgetExceededError } from './consumer';
export { withTesseraMeter } from './sdk';
export type { WithTesseraMeterOptions } from './sdk';
