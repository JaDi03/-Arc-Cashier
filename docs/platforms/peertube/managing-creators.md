# Admin Configuration (Platform Fees)

As the administrator of the PeerTube instance, you provide the hosting and bandwidth. Therefore, Tessera allows you to configure a "Platform Fee" that is automatically deducted from the per-second payments before the funds reach the video creator's wallet.

## Environment Variables

To collect your platform fees, you must configure two critical variables in the `.env` file of your **Tessera** server (not PeerTube):

```env
# The private key of the Administrator's wallet where fees will be deposited
SELLER_PRIVATE_KEY="0xYourHexPrivateKey"

# A shared secret password between the PeerTube Plugin and Tessera
PEERTUBE_WEBHOOK_SECRET="super_secret_random_123"
```

### Why `PEERTUBE_WEBHOOK_SECRET`?
The administrator withdrawal endpoint (`POST /api/connectors/peertube/seller/withdraw`) is protected to ensure external attackers cannot indiscriminately trigger your withdrawals or query your balance. Only the PeerTube Plugin knows this secret.

## Withdrawing Platform Fees

You do not need to interact with the terminal to withdraw your funds.
1. Log in to PeerTube as an Administrator.
2. Navigate to the **Settings** of the Tessera plugin.
3. The plugin will use the `PEERTUBE_WEBHOOK_SECRET` to securely query Tessera and display your accumulated balance.
4. Click **Withdraw Platform Fees**. The Tessera backend will use your `SELLER_PRIVATE_KEY` to sign the withdrawal transaction on the Arc network and send the USDC directly to your wallet.
