// arc-paywall.js - Universal Paywall Engine (platform-agnostic)
// Injected or embedded by any Tessera connector (Owncast, PeerTube, etc.)

import { W3SSdk } from '@circle-fin/w3s-pw-web-sdk';

// ─── Constants (all values verified from official docs) ──────────────────────

const SCRIPT_SRC = (document.currentScript && document.currentScript.src) ? document.currentScript.src : '';
const SCRIPT_BASE_DIR = SCRIPT_SRC ? SCRIPT_SRC.substring(0, SCRIPT_SRC.lastIndexOf('/') + 1) : '/demo-assets/';
const ARC_API_BASE = SCRIPT_SRC ? new URL(SCRIPT_SRC).origin : window.location.origin;

// Arc Testnet — Chain ID verified from docs.arc.network
const ARC_CHAIN_ID = 5042002;
const ARC_CHAIN_ID_HEX = '0x' + ARC_CHAIN_ID.toString(16);

// Arc Testnet — USDC native token address (verified from Circle docs)
const ARC_USDC = '0x3600000000000000000000000000000000000000';

// CCTP — Source chains supported in testnet (verified from Circle docs)
// TokenMessengerV2 is the same address on all EVM testnets
const TOKEN_MESSENGER_V2 = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';

const CCTP_CHAINS = [
    {
        name: 'Ethereum Sepolia',
        chainId: 11155111,
        chainIdHex: '0xaa36a7',
        domain: 0,
        usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        rpcUrl: 'https://rpc.sepolia.org',
        blockExplorer: 'https://sepolia.etherscan.io',
        icon: '🔷',
    },
    {
        name: 'Base Sepolia',
        chainId: 84532,
        chainIdHex: '0x14a34',
        domain: 6,
        usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        rpcUrl: 'https://sepolia.base.org',
        blockExplorer: 'https://base-sepolia.blockscout.com',
        icon: '🔵',
    },
    {
        name: 'Arbitrum Sepolia',
        chainId: 421614,
        chainIdHex: '0x66eee',
        domain: 3,
        usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
        rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
        blockExplorer: 'https://sepolia.arbiscan.io',
        icon: '🔶',
    },
];

// Minimum balance required in the Arc wallet before enabling the unlock button
const MIN_ARC_BALANCE_WEI = BigInt('10000000000000000'); // 0.01 USDC (18 decimals)

// ─── State ───────────────────────────────────────────────────────────────────

let arcSdk = null;
let viewerState = {
    userId: localStorage.getItem('arc_cashier_user_id'),
    userToken: null,
    encryptionKey: null,
    appId: null,
    walletId: localStorage.getItem('arc_circle_wallet_id'),
    walletAddress: localStorage.getItem('arc_circle_wallet_address'),
    ephemeralPk: localStorage.getItem('arc_ephemeral_pk'),
};
let balancePollingInterval = null;

// ─── Init ────────────────────────────────────────────────────────────────────

function initPaywall() {
    injectDependencies();
    document.body.classList.add('arc-locked');
    lockMedia();
    renderPaywallOverlay();
    renderSessionManager();
}

function injectDependencies() {
    if (!document.getElementById('arc-paywall-css')) {
        const link = document.createElement('link');
        link.id = 'arc-paywall-css';
        link.rel = 'stylesheet';
        link.href = SCRIPT_BASE_DIR + 'paywall.css';
        document.head.appendChild(link);
    }
}

function lockMedia() {
    document.addEventListener('play', (e) => {
        if (document.body.classList.contains('arc-locked') &&
            (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
            e.target.pause();
        }
    }, true);
    setInterval(() => {
        if (document.body.classList.contains('arc-locked')) {
            document.querySelectorAll('video, audio').forEach(m => { if (!m.paused) m.pause(); });
        }
    }, 500);
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

function renderPaywallOverlay() {
    const existing = document.getElementById('arc-paywall-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'arc-paywall-overlay';
    overlay.innerHTML = `
        <div id="arc-paywall-modal">
            <div id="arc-paywall-header">
                <div id="arc-paywall-logo">⚡ Tessera</div>
                <h2>Premium Stream</h2>
                <p>Pay only for the seconds you watch. No subscriptions.</p>
            </div>
            <div id="arc-paywall-body">
                <div id="arc-phase-login" class="arc-phase arc-phase-active">
                    <div class="arc-pricing-box">
                        <div class="arc-pricing-row">
                            <span>Rate</span>
                            <span class="arc-accent">$0.0001 USDC / sec</span>
                        </div>
                        <div class="arc-pricing-row">
                            <span>Min. deposit</span>
                            <span class="arc-accent">1.00 USDC</span>
                        </div>
                        <p class="arc-pricing-note">Unused funds stay in your wallet.</p>
                    </div>
                    <button id="arc-login-btn" class="arc-btn arc-btn-primary">
                        <span class="arc-btn-icon">🔐</span>
                        Sign in with PIN
                    </button>
                    <p id="arc-login-status" class="arc-status-text" style="display:none;"></p>
                </div>

                <div id="arc-phase-fund" class="arc-phase" style="display:none;">
                    <div id="arc-wallet-address-box" class="arc-info-box">
                        <span class="arc-info-label">Your Arc Wallet</span>
                        <div class="arc-address-row">
                            <span id="arc-wallet-display" class="arc-address-text"></span>
                            <button id="arc-copy-btn" class="arc-copy-btn" title="Copy address">📋</button>
                        </div>
                    </div>

                    <p class="arc-fund-label">Fund your wallet to watch:</p>

                    <div class="arc-fund-options">
                        <button id="arc-bridge-btn" class="arc-fund-card">
                            <span class="arc-fund-icon">🌉</span>
                            <div>
                                <strong>Bridge from another chain</strong>
                                <span>Ethereum, Base, Arbitrum</span>
                            </div>
                            <span class="arc-chevron">›</span>
                        </button>

                        <a href="https://faucet.circle.com" target="_blank" rel="noopener" class="arc-fund-card">
                            <span class="arc-fund-icon">🚰</span>
                            <div>
                                <strong>Get test USDC (Faucet)</strong>
                                <span>faucet.circle.com</span>
                            </div>
                            <span class="arc-chevron">↗</span>
                        </a>
                    </div>

                    <div id="arc-waiting-balance" class="arc-waiting-box" style="display:none;">
                        <div class="arc-spinner-sm"></div>
                        <span>Waiting for funds to arrive on Arc…</span>
                    </div>

                    <button id="arc-unlock-btn" class="arc-btn arc-btn-primary arc-btn-disabled" disabled>
                        🔓 Unlock Video
                    </button>
                    <p id="arc-fund-status" class="arc-status-text" style="display:none;"></p>
                </div>
            </div>
        </div>

        <!-- CCTP Bridge Modal -->
        <div id="arc-cctp-modal" class="arc-modal-backdrop" style="display:none;">
            <div class="arc-modal-box">
                <div class="arc-modal-header">
                    <h3>Bridge USDC to Arc</h3>
                    <button id="arc-cctp-close" class="arc-modal-close">✕</button>
                </div>
                <div class="arc-modal-body">
                    <div id="arc-cctp-step-select">
                        <p class="arc-modal-label">Select source network:</p>
                        <div id="arc-cctp-network-list" class="arc-network-list"></div>

                        <div class="arc-amount-row">
                            <label for="arc-cctp-amount">Amount (USDC)</label>
                            <div class="arc-amount-input-wrap">
                                <input id="arc-cctp-amount" type="number" min="0.1" step="0.1" value="2" class="arc-amount-input" />
                                <span class="arc-amount-suffix">USDC</span>
                            </div>
                        </div>

                        <div id="arc-cctp-supported-info" class="arc-supported-info">
                            <span class="arc-info-icon" id="arc-cctp-info-btn">ℹ️ Supported networks</span>
                            <div id="arc-cctp-info-popup" class="arc-info-popup" style="display:none;">
                                <strong>CCTP-supported testnets:</strong>
                                <ul>
                                    <li>🔷 Ethereum Sepolia</li>
                                    <li>🔵 Base Sepolia</li>
                                    <li>🔶 Arbitrum Sepolia</li>
                                </ul>
                                <p>Mainnet support will be added at launch.</p>
                            </div>
                        </div>

                        <button id="arc-cctp-bridge-btn" class="arc-btn arc-btn-primary" style="margin-top:16px;" disabled>
                            Select a network to continue
                        </button>
                    </div>

                    <div id="arc-cctp-step-progress" style="display:none;">
                        <div class="arc-progress-steps">
                            <div class="arc-progress-step" id="arc-step-approve">
                                <span class="arc-step-num">1</span>
                                <span>Approve USDC</span>
                                <span class="arc-step-status" id="arc-step-approve-status"></span>
                            </div>
                            <div class="arc-progress-step" id="arc-step-burn">
                                <span class="arc-step-num">2</span>
                                <span>Send to Arc</span>
                                <span class="arc-step-status" id="arc-step-burn-status"></span>
                            </div>
                            <div class="arc-progress-step" id="arc-step-mint">
                                <span class="arc-step-num">3</span>
                                <span>Mint on Arc</span>
                                <span class="arc-step-status" id="arc-step-mint-status"></span>
                            </div>
                        </div>
                        <p id="arc-cctp-progress-msg" class="arc-status-text" style="margin-top:12px;"></p>
                        <p class="arc-cctp-note">You can close this modal. We'll complete the process and your balance will update automatically.</p>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Wire up events
    document.getElementById('arc-login-btn').addEventListener('click', handleEmailLogin);
    document.getElementById('arc-bridge-btn').addEventListener('click', openCctpModal);
    document.getElementById('arc-cctp-close').addEventListener('click', closeCctpModal);
    document.getElementById('arc-unlock-btn').addEventListener('click', handleUnlock);
    document.getElementById('arc-cctp-info-btn').addEventListener('click', toggleCctpInfo);
    document.getElementById('arc-copy-btn').addEventListener('click', copyWalletAddress);

    // Build network list inside CCTP modal
    buildCctpNetworkList();
}

// ─── Phase 1: Email Login → Arc Wallet ───────────────────────────────────────

async function handleEmailLogin() {
    const btn = document.getElementById('arc-login-btn');
    btn.disabled = true;
    btn.innerHTML = '<div class="arc-spinner-sm" style="margin-right:8px;"></div> Connecting…';
    setLoginStatus('');

    try {
        // Persist userId in localStorage so returning users skip wallet creation
        viewerState.userId = localStorage.getItem('arc_cashier_user_id');
        if (!viewerState.userId) {
            viewerState.userId = 'arc_' + Math.random().toString(36).substring(2, 15);
            localStorage.setItem('arc_cashier_user_id', viewerState.userId);
        }

        // Step 1: Get Circle session token
        setLoginStatus('Initializing Circle session…');
        const tokenRes = await fetch(ARC_API_BASE + '/api/core/circle/get-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: viewerState.userId }),
        });
        if (!tokenRes.ok) throw new Error('Failed to initialize Circle session');
        const tokenData = await tokenRes.json();
        if (!tokenData.userToken) throw new Error('Circle token not received');

        viewerState.userToken = tokenData.userToken;
        viewerState.encryptionKey = tokenData.encryptionKey;
        viewerState.appId = tokenData.appId;

        // Step 2: Initialize Circle Web SDK
        arcSdk = new W3SSdk({
            appSettings: { appId: viewerState.appId }
        });
        arcSdk.setAuthentication({
            userToken: viewerState.userToken,
            encryptionKey: viewerState.encryptionKey,
        });

        // Step 3: Get or create Arc SCA wallet
        setLoginStatus('Setting up your Arc wallet…');
        const walletData = await getOrCreateArcWallet();

        viewerState.walletId = walletData.walletId;
        viewerState.walletAddress = walletData.walletAddress;

        // Cache for session recovery
        localStorage.setItem('arc_circle_wallet_id', viewerState.walletId);
        localStorage.setItem('arc_circle_wallet_address', viewerState.walletAddress);

        // Step 4: Check if Arc wallet already has funds
        setLoginStatus('Checking wallet balance…');
        const hasFunds = await checkArcBalance(viewerState.walletAddress);

        if (hasFunds) {
            // User already has USDC — go straight to unlock button
            transitionToFundPhase();
            enableUnlockButton();
        } else {
            // Show funding panel
            transitionToFundPhase();
            startBalancePolling();
        }

    } catch (error) {
        console.error('[Tessera] Login error:', error);
        btn.disabled = false;
        btn.innerHTML = '<span class="arc-btn-icon">🔐</span> Sign in with PIN';
        setLoginStatus('Error: ' + (error.message || 'Unknown error. Please retry.'), true);
    }
}

async function getOrCreateArcWallet() {
    const walletRes = await fetch(ARC_API_BASE + '/api/core/circle/get-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: viewerState.userId, userToken: viewerState.userToken }),
    });
    if (!walletRes.ok) throw new Error('Failed to resolve Arc wallet');
    const walletData = await walletRes.json();

    // First-time user: complete wallet creation challenge via Circle SDK popup
    if (walletData.status === 'needs_creation') {
        setLoginStatus('Complete security setup in the popup…');
        await new Promise((resolve, reject) => {
            arcSdk.execute(walletData.challengeId, (error, result) => {
                if (error) reject(new Error('Wallet setup cancelled or failed'));
                else resolve(result);
            });
        });
        // Re-fetch to get the walletId now that it's been created
        return getOrCreateArcWallet();
    }

    return walletData;
}

// ─── Arc Balance Check (via eth_call on Arc RPC) ──────────────────────────────

async function checkArcBalance(address) {
    try {
        // On Arc Testnet, USDC is the native gas token. Use eth_getBalance instead of ERC20 balanceOf
        const res = await fetch('https://rpc.testnet.arc.network', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'eth_getBalance',
                params: [address, 'latest'],
            }),
        });
        const json = await res.json();
        // Native balance on Arc Testnet uses 18 decimals!
        // 0.01 USDC = 0.01 * 10^18 = 10000000000000000 wei
        const balance = BigInt(json.result || '0x0');
        // Check if balance >= 0.01 native USDC (10^16 wei)
        return balance >= 10000000000000000n;
    } catch (e) {
        console.warn('[Tessera] Balance check failed:', e);
        return false;
    }
}

// ─── Phase 2: Funding Panel ───────────────────────────────────────────────────

function transitionToFundPhase() {
    document.getElementById('arc-phase-login').style.display = 'none';
    const fundPhase = document.getElementById('arc-phase-fund');
    fundPhase.style.display = 'block';

    // Show abbreviated wallet address
    const addr = viewerState.walletAddress || '';
    const display = addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '';
    document.getElementById('arc-wallet-display').textContent = display;
}

function copyWalletAddress() {
    if (!viewerState.walletAddress) return;
    navigator.clipboard.writeText(viewerState.walletAddress).then(() => {
        const btn = document.getElementById('arc-copy-btn');
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = '📋'; }, 2000);
    });
}

function startBalancePolling() {
    document.getElementById('arc-waiting-balance').style.display = 'flex';
    if (balancePollingInterval) clearInterval(balancePollingInterval);
    balancePollingInterval = setInterval(async () => {
        const hasFunds = await checkArcBalance(viewerState.walletAddress);
        if (hasFunds) {
            clearInterval(balancePollingInterval);
            balancePollingInterval = null;
            document.getElementById('arc-waiting-balance').style.display = 'none';
            enableUnlockButton();
        }
    }, 4000);
}

function enableUnlockButton() {
    const btn = document.getElementById('arc-unlock-btn');
    btn.disabled = false;
    btn.classList.remove('arc-btn-disabled');
    btn.innerHTML = '🔓 Unlock Video';
    document.getElementById('arc-waiting-balance').style.display = 'none';
    // Small celebration pulse
    btn.classList.add('arc-pulse-once');
    setTimeout(() => btn.classList.remove('arc-pulse-once'), 600);
}

// ─── Phase 3: Unlock Video ────────────────────────────────────────────────────

async function handleUnlock() {
    const btn = document.getElementById('arc-unlock-btn');
    btn.disabled = true;
    btn.innerHTML = '<div class="arc-spinner-sm" style="margin-right:8px;"></div> Unlocking…';
    setFundStatus('');

    try {
        setFundStatus('Preparing deposit to Gateway…');

        // Refresh Circle token if expired
        const tokenRes = await fetch(ARC_API_BASE + '/api/core/circle/get-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: viewerState.userId }),
        });
        if (!tokenRes.ok) throw new Error('Failed to refresh session');
        const tokenData = await tokenRes.json();
        viewerState.userToken = tokenData.userToken;
        viewerState.encryptionKey = tokenData.encryptionKey;
        arcSdk.setAuthentication({
            userToken: viewerState.userToken,
            encryptionKey: viewerState.encryptionKey,
        });

        // Ensure ephemeral key exists (needed for both deposit and register-session)
        viewerState.ephemeralPk = localStorage.getItem('arc_ephemeral_pk');
        if (!viewerState.ephemeralPk) {
            viewerState.ephemeralPk = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
                .map(b => b.toString(16).padStart(2, '0')).join('');
            localStorage.setItem('arc_ephemeral_pk', viewerState.ephemeralPk);
        }

        // Check if Gateway already funded (returning user)
        let skipDeposit = false;
        try {
            const balRes = await fetch(ARC_API_BASE + '/api/core/session-balance?userId=' + viewerState.userId);
            if (balRes.ok) {
                const balData = await balRes.json();
                if (Number(balData.gatewayAvailable) > 0.01) {
                    skipDeposit = true;
                    console.log('[Tessera] Gateway already funded. Skipping deposit.');
                }
            }
        } catch (_) { /* proceed to deposit */ }

        if (!skipDeposit) {
            setFundStatus('Approve USDC deposit in the popup…');

            // Prepare a 1 USDC deposit challenge from SCA → Ephemeral Wallet
            const depositRes = await fetch(ARC_API_BASE + '/api/core/circle/prepare-deposit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userToken: viewerState.userToken,
                    walletId: viewerState.walletId,
                    depositAmount: '1',
                    ephemeralPk: viewerState.ephemeralPk,
                }),
            });
            if (!depositRes.ok) throw new Error('Failed to prepare deposit');
            const depositData = await depositRes.json();
            if (!depositData.challengeId) throw new Error('No deposit challenge received');

            // User approves via Circle PIN/Email popup
            await new Promise((resolve, reject) => {
                arcSdk.execute(depositData.challengeId, (error, result) => {
                    if (error) reject(new Error('Deposit cancelled or failed'));
                    else resolve(result);
                });
            });

            // Poll until deposit is confirmed on-chain
            setFundStatus('Confirming deposit on-chain…');
            let confirmed = false;
            for (let i = 0; i < 30; i++) {
                const pollRes = await fetch(ARC_API_BASE + '/api/core/circle/poll-challenge', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userToken: viewerState.userToken, challengeId: depositData.challengeId }),
                });
                const pollData = await pollRes.json();
                if (pollData.status === 'COMPLETE') { confirmed = true; break; }
                if (pollData.status === 'FAILED' || pollData.status === 'EXPIRED') {
                    throw new Error('Deposit transaction failed on-chain');
                }
                await new Promise(r => setTimeout(r, 2000));
            }
            if (!confirmed) throw new Error('Deposit timed out. Please try again.');
        }

        // Register session with ephemeral key
        setFundStatus('Opening stream…');

        const regRes = await fetch(ARC_API_BASE + '/api/core/register-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: viewerState.userId,
                privateKey: viewerState.ephemeralPk,
                returnAddress: viewerState.walletAddress,
            }),
        });
        if (!regRes.ok) {
            const errJson = await regRes.json().catch(() => ({}));
            throw new Error(errJson.error || 'Backend failed to register session.');
        }

        // ✅ Unlock stream
        document.body.classList.remove('arc-locked');
        const overlay = document.getElementById('arc-paywall-overlay');
        if (overlay) {
            overlay.style.opacity = '0';
            setTimeout(() => overlay.remove(), 500);
        }
        const sm = document.getElementById('arc-session-manager');
        if (sm) sm.classList.remove('arc-hidden');
        startSessionTimer();

    } catch (error) {
        console.error('[Tessera] Unlock error:', error);
        btn.disabled = false;
        btn.innerHTML = '🔓 Unlock Video';
        setFundStatus('Error: ' + (error.message || 'Please retry.'), true);
    }
}

// ─── CCTP Bridge Modal ────────────────────────────────────────────────────────

let selectedChain = null;

function buildCctpNetworkList() {
    const list = document.getElementById('arc-cctp-network-list');
    CCTP_CHAINS.forEach(chain => {
        const btn = document.createElement('button');
        btn.className = 'arc-network-btn';
        btn.dataset.chainId = chain.chainId;
        btn.innerHTML = `<span>${chain.icon}</span> <span>${chain.name}</span>`;
        btn.addEventListener('click', () => selectCctpChain(chain, btn));
        list.appendChild(btn);
    });
}

function selectCctpChain(chain, btnEl) {
    selectedChain = chain;
    document.querySelectorAll('.arc-network-btn').forEach(b => b.classList.remove('arc-network-btn-selected'));
    btnEl.classList.add('arc-network-btn-selected');
    const bridgeBtn = document.getElementById('arc-cctp-bridge-btn');
    bridgeBtn.disabled = false;
    bridgeBtn.textContent = `Bridge to Arc via ${chain.name}`;
    bridgeBtn.onclick = () => executeCctpBridge(chain);
}

function openCctpModal() {
    document.getElementById('arc-cctp-modal').style.display = 'flex';
}

function closeCctpModal() {
    document.getElementById('arc-cctp-modal').style.display = 'none';
}

function toggleCctpInfo() {
    const popup = document.getElementById('arc-cctp-info-popup');
    popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
}

async function executeCctpBridge(chain) {
    if (!window.ethereum) {
        alert('MetaMask is not installed. Please install MetaMask to use the bridge.');
        return;
    }

    const amountInput = document.getElementById('arc-cctp-amount');
    const amountFloat = parseFloat(amountInput.value);
    if (!amountFloat || amountFloat < 0.1) {
        alert('Please enter a valid amount (min 0.1 USDC).');
        return;
    }

    // USDC has 6 decimals on EVM chains (except Arc which uses 18 for native gas)
    const amountUnits = BigInt(Math.round(amountFloat * 1_000_000));

    // Switch to progress view
    document.getElementById('arc-cctp-step-select').style.display = 'none';
    document.getElementById('arc-cctp-step-progress').style.display = 'block';
    setCctpProgress('Connecting MetaMask…');

    try {
        // Step 1: Connect MetaMask
        await window.ethereum.request({ method: 'eth_requestAccounts' });

        // Switch to the selected source chain
        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: chain.chainIdHex }],
            });
        } catch (switchErr) {
            // Chain not added yet — add it
            if (switchErr.code === 4902) {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: chain.chainIdHex,
                        chainName: chain.name,
                        rpcUrls: [chain.rpcUrl],
                        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                        blockExplorerUrls: [chain.blockExplorer],
                    }],
                });
            } else throw switchErr;
        }

        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
        const fromAddress = accounts[0];

        // ── Step 1: Approve USDC → TokenMessengerV2 ──────────────────────────
        setStepStatus('arc-step-approve-status', 'pending');
        setCctpProgress('Approving USDC… Sign in MetaMask.');

        const approveData = '0x095ea7b3' +
            TOKEN_MESSENGER_V2.slice(2).padStart(64, '0') +
            amountUnits.toString(16).padStart(64, '0');

        const approveTx = await window.ethereum.request({
            method: 'eth_sendTransaction',
            params: [{ from: fromAddress, to: chain.usdc, data: approveData }],
        });
        await waitForTx(approveTx, chain.chainId);
        setStepStatus('arc-step-approve-status', 'done');

        // ── Step 2: depositForBurn → burn USDC on source chain ───────────────
        setStepStatus('arc-step-burn-status', 'pending');
        setCctpProgress('Burning USDC on source chain… Sign in MetaMask.');

        // mintRecipient must be bytes32 (padded Arc wallet address)
        const recipient = viewerState.walletAddress;
        const recipientBytes32 = '0x000000000000000000000000' + recipient.slice(2);

        // ARC_TESTNET_DOMAIN = 26
        const ARC_DOMAIN = 26;
        const maxFee = BigInt(500); // 0.0005 USDC (500 subunits) — small CCTP fee
        const minFinalityThreshold = 1000; // enables Fast Transfer

        // depositForBurn(amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold)
        const burnData = '0x44a45248' // depositForBurn selector for V2
            + amountUnits.toString(16).padStart(64, '0')
            + ARC_DOMAIN.toString(16).padStart(64, '0')
            + recipientBytes32.slice(2).padStart(64, '0')
            + chain.usdc.slice(2).padStart(64, '0')
            + '0'.padStart(64, '0') // destinationCaller = zero (any relayer)
            + maxFee.toString(16).padStart(64, '0')
            + minFinalityThreshold.toString(16).padStart(64, '0');

        const burnTx = await window.ethereum.request({
            method: 'eth_sendTransaction',
            params: [{ from: fromAddress, to: TOKEN_MESSENGER_V2, data: burnData }],
        });
        await waitForTx(burnTx, chain.chainId);
        setStepStatus('arc-step-burn-status', 'done');

        // ── Step 3: Delegate minting to backend ──────────────────────────────
        setStepStatus('arc-step-mint-status', 'pending');
        setCctpProgress('Minting on Arc… This takes ~1-2 minutes. You can close this modal.');
        closeCctpModal();

        // Show waiting indicator on funding panel
        document.getElementById('arc-waiting-balance').style.display = 'flex';
        if (balancePollingInterval) clearInterval(balancePollingInterval);

        // Backend handles Iris polling + receiveMessage() on Arc (non-blocking for user)
        const finalizeRes = await fetch(ARC_API_BASE + '/api/core/circle/cctp-finalize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sourceDomain: chain.domain,
                transactionHash: burnTx,
                recipientAddress: recipient,
            }),
        });

        if (finalizeRes.ok) {
            setStepStatus('arc-step-mint-status', 'done');
            // Balance polling will detect the new funds and enable unlock button
            startBalancePolling();
        } else {
            const err = await finalizeRes.json().catch(() => ({}));
            console.error('[Tessera] cctp-finalize error:', err);
            setFundStatus('Bridge submitted but minting failed. Please retry or use the faucet.', true);
            startBalancePolling(); // Still poll — might have succeeded
        }

    } catch (error) {
        console.error('[Tessera] CCTP bridge error:', error);
        setCctpProgress('Error: ' + (error.message || 'Bridge failed. Please retry.'));
        // Reset to select step
        document.getElementById('arc-cctp-step-select').style.display = 'block';
        document.getElementById('arc-cctp-step-progress').style.display = 'none';
    }
}

async function waitForTx(txHash, chainId) {
    // Poll eth_getTransactionReceipt until mined
    const rpc = CCTP_CHAINS.find(c => c.chainId === chainId)?.rpcUrl || 'https://rpc.sepolia.org';
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
            const res = await fetch(rpc, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
            });
            const data = await res.json();
            if (data.result && data.result.status === '0x1') return;
            if (data.result && data.result.status === '0x0') throw new Error('Transaction reverted on-chain');
        } catch (e) {
            if (e.message.includes('reverted')) throw e;
        }
    }
    throw new Error('Transaction confirmation timed out');
}

function setStepStatus(stepId, status) {
    const el = document.getElementById(stepId);
    if (!el) return;
    el.textContent = status === 'pending' ? '⏳' : status === 'done' ? '✅' : '';
}

function setCctpProgress(msg) {
    const el = document.getElementById('arc-cctp-progress-msg');
    if (el) el.textContent = msg;
}

// ─── Session Manager (post-unlock) ───────────────────────────────────────────

function renderSessionManager() {
    const existing = document.getElementById('arc-session-manager');
    if (existing) existing.remove();

    const sm = document.createElement('div');
    sm.id = 'arc-session-manager';
    sm.className = 'arc-hidden';
    sm.innerHTML = `
        <div id="arc-sm-header">
            <h3><span class="arc-pulse-dot"></span> Active Session</h3>
            <button id="arc-sm-minimize-btn" title="Minimize">−</button>
        </div>
        <div id="arc-sm-content">
            <div class="arc-sm-stats">
                <div><span>Time:</span> <span id="arc-sm-time">0s</span></div>
                <div><span>Cost:</span> <span id="arc-sm-cost">$0.0000 USDC</span></div>
                <div><span>Balance:</span> <span id="arc-sm-balance">$1.0000 USDC</span></div>
            </div>
            <div id="arc-sm-warning" class="arc-hidden" style="background:rgba(255,165,0,0.2);border:1px solid orange;padding:10px;margin-top:10px;margin-bottom:10px;border-radius:4px;text-align:center;">
                <p style="margin:0 0 5px;color:orange;font-size:12px;font-weight:bold;">⚠️ Low Balance: <span id="arc-sm-time-left"></span> left</p>
                <button id="arc-sm-topup-btn" class="arc-btn" style="padding:5px 10px;font-size:11px;margin:0 auto;display:inline-block;">Top Up +30 Mins</button>
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;">
                <button id="arc-sm-leave-btn" class="arc-btn" style="flex:1;background:#4a5568;font-size:11px;padding:8px 4px;">⏸ Just Leave</button>
                <button id="arc-sm-end-btn" class="arc-btn arc-btn-danger" style="flex:2;font-size:11px;padding:8px 4px;">💸 Cash Out &amp; Exit</button>
            </div>
            <p style="margin:6px 0 0;font-size:10px;color:#718096;text-align:center;">Leave keeps funds for next time. Cash Out withdraws to your wallet.</p>
        </div>
    `;
    document.body.appendChild(sm);

    // Draggable
    let isDragging = false, startX, startY, initialX, initialY;
    const header = document.getElementById('arc-sm-header');
    header.addEventListener('mousedown', (e) => {
        if (e.target.id === 'arc-sm-minimize-btn') return;
        isDragging = true;
        const rect = sm.getBoundingClientRect();
        initialX = rect.left; initialY = rect.top;
        startX = e.clientX; startY = e.clientY;
        sm.style.right = 'auto'; sm.style.bottom = 'auto';
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        sm.style.left = `${initialX + e.clientX - startX}px`;
        sm.style.top = `${initialY + e.clientY - startY}px`;
    });
    document.addEventListener('mouseup', () => { isDragging = false; });

    document.getElementById('arc-sm-minimize-btn').addEventListener('click', () => {
        sm.classList.toggle('arc-sm-minimized');
        document.getElementById('arc-sm-minimize-btn').innerText =
            sm.classList.contains('arc-sm-minimized') ? '+' : '−';
    });
    document.getElementById('arc-sm-topup-btn').addEventListener('click', handleTopUp);
    document.getElementById('arc-sm-leave-btn').addEventListener('click', window.arcLeaveSession);
    document.getElementById('arc-sm-end-btn').addEventListener('click', window.arcEndSession);
}

function startSessionTimer() {
    let seconds = 0;
    window.sessionTimer = setInterval(async () => {
        seconds++;
        const timeEl = document.getElementById('arc-sm-time');
        const costEl = document.getElementById('arc-sm-cost');
        if (timeEl) timeEl.innerText = seconds + 's';
        if (costEl) costEl.innerText = '$' + (seconds * 0.0001).toFixed(4) + ' USDC';

        if (seconds % 5 === 0) {
            try {
                const statusRes = await fetch(ARC_API_BASE + '/api/core/session-status?userId=' + viewerState.userId);
                if (statusRes.status === 404) {
                    clearInterval(window.sessionTimer);
                    const sm = document.getElementById('arc-session-manager');
                    if (sm) sm.classList.add('arc-hidden');
                    initPaywall();
                } else if (statusRes.ok) {
                    const balanceRes = await fetch(ARC_API_BASE + '/api/core/session-balance?userId=' + viewerState.userId);
                    if (balanceRes.ok) {
                        const data = await balanceRes.json();
                        const withdrawable = Number(data.gatewayWithdrawable);
                        const balEl = document.getElementById('arc-sm-balance');
                        if (balEl) balEl.innerText = '$' + withdrawable.toFixed(4) + ' USDC';
                        const secondsLeft = withdrawable / 0.0001;
                        const warningDiv = document.getElementById('arc-sm-warning');
                        if (warningDiv) {
                            if (secondsLeft <= 300 && secondsLeft > 0) {
                                warningDiv.classList.remove('arc-hidden');
                                const tl = document.getElementById('arc-sm-time-left');
                                if (tl) tl.innerText = `${Math.floor(secondsLeft / 60)}m ${Math.floor(secondsLeft % 60)}s`;
                            } else {
                                warningDiv.classList.add('arc-hidden');
                            }
                        }
                    }
                }
            } catch (e) { console.error('Heartbeat failed', e); }
        }
    }, 1000);
}

// ─── Top-Up ───────────────────────────────────────────────────────────────────

async function handleTopUp() {
    const btn = document.getElementById('arc-sm-topup-btn');
    btn.disabled = true;
    btn.innerText = 'Processing…';

    try {
        const tokenRes = await fetch(ARC_API_BASE + '/api/core/circle/get-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: viewerState.userId }),
        });
        if (!tokenRes.ok) throw new Error('Failed to refresh Circle session');
        const tokenData = await tokenRes.json();

        arcSdk.setAuthentication({
            userToken: tokenData.userToken,
            encryptionKey: tokenData.encryptionKey,
        });

        const topUpAmount = (0.0001 * 30 * 60).toFixed(6); // 0.18 USDC = 30 min

        const depositRes = await fetch(ARC_API_BASE + '/api/core/circle/prepare-deposit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userToken: tokenData.userToken,
                walletId: viewerState.walletId,
                depositAmount: topUpAmount,
            }),
        });
        if (!depositRes.ok) throw new Error('Failed to prepare top-up');
        const depositData = await depositRes.json();

        await new Promise((resolve, reject) => {
            arcSdk.execute(depositData.challengeId, (error, result) => {
                if (error) reject(new Error('Top-up cancelled'));
                else resolve(result);
            });
        });

        await fetch(ARC_API_BASE + '/api/core/topup-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: viewerState.userId }),
        });

        btn.innerText = 'Top Up +30 Mins';
        btn.disabled = false;
        document.getElementById('arc-sm-warning').classList.add('arc-hidden');
    } catch (error) {
        console.error('[Tessera] Top-up failed', error);
        btn.innerText = 'Error (Retry)';
        btn.disabled = false;
    }
}

// ─── Leave / Cash-Out ─────────────────────────────────────────────────────────

window.arcLeaveSession = async function() {
    const leaveBtn = document.getElementById('arc-sm-leave-btn');
    if (leaveBtn) { leaveBtn.disabled = true; leaveBtn.innerText = 'Leaving…'; }
    clearInterval(window.sessionTimer);
    if (window.arcPingInterval) clearInterval(window.arcPingInterval);

    try {
        await fetch(ARC_API_BASE + '/api/core/end-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: viewerState.userId }),
        });
    } catch (_) { /* best effort */ }

    const sm = document.getElementById('arc-session-manager');
    if (sm) {
        sm.innerHTML = `
            <div style="padding:10px;">
                <h3 style="color:#63b3ed;margin:0 0 8px 0;">⏸ Session Paused</h3>
                <p style="font-size:12px;color:#a0aec0;margin:0 0 10px 0;">Your balance is safe. Sign in again with the same email to resume.</p>
                <p style="font-size:11px;color:#718096;margin:0;">Billing has stopped.</p>
            </div>
        `;
    }
    document.body.classList.add('arc-locked');
};

window.arcEndSession = async function() {
    const endBtn = document.getElementById('arc-sm-end-btn');
    if (endBtn) {
        endBtn.disabled = true;
        endBtn.innerHTML = '<div class="arc-spinner" style="width:14px;height:14px;border-width:2px;margin-right:5px;"></div> Withdrawing…';
    }
    clearInterval(window.sessionTimer);
    if (window.arcPingInterval) clearInterval(window.arcPingInterval);

    const walletAddress = viewerState.walletAddress || localStorage.getItem('arc_circle_wallet_address') || '';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', ARC_API_BASE + '/api/core/cash-out', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 15000;

    xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
            localStorage.removeItem('arc_ephemeral_pk');
            const sm = document.getElementById('arc-session-manager');
            if (sm) {
                sm.innerHTML = `
                    <div style="padding:10px;">
                        <h3 style="color:#68d391;margin:0 0 10px 0;">✅ Session Ended &amp; Cashed Out</h3>
                        <p style="font-size:13px;color:#a0aec0;margin:0 0 10px 0;">Your refund was processed to your wallet.</p>
                        <a href="https://testnet.arcscan.app/address/${walletAddress}" target="_blank"
                           style="font-size:12px;color:#4facfe;text-decoration:underline;">
                            🧾 View Balance on Arcscan
                        </a>
                    </div>
                `;
            }
        } else {
            if (endBtn) { endBtn.disabled = false; endBtn.innerText = 'Error: Retry'; }
        }
        document.body.classList.add('arc-locked');
    };

    xhr.onerror = xhr.ontimeout = function() {
        if (endBtn) { endBtn.disabled = false; endBtn.innerText = 'Network Error - Retry'; }
    };

    xhr.send(JSON.stringify({ userId: viewerState.userId }));
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setLoginStatus(msg, isError = false) {
    const el = document.getElementById('arc-login-status');
    if (!el) return;
    el.style.display = msg ? 'block' : 'none';
    el.textContent = msg;
    el.className = 'arc-status-text' + (isError ? ' arc-status-error' : '');
}

function setFundStatus(msg, isError = false) {
    const el = document.getElementById('arc-fund-status');
    if (!el) return;
    el.style.display = msg ? 'block' : 'none';
    el.textContent = msg;
    el.className = 'arc-status-text' + (isError ? ' arc-status-error' : '');
}

// ─── Bootstrap & SPA API ────────────────────────────────────────────────────────

window.ArcCashier = {
    init: initPaywall
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPaywall);
} else {
    initPaywall();
}
