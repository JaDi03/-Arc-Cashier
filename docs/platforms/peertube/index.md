# PeerTube Integration

Tessera integrates natively with PeerTube via an official plugin. Unlike other monolithic platforms, **PeerTube does not require setting up a reverse proxy**, as the plugin handles injecting the paywall directly into the video interface automatically.

This guide assumes you already have a PeerTube instance running and that you have Administrator access.

## Plugin Installation

The official Tessera plugin for PeerTube is not available in the public NPM registry, so it must be cloned and installed directly from its GitHub repository.

### Step 1: Clone and Build
SSH into your PeerTube server, navigate to the plugins directory, and run:

```bash
cd /var/www/peertube/storage/plugins
git clone https://github.com/JaDi03/peertube-plugin-tessera
cd peertube-plugin-tessera
npm install
npm run build
```

### Step 2: Enable in PeerTube
Next, install the plugin locally using the PeerTube CLI:

```bash
cd /var/www/peertube/peertube-server
NODE_ENV=production npm run plugin:install -- --plugin-path /var/www/peertube/storage/plugins/peertube-plugin-tessera
```

### Step 3: Configure the Tessera URL
1. Log in to your PeerTube instance as an Administrator.
2. Go to **Administration** > **Plugins/Themes** > **Local**.
3. Locate **Tessera Paywall Plugin** and click **Settings**.
4. In the `Tessera Backend URL` field, enter the public URL of your Tessera instance (e.g., `https://tessera.my-server.com`).

Once configured, the PeerTube plugin will begin displaying the paywall on your videos and automatically sending per-second billing webhooks to the Tessera backend.
