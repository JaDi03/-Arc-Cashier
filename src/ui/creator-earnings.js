/**
 * Creator earnings panel: Gateway balance + MetaMask (EIP-712 BurnIntent) withdraw.
 * Mounted by connectors via window.ArcCashier.initCreatorEarnings({ wallet, apiBase?, mount? }).
 * Kept separate from paywall.js to avoid growing the viewer paywall further.
 */

const ARC_CHAIN_ID_HEX = '0x4cef52'; // 5042002 Arc Testnet
const ARCSCAN_TX = 'https://testnet.arcscan.app/tx/';

function resolveApiBase(explicit) {
    if (explicit) return explicit.replace(/\/$/, '');
    const scriptSrc = (document.currentScript && document.currentScript.src)
        ? document.currentScript.src
        : '';
    if (scriptSrc) {
        return scriptSrc.replace(/\/[^/]*assets\/[^?#]*.*$/, '');
    }
    return window.location.origin;
}

async function ensureArcNetwork(ethereum) {
    try {
        await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: ARC_CHAIN_ID_HEX }],
        });
    } catch (err) {
        if (err && err.code === 4902) {
            await ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId: ARC_CHAIN_ID_HEX,
                    chainName: 'Arc Testnet',
                    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
                    rpcUrls: ['https://rpc.testnet.arc.network'],
                }],
            });
        } else {
            throw err;
        }
    }
}

async function connectCreatorWallet(expectedWallet) {
    const ethereum = window.ethereum;
    if (!ethereum) throw new Error('Install MetaMask to withdraw earnings.');
    const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
    const connected = accounts && accounts[0];
    if (!connected) throw new Error('No MetaMask account selected.');
    if (connected.toLowerCase() !== expectedWallet.toLowerCase()) {
        throw new Error('Connect the wallet configured as creator (' + expectedWallet + ').');
    }
    await ensureArcNetwork(ethereum);
    return connected;
}

function shortenAddress(addr) {
    if (!addr || addr.length < 12) return addr || '';
    return addr.slice(0, 6) + '…' + addr.slice(-4);
}

/**
 * @param {{ wallet: string, apiBase?: string, mount?: HTMLElement|string, title?: string }} options
 */
export function initCreatorEarnings(options) {
    const wallet = (options && options.wallet ? String(options.wallet) : '').trim();
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
        console.warn('[Tessera] initCreatorEarnings: invalid or missing wallet');
        return null;
    }

    const apiBase = resolveApiBase(options && options.apiBase);
    const title = (options && options.title) || 'Creator Earnings';

    let mount = options && options.mount;
    if (typeof mount === 'string') mount = document.querySelector(mount);
    if (!mount) mount = document.body;

    const existing = document.getElementById('tessera-creator-earnings');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'tessera-creator-earnings';
    panel.className = 'tessera-creator-earnings arc-tessera-root';
    panel.innerHTML =
        '<h4 class="tce-title">' + title + '</h4>' +
        '<div class="tce-wallet" title="' + wallet + '">' + shortenAddress(wallet) + '</div>' +
        '<div class="tce-balance" data-tce-balance>—</div>' +
        '<button type="button" class="tce-btn tce-btn-balance" data-tce-action="balance">Check Balance</button>' +
        '<button type="button" class="tce-btn tce-btn-withdraw" data-tce-action="withdraw">Withdraw Earnings</button>' +
        '<div class="tce-status" data-tce-status></div>';

    mount.appendChild(panel);

    const balanceEl = panel.querySelector('[data-tce-balance]');
    const statusEl = panel.querySelector('[data-tce-status]');

    async function refreshBalance() {
        if (balanceEl) balanceEl.textContent = 'Loading…';
        if (statusEl) statusEl.textContent = '';
        try {
            const res = await fetch(
                apiBase + '/api/core/creator/balance?address=' + encodeURIComponent(wallet),
                { credentials: 'same-origin' }
            );
            const data = await res.json().catch(function () { return {}; });
            if (!res.ok) throw new Error(data.error || 'Balance fetch failed');
            const withdrawable = Number(data.gatewayWithdrawable ?? data.gatewayAvailable ?? 0);
            if (balanceEl) balanceEl.textContent = '$' + withdrawable.toFixed(4) + ' USDC';
        } catch (err) {
            if (balanceEl) balanceEl.textContent = (err && err.message) || 'Error';
        }
    }

    async function withdraw() {
        if (statusEl) statusEl.textContent = 'Preparing withdrawal…';
        try {
            const connected = await connectCreatorWallet(wallet);
            if (statusEl) statusEl.textContent = 'Fetching BurnIntent from Tessera…';

            const prepareRes = await fetch(apiBase + '/api/core/creator/prepare-withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ address: connected }),
            });
            const prepareData = await prepareRes.json().catch(function () { return {}; });
            if (!prepareRes.ok) throw new Error(prepareData.error || 'Could not prepare withdrawal');
            if (prepareData.status === 'no_funds') {
                if (statusEl) statusEl.textContent = 'No withdrawable balance yet.';
                return;
            }

            if (statusEl) statusEl.textContent = 'Sign the BurnIntent in MetaMask…';
            const signature = await window.ethereum.request({
                method: 'eth_signTypedData_v4',
                params: [connected, JSON.stringify(prepareData.typedData)],
            });

            if (statusEl) statusEl.textContent = 'Submitting signature…';
            const completeRes = await fetch(apiBase + '/api/core/creator/complete-withdraw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    address: connected,
                    burnIntent: prepareData.burnIntent,
                    signature: signature,
                }),
            });
            const completeData = await completeRes.json().catch(function () { return {}; });
            if (!completeRes.ok) throw new Error(completeData.error || 'Withdraw attestation failed');

            completeData.txRequest.from = connected;
            if (statusEl) statusEl.textContent = 'Confirm mint in MetaMask…';
            const txHash = await window.ethereum.request({
                method: 'eth_sendTransaction',
                params: [completeData.txRequest],
            });

            if (statusEl) {
                statusEl.innerHTML =
                    '<a class="tce-tx-link" href="' + ARCSCAN_TX + txHash + '" target="_blank" rel="noopener">' +
                    'View transaction on Arcscan</a>';
            }
            await refreshBalance();
        } catch (err) {
            if (statusEl) statusEl.textContent = (err && err.message) || 'Withdraw failed';
        }
    }

    panel.addEventListener('click', function (e) {
        const btn = e.target && e.target.closest ? e.target.closest('[data-tce-action]') : null;
        if (!btn) return;
        const action = btn.getAttribute('data-tce-action');
        if (action === 'balance') void refreshBalance();
        if (action === 'withdraw') void withdraw();
    });

    void refreshBalance();
    return panel;
}
