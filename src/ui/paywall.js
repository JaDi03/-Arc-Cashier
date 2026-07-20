// arc-paywall.js - Universal Paywall Engine (platform-agnostic)
// Injected or embedded by any Tessera connector (Owncast, PeerTube, etc.)

import { W3SSdk } from '@circle-fin/w3s-pw-web-sdk';

// ─── Constants (all values verified from official docs) ──────────────────────

const SCRIPT_SRC = (document.currentScript && document.currentScript.src) ? document.currentScript.src : '';
const SCRIPT_BASE_DIR = SCRIPT_SRC ? SCRIPT_SRC.substring(0, SCRIPT_SRC.lastIndexOf('/') + 1) : '/demo-assets/';
// Derive the API base by stripping the asset-directory suffix from the script URL.
// This works in both deployment modes:
//   Sidecar-direct:  https://api.domain.com/peertube-assets/paywall.bundle.js → https://api.domain.com
//   Plugin relay:    https://peertube.domain.com/.../router/assets/paywall.bundle.js → https://peertube.domain.com/.../router
const ARC_API_BASE = SCRIPT_SRC
    ? SCRIPT_SRC.replace(/\/(peertube-assets|assets)\/[^?#]*.*$/, '')
    : window.location.origin;

console.log(
    "%c Tessera %c Universal Payment Sidecar initialized %c https://try-tessera.xyz ",
    "background: #ffb300; color: #000; font-weight: bold; border-radius: 3px 0 0 3px; padding: 3px 6px;",
    "background: #111827; color: #93c5fd; border-radius: 0; padding: 3px 6px;",
    "background: #1f2937; color: #a7f3d0; text-decoration: underline; border-radius: 0 3px 3px 0; padding: 3px 6px;"
);

// Arc Testnet — Chain ID verified from docs.arc.network
const ARC_CHAIN_ID = 5042002;
const ARC_CHAIN_ID_HEX = '0x' + ARC_CHAIN_ID.toString(16);

// Arc Testnet — USDC native token address (verified from Circle docs)
const ARC_USDC = '0x3600000000000000000000000000000000000000';

const LOCK_SVG = `
    <svg class="arc-btn-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:8px; display:inline-block; vertical-align:middle;">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>
`;

const UNLOCK_SVG = `
    <svg class="arc-btn-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:8px; display:inline-block; vertical-align:middle;">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
    </svg>
`;

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
let isTipMode = false;
let tipCreatorWallet = null;
let tipAmountVal = null;
let isCheckingAutoUnlock = false;

function getRequiredMinBalance() {
    if (isTipMode) {
        // Tipping mode: require at least the tip amount (e.g. 0.10 USDC)
        const tipBtn = document.getElementById('arc-tip-btn');
        if (tipBtn) {
            const match = tipBtn.textContent.match(/\$([0-9.]+)/);
            if (match) return parseFloat(match[1]) || 0.10;
        }
        return 0.10; // fallback tip amount
    } else {
        // Pay-per-second mode: require at least 1 second of playback rate
        return typeof currentRatePerSecond !== 'undefined' ? currentRatePerSecond : 0.0001;
    }
}

async function checkAutoUnlock() {
    if (isCheckingAutoUnlock) return;
    if (!viewerState.userId || !viewerState.walletAddress) return;

    isCheckingAutoUnlock = true;
    try {
        setFundStatus('Checking wallet balance…');
        const minReq = getRequiredMinBalance();
        const hasFunds = await checkArcBalance(viewerState.walletAddress);

        if (hasFunds) {
            // Check if Gateway already has funds
            const balRes = await fetch(ARC_API_BASE + '/api/core/session-balance?userId=' + viewerState.userId);
            if (balRes.ok) {
                const balData = await balRes.json();
                const available = Number(balData.gatewayAvailable || '0');

                if (available >= minReq) {
                    setFundStatus('Auto-unlocking session…');
                    // Ensure we have an ephemeral key
                    viewerState.ephemeralPk = localStorage.getItem('arc_ephemeral_pk');
                    if (!viewerState.ephemeralPk) {
                        viewerState.ephemeralPk = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
                            .map(b => b.toString(16).padStart(2, '0')).join('');
                        localStorage.setItem('arc_ephemeral_pk', viewerState.ephemeralPk);
                    }

                    // Register session with backend
                    const regRes = await fetch(ARC_API_BASE + '/api/core/register-session', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            userId: viewerState.userId,
                            privateKey: viewerState.ephemeralPk,
                            returnAddress: viewerState.walletAddress,
                            ratePerSecond: getRequiredMinBalance(),
                        }),
                    });

                    if (regRes.ok) {
                        console.log('[Tessera] Auto-unlocked video using existing funded gateway session.');
                        setFundStatus('');
                        document.body.classList.remove('arc-locked');

                        const overlay = document.getElementById('arc-paywall-overlay');
                        if (overlay) {
                            overlay.style.opacity = '0';
                            setTimeout(() => overlay.remove(), 500);
                        }

                        const sm = document.getElementById('arc-session-manager');
                        if (sm) sm.classList.remove('arc-hidden');
                        startSessionTimer();
                        return;
                    }
                }
            }

            // Wallet has funds but gateway is not funded yet -> enable unlock button
            enableUnlockButton();
            const overlay = document.getElementById('arc-paywall-overlay');
            if (overlay) overlay.classList.remove('arc-hidden-initially');
        } else {
            // No funds in wallet yet -> start polling
            startBalancePolling();
            const overlay = document.getElementById('arc-paywall-overlay');
            if (overlay) overlay.classList.remove('arc-hidden-initially');
        }
    } catch (error) {
        console.error('[Tessera] Auto-unlock check failed:', error);
        startBalancePolling();
        const overlay = document.getElementById('arc-paywall-overlay');
        if (overlay) overlay.classList.remove('arc-hidden-initially');
    } finally {
        isCheckingAutoUnlock = false;
    }
}

// ─── Init ────────────────────────────────────────────────────────────────────

function initPaywall() {
    isTipMode = false;
    injectDependencies();

    // Clear tipping widget if it was open from previous video
    const tipBtn = document.getElementById('arc-tip-btn-container');
    if (tipBtn) tipBtn.remove();

    // Clear any active balance polling intervals
    if (balancePollingInterval) {
        clearInterval(balancePollingInterval);
        balancePollingInterval = null;
    }
    playingMediaCount = 0;

    document.body.classList.add('arc-locked');
    lockMedia();
    renderPaywallOverlay(true);
    renderSessionManager();

    if (viewerState.userId && viewerState.walletAddress) {
        transitionToFundPhase();
        void checkAutoUnlock();
    }
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

function renderPaywallOverlay(hideInitially = false) {
    const existing = document.getElementById('arc-paywall-overlay');
    if (existing) existing.remove();

    const title = isTipMode ? "Support Creator" : "Premium Stream";
    const subtitle = isTipMode ? "Set up your wallet to send tips." : "Pay only for the seconds you watch.<br>No subscriptions.";
    const pricingBox = isTipMode ? `
                        <div class="arc-pricing-row">
                            <span>Action</span>
                            <span class="arc-accent">Support Creator</span>
                        </div>
                        <div class="arc-pricing-row">
                            <span>Min. deposit</span>
                            <span class="arc-accent">1.00 USDC</span>
                        </div>
                        <p class="arc-pricing-note">Deposit funds to tip. Unused funds can be withdrawn anytime.</p>
    ` : `
                        <div class="arc-pricing-row">
                            <span>Rate</span>
                            <span class="arc-accent" id="arc-display-rate">From $0.0001 USDC / sec (varies by video)</span>
                        </div>
                        <div class="arc-pricing-row">
                            <span>Min. deposit</span>
                            <span class="arc-accent">1.00 USDC</span>
                        </div>
    `;
    const fundLabel = isTipMode ? "Fund your wallet to tip:" : "Fund your wallet to watch:";
    const unlockBtnText = isTipMode 
        ? `${UNLOCK_SVG} Enable Tipping` 
        : `${UNLOCK_SVG} Unlock Video`;

    const overlay = document.createElement('div');
    overlay.id = 'arc-paywall-overlay';

    // Check if user is logged in to hide initially and prevent flicker
    const isLoggedIn = viewerState.userId && viewerState.walletAddress;
    if (isLoggedIn && hideInitially) {
        overlay.classList.add('arc-hidden-initially');
    }
    overlay.innerHTML = `
        <div id="arc-paywall-modal">
            <div id="arc-paywall-header">
                <div id="arc-paywall-logo">
                    <img src="${SCRIPT_BASE_DIR}logo_yellow.svg" alt="Tessera" />
                </div>
                <h2>${title}</h2>
                <p>${subtitle}</p>
            </div>
            <div id="arc-paywall-body">
                <div id="arc-phase-login" class="arc-phase arc-phase-active">
                    <div class="arc-pricing-box">
                        ${pricingBox}
                    </div>
                    <button id="arc-login-btn" class="arc-btn arc-btn-primary">
                        ${LOCK_SVG} Sign in with PIN
                    </button>
                    <p id="arc-login-status" class="arc-status-text" style="display:none;"></p>
                </div>

                <div id="arc-phase-fund" class="arc-phase" style="display:none;">
                    <div id="arc-wallet-address-box" class="arc-info-box">
                        <span class="arc-info-label">Your Arc Wallet</span>
                        <div class="arc-address-row">
                            <span id="arc-wallet-display" class="arc-address-text"></span>
                            <button id="arc-copy-btn" class="arc-copy-btn" title="Copy address">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                </svg>
                            </button>
                        </div>
                    </div>

                    <p class="arc-fund-label">${fundLabel}</p>

                    <div class="arc-fund-options">
                        <button id="arc-bridge-btn" class="arc-fund-card">
                            <div>
                                <strong>Bridge USDC</strong>
                            </div>
                        </button>

                        <a href="https://faucet.circle.com" target="_blank" rel="noopener" class="arc-fund-card">
                            <div>
                                <strong>USDC Faucet</strong>
                            </div>
                        </a>
                    </div>

                    <!-- Deposit Selector Section -->
                    <div class="arc-deposit-selector-wrap">
                        <span class="arc-info-label">USDC Deposit Amount to Gateway</span>
                        <div class="arc-deposit-selector">
                            <button type="button" class="arc-deposit-opt active" data-amount="1.00">1 USDC</button>
                            <button type="button" class="arc-deposit-opt" data-amount="5.00">5 USDC</button>
                            <button type="button" class="arc-deposit-opt" data-amount="10.00">10 USDC</button>
                            <div class="arc-deposit-custom-wrap">
                                <span class="arc-deposit-custom-symbol">$</span>
                                <input id="arc-deposit-custom-input" type="number" min="0.1" step="0.1" placeholder="Custom" />
                            </div>
                        </div>
                    </div>

                    <div id="arc-waiting-balance" class="arc-waiting-box" style="display:none;">
                        <div class="arc-spinner-sm"></div>
                        <span>Waiting for funds to arrive on Arc…</span>
                    </div>

                    <button id="arc-unlock-btn" class="arc-btn arc-btn-primary arc-btn-disabled" disabled>
                        ${unlockBtnText}
                    </button>
                    <p id="arc-fund-status" class="arc-status-text" style="display:none;"></p>
                </div>

                <div id="arc-phase-success" class="arc-phase" style="display:none;">
                    <div style="text-align:center;padding:12px 0 0;">
                        <!-- Circular Green SVG Checkmark -->
                        <div style="margin: 0 auto 16px; width: 44px; height: 44px; border-radius: 50%; background: rgba(34, 197, 94, 0.05); border: 1.5px solid rgba(34, 197, 94, 0.25); display: flex; align-items: center; justify-content: center;">
                            <svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width: 20px; height: 20px;">
                                <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                        </div>
                        <h3 style="color:#ffffff;margin:0 0 8px 0;font-size:18px;font-weight:700;font-family:'Outfit',sans-serif;">Session Ended</h3>
                        <p style="font-size:13.5px;color:#ffffff;margin:0 0 16px 0;line-height:1.5;font-weight:500;font-family:'Plus Jakarta Sans',sans-serif;">Your refund was successfully processed to your wallet.</p>
                        <a id="arc-success-scan-link" href="#" target="_blank"
                           style="font-size:13px;color:#22c55e;text-decoration:none;font-weight:700;display:inline-block;margin-bottom:20px;font-family:'Plus Jakarta Sans',sans-serif;">
                            View Balance on Arcscan ↗
                        </a>
                        <button id="arc-success-done-btn" class="arc-btn arc-btn-primary" style="width:100%;">Return to Home</button>
                    </div>
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

                        <div id="arc-cctp-supported-info" class="arc-supported-info" style="margin-top: 2px; margin-bottom: 12px;">
                            <span class="arc-info-icon" id="arc-cctp-info-btn" style="display: flex; align-items: center; gap: 4px;">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px; height:12px; flex-shrink:0;">
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <line x1="12" y1="16" x2="12" y2="12"></line>
                                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                                </svg>
                                Supported networks
                            </span>
                            <div id="arc-cctp-info-popup" class="arc-info-popup" style="display:none;">
                                <strong>CCTP-supported testnets:</strong>
                                <ul>
                                    <li>Ethereum Sepolia</li>
                                    <li>Base Sepolia</li>
                                    <li>Arbitrum Sepolia</li>
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

    // Wire up deposit selector buttons and custom input events
    const optButtons = overlay.querySelectorAll('.arc-deposit-opt');
    const customInput = overlay.querySelector('#arc-deposit-custom-input');

    optButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            optButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (customInput) customInput.value = '';
        });
    });

    if (customInput) {
        customInput.addEventListener('input', () => {
            optButtons.forEach(b => b.classList.remove('active'));
        });
        customInput.addEventListener('focus', () => {
            optButtons.forEach(b => b.classList.remove('active'));
        });
    }

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
        // REQUIRED per Circle UCW docs: establishes session with Circle's service via iframe.
        // Without this call, sdk.execute() silently fails and no PIN popup appears.
        arcSdk.getDeviceId();
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
        btn.innerHTML = `${LOCK_SVG} Sign in with PIN`;
        setLoginStatus('Error: ' + (error.message || 'Unknown error. Please retry.'), true);
    }
}

async function getOrCreateArcWallet(retries = 0) {
    if (retries > 10) {
        throw new Error('No se pudo configurar la wallet. Por favor intenta de nuevo.');
    }

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
        const execOutcome = await new Promise((resolve) => {
            arcSdk.execute(walletData.challengeId, (error, result) => {
                // Circle SDK can fire 'cancelled' even after the user completes PIN
                // and the wallet is created on Circle's side. Always resolve (never
                // reject here) so we can attempt recovery before giving up.
                resolve({ error: error ?? null, result: result ?? null });
            });
        });

        if (execOutcome.error) {
            // SDK reported an error — could be a Circle SDK false-positive "cancelled",
            // or the user genuinely closed the popup. Either way, check if the wallet
            // was actually created before throwing.
            const recoveryRes = await fetch(ARC_API_BASE + '/api/core/circle/get-wallet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: viewerState.userId, userToken: viewerState.userToken }),
            });
            if (recoveryRes.ok) {
                const recoveryData = await recoveryRes.json();
                if (recoveryData.status === 'existing' || recoveryData.status === 'ready') {
                    console.log('[Tessera] SDK reported cancel but wallet exists — recovered silently.');
                    return recoveryData;
                }
            }
            // Wallet genuinely does not exist — user cancelled before completing PIN.
            throw new Error('Setup cancelled. Click "Sign in with PIN" to try again.');
        }

        // SDK succeeded — re-fetch to get the confirmed walletId and address
        return getOrCreateArcWallet(retries + 1);
    }

    // Circle error 155106: wallet just initialized, still indexing on Circle's side.
    // Wait 1.5s and retry — per Circle docs: "Fetch existing wallets instead of creating".
    if (walletData.status === 'indexing') {
        setLoginStatus('Setting up your wallet…');
        await new Promise(resolve => setTimeout(resolve, 1500));
        return getOrCreateArcWallet(retries + 1);
    }

    return walletData;
}

// ─── Arc Balance Check (via eth_call on Arc RPC) ──────────────────────────────

async function getArcBalance(address) {
    try {
        const res = await fetch(ARC_API_BASE + '/api/core/wallet-balance?address=' + address);
        if (!res.ok) throw new Error('Balance endpoint returned non-OK status');
        const json = await res.json();
        return json.balance;
    } catch (e) {
        console.warn('[Tessera] Balance fetch via backend failed, using direct query fallback:', e);
        // Direct query fallback (handles case when backend is down/unreachable during early setup)
        try {
            const res = await fetch('https://rpc.testnet.arc.network', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 1, method: 'eth_getBalance',
                    params: [address, 'latest'],
                }),
            });
            const json = await res.json();
            const balance = BigInt(json.result || '0x0');
            return Number(balance) / 1e18;
        } catch (innerErr) {
            console.warn('[Tessera] Direct query fallback also failed:', innerErr);
            return 0;
        }
    }
}

async function checkArcBalance(address) {
    const bal = await getArcBalance(address);
    const minReq = getRequiredMinBalance();
    const minDeposit = isTipMode ? minReq : Math.max(0.10, minReq);
    return bal >= minDeposit;
}

// ─── Phase 2: Funding Panel ───────────────────────────────────────────────────

function transitionToFundPhase() {
    document.getElementById('arc-phase-login').style.display = 'none';
    const fundPhase = document.getElementById('arc-phase-fund');
    fundPhase.style.display = 'block';

    // Change header content to the simplified Phase 2 label
    const headerTitle = document.querySelector('#arc-paywall-header h2');
    if (headerTitle) {
        headerTitle.innerHTML = 'Fund your wallet to watch:';
        headerTitle.className = 'arc-fund-header-label'; // Change layout style
    }
    const headerSub = document.querySelector('#arc-paywall-header p');
    if (headerSub) headerSub.style.display = 'none';

    // Show abbreviated wallet address
    const addr = viewerState.walletAddress || '';
    const display = addr ? addr.slice(0, 6) + '…' + addr.slice(-4) : '';
    const displayEl = document.getElementById('arc-wallet-display');
    if (displayEl) displayEl.textContent = display;
}

function copyWalletAddress() {
    if (!viewerState.walletAddress) return;
    navigator.clipboard.writeText(viewerState.walletAddress).then(() => {
        const btn = document.getElementById('arc-copy-btn');
        const oldHtml = btn.innerHTML;
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width:14px; height:14px;"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => { btn.innerHTML = oldHtml; }, 2000);
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
    btn.innerHTML = isTipMode ? `${UNLOCK_SVG} Enable Tipping` : `${UNLOCK_SVG} Unlock Video`;
    document.getElementById('arc-waiting-balance').style.display = 'none';
    // Small celebration pulse
    btn.classList.add('arc-pulse-once');
    setTimeout(() => btn.classList.remove('arc-pulse-once'), 600);
}

function getSelectedDepositAmount() {
    const customInput = document.getElementById('arc-deposit-custom-input');
    if (customInput && customInput.value.trim() !== '') {
        const amt = parseFloat(customInput.value);
        return isNaN(amt) ? 1.00 : amt;
    }
    const activeBtn = document.querySelector('.arc-deposit-opt.active');
    if (activeBtn) {
        const amt = parseFloat(activeBtn.getAttribute('data-amount'));
        return isNaN(amt) ? 1.00 : amt;
    }
    return 1.00;
}

// ─── Phase 3: Unlock Video / Enable Tipping ───────────────────────────────────

async function handleUnlock() {
    const btn = document.getElementById('arc-unlock-btn');
    btn.disabled = true;
    btn.innerHTML = isTipMode 
        ? '<div class="arc-spinner-sm" style="margin-right:8px;"></div> Enabling…'
        : '<div class="arc-spinner-sm" style="margin-right:8px;"></div> Unlocking…';
    setFundStatus('');

    try {
        const selectedAmount = getSelectedDepositAmount();
        if (selectedAmount < 0.1) {
            throw new Error('Minimum deposit amount is 0.1 USDC');
        }

        setFundStatus('Checking wallet balance…');
        const currentBalance = await getArcBalance(viewerState.walletAddress);
        if (currentBalance < selectedAmount) {
            throw new Error(`Insufficient funds: Your wallet has $${currentBalance.toFixed(4)} USDC, but you chose to deposit $${selectedAmount.toFixed(2)} USDC.`);
        }

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
        if (!arcSdk) {
            arcSdk = new W3SSdk({
                appSettings: { appId: tokenData.appId }
            });
            arcSdk.getDeviceId();
        }
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
                if (Number(balData.gatewayAvailable) >= getRequiredMinBalance()) {
                    skipDeposit = true;
                    console.log('[Tessera] Gateway already funded. Skipping deposit.');
                }
            }
        } catch (_) { /* proceed to deposit */ }

        if (!skipDeposit) {
            setFundStatus('Approve USDC deposit in the popup…');

            // Prepare a deposit challenge from SCA → Ephemeral Wallet
            const depositRes = await fetch(ARC_API_BASE + '/api/core/circle/prepare-deposit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userToken: viewerState.userToken,
                    walletId: viewerState.walletId,
                    depositAmount: selectedAmount.toString(),
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
                ratePerSecond: getRequiredMinBalance(),
            }),
        });
        if (!regRes.ok) {
            const errJson = await regRes.json().catch(() => ({}));
            throw new Error(errJson.error || 'Backend failed to register session.');
        }

        // ✅ Unlock stream or Enable Tipping
        if (!isTipMode) {
            document.body.classList.remove('arc-locked');
            const sm = document.getElementById('arc-session-manager');
            if (sm) sm.classList.remove('arc-hidden');
            startSessionTimer();
        } else {
            // Refresh tipping widget to reflect new wallet balance/card state
            if (typeof window.arcShowTipButton === 'function') {
                viewerState.userId = localStorage.getItem('arc_cashier_user_id');
                viewerState.walletId = localStorage.getItem('arc_circle_wallet_id');
                viewerState.walletAddress = localStorage.getItem('arc_circle_wallet_address');
                viewerState.ephemeralPk = localStorage.getItem('arc_ephemeral_pk');
                window.arcShowTipButton(tipCreatorWallet, tipAmountVal);
            }

            // Automatically trigger the tip button click
            const tipBtn = document.getElementById('arc-tip-btn');
            if (tipBtn) {
                setTimeout(() => {
                    tipBtn.click();
                }, 100);
            }
        }

        const overlay = document.getElementById('arc-paywall-overlay');
        if (overlay) {
            overlay.style.opacity = '0';
            setTimeout(() => overlay.remove(), 500);
        }

    } catch (error) {
        console.error('[Tessera] Unlock error:', error);
        btn.disabled = false;
        btn.innerHTML = isTipMode ? `${UNLOCK_SVG} Enable Tipping` : `${UNLOCK_SVG} Unlock Video`;
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
        btn.innerHTML = `<span>${chain.name}</span>`;
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
    setCctpProgress('Connecting wallet…');

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

        // ── Step 1: Approve USDC -> TokenMessengerV2 ──────────────────────────
        setStepStatus('arc-step-approve-status', 'pending');
        setCctpProgress('Approving USDC…<br>Confirm in your wallet.');

        const bridgeAmount = amountUnits;
        const forwardingFee = BigInt(200000); // 0.20 USDC fee for Circle Forwarding Service
        const totalAmount = bridgeAmount + forwardingFee;

        const approveData = '0x095ea7b3' +
            TOKEN_MESSENGER_V2.slice(2).padStart(64, '0') +
            totalAmount.toString(16).padStart(64, '0');

        const approveTx = await window.ethereum.request({
            method: 'eth_sendTransaction',
            params: [{ from: fromAddress, to: chain.usdc, data: approveData }],
        });
        await waitForTx(approveTx, chain.chainId);
        setStepStatus('arc-step-approve-status', 'done');

        // ── Step 2: depositForBurnWithHook -> burn USDC with Forwarding hook ──
        setStepStatus('arc-step-burn-status', 'pending');
        setCctpProgress('Burning USDC on source chain…<br>Confirm in your wallet.');

        // mintRecipient must be bytes32 (padded Arc wallet address)
        const recipient = viewerState.walletAddress;
        const recipientBytes32 = '0x000000000000000000000000' + recipient.slice(2);

        // ARC_TESTNET_DOMAIN = 26
        const ARC_DOMAIN = 26;
        const minFinalityThreshold = 1000; // enables Fast Transfer

        // depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)
        // selector: 0xe0a17441
        // offset of hookData (8th parameter) = 256 bytes (8 slots * 32 bytes)
        // length of hookData = 32 bytes
        // hookData = 0x636374702d666f72776172640000000000000000000000000000000000000000
        const selector = '0xe0a17441';
        const offset = BigInt(256);
        const hookDataLength = BigInt(32);
        const hookDataValue = '636374702d666f72776172640000000000000000000000000000000000000000';

        const burnData = selector
            + totalAmount.toString(16).padStart(64, '0')
            + ARC_DOMAIN.toString(16).padStart(64, '0')
            + recipientBytes32.slice(2).padStart(64, '0')
            + chain.usdc.slice(2).padStart(64, '0')
            + '0'.padStart(64, '0') // destinationCaller = zero (any relayer)
            + forwardingFee.toString(16).padStart(64, '0')
            + minFinalityThreshold.toString(16).padStart(64, '0')
            + offset.toString(16).padStart(64, '0')
            + hookDataLength.toString(16).padStart(64, '0')
            + hookDataValue;

        const burnTx = await window.ethereum.request({
            method: 'eth_sendTransaction',
            params: [{ from: fromAddress, to: TOKEN_MESSENGER_V2, data: burnData }],
        });
        await waitForTx(burnTx, chain.chainId);
        setStepStatus('arc-step-burn-status', 'done');

        // ── Step 3: Poll Circle Forwarding status on frontend ─────────────────
        setStepStatus('arc-step-mint-status', 'pending');
        setCctpProgress('Minting on Arc via Circle Relayer…<br>This takes ~1-2 minutes. You can close this modal.');
        closeCctpModal();

        // Show waiting indicator on funding panel
        document.getElementById('arc-waiting-balance').style.display = 'flex';
        if (balancePollingInterval) clearInterval(balancePollingInterval);

        // Poll Iris API for forwardTxHash
        try {
            const forwardTxHash = await pollCctpForwarding(chain.domain, burnTx);
            setStepStatus('arc-step-mint-status', 'done');
            console.log(`[CCTP] Forwarded mint transaction detected on Arc: ${forwardTxHash}`);
            startBalancePolling();
        } catch (err) {
            console.error('[Tessera] CCTP forwarding error:', err);
            setFundStatus('Bridge submitted but confirmation timed out. Polling wallet balance...', true);
            startBalancePolling(); // Still poll as the mint might succeed eventually
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

async function pollCctpForwarding(sourceDomain, txHash) {
    const irisUrl = `https://iris-api-sandbox.circle.com/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
    for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
            const res = await fetch(irisUrl);
            if (!res.ok) continue;

            const data = await res.json();
            const msg = data?.messages?.[0];
            if (msg?.forwardTxHash) {
                return msg.forwardTxHash;
            }
        } catch (e) {
            console.warn(`[CCTP] Error polling Iris:`, e);
        }
    }
    throw new Error('CCTP forwarding timed out');
}

function setStepStatus(stepId, status) {
    const el = document.getElementById(stepId);
    if (!el) return;
    el.innerHTML = status === 'pending' 
        ? '<div class="arc-spinner-sm"></div>' 
        : status === 'done' 
            ? '<span style="color:#22c55e;font-weight:700;">✓</span>' 
            : '';
}

function setCctpProgress(msg) {
    const el = document.getElementById('arc-cctp-progress-msg');
    if (el) el.innerHTML = msg;
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
                <div><span>Rate:</span>       <span id="arc-sm-rate">$0.0001 USDC / sec</span></div>
                <div><span>Video cost:</span> <span id="arc-sm-video-cost">$0.0000 USDC</span></div>
                <div><span>Balance:</span>    <span id="arc-sm-balance">— USDC</span></div>
            </div>
            <div id="arc-sm-warning" class="arc-hidden">
                <p class="arc-warning-text">⚠️ Low Balance: <span id="arc-sm-time-left"></span> left</p>
                <div id="arc-sm-topup-form" style="display:none;margin:6px 0;">
                    <div style="display:flex;gap:6px;align-items:center;justify-content:center;">
                        <span style="color:#ffffff;font-size:12px;font-weight:700;">$</span>
                        <input id="arc-sm-topup-input" type="number" min="0.01" step="0.01" placeholder="Amount" />
                        <button id="arc-sm-topup-confirm-btn" class="arc-sm-btn">Confirm</button>
                        <button id="arc-sm-topup-cancel-btn" class="arc-sm-btn">✕</button>
                    </div>
                </div>
                <button id="arc-sm-topup-btn" class="arc-sm-btn">Top Up</button>
            </div>
            <div class="arc-sm-btn-group">
                <button id="arc-sm-leave-btn" class="arc-sm-btn">Just Leave</button>
                <button id="arc-sm-end-btn" class="arc-sm-btn">Cash Out &amp; Exit</button>
            </div>
            <p style="margin:8px 0 0;font-size:10px;color:#ffffff;text-align:center;line-height:1.3;font-weight:500;">Leave keeps funds for next time. Cash Out withdraws to your wallet.</p>
        </div>
    `;
    document.body.appendChild(sm);

    // Draggable
    let isDragging = false, startX, startY, initialX, initialY;
    const header = document.getElementById('arc-sm-header');
    header.addEventListener('mousedown', (e) => {
        if (e.target.id === 'arc-sm-minimize-btn' || e.target.closest('button') || e.target.closest('input')) return;
        e.preventDefault(); // Prevent text selection and cursor updates while dragging
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

    // Top Up: toggle the amount input form
    document.getElementById('arc-sm-topup-btn').addEventListener('click', () => {
        document.getElementById('arc-sm-topup-form').style.display = 'block';
        document.getElementById('arc-sm-topup-btn').style.display = 'none';
        document.getElementById('arc-sm-topup-input').focus();
    });
    document.getElementById('arc-sm-topup-cancel-btn').addEventListener('click', () => {
        document.getElementById('arc-sm-topup-form').style.display = 'none';
        document.getElementById('arc-sm-topup-btn').style.display = 'inline-block';
        document.getElementById('arc-sm-topup-btn').innerText = 'Top Up';
        document.getElementById('arc-sm-topup-btn').disabled = false;
    });
    document.getElementById('arc-sm-topup-confirm-btn').addEventListener('click', () => {
        const input = document.getElementById('arc-sm-topup-input');
        const amount = parseFloat(input.value);
        if (!amount || amount < 0.01) {
            input.style.borderColor = 'red';
            return;
        }
        input.style.borderColor = '';
        handleTopUp(amount);
    });
    document.getElementById('arc-sm-leave-btn').addEventListener('click', window.arcLeaveSession);
    document.getElementById('arc-sm-end-btn').addEventListener('click', window.arcEndSession);
}

// ─── Global Media Tracking ────────────────────────────────────────────────────
let playingMediaCount = 0;

// Expose manual control for dedicated plugins (like PeerTube) to override blind global tracking
if (window.arcManualMediaControl === undefined) {
    window.arcManualMediaControl = false;
}
window.arcSetMediaPlaying = function(isPlaying) {
    playingMediaCount = isPlaying ? 1 : 0;
};

// Allow plugin to update rate when switching between videos with different prices
window.arcSetRate = function(ratePerSec) {
    if (ratePerSec && Number(ratePerSec) > 0) {
        currentRatePerSecond = Number(ratePerSec);
        // Paywall overlay rate display
        const el = document.getElementById('arc-display-rate');
        if (el) el.textContent = 'From $' + currentRatePerSecond.toFixed(4) + ' USDC / sec (varies by video)';
        // Session manager rate display
        const rateEl = document.getElementById('arc-sm-rate');
        if (rateEl) rateEl.textContent = '$' + currentRatePerSecond.toFixed(4) + ' USDC / sec';
    }
};

// Called by the PeerTube plugin (client.ts) when the user navigates to a new video.
// Resets the per-video cost counter and updates the displayed rate without
// touching the global session or the gateway balance.
window.arcResetVideoSession = function(newRate) {
    // Reset per-video counters
    secondsThisVideo = 0;
    initialGatewayBalance = null; // Will be re-captured on next heartbeat

    // Update rate if provided
    if (newRate && Number(newRate) > 0) {
        currentRatePerSecond = Number(newRate);
    }

    // Refresh session manager UI
    const rateEl = document.getElementById('arc-sm-rate');
    if (rateEl) rateEl.textContent = '$' + currentRatePerSecond.toFixed(4) + ' USDC / sec';

    const videoCostEl = document.getElementById('arc-sm-video-cost');
    if (videoCostEl) videoCostEl.textContent = '$0.0000 USDC';

    // Also keep paywall overlay in sync
    const displayRate = document.getElementById('arc-display-rate');
    if (displayRate) displayRate.textContent = 'From $' + currentRatePerSecond.toFixed(4) + ' USDC / sec (varies by video)';

    // Auto-unlock if credentials exist and paywall is still locked
    if (document.body.classList.contains('arc-locked') && viewerState.userId && viewerState.walletAddress) {
        void checkAutoUnlock();
    }
};

document.addEventListener('play', (e) => {
    if (window.arcManualMediaControl) return;
    if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') {
        playingMediaCount++;
    }
}, true);
document.addEventListener('pause', (e) => {
    if (window.arcManualMediaControl) return;
    if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') {
        playingMediaCount = Math.max(0, playingMediaCount - 1);
    }
}, true);
document.addEventListener('ended', (e) => {
    if (window.arcManualMediaControl) return;
    if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') {
        playingMediaCount = Math.max(0, playingMediaCount - 1);
    }
}, true);

// Current rate per second — updated dynamically from each video's ping response
let currentRatePerSecond = 0.0001;
// Per-video cost counter — lives at module scope so arcResetVideoSession() can reset it
let secondsThisVideo = 0;
// Gateway balance at session start — used to display accurate real cost (not a client-side estimate)
let initialGatewayBalance = null;

function startSessionTimer() {
    if (window.sessionTimer) clearInterval(window.sessionTimer);
    // Reset per-video counters for this new session unlock
    secondsThisVideo = 0;
    initialGatewayBalance = null;
    // Local tick counter for the 5-second backend sync interval
    // (ticks every 1s regardless of play state, so the sync is time-based)
    let tickCount = 0;

    // Show initial rate in the session manager immediately
    const initialRateEl = document.getElementById('arc-sm-rate');
    if (initialRateEl) initialRateEl.textContent = '$' + currentRatePerSecond.toFixed(4) + ' USDC / sec';

    let lastWithdrawableBalance = null;

    // Fetch the initial gateway balance immediately so video cost is accurate and displayed from the start
    fetch(ARC_API_BASE + '/api/core/session-balance?userId=' + viewerState.userId)
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
            if (data) {
                const withdrawable = Number(data.gatewayWithdrawable);
                initialGatewayBalance = withdrawable;
                lastWithdrawableBalance = withdrawable;
                const balEl = document.getElementById('arc-sm-balance');
                if (balEl) balEl.textContent = '$' + withdrawable.toFixed(4) + ' USDC';
                const videoCostEl = document.getElementById('arc-sm-video-cost');
                if (videoCostEl) videoCostEl.textContent = '$0.0000 USDC';
            }
        })
        .catch(function() {});

    window.sessionTimer = setInterval(async () => {
        tickCount++;
        let isMediaPlaying = playingMediaCount > 0;
        if (!isMediaPlaying) {
            // Fallback: check if there's any active HTML5 video or audio element playing in the DOM
            const mediaElements = document.querySelectorAll('video, audio');
            mediaElements.forEach(m => {
                if (!m.paused && !m.ended && m.readyState >= 2) {
                    isMediaPlaying = true;
                }
            });
        }
        const shouldTick = !document.body.classList.contains('arc-locked') && isMediaPlaying;
        if (shouldTick) {
            secondsThisVideo++;
        }

        if (tickCount % 5 === 0) {
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
                        // Capture initial balance on first heartbeat if the immediate fetch above hadn't resolved yet
                        if (initialGatewayBalance === null) {
                            initialGatewayBalance = withdrawable;
                        } else if (lastWithdrawableBalance !== null && withdrawable > lastWithdrawableBalance) {
                            // Top-up detected! Adjust initial balance to keep spent calculation correct.
                            initialGatewayBalance += (withdrawable - lastWithdrawableBalance);
                        }
                        lastWithdrawableBalance = withdrawable;
                        const balEl = document.getElementById('arc-sm-balance');
                        if (balEl) balEl.textContent = '$' + withdrawable.toFixed(4) + ' USDC';
                        // Display real cost: what the gateway actually deducted, not a client-side estimate
                        const videoCostEl = document.getElementById('arc-sm-video-cost');
                        if (videoCostEl) {
                            const spent = Math.max(0, initialGatewayBalance - withdrawable);
                            videoCostEl.textContent = '$' + spent.toFixed(4) + ' USDC';
                        }
                        const secondsLeft = withdrawable / currentRatePerSecond;
                        const warningDiv = document.getElementById('arc-sm-warning');
                        if (warningDiv) {
                            if (secondsLeft <= 300 && secondsLeft > 0) {
                                warningDiv.classList.remove('arc-hidden');
                                const tl = document.getElementById('arc-sm-time-left');
                                if (tl) tl.textContent = `${Math.floor(secondsLeft / 60)}m ${Math.floor(secondsLeft % 60)}s`;
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

async function handleTopUp(depositAmount) {
    const btn = document.getElementById('arc-sm-topup-btn');
    const confirmBtn = document.getElementById('arc-sm-topup-confirm-btn');
    const cancelBtn = document.getElementById('arc-sm-topup-cancel-btn');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.innerText = 'Processing…'; }
    if (cancelBtn) cancelBtn.disabled = true;

    const resetForm = (label = 'Top Up') => {
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.innerText = 'Confirm'; }
        if (cancelBtn) cancelBtn.disabled = false;
        const form = document.getElementById('arc-sm-topup-form');
        if (form) form.style.display = 'none';
        if (btn) { btn.style.display = 'inline-block'; btn.innerText = label; btn.disabled = false; }
    };

    try {
        // Step 0: Flush any funds already sitting in the ephemeral wallet
        // (handles Circle SDK false-positive errors from previous top-up attempts)
        const flushRes = await fetch(ARC_API_BASE + '/api/core/topup-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: viewerState.userId }),
        });
        if (flushRes.ok) {
            const flushData = await flushRes.json();
            if (flushData.deposited && Number(flushData.deposited) > 0) {
                console.log(`[Tessera] Flushed ${flushData.deposited} USDC from ephemeral wallet to Gateway.`);
                resetForm('Top Up');
                document.getElementById('arc-sm-warning').classList.add('arc-hidden');
                return; // Funds recovered — no Circle SDK interaction needed
            }
        }

        // Step 1: Refresh Circle user token
        const tokenRes = await fetch(ARC_API_BASE + '/api/core/circle/get-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: viewerState.userId }),
        });
        if (!tokenRes.ok) throw new Error('Failed to refresh Circle session');
        const tokenData = await tokenRes.json();

        if (!arcSdk) {
            arcSdk = new W3SSdk({
                appSettings: { appId: tokenData.appId }
            });
            arcSdk.getDeviceId();
        }
        arcSdk.setAuthentication({
            userToken: tokenData.userToken,
            encryptionKey: tokenData.encryptionKey,
        });

        // Step 2: Create the transfer from the SCA wallet to the ephemeral wallet
        const prepRes = await fetch(ARC_API_BASE + '/api/core/circle/prepare-deposit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userToken: tokenData.userToken,
                walletId: viewerState.walletId,
                depositAmount: depositAmount.toFixed(6),
                ephemeralPk: viewerState.ephemeralPk,
            }),
        });
        if (!prepRes.ok) throw new Error('Failed to prepare top-up');
        const prepData = await prepRes.json();

        // Step 3: Execute — Circle SDK shows the approval popup
        // We do NOT reject on SDK callback error: the transaction may have succeeded
        // on-chain even if the callback fires with an error (Circle SDK quirk).
        // topup-session in Step 4 will confirm whether funds arrived.
        let sdkSucceeded = false;
        await new Promise((resolve) => {
            arcSdk.execute(prepData.challengeId, (error, result) => {
                if (!error) sdkSucceeded = true;
                resolve(); // Always continue — verify via topup-session
            });
        });

        // Step 4: Deposit ephemeral wallet balance into Gateway
        const topupRes = await fetch(ARC_API_BASE + '/api/core/topup-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: viewerState.userId, expectFunds: true }),
        });

        if (!topupRes.ok) {
            // topup-session 400 means no funds arrived in ephemeral wallet
            // (user likely cancelled the Circle SDK popup)
            throw new Error('Top-up cancelled or no funds received');
        }

        resetForm('Top Up');
        document.getElementById('arc-sm-warning').classList.add('arc-hidden');
    } catch (error) {
        console.error('[Tessera] Top-up failed', error);
        resetForm('Error (Retry)');
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

    if (isTipMode) {
        // Tipping mode: clear ephemeral session keys and reset the tipping widget UI
        localStorage.removeItem('arc_ephemeral_pk');
        viewerState.ephemeralPk = null;

        // Reset tipping widget to onboarding/connect state
        const container = document.getElementById('arc-tip-btn-container');
        if (container) {
            container.remove();
            if (typeof window.arcShowTipButton === 'function') {
                window.arcShowTipButton(tipCreatorWallet, tipAmountVal);
            }
        }
    } else {
        // Pay-per-second mode: lock video and show paused session message
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
    }
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
            viewerState.ephemeralPk = null;
            // We keep user identity (userId, walletId, walletAddress) so returning users do not have to recreate their PIN or wallet address.
            // These stay persistent for subsequent sessions or top-ups.

            // Lock screen
            document.body.classList.add('arc-locked');

            // Force render overlay
            renderPaywallOverlay();

            // Parse transaction hash from response
            let txHash = '';
            try {
                const resData = JSON.parse(xhr.responseText);
                txHash = resData.txHash || '';
            } catch (_) {}

            const scanUrl = txHash 
                ? `https://testnet.arcscan.app/tx/${txHash}` 
                : `https://testnet.arcscan.app/address/${walletAddress}`;

            const scanText = txHash
                ? '🧾 View Transaction on Arcscan'
                : '🧾 View Balance on Arcscan';

            // Transition to success phase on overlay
            document.getElementById('arc-phase-login').style.display = 'none';
            document.getElementById('arc-phase-fund').style.display = 'none';
            const successPhase = document.getElementById('arc-phase-success');
            if (successPhase) {
                successPhase.style.display = 'block';
                const link = document.getElementById('arc-success-scan-link');
                if (link) {
                    link.href = scanUrl;
                    link.textContent = scanText;
                }
                const doneBtn = document.getElementById('arc-success-done-btn');
                if (doneBtn) {
                    doneBtn.onclick = () => {
                        successPhase.style.display = 'none';
                        document.getElementById('arc-phase-login').style.display = 'block';
                    };
                }
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

// ─── Tip Button (Free Videos) ─────────────────────────────────────────────────
//
// Renders a floating tip button and a wallet status/balance widget.
// Handles onboarding (Circle login + wallet setup) if the user has no session.

// Fetches the viewer's current Gateway balance. Returns number or null on failure.
async function fetchTipBalance() {
    const userId = viewerState.userId;
    if (!userId) return null;
    try {
        const res = await fetch(ARC_API_BASE + '/api/core/session-balance?userId=' + userId);
        if (!res.ok) return null;
        const data = await res.json();
        return Number(data.gatewayWithdrawable) || 0;
    } catch (_) { return null; }
}

// Triggers the full Circle wallet onboarding overlay so the user can
// connect/create their wallet and fund it before tipping.
function openTipOnboarding() {
    if (isTipMode) {
        injectDependencies();
        renderPaywallOverlay();
    } else if (window.ArcCashier && typeof window.ArcCashier.initPaywall === 'function') {
        window.ArcCashier.initPaywall();
    } else {
        document.body.classList.add('arc-locked');
    }
}

window.arcShowTipButton = function(creatorWallet, tipAmount) {
    // Remove any existing tip button
    const existing = document.getElementById('arc-tip-btn-container');
    if (existing) existing.remove();

    const amount = parseFloat(tipAmount) || 0.10;
    let tipCount = 0;

    const container = document.createElement('div');
    container.id = 'arc-tip-btn-container';

    // Renders the container styled dynamically based on whether the wallet is active
    const updateContainerStyle = () => {
        if (viewerState.userId && viewerState.ephemeralPk) {
            // Funded/Connected card style
            container.classList.remove('arc-tip-unconnected');
            container.classList.add('arc-tip-connected');
        } else {
            // Simple floating button container style
            container.classList.remove('arc-tip-connected');
            container.classList.add('arc-tip-unconnected');
        }
    };
    updateContainerStyle();

    container.innerHTML = `
        <div id="arc-tip-header" style="display:none;">
            <h3><span class="arc-pulse-dot"></span> Support Creator</h3>
            <button id="arc-tip-minimize-btn" title="Minimize">−</button>
        </div>
        
        <div id="arc-tip-status-card" class="arc-sm-stats" style="display:none;">
            <div>
                <span>Balance:</span>
                <span id="arc-tip-balance-val">⏳ Checking…</span>
            </div>
            <div id="arc-tip-sent-row" style="display:none;">
                <span>Tips Sent:</span>
                <span id="arc-tip-sent-val">$0.00 USDC</span>
            </div>
        </div>

        <div id="arc-tip-status-pill" style="display:none;">
            🔗 Connect wallet to tip
        </div>

        <div style="display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;">
            <button id="arc-tip-btn" class="arc-btn">
                ❤️ Support $${amount.toFixed(2)}
            </button>
            
            <div id="arc-tip-wallet-actions" style="display:none;">
                <button id="arc-tip-leave-btn">Just Leave</button>
                <button id="arc-tip-end-btn">Cash Out &amp; Exit</button>
            </div>
        </div>
    `;

    document.body.appendChild(container);

    // Draggable & Minimizable
    let isTipDragging = false, tipStartX, tipStartY, tipInitialX, tipInitialY;
    const tipHeaderEl = document.getElementById('arc-tip-header');
    
    tipHeaderEl.addEventListener('mousedown', (e) => {
        if (e.target.id === 'arc-tip-minimize-btn' || e.target.closest('button') || e.target.closest('input')) return;
        e.preventDefault(); // Prevent text selection and cursor updates while dragging
        isTipDragging = true;
        const rect = container.getBoundingClientRect();
        tipInitialX = rect.left; tipInitialY = rect.top;
        tipStartX = e.clientX; tipStartY = e.clientY;
        container.style.right = 'auto'; container.style.bottom = 'auto';
    });
    tipHeaderEl.addEventListener('mousedown', () => { tipHeaderEl.style.cursor = 'grabbing'; });
    document.addEventListener('mousemove', (e) => {
        if (!isTipDragging) return;
        container.style.left = `${tipInitialX + e.clientX - tipStartX}px`;
        container.style.top = `${tipInitialY + e.clientY - tipStartY}px`;
    });
    document.addEventListener('mouseup', () => { 
        isTipDragging = false; 
        tipHeaderEl.style.cursor = 'grab';
    });

    document.getElementById('arc-tip-minimize-btn').addEventListener('click', () => {
        container.classList.toggle('arc-tip-minimized');
        document.getElementById('arc-tip-minimize-btn').innerText =
            container.classList.contains('arc-tip-minimized') ? '+' : '−';
    });

    const btn = document.getElementById('arc-tip-btn');
    const header = document.getElementById('arc-tip-header');
    const statusCard = document.getElementById('arc-tip-status-card');
    const statusPill = document.getElementById('arc-tip-status-pill');
    const balanceVal = document.getElementById('arc-tip-balance-val');
    const sentRow = document.getElementById('arc-tip-sent-row');
    const sentVal = document.getElementById('arc-tip-sent-val');
    const walletActions = document.getElementById('arc-tip-wallet-actions');

    const leaveBtn = document.getElementById('arc-tip-leave-btn');
    const endBtn = document.getElementById('arc-tip-end-btn');

    btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.03)'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = 'scale(1)'; });

    const refreshStatus = async () => {
        if (!viewerState.userId || !viewerState.ephemeralPk) {
            updateContainerStyle();
            header.style.display = 'none';
            statusCard.style.display = 'none';
            walletActions.style.display = 'none';
            statusPill.style.display = 'block';
            statusPill.style.color = '#718096';
            statusPill.textContent = '🔗 Connect wallet to tip';
            return;
        }

        updateContainerStyle();
        header.style.display = 'flex';
        statusCard.style.display = 'block';
        walletActions.style.display = 'flex';
        statusPill.style.display = 'none';

        const balance = await fetchTipBalance();
        if (balance === null) {
            balanceVal.textContent = `$0.0000 USDC`;
        } else {
            balanceVal.textContent = `$${balance.toFixed(4)} USDC`;
        }
    };
    void refreshStatus();

    // Start background status updates for tipping balance
    const tipInterval = setInterval(() => {
        if (document.getElementById('arc-tip-btn-container')) {
            void refreshStatus();
        } else {
            clearInterval(tipInterval);
        }
    }, 5000);

    leaveBtn.addEventListener('click', window.arcLeaveSession);

    endBtn.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to cash out and exit? This will return your remaining balance to your wallet.')) {
            return;
        }

        endBtn.disabled = true;
        endBtn.innerHTML = 'Withdrawing…';

        try {
            await fetch(ARC_API_BASE + '/api/core/end-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: viewerState.userId }),
            });

            const res = await fetch(ARC_API_BASE + '/api/core/cash-out', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: viewerState.userId }),
            });

            if (res.ok) {
                const walletAddress = viewerState.walletAddress || '';
                
                // Parse transaction hash from response
                let txHash = '';
                try {
                    const resData = await res.json();
                    txHash = resData.txHash || '';
                } catch (_) {}

                localStorage.removeItem('arc_ephemeral_pk');
                viewerState.ephemeralPk = null;
                // We keep user identity (userId, walletId, walletAddress) so returning users do not have to recreate their PIN or wallet address.
                // These stay persistent for subsequent sessions or top-ups.

                const scanUrl = txHash 
                    ? `https://testnet.arcscan.app/tx/${txHash}` 
                    : `https://testnet.arcscan.app/address/${walletAddress}`;

                const scanText = txHash
                    ? '🧾 View Transaction on Arcscan'
                    : '🧾 View Balance on Arcscan';

                // Render success screen inside the tipping widget card
                container.innerHTML = `
                    <div style="padding:10px;text-align:center;font-family:'Inter',sans-serif;color:#f1f5f9;width:100%;box-sizing:border-box;">
                        <h3 style="color:#68d391;margin:0 0 10px 0;font-size:13px;font-weight:600;">✅ Cashed Out</h3>
                        <p style="font-size:11px;color:#a0aec0;margin:0 0 12px 0;line-height:1.4;">Your refund was successfully processed to your wallet.</p>
                        <a href="${scanUrl}" target="_blank"
                           style="font-size:11px;color:#38ef7d;text-decoration:underline;font-weight:600;display:inline-block;margin-bottom:8px;">
                            ${scanText}
                        </a>
                        <button id="arc-tip-success-close" class="arc-btn" style="padding:4px 8px;font-size:10px;background:#4a5568;width:100%;margin-top:6px;box-shadow:none;justify-content:center;">Close</button>
                    </div>
                `;
                document.getElementById('arc-tip-success-close').addEventListener('click', () => {
                    // Reset the tipping button state back to initial unconnected floating card
                    window.arcShowTipButton(creatorWallet, tipAmount);
                });
            } else {
                throw new Error('Cash-out failed on server');
            }
        } catch (err) {
            console.error('[Tessera] Cash-out failed', err);
            alert('Cash-out failed: ' + (err.message || 'Please try again.'));
            endBtn.disabled = false;
            endBtn.innerHTML = 'Cash Out & Exit';
        }
    });

    // ── Click handler ─────────────────────────────────────────────────────
    btn.addEventListener('click', async () => {
        // No userId or no ephemeralPk (active session) -> trigger full wallet onboarding
        if (!viewerState.userId || !viewerState.ephemeralPk) {
            openTipOnboarding();
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Sending\u2026';

        const sendTip = async (attempt = 1) => {
            try {
                const res = await fetch(ARC_API_BASE + '/api/core/tip', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: viewerState.userId,
                        creatorWallet: creatorWallet,
                        amount: amount.toFixed(6),
                    }),
                });

                if (res.ok) {
                    tipCount++;
                    const total = (amount * tipCount).toFixed(2);
                    statusCard.style.display = 'block';
                    sentRow.style.display = 'flex';
                    sentVal.textContent = `\u2764\uFE0F \xD7${tipCount} = $${total} sent`;
                    btn.textContent = `\u2764\uFE0F +$${amount.toFixed(2)} more`;
                    void refreshStatus();
                } else {
                    const err = await res.json().catch(() => ({}));
                    console.error('[Tessera] Tip failed:', err);

                    if (res.status === 404) {
                        if (attempt === 1 && viewerState.walletAddress && viewerState.ephemeralPk) {
                            console.log('[Tessera] Attempting silent session registration...');
                            try {
                                const regRes = await fetch(ARC_API_BASE + '/api/core/register-session', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        userId: viewerState.userId,
                                        privateKey: viewerState.ephemeralPk,
                                        returnAddress: viewerState.walletAddress,
                                        ratePerSecond: getRequiredMinBalance(),
                                    }),
                                });
                                if (regRes.ok) {
                                    console.log('[Tessera] Silent session registration succeeded. Retrying tip.');
                                    await sendTip(2);
                                    return;
                                }
                            } catch (regErr) {
                                console.error('[Tessera] Silent registration error:', regErr);
                            }
                        }

                        btn.textContent = `\u2764\uFE0F Support $${amount.toFixed(2)}`;
                        void refreshStatus();
                        openTipOnboarding();
                    } else if (res.status === 402) {
                        btn.textContent = `\u2764\uFE0F Support $${amount.toFixed(2)}`;
                        void refreshStatus();
                        openTipOnboarding();
                    } else {
                        btn.textContent = 'Error \u2014 retry';
                    }
                }
            } catch (e) {
                console.error('[Tessera] Tip request error:', e);
                btn.textContent = 'Error \u2014 retry';
            }
        };

        await sendTip();
        btn.disabled = false;
    });
};


// ─── Tip Mode (Free Videos) ──────────────────────────────────────────────────
//
// Called by the PeerTube plugin when the current video is in 'free' mode.
// Does NOT lock the video. Only renders the session manager (hidden) and
// shows the tip button so the viewer can optionally support the creator.

function initTipMode(creatorWallet, tipAmount) {
    isTipMode = true;
    tipCreatorWallet = creatorWallet;
    tipAmountVal = tipAmount;
    injectDependencies();

    // Clear any active pay-per-second timers from previous premium videos
    if (window.sessionTimer) {
        clearInterval(window.sessionTimer);
        window.sessionTimer = null;
    }
    if (window.arcPingInterval) {
        clearInterval(window.arcPingInterval);
        window.arcPingInterval = null;
    }
    playingMediaCount = 0;

    // Clear any active balance polling intervals
    if (balancePollingInterval) {
        clearInterval(balancePollingInterval);
        balancePollingInterval = null;
    }

    // Guarantee video is never locked in tip mode
    document.body.classList.remove('arc-locked');
    // Remove any lingering paywall overlay from previous videos
    const overlay = document.getElementById('arc-paywall-overlay');
    if (overlay) overlay.remove();
    // Render hidden session manager so arcLeaveSession / arcEndSession work
    // if the user already has an active pay-per-second session elsewhere.
    renderSessionManager();
    // Show the floating tip button
    if (typeof window.arcShowTipButton === 'function') {
        window.arcShowTipButton(creatorWallet, tipAmount);
    }
}

// ─── Bootstrap & SPA API ─────────────────────────────────────────────────────
//
// paywall.js does NOT auto-initialize on load.
// The PeerTube plugin (client.ts) reads the video's tessera-mode from the
// backend FIRST, then calls the appropriate method:
//
//   window.ArcCashier.initPaywall()              → pay-per-second (blocks video)
//   window.ArcCashier.initTipMode(wallet, amount) → free video (tip button only)
//
// This prevents free videos from being incorrectly blocked before the ping
// response arrives, which was the root cause of the reported bug.

window.ArcCashier = {
    initPaywall,
    initTipMode,
    // Legacy alias kept for backwards compatibility with any external callers
    init: initPaywall,
};
