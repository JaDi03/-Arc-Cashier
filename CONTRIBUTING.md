# Contributing to Tessera

## Development

```bash
npm install
cp .env.example .env
npm run typecheck
npm run lint
npm run test
npm run build:ui
```

## Adding a platform

Do **not** add code under this repo for a new platform. Implement a plugin or webhook client against [CONNECTOR_SPEC.md](CONNECTOR_SPEC.md).

## Pull requests

- Conventional commits when possible (`feat`, `fix`, `docs`, …).
- Keep Circle / Arc payment changes aligned with Canteen docs when touching the rail.
- Do not commit `.env`, secrets, or local agent folders (`.agents/`, `.cursor/`, `.context/`).
