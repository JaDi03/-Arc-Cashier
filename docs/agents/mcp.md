# Model Context Protocol (MCP) & Autonomous Agents

Tessera provides a **zero-code streaming payment proxy and SDK** for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). 

It enables AI tool developers (Admins) to meter tool execution time and collect gasless per-second micropayments in USDC on **Arc** via Circle Gateway, while enabling autonomous agents (Consumers like OpenClaw, Hermes, and Eliza) to pay for persistent compute on-demand with built-in watchdog protection.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────┐
│  AI Client / Autonomous Agent (Claude / Hermes / OpenClaw)
└──────────────────────────┬─────────────────────────────┘
                           │ stdio JSON-RPC 2.0
                           ▼
┌────────────────────────────────────────────────────────┐
│             TESSERA MCP PROXY (stdio)                  │
│  - Unmetered discovery (`initialize`, `tools/list`)   │
│  - Intercepts `tools/call` execution                   │
│  - Starts session on Tessera Core (`sessions/start`)   │
│  - Watchdog timer monitors tool health & timeout       │
│  - Streams Gateway ticks per elapsed second            │
│  - Settles session on completion (`sessions/stop`)     │
└──────────────────────────┬─────────────────────────────┘
                           │ Child Process (stdin / stdout)
                           ▼
┌────────────────────────────────────────────────────────┐
│  Target MCP Tool Server (Puppeteer, Python Sandbox)    │
└────────────────────────────────────────────────────────┘
```

---

## 1. For Tool Providers (Admins / Hosts)

Monetize any open-source or custom MCP tool server without modifying its code.

### A. Zero-Code Wrapping via CLI Proxy

Wrap any target command (e.g. `@modelcontextprotocol/server-puppeteer` or a Python script):

```bash
# Wrap a package command
node dist/mcp/proxy.js \
  --target "npx -y @modelcontextprotocol/server-puppeteer" \
  --rate 0.0005 \
  --payout 0xYourArcPayoutAddress \
  --watchdog 10000
```

### Configuration Options

| Option | Flag | Env Var | Default | Description |
|---|---|---|---|---|
| Payout Address | `--payout` | `TESSERA_PAYOUT_ADDRESS` | *Required* | Creator `0x` EVM address on Arc |
| Rate / Second | `--rate` | `TESSERA_RATE_PER_SECOND` | `0.0001` | Decimal USDC per elapsed second |
| Watchdog Timeout | `--watchdog` | `TESSERA_WATCHDOG_TIMEOUT_MS` | `10000` | Max milliseconds before cutting hung tools |
| Target Command | `--target` | `TESSERA_TARGET_COMMAND` | *Required* | Child command to execute |
| Tessera Base URL | `--base-url` | `TESSERA_BASE_URL` | `http://127.0.0.1:7878` | Server-to-server Tessera Core URL |
| Ingest Secret | `--secret` | `TESSERA_INGEST_SECRET` | *Required* | HMAC secret matching `.env` |

---

## 2. For Autonomous Agents (Consumers)

Autonomous agents running 24/7 (such as OpenClaw, Hermes, or Eliza) consume paid tools programmatically without human intervention or browser OTP popups.

### A. Autonomous Wallet & Gateway Flow

1. **Agent Key**: The agent generates or loads an EVM private key (`0x...`) on Arc Testnet (Chain ID `5042002`).
2. **Gateway Balance**: The agent maintains a USDC balance in Circle Gateway.
3. **Session Handshake**: When connecting, the consumer performs `tessera/identify` to discover tool pricing and network parameters.
4. **Execution & Signing**: During tool execution, the agent signs Gateway micropayments per elapsed second.
5. **Budget Guard**: If cumulative spend hits `maxBudgetUsdc`, the consumer client halts tick signing and safely cancels the in-flight tool call.

### B. Programmatic Usage (TypeScript / Node.js)

```typescript
import { TesseraMcpConsumer } from 'tessera/mcp';

const consumer = new TesseraMcpConsumer({
  agentPrivateKey: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  maxBudgetUsdc: 5.00, // Hard limit: maximum 5 USDC total spend
  tesseraBaseUrl: 'http://127.0.0.1:7878',
  targetCommand: 'node dist/mcp/proxy.js --target "npx -y @modelcontextprotocol/server-puppeteer"',
});

await consumer.connect();

// Execute a paid tool call autonomously
const result = await consumer.callTool('puppeteer_navigate', {
  url: 'https://arc.network',
});

console.log('Result:', result);
await consumer.disconnect();
```

---

## 3. Desktop AI Client Setup (Claude / Cursor)

To use a monetized MCP tool inside Claude Desktop:

Add the proxy to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "metered-puppeteer": {
      "command": "node",
      "args": [
        "/path/to/tessera/dist/mcp/proxy.js",
        "--target", "npx -y @modelcontextprotocol/server-puppeteer",
        "--rate", "0.0005",
        "--payout", "0xYourArcPayoutAddress"
      ],
      "env": {
        "TESSERA_INGEST_SECRET": "your-sidecar-ingest-secret"
      }
    }
  }
}
```

---

## 4. Built-in Watchdog Protection

When dealing with AI agents and complex tool execution (e.g. web scraping, heavy math, code execution sandboxes), tools can occasionally deadlock or enter infinite loops.

* **Automated Timeout**: If a tool fails to return a JSON-RPC response within `watchdogTimeoutMs`, the Tessera Watchdog fires.
* **Instant Billing Cut**: Tessera immediately sends `POST /api/core/v1/sessions/stop` to freeze billing, ensuring the consumer is never overcharged.
* **Self-Healing Process**: The hung child process is terminated (`SIGTERM`/`SIGKILL`), a clean child instance is respawned, and a sanitized JSON-RPC error code (`-32001 WATCHDOG_TIMEOUT`) is returned.
