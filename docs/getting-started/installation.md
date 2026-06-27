# Installation

Installing Tessera is straightforward. It runs as a standard Node.js application.

## 1. Clone the Repository

Begin by cloning the official repository from GitHub to the machine where you intend to run the sidecar.

```bash
git clone https://github.com/JaDi03/tessera.git
cd tessera
```

## 2. Install Dependencies

Install the required NPM packages. We recommend using `npm`, though `yarn` or `pnpm` will also work.

```bash
npm install
```

## 3. Interactive Setup

Tessera includes an interactive setup wizard that configures the sidecar for your specific platform. Run the setup script:

```bash
npm run setup
```

![Tessera Setup Wizard](../assets/run_setup.png)

This wizard will automatically:
1. Ask which platform you want to monetize (e.g., PeerTube, Owncast).
2. Ask for the local upstream URL where your platform is running.
3. Configure `src/tessera.config.ts` with those details.
4. Generate a secure `.env` file (including webhook secrets if needed).

You can then proceed to the [Configuration guide](configuration.md) to add your Circle API keys.

## 4. Build the Project

Once the dependencies are installed, compile the TypeScript source code into production-ready JavaScript:

```bash
npm run build
```

This will compile the backend into the `dist/` directory and prepare the frontend assets.

---

With the engine built, the next step is to ensure your variables and connectors are properly defined in the [Configuration phase](configuration.md).
