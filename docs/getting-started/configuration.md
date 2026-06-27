# Configuration

Tessera requires two layers of configuration: environment variables for security credentials, and the sidecar config file for routing logic.

## 1. Environment Variables (`.env`)

If you ran the `npm run setup` script during installation, your `.env` file was automatically created for you. If not, you can manually copy the example template:

```bash
cp .env.example .env
```

Open `.env` in your text editor. Ensure the following critical variables are set:

| Variable | Description |
| :--- | :--- |
| `CIRCLE_API_KEY` | Your backend key from the Circle Console. |
| `CIRCLE_APP_ID` | Your frontend UI App ID from the Circle Console. |
| `SELLER_ADDRESS` | The EVM-compatible address where your earnings will be sent. |
| `SELLER_PRIVATE_KEY` | The private key to `SELLER_ADDRESS`. This is required to process withdrawals automatically via the `/seller/withdraw` endpoint. |

> [!CAUTION]
> **Security Warning**
> 
> Never commit your `.env` file to version control. Your `SELLER_PRIVATE_KEY` must remain strictly private. If anyone gains access to this key, they control your funds.

## 2. Sidecar Configuration (`tessera.config.ts`)

> [!TIP]
> **Automatically Configured!**
> If you ran the `npm run setup` wizard, this file was already configured for you with your chosen platform and upstream URL. You only need to edit this file if you want to change your pricing rate, port, or add more platforms manually.

The sidecar's routing logic and pricing are defined in `src/tessera.config.ts`. This file tells Tessera which port to listen on, what platforms to proxy traffic to, and how much to charge viewers.

Open `src/tessera.config.ts` to review or modify your settings. It looks like this:

```typescript
import type { CashierConfig } from './core/types';

const config: CashierConfig = {
    port: 3000,
    connectors: [
        {
            name: 'peertube',
            upstreamUrl: 'http://localhost:9000',
            ratePerSecond: 0.0001,
        },
    ],
};

export default config;
```

### Options

- **`port`**: The port Tessera will bind to. (Default: 3000).
- **`connectors`**: An array of enabled platforms.
- **`name`**: The identifier of the connector (e.g., `'peertube'`, `'owncast'`).
- **`upstreamUrl`**: The local URL where your actual platform is running. Tessera will intercept traffic, inject the paywall, and forward the rest of the requests to this URL.
- **`ratePerSecond`**: How much USDC to charge viewers per second of active session time.

To enable a new platform, simply add its configuration to the `connectors` array and re-run `npm run build`.

---

Once configured, you are ready to boot up the sidecar. Head over to the [First Run](first-run.md) guide.
