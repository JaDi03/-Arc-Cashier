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

## 3. Fast Setup

Tessera includes a fast setup script that will prepare your environment variables file. Run the setup script:

```bash
npm run setup
```

This script will automatically copy the `.env.example` file and create a new `.env` file for you, ready to be filled with your private keys and configuration details. You can proceed to the [Configuration guide](configuration.md) to learn which keys you need to add.

## 4. Build the Project

Once the dependencies are installed, compile the TypeScript source code into production-ready JavaScript:

```bash
npm run build
```

This will compile the backend into the `dist/` directory and prepare the frontend assets.

---

With the engine built, the next step is to ensure your variables and connectors are properly defined in the [Configuration phase](configuration.md).
