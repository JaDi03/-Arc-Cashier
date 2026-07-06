# Contributing to Tessera

Thank you for your interest in contributing to Tessera! This document outlines the process for contributing to the project.

## Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct. Please be respectful and professional in all interactions.

## Reporting Bugs

If you find a bug, please open an issue in the GitHub repository. Include:
1. A clear and descriptive title.
2. Steps to reproduce the bug.
3. Expected behavior vs actual behavior.
4. Information about your environment (Node version, OS, etc.).

## Pull Request Workflow

1. **Fork the repository** and create your branch from `main`.
2. **Setup your environment** using the recommended flow (`nvm use`, `npm install`).
3. **Make your changes** ensuring that the code is clean and modular.
4. **Run checks** locally before pushing:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
5. **Commit your changes** using conventional commit messages (e.g., `feat:`, `fix:`, `docs:`).
6. **Submit a Pull Request**. Nuestro CI pipeline will automatically run checks against your branch. Wait for the pipeline to pass (turn green) and respond to any code review feedback.

## Proposing New Connectors

Tessera is designed to be easily extensible. If you want to add support for a new self-hosted platform (e.g., PeerTube, Jellyfin):

1. Create a new folder under `src/connectors/<your-platform>`.
2. Implement the `Connector` interface defined in `src/core/types.ts`.
3. Provide a simple `README.md` inside your connector folder explaining how to configure the webhooks or integration APIs for your platform.
4. Add your connector to the `CONNECTOR_REGISTRY` en `src/server.ts` (optional for local forks, but required if you want it merged upstream).

We welcome all new platform integrations!
