# First Run

Once Tessera is installed and configured, it is ready to act as the payment gateway between your users and your self-hosted platform.

## 1. Start the Sidecar

If you haven't built the project yet, ensure you run `npm run build`.

To start Tessera in production mode, use:
```bash
npm run start
```

If you are developing or testing, you can run it directly with `ts-node` using:
```bash
npm run dev
```

You should see output similar to this in your terminal:
```
🚀 Tessera running on http://localhost:3000
📋 Active connectors: peertube
```

## 2. Verify the Proxy

Tessera intercepts incoming HTTP requests on port `3000` (or whatever port you configured) and transparently proxies them to your platform's `upstreamUrl` (e.g., port `9000` for PeerTube).

Open your web browser and navigate to:
```
http://localhost:3000
```

Instead of immediately seeing your platform's content, you should now be greeted by the **Tessera Paywall Overlay**. This overlay prompts users to connect their wallets or create a new Circle User-Controlled Wallet via email and PIN before they can access the content.

## What's Next?

Congratulations! Your platform is now monetized by the second. 

- To understand how the money flows in the background, read the [Architecture Guide](../architecture/payment-flow.md).
- To learn how to withdraw your earnings, see the [Admin Guide](../admin-guide/withdrawals.md).
