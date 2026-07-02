# Configuration

After installing the Tessera plugin on your PeerTube instance, you must configure the backend connection. The configuration is split into two parts: **Global Configuration** for the instance administrator, and **Channel Configuration** for individual content creators.

## Global Configuration (Administrator)

As the administrator of the PeerTube instance, you must link the plugin to your Tessera sidecar and configure your foundational platform wallet.

1. Log in to your PeerTube instance as an Administrator.
2. Go to **Administration** > **Plugins/Themes** > **Installed**.
3. Locate the **plugin tessera** and click **Settings**.

You will see the following configuration panel:

![PeerTube Plugin Settings](../../assets/peertube_plugin_settings.png)

### Field Guide

1. **Tessera Base URL**: The public URL where your Tessera backend is running (e.g., `https://tessera.yourdomain.com`). This is the same URL you configured during the `npm run setup` process.
2. **Tessera Webhook URL**: The exact route where PeerTube will send server-side events. This must be your base URL appended with `/api/connectors/peertube/webhook`.
3. **Tessera Webhook Secret**: The `WEBHOOK_SECRET` randomly generated during your `npm run setup` process. You can find this inside your Tessera `.env` file. This ensures all communication is cryptographically signed and secure.
4. **Max Active Viewers**: The maximum number of concurrent viewers allowed in memory. `10000` is the recommended default to protect your server.
5. **Admin Wallet (Arc Network)**: Your public wallet address (e.g., `0x...`) on the Arc Network. This is a **mandatory** field.

> [!IMPORTANT]
> **Why the Admin Wallet is Required**
> The core Tessera engine uses your Admin Wallet as the foundational routing address to interface with the Circle Gateway. Without it, the engine will block all viewer deposits with a 400 Error. 
> By default, the system automatically routes a fixed **10%** of all per-second micropayments to this address to help cover your hosting costs, while the remaining **90%** goes directly to the creators. This uses a **deterministic tick-routing engine** rather than a percentage calculation at the end of the session, guaranteeing that exactly 1 out of every 10 nanopayments goes straight to the admin's wallet.

Once you have filled out these fields, click **Update plugin settings**.

## Channel Configuration (Creator)

*(This section will explain how individual creators set up their wallets and pricing. To be documented).*
