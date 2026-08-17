# Viewer Wallet Guide

Tessera uses Circle **User-Controlled Wallets** (UCW). Viewers sign in in the browser with **email OTP** or **Google** (Facebook if the instance enables it). No browser extension and no seed phrase.

---

## 1. Creating Your Wallet

Open exclusive content or the tip button. The overlay asks you to sign in.

=== "Step 1: Sign in"
    **Continue with Google**, or enter your email and **Send email code**. Facebook appears when the instance has configured it.

=== "Step 2: Verify"
    Email: enter the one-time code Circle sends, then **Verify code**. Google: approve the Google window (the page may cover while it returns).

=== "Step 3: Wallet"
    First time, Circle opens a confirmation window (`needs_creation`). Confirm it. Tessera then shows your Arc SCA address.

=== "Step 4: Return later"
    Sign in again with the same email or Google account.

---

## 2. Funding & Depositing

Fund the SCA with USDC on **Arc Testnet**, then deposit into Gateway to watch or tip.

![Funding Panel Options](../assets/fund_wallet.png)

1. **Your Arc Wallet:** SCA address. Copy it with the clipboard icon.
2. **Bridge USDC:** Circle CCTP from Ethereum Sepolia, Base Sepolia, or Arbitrum Sepolia (MetaMask).
3. **USDC Faucet:** [faucet.circle.com](https://faucet.circle.com). Choose **Arc Testnet**.

Then pick a Gateway deposit amount (1 / 5 / 10 USDC or custom) and **Unlock Video** or **Enable Tipping**.

---

### How to use the Faucet

??? info "Show Faucet Step-by-Step"
    ![Circle Faucet Request](../assets/faucet_request.png)

    1. Copy your Arc address from the overlay.
    2. Paste it in the faucet **Wallet Address** field.
    3. Network: **Arc Testnet**.

---

### How to use the Bridge (CCTP)

??? info "Show Bridge Step-by-Step"
    ![CCTP Bridge Selector](../assets/bridge_select.png)

    1. Select the testnet where you already have USDC.
    2. Enter the amount (minimum 0.1 USDC).
    3. Confirm approve/burn in MetaMask. Circle Forwarding mints on Arc to your SCA.

---

## 3. Cashing Out

Exclusive sessions show **Just Leave** and **Cash Out & Exit**:

![Just Leave options](../assets/just_leave.png)

* **Just Leave:** Stops billing (`POST /end-session`). Unused Gateway USDC stays for the next watch.
* **Cash Out & Exit:** Withdraws leftover Gateway USDC to your SCA (`POST /cash-out`). The overlay polls the Circle challenge, then links the tx on [Arcscan](https://testnet.arcscan.app/).

![Cash Out Button](../assets/cash_out1.png)

![Cash Out Modal](../assets/cash_out2.png)

The tip widget uses **Cash Out & Exit** the same way.
