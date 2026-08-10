# Tessera Connector Specification

A connector is a single TypeScript file in `src/connectors/<name>.ts` that implements the `Connector` interface from `src/core/types.ts`.

Its only job: translate platform events into calls to the core's HTTP contract below.

---

## Core HTTP Contract

Base URL: `http://localhost:{PORT}/api/core`

All requests are localhost-only. The connector and the core run in the same process.

---

### POST /v1/sessions/start

Start billing a user.

```json
{
  "userId": "string",
  "resourceId": "string",
  "ratePerSecond": "0.000100",
  "payoutAddress": "0x...",
  "splits": [
    { "address": "0x...", "fraction": 0.1, "label": "platform-fee" }
  ],
  "metadata": {}
}
```

- `ratePerSecond` — decimal string in USDC. `"0"` is valid (tip-only mode).
- `splits` — optional. Sum of fractions must be `<= 1`. The remainder goes to `payoutAddress`.
- `metadata` — optional. Opaque key/value, never interpreted by the core.

**Response:** `{ "status": "session_started", "sessionId": "userId" }`

---

### POST /v1/sessions/stop

Stop billing a user.

```json
{ "userId": "string" }
```

**Response:** `{ "status": "session_stopped" }`

---

### POST /v1/tips

One-off tip, independent of any active session.

```json
{
  "userId": "string",
  "payoutAddress": "0x...",
  "amount": "0.100000"
}
```

- Requires the user to have a registered gateway session (`/register-session`).
- `amount` — decimal string in USDC.

**Response:** `{ "status": "success", "amount": "0.100000", "payoutAddress": "0x..." }`

---

## Connector Interface

```typescript
export interface Connector {
    readonly name: string;
    register(app: Express, config: ConnectorConfig): void;
}
```

`register()` is called once at startup. Mount all routes, webhooks, and static assets here.

---

## Rules

- Each connector is self-contained. It communicates with the core exclusively over the HTTP contract above.
- All identity resolution (payee address, splits, rate) is the connector's responsibility. The core receives already-resolved values.
- Connectors are isolated from each other. The dependency graph is: `connector → core HTTP`, never `connector → connector`.
- Webhook authentication uses `verifyConnectorSignature` from `src/core/security/verify-connector-signature.ts`.

---

## Adding a New Connector

1. Create `src/connectors/<name>.ts`.
2. Export a default object implementing `Connector`.
3. Register it in `tessera.config.ts` under `connectors`.
4. Add the secret `TESSERA_CONNECTOR_SECRET_<NAME_UPPERCASE>` to `.env`.
