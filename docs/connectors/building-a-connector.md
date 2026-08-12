# Integrating a platform

Tessera has no in-repo platform adapters. Your plugin or native service calls the HTTP contract:

See [CONNECTOR_SPEC.md](../../CONNECTOR_SPEC.md).

Summary:

1. On join / playback start: `POST /api/core/v1/sessions/start` (HMAC with `TESSERA_INGEST_SECRET`).
2. On leave / stop: `POST /api/core/v1/sessions/stop`.
3. Resolve `payoutAddress`, `ratePerSecond`, and `splits` in the plugin before calling.
4. Load UI from `{PUBLIC_URL}/assets/`.
