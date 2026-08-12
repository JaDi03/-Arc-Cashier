# Tessera Integration Contract

Plugins and platform services call the core HTTP API. Tessera does not embed platform adapters.

**Base URL (plugin setting):** HTTP origin where the platform server reaches Tessera. How to set it: [Quick Start §3](docs/getting-started/index.md#3-tessera-base-url).

API paths below are relative to `{Base URL}/api/core`.

## Auth (sessions only)

`POST /v1/sessions/start` and `POST /v1/sessions/stop` require:

- Env on Tessera: `TESSERA_INGEST_SECRET`
- Headers: `X-Tessera-Timestamp`, `X-Tessera-Nonce`, `X-Tessera-Signature`
- Signature: `HMAC-SHA256(secret, \`${timestamp}.${nonce}.${rawBody}\`)` hex digest
- Replay window: 60s; nonces are single-use

Tips (`POST /v1/tips`) use the viewer Gateway session, not ingest HMAC.

## POST /v1/sessions/start

```json
{
  "userId": "string",
  "resourceId": "string",
  "ratePerSecond": "0.000100",
  "payoutAddress": "0x...",
  "splits": [
    { "address": "0x...", "fraction": 0.1, "label": "display-admin" }
  ],
  "metadata": {}
}
```

- `ratePerSecond`: USDC decimal string. `"0"` is tip-only.
- `splits`: optional; sum of fractions `<= 1`; remainder goes to `payoutAddress`.
- Resolve payee, rate, and splits in the plugin before calling.

Response: `{ "status": "session_started", "sessionId": "userId" }`

## POST /v1/sessions/stop

```json
{ "userId": "string" }
```

Response: `{ "status": "session_stopped" }`

## POST /v1/tips

```json
{
  "userId": "string",
  "payoutAddress": "0x...",
  "amount": "0.100000"
}
```

Requires a registered Gateway session for `userId`.

## Assets

UI bundles: `GET {PUBLIC_URL}/assets/paywall.bundle.js` (and related files under `/assets`).

## Creator

- `GET /api/core/creator/balance?address=`
- `POST /api/core/creator/prepare-withdraw`
- `POST /api/core/creator/complete-withdraw`
- `GET /api/core/creator/stats?address=`
