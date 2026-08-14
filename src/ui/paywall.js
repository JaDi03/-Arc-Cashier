// arc-paywall.js - Universal Paywall Engine (platform-agnostic)
// Injected or embedded by any Tessera connector.

import { W3SSdk } from '@circle-fin/w3s-pw-web-sdk';
import { initCreatorEarnings } from './creator-earnings.js';
import { wireCctpBridgeModal } from './cctp-bridge.js';

// Circle W3S SocialLoginProvider string values (enum not re-exported from package entry).
const SOCIAL_GOOGLE = 'Google';
const SOCIAL_FACEBOOK = 'Facebook';
const SOCIAL_PENDING_KEY = 'tessera_social_login_pending';
/** Survives OAuth location.replace so the video page stays covered until paywall mounts. */
const OPAQUE_COVER_KEY = 'tessera_opaque_cover';

// ─── Constants (all values verified from official docs) ──────────────────────

const SCRIPT_SRC = (document.currentScript && document.currentScript.src) ? document.currentScript.src : '';
const SCRIPT_BASE_DIR = SCRIPT_SRC ? SCRIPT_SRC.substring(0, SCRIPT_SRC.lastIndexOf('/') + 1) : '/demo-assets/';
// Derive the API base by stripping the asset-directory suffix from the script URL.
const ARC_API_BASE = SCRIPT_SRC
    ? SCRIPT_SRC.replace(/\/[^/]*assets\/[^?#]*.*$/, '')
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

// Maximum safe 32-bit signed integer. Used for every element that must float
// above the page's own content. On its own this is NOT sufficient to beat a
// real Fullscreen-API element (see mountFloatingElement below) — the browser
// promotes a fullscreen element to a "top layer" that no z-index outside it
// can ever cross. Reparenting handles that; this constant handles everything
// else (regular in-page stacking contexts).
const MAX_Z_INDEX = 2147483647;

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

// Official multicolor "G" from Google Identity branding (Sign in with Google).
const GOOGLE_G_SVG = `
    <svg class="arc-btn-svg arc-google-g" width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false" style="margin-right:8px; display:inline-block; vertical-align:middle;">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
    </svg>
`;

const GOOGLE_CONTINUE_HTML = `${GOOGLE_G_SVG} Continue with Google`;

// Minimum balance required in the Arc wallet before enabling the unlock button
const MIN_ARC_BALANCE_WEI = BigInt('10000000000000000'); // 0.01 USDC (18 decimals)

// ─── State ───────────────────────────────────────────────────────────────────

let arcSdk = null;
/** Shared in-flight promise so module bootstrap + initPaywall do not double-resume. */
let socialResumeInFlight = null;
/** Resolves when a one-time Circle handoff or server-side refresh is loaded into memory. */
let circleAuthHydratePromise = null;
let viewerState = {
    userId: localStorage.getItem('arc_cashier_user_id'),
    // Circle SDK credentials exist in memory only. The refresh token remains httpOnly.
    userToken: null,
    encryptionKey: null,
    appId: null,
    authMethod: localStorage.getItem('arc_cashier_auth_method') || 'email',
    email: localStorage.getItem('arc_cashier_email') || null,
    walletId: localStorage.getItem('arc_circle_wallet_id'),
    walletAddress: localStorage.getItem('arc_circle_wallet_address'),
    // Memory only. Never persist private keys in localStorage (XSS surface).
    ephemeralPk: null,
};

// Migrate away from legacy persisted ephemeral keys.
try { localStorage.removeItem('arc_ephemeral_pk'); } catch (_) { /* ignore */ }

const CIRCLE_AUTH_LS_KEYS = [
    'arc_cashier_user_id',
    'arc_cashier_email',
    'arc_cashier_auth_method',
    'arc_cashier_user_token',
    'arc_cashier_encryption_key',
    'arc_cashier_refresh_token',
    'arc_circle_wallet_id',
    'arc_circle_wallet_address',
];

const CIRCLE_TOKEN_LS_KEYS = [
    'arc_cashier_user_token',
    'arc_cashier_encryption_key',
    'arc_cashier_refresh_token',
];

function clearCircleTokenLocalStorage() {
    CIRCLE_TOKEN_LS_KEYS.forEach((key) => {
        try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
    });
}

async function persistCircleServerSession(userToken, refreshToken) {
    if (!userToken || !refreshToken) {
        throw new Error('Circle login did not return a refresh token');
    }
    const res = await fetch(ARC_API_BASE + '/api/core/circle/auth/session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userToken, refreshToken }),
    });
    if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to persist Circle session');
    }
}

async function createCircleAuthHandoff() {
    if (!viewerState.userToken || !viewerState.encryptionKey) {
        throw new Error('Missing Circle credentials for redirect handoff');
    }
    const res = await fetch(ARC_API_BASE + '/api/core/circle/auth/handoff', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userToken: viewerState.userToken,
            encryptionKey: viewerState.encryptionKey,
        }),
    });
    if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to create Circle auth handoff');
    }
}

async function clearCircleServerSession() {
    try {
        await fetch(ARC_API_BASE + '/api/core/circle/auth/session', {
            method: 'DELETE',
            credentials: 'include',
        });
    } catch (_) { /* ignore */ }
}

/**
 * Load Circle SDK credentials once after OAuth redirect. On normal reloads, the
 * backend refreshes from httpOnly session cookies without exposing refreshToken.
 */
function ensureCircleAuthHydrated() {
    if (circleAuthHydratePromise) return circleAuthHydratePromise;
    circleAuthHydratePromise = (async () => {
        const legacyToken = localStorage.getItem('arc_cashier_user_token');
        const legacyEnc = localStorage.getItem('arc_cashier_encryption_key');
        const legacyRefresh = localStorage.getItem('arc_cashier_refresh_token');
        if (legacyToken && legacyEnc) {
            viewerState.userToken = legacyToken;
            viewerState.encryptionKey = legacyEnc;
            try {
                if (legacyRefresh) {
                    await persistCircleServerSession(legacyToken, legacyRefresh);
                }
            } catch (err) {
                console.warn(
                    '[Tessera] Failed to migrate Circle server session:',
                    err && err.message ? err.message : err,
                );
            }
            clearCircleTokenLocalStorage();
            return;
        }
        clearCircleTokenLocalStorage();
        try {
            const res = await fetch(ARC_API_BASE + '/api/core/circle/auth/handoff/redeem', {
                method: 'POST',
                credentials: 'include',
            });
            if (res.ok) {
                const data = await res.json();
                if (data.userToken && data.encryptionKey) {
                    viewerState.userToken = data.userToken;
                    viewerState.encryptionKey = data.encryptionKey;
                    return;
                }
            }
            if (viewerState.userId) {
                await refreshCircleAuthFromServer();
            }
        } catch (err) {
            console.warn(
                '[Tessera] Failed to hydrate Circle session:',
                err && err.message ? err.message : err,
            );
        }
    })();
    return circleAuthHydratePromise;
}

/** Persist non-secret identity only. Circle credentials remain in memory/server cookies. */
function persistCircleAuthSession() {
    if (viewerState.userId) localStorage.setItem('arc_cashier_user_id', viewerState.userId);
    if (viewerState.email) localStorage.setItem('arc_cashier_email', viewerState.email);
    if (viewerState.authMethod) localStorage.setItem('arc_cashier_auth_method', viewerState.authMethod);
    if (viewerState.walletId) localStorage.setItem('arc_circle_wallet_id', viewerState.walletId);
    if (viewerState.walletAddress) localStorage.setItem('arc_circle_wallet_address', viewerState.walletAddress);
    clearCircleTokenLocalStorage();
}

function clearCircleAuthTokens() {
    viewerState.userToken = null;
    viewerState.encryptionKey = null;
    clearCircleTokenLocalStorage();
    void clearCircleServerSession();
}

/** True when Unlock/deposit can resume without a fresh email/social login. */
function hasResumableCircleSession() {
    return Boolean(
        viewerState.userId
        && viewerState.walletAddress
        && viewerState.userToken
        && viewerState.encryptionKey
    );
}

// Auth is email OTP or social login only. Legacy PIN-era identities (arc_*)
// cannot resume a session, so drop them: the viewer signs in with email/social.
if (viewerState.userId
    && !viewerState.userId.startsWith('email:')
    && !viewerState.userId.startsWith('social:')) {
    CIRCLE_AUTH_LS_KEYS.forEach((key) => localStorage.removeItem(key));
    viewerState.userId = null;
    viewerState.authMethod = 'email';
    viewerState.email = null;
    viewerState.walletId = null;
    viewerState.walletAddress = null;
    clearCircleAuthTokens();
}

// Incomplete session check runs after cookie hydrate (see ensureCircleAuthHydrated).
let pendingEmailOtp = null; // { deviceToken, deviceEncryptionKey, otpToken, email, appId }
let socialAuthConfig = { googleClientId: '', facebookAppId: '' };

let balancePollingInterval = null;
let isTipMode = false;
let tipCreatorWallet = null;
let tipAmountVal = null;
let isCheckingAutoUnlock = false;

// Idempotency guard for lockMedia(). Null means no lock is active.
let mediaLockController = null;

/** Debug helper kept as a no-op so call sites stay harmless in production. */
function agentDebugLog(_hypothesisId, _message, _data) { }

// Floating elements are reparented into document.fullscreenElement on
// every fullscreenchange so they stay visible above the top-layer.
const floatingElements = new Set();

// ─── Universal container / fullscreen mounting (no platform selectors) ───────

/** Returns the connector-supplied container element, or null if none. */
function resolveContainer(targetContainer) {
    if (targetContainer instanceof HTMLElement) return targetContainer;
    if (typeof targetContainer === 'string') {
        const el = document.querySelector(targetContainer);
        if (el) return el;
    }
    return null;
}

/** Returns document.fullscreenElement if active, otherwise document.body. */
function getOverlayMountPoint() {
    return document.fullscreenElement || document.body;
}

/**
 * Appends `el` to `explicitContainer` (if given) or to the current fullscreen
 * mount point. Elements without an explicit container are tracked in
 * `floatingElements` and reparented automatically on fullscreenchange.
 */
function mountFloatingElement(el, explicitContainer) {
    const container = explicitContainer || getOverlayMountPoint();
    el.style.zIndex = String(MAX_Z_INDEX);
    container.appendChild(el);
    if (!explicitContainer) {
        floatingElements.add(el);
    }
}

document.addEventListener('fullscreenchange', () => {
    const mountPoint = getOverlayMountPoint();
    floatingElements.forEach((el) => {
        if (el.isConnected && el.parentElement !== mountPoint) {
            mountPoint.appendChild(el);
        }
    });
});

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

function isValidEphemeralPrivateKey(pk) {
    return typeof pk === 'string' && /^0x[0-9a-fA-F]{64}$/.test(pk);
}

/**
 * Prefer the server-canonical ephemeral (sync-session) when Circle auth is
 * available so web and mobile share the same Gateway balance. Only mint a
 * new key when sync returns 404 / no session.
 */
async function ensureEphemeralKey() {
    const memoryPk = viewerState.ephemeralPk;

    if (viewerState.userId && viewerState.userToken && viewerState.walletAddress) {
        try {
            const syncRes = await fetch(ARC_API_BASE + '/api/core/sync-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: viewerState.userId,
                    userToken: viewerState.userToken,
                    returnAddress: viewerState.walletAddress,
                }),
            });
            if (syncRes.ok) {
                const data = await syncRes.json();
                if (isValidEphemeralPrivateKey(data.privateKey)) {
                    viewerState.ephemeralPk = data.privateKey;
                    return data.privateKey;
                }
            } else if (syncRes.status !== 404) {
                console.warn('[Tessera] sync-session status=' + syncRes.status);
            }
        } catch (err) {
            console.warn('[Tessera] sync-session error:', err && err.message ? err.message : err);
        }
    }

    if (isValidEphemeralPrivateKey(memoryPk)) {
        viewerState.ephemeralPk = memoryPk;
        return memoryPk;
    }

    const generated = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    viewerState.ephemeralPk = generated;
    return generated;
}

function applyCanonicalEphemeralFromRegister(regData) {
    if (regData && isValidEphemeralPrivateKey(regData.privateKey)) {
        viewerState.ephemeralPk = regData.privateKey;
    }
}

async function registerViewerSession(ratePerSecond) {
    await ensureEphemeralKey();
    if (!viewerState.userToken) {
        throw new Error('Circle session required to register billing session');
    }
    // #region agent log
    const regStart = Date.now();
    agentDebugLog('H4', 'register-session start', {
        userId: viewerState.userId,
        hasEphemeral: !!viewerState.ephemeralPk,
        ratePerSecond,
    });
    // #endregion
    const regRes = await fetch(ARC_API_BASE + '/api/core/register-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: viewerState.userId,
            privateKey: viewerState.ephemeralPk,
            returnAddress: viewerState.walletAddress,
            ratePerSecond: ratePerSecond,
            userToken: viewerState.userToken,
        }),
    });
    const regData = await regRes.json().catch(() => ({}));
    if (regRes.ok) {
        applyCanonicalEphemeralFromRegister(regData);
    }
    // #region agent log
    agentDebugLog('H4', 'register-session end', {
        status: regRes.status,
        ok: regRes.ok,
        elapsedMs: Date.now() - regStart,
        error: regData.error || null,
    });
    // #endregion
    return { regRes, regData };
}

async function checkAutoUnlock() {
    await ensureCircleAuthHydrated();
    if (isCheckingAutoUnlock) return;
    if (!hasResumableCircleSession()) return;

    isCheckingAutoUnlock = true;
    // Paid init uses hideInitially (pointer-events:none). Free tip modal does not.
    // Always reveal + clear sticky status unless we fully auto-unlocked.
    let autoUnlocked = false;
    let hasFundsResult = null;
    let sessionBalanceStatus = null;
    let autoUnlockBranch = 'start';
    // #region agent log
    const autoUnlockStart = Date.now();
    agentDebugLog('H3', 'checkAutoUnlock enter', {
        userId: viewerState.userId,
        hasToken: !!viewerState.userToken,
        hasWallet: !!viewerState.walletAddress,
    });
    // #endregion
    try {
        // Unlock/billing is funded from Gateway (same source the tip widget shows).
        // Wallet SCA balance only matters later, when the user needs to deposit into Gateway.
        setFundStatus('Checking Gateway balance…');
        const minReq = getRequiredMinBalance();

        // First try: existing session record (returning user / already registered).
        let balRes = await fetch(ARC_API_BASE + '/api/core/session-balance?userId=' + viewerState.userId);
        sessionBalanceStatus = balRes.status;
        // #region agent log
        agentDebugLog('H3', 'session-balance first', { status: balRes.status });
        // #endregion

        // 404 = no session record. Do NOT register here: register-session waits
        // ~18s for ephemeral funds that do not exist yet. Show deposit UI instead.
        if (balRes.status === 404) {
            // #region agent log
            agentDebugLog('H3', 'session-balance 404 -> skip register, show deposit', { minReq });
            // #endregion
            autoUnlockBranch = 'no-session-show-deposit';
            setFundStatus('');
            enableUnlockButton();
            return;
        }

        let gatewayAvailable = 0;
        if (balRes.ok) {
            const balData = await balRes.json();
            gatewayAvailable = Number(balData.gatewayAvailable || '0');
        }
        hasFundsResult = gatewayAvailable >= minReq;

        if (gatewayAvailable >= minReq) {
            // Tip mode: never auto-start a paid session timer / initPaywall path.
            if (isTipMode) {
                autoUnlockBranch = 'tip-enable';
                setFundStatus('');
                enableUnlockButton();
                return;
            }

            setFundStatus('Auto-unlocking session…');
            const { regRes } = await registerViewerSession(getRequiredMinBalance());

            if (regRes.ok) {
                console.log('[Tessera] Auto-unlocked using existing Gateway session.');
                autoUnlocked = true;
                autoUnlockBranch = 'paid-auto-unlocked';
                setFundStatus('');
                unlockMedia();
                document.body.classList.remove('arc-locked');

                const overlay = document.getElementById('arc-paywall-overlay');
                if (overlay) {
                    overlay.style.pointerEvents = 'none';
                    overlay.style.opacity = '0';
                    setTimeout(() => overlay.remove(), 500);
                }

                const sm = document.getElementById('arc-session-manager');
                if (sm) sm.classList.remove('arc-hidden');
                startSessionTimer();
                if (typeof window.tesseraOnPaywallUnlocked === 'function') {
                    void window.tesseraOnPaywallUnlocked();
                }
                return;
            }

            // Gateway funded but register failed -> let user retry via Unlock
            autoUnlockBranch = 'manual-unlock';
            setFundStatus('');
            enableUnlockButton();
            return;
        }

        // Gateway empty: wallet only gates whether the user can deposit now.
        const walletCanDeposit = await checkArcBalance(viewerState.walletAddress);
        if (walletCanDeposit) {
            autoUnlockBranch = 'manual-unlock';
            setFundStatus('');
            enableUnlockButton();
        } else {
            autoUnlockBranch = 'polling';
            setFundStatus('');
            startBalancePolling();
        }
    } catch (error) {
        console.error('[Tessera] Auto-unlock check failed:', error && error.message ? error.message : error);
        autoUnlockBranch = 'catch';
        setFundStatus('');
        startBalancePolling();
    } finally {
        isCheckingAutoUnlock = false;
        if (!autoUnlocked) {
            const overlay = document.getElementById('arc-paywall-overlay');
            if (overlay) {
                overlay.classList.remove('arc-hidden-initially');
                overlay.classList.remove('arc-session-check');
            }
        }
        // #region agent log
        const overlay = document.getElementById('arc-paywall-overlay');
        const btn = document.getElementById('arc-unlock-btn');
        let topAtCenter = null;
        if (overlay) {
            const r = overlay.getBoundingClientRect();
            topAtCenter = document.elementFromPoint(
                r.left + (r.width / 2),
                r.top + (r.height / 2)
            );
        }
        agentDebugLog('H3', 'checkAutoUnlock exit', {
            isTipMode,
            autoUnlocked,
            autoUnlockBranch,
            hasFunds: hasFundsResult,
            sessionBalanceStatus,
            btnDisabled: btn ? btn.disabled : null,
            btnClass: btn ? btn.className : null,
            overlayClass: overlay ? overlay.className : null,
            overlayPointerEvents: overlay ? getComputedStyle(overlay).pointerEvents : null,
            overlayOpacity: overlay ? getComputedStyle(overlay).opacity : null,
            fundStatus: (document.getElementById('arc-fund-status') || {}).textContent || '',
            parentTag: overlay && overlay.parentElement ? overlay.parentElement.tagName : null,
            topAtCenterTag: topAtCenter ? topAtCenter.tagName : null,
            topAtCenterId: topAtCenter ? topAtCenter.id : null,
            elapsedMs: Date.now() - autoUnlockStart,
        });
        // #endregion
    }
}

// ─── Init ────────────────────────────────────────────────────────────────────

function initPaywall(targetContainer) {
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
    renderPaywallOverlay(true, targetContainer);
    renderSessionManager();

    // #region agent log
    agentDebugLog('H1', 'initPaywall start', {
        hasResumable: hasResumableCircleSession(),
        hideInitially: true,
        overlayHidden: document.getElementById('arc-paywall-overlay')?.classList.contains('arc-hidden-initially'),
    });
    // #endregion

    void (async () => {
        await ensureCircleAuthHydrated();
        const resumed = await tryResumeSocialLogin();
        if (resumed) return;
        // Only skip login when Circle session can actually refresh + sign deposits.
        if (hasResumableCircleSession()) {
            transitionToFundPhase();
            void checkAutoUnlock();
        } else {
            // Reveal login card if we hid it during hydrate (returning-wallet cover).
            const overlay = document.getElementById('arc-paywall-overlay');
            if (overlay) {
                overlay.classList.remove('arc-session-check');
                overlay.classList.remove('arc-hidden-initially');
            }
        }
    })();
}

function injectCss(id, filename) {
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = SCRIPT_BASE_DIR + filename;
    document.head.appendChild(link);
}

function injectDependencies() {
    injectCss('arc-paywall-css', 'paywall.css');
}

function initCreatorEarningsUi(options) {
    injectDependencies();
    injectCss('arc-creator-earnings-css', 'creator-earnings.css');
    return initCreatorEarnings(options);
}

/**
 * Pauses all media while arc-locked is active. Idempotent — safe to call
 * multiple times across SPA navigations. Only elements paused by this function
 * are tracked; unlockMedia() resumes exactly those and nothing else.
 */
function lockMedia() {
    if (mediaLockController) return;

    const pausedByUs = new WeakSet();

    const pausePlayingMedia = () => {
        if (isTipMode || !document.body.classList.contains('arc-locked')) return;
        document.querySelectorAll('video, audio').forEach((m) => {
            if (!m.paused) {
                m.pause();
                pausedByUs.add(m);
            }
        });
    };

    // Pause immediately: do not wait for the next play event or 500ms poll.
    pausePlayingMedia();

    const onPlayCapture = (e) => {
        if (isTipMode) return;
        if (!document.body.classList.contains('arc-locked')) return;
        const target = e.target;
        if (target.tagName === 'VIDEO' || target.tagName === 'AUDIO') {
            target.pause();
            pausedByUs.add(target);
        }
    };

    const intervalId = setInterval(pausePlayingMedia, 500);

    document.addEventListener('play', onPlayCapture, true);

    mediaLockController = {
        pausedByUs,
        teardown() {
            document.removeEventListener('play', onPlayCapture, true);
            clearInterval(intervalId);
        },
    };
}

/** Tears down the media lock and resumes exactly the elements lockMedia() paused. */
function unlockMedia() {
    if (!mediaLockController) return;
    const { pausedByUs, teardown } = mediaLockController;
    teardown();
    mediaLockController = null;

    document.querySelectorAll('video, audio').forEach((m) => {
        if (pausedByUs.has(m)) {
            m.play().catch(() => { /* autoplay policy may block; user can resume manually */ });
        }
    });
}

// ─── Overlay ─────────────────────────────────────────────────────────────────

function renderPaywallOverlay(hideInitially = false, targetContainer = null) {
    const existing = document.getElementById('arc-paywall-overlay');
    if (existing) existing.remove();

    const title = isTipMode ? "Support Creator" : "Premium Stream";
    const subtitle = isTipMode ? "Set up your wallet to send tips." : "Pay only for the seconds you watch.";
    const pricingBox = isTipMode ? `
                        <div class="arc-pricing-row">
                            <span>Action</span>
                            <span class="arc-accent">Support Creator</span>
                        </div>
                        <div class="arc-pricing-row">
                            <span>Min. deposit</span>
                            <span class="arc-accent">1.00 USDC</span>
                        </div>
    ` : `
                        <div class="arc-pricing-row">
                            <span>Rate</span>
                            <span class="arc-accent" id="arc-display-rate">From $0.0001 / sec</span>
                        </div>
    `;
    const fundLabel = isTipMode ? "Fund your wallet to tip:" : "Fund your wallet to watch:";
    const unlockBtnText = isTipMode
        ? `${UNLOCK_SVG} Enable Tipping`
        : `${UNLOCK_SVG} Unlock Video`;

    const overlay = document.createElement('div');
    overlay.id = 'arc-paywall-overlay';
    overlay.classList.add('arc-tessera-root');
    // Critical cover styles inline so the video is hidden even if paywall.css
    // has not finished loading yet (avoids a one-frame flash).
    if (!isTipMode) {
        overlay.style.background = 'rgba(6, 7, 10, 0.92)';
    }

    // Paid hideInitially: opaque cover + hide modal card while auth hydrate/auto-unlock
    // runs. Do not require in-memory tokens (httpOnly hydrate is async); userId+wallet
    // from localStorage is enough to treat as returning viewer for cover purposes.
    const mayResumeSession = Boolean(viewerState.userId && viewerState.walletAddress);
    if ((mayResumeSession || hasResumableCircleSession()) && hideInitially && !isTipMode) {
        overlay.classList.add('arc-session-check');
    }
    overlay.innerHTML = `
        <div id="arc-paywall-modal" style="position:relative;">
            ${isTipMode ? '<button id="arc-paywall-close-btn" class="arc-modal-close" style="position:absolute;top:16px;right:16px;background:none;border:none;color:#a0aec0;font-size:18px;cursor:pointer;z-index:10;">✕</button>' : ''}
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
                    <button id="arc-google-btn" class="arc-btn arc-btn-primary arc-btn-google" type="button" style="width:100%;display:none;">
                        ${GOOGLE_CONTINUE_HTML}
                    </button>
                    <button id="arc-facebook-btn" class="arc-btn arc-btn-primary" type="button" style="width:100%;margin-top:10px;display:none;">
                        Continue with Facebook
                    </button>
                    <div id="arc-social-email-divider" style="display:none;align-items:center;gap:10px;margin:10px 0;color:#718096;font-size:12px;">
                        <span style="flex:1;height:1px;background:rgba(255,255,255,0.12);"></span>
                        or
                        <span style="flex:1;height:1px;background:rgba(255,255,255,0.12);"></span>
                    </div>
                    <label for="arc-email-input" class="arc-info-label" style="display:block;margin:0 0 6px 0;text-align:left;">Email</label>
                    <input id="arc-email-input" type="email" autocomplete="email" placeholder="you@example.com" value="${viewerState.email || ''}"
                        style="width:100%;box-sizing:border-box;margin:0 0 10px 0;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(0,0,0,0.35);color:#fff;font-size:14px;" />
                    <button id="arc-login-btn" class="arc-btn arc-btn-primary" type="button">
                        ${LOCK_SVG} Send email code
                    </button>
                    <button id="arc-verify-otp-btn" class="arc-btn arc-btn-primary" type="button" style="display:none;margin-top:10px;">
                        Verify code
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
                        <div class="arc-ucw-balance-row">
                            <span class="arc-info-label" style="margin:0;">Wallet balance</span>
                            <div class="arc-ucw-balance-actions">
                                <span id="arc-ucw-balance" class="arc-accent">…</span>
                                <button id="arc-withdraw-btn" type="button" class="arc-icon-btn" title="Withdraw" aria-label="Withdraw">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                        <path d="M7 17L17 7"></path>
                                        <path d="M7 7h10v10"></path>
                                    </svg>
                                </button>
                            </div>
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
                    <button id="arc-signout-btn" type="button" style="background:none;border:none;color:rgba(255,255,255,0.45);font-size:12px;margin-top:10px;cursor:pointer;text-decoration:underline;width:100%;">Sign out</button>
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
                        <button id="arc-success-withdraw-btn" class="arc-btn arc-btn-primary" type="button" style="width:100%;margin-bottom:10px;">Withdraw</button>
                        <button id="arc-success-done-btn" class="arc-btn arc-btn-secondary" type="button" style="width:100%;">Return to Home</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- External withdraw modal (UCW → Arc address) -->
        <div id="arc-withdraw-modal" class="arc-modal-backdrop" style="display:none;">
            <div class="arc-modal-box">
                <div class="arc-modal-header">
                    <h3>Withdraw USDC</h3>
                    <button id="arc-withdraw-close" class="arc-modal-close" type="button">✕</button>
                </div>
                <div class="arc-modal-body">
                    <div id="arc-withdraw-step-form">
                        <div class="arc-amount-row">
                            <label for="arc-withdraw-address">Destination address</label>
                            <input id="arc-withdraw-address" type="text" autocomplete="off" spellcheck="false" placeholder="0x…" class="arc-amount-input" style="width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;" />
                        </div>
                        <div class="arc-amount-row" style="margin-top:12px;">
                            <label for="arc-withdraw-amount">Amount (USDC)</label>
                            <div class="arc-amount-input-wrap">
                                <input id="arc-withdraw-amount" type="number" min="0.000001" step="any" placeholder="0.00" class="arc-amount-input" />
                                <span class="arc-amount-suffix">USDC</span>
                            </div>
                        </div>
                        <p id="arc-withdraw-form-status" class="arc-status-text" style="display:none;margin-top:10px;"></p>
                        <button id="arc-withdraw-review-btn" class="arc-btn arc-btn-primary" type="button" style="margin-top:16px;width:100%;">
                            Review withdraw
                        </button>
                    </div>
                    <div id="arc-withdraw-step-confirm" style="display:none;">
                        <p class="arc-modal-label">Confirm this transfer</p>
                        <div class="arc-withdraw-review-box">
                            <div><span>Network</span><strong>Arc Testnet</strong></div>
                            <div><span>Token</span><strong>USDC</strong></div>
                            <div><span>To</span><strong id="arc-withdraw-review-to" class="arc-withdraw-review-addr">—</strong></div>
                            <div><span>Amount</span><strong id="arc-withdraw-review-amount">—</strong></div>
                            <div><span>Est. fee</span><strong id="arc-withdraw-review-fee">—</strong></div>
                        </div>
                        <p id="arc-withdraw-confirm-status" class="arc-status-text" style="display:none;margin-top:10px;"></p>
                        <div style="display:flex;gap:8px;margin-top:16px;">
                            <button id="arc-withdraw-back-btn" class="arc-btn arc-btn-secondary" type="button" style="flex:1;">Back</button>
                            <button id="arc-withdraw-confirm-btn" class="arc-btn arc-btn-primary" type="button" style="flex:1;">Confirm &amp; approve</button>
                        </div>
                    </div>
                    <div id="arc-withdraw-step-done" style="display:none;text-align:center;">
                        <p class="arc-status-text" style="display:block;color:#22c55e;">Withdraw complete</p>
                        <a id="arc-withdraw-tx-link" href="#" target="_blank" rel="noopener" style="font-size:13px;color:#22c55e;font-weight:700;display:inline-block;margin:12px 0 16px;">View on Arcscan ↗</a>
                        <button id="arc-withdraw-done-btn" class="arc-btn arc-btn-primary" type="button" style="width:100%;">Done</button>
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

    // Always mount on body / fullscreen mount point (same as tip mode). Contained
    // mounts inside the player lose hit-testing to host OSD pages (e.g. Jellyfin
    // videoOsdPage) that sit outside the player stacking context. Connectors may
    // still pass targetContainer for API compatibility; it is ignored for mount.
    mountFloatingElement(overlay);
    // Paywall is up: drop OAuth/early cover so we do not stack two full-screen layers.
    consumeOpaqueCoverFlag();
    hideSocialResumeSplash();

    // #region agent log
    const unlockBtnForMountLog = document.getElementById('arc-unlock-btn');
    const overlayRect = overlay.getBoundingClientRect();
    const centerX = overlayRect.left + (overlayRect.width / 2);
    const centerY = overlayRect.top + (overlayRect.height / 2);
    const topAtCenter = document.elementFromPoint(centerX, centerY);
    agentDebugLog('H1,H4', 'paywall overlay mounted', {
        isTipMode,
        contained: false,
        connectorPassedContainer: Boolean(resolveContainer(targetContainer)),
        parentTag: overlay.parentElement ? overlay.parentElement.tagName : null,
        parentClass: overlay.parentElement ? overlay.parentElement.className : null,
        parentLastChildId: overlay.parentElement && overlay.parentElement.lastElementChild ? overlay.parentElement.lastElementChild.id : null,
        overlayClass: overlay.className,
        overlayPointerEvents: getComputedStyle(overlay).pointerEvents,
        overlayOpacity: getComputedStyle(overlay).opacity,
        btnDisabled: unlockBtnForMountLog ? unlockBtnForMountLog.disabled : null,
        topAtCenterTag: topAtCenter ? topAtCenter.tagName : null,
        topAtCenterId: topAtCenter ? topAtCenter.id : null,
        topAtCenterClass: topAtCenter ? topAtCenter.className : null,
    });
    // #endregion

    // Wire up events
    if (isTipMode) {
        overlay.classList.add('arc-tip-mode-overlay');
        document.body.classList.remove('arc-locked');

        // Dismiss modal on clicking outside the modal box
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                document.body.classList.remove('arc-locked');
            }
        });

        const tipCloseBtn = document.getElementById('arc-paywall-close-btn');
        if (tipCloseBtn) {
            tipCloseBtn.addEventListener('click', () => {
                const ov = document.getElementById('arc-paywall-overlay');
                if (ov) ov.remove();
                document.body.classList.remove('arc-locked');
            });
        }
    }
    document.getElementById('arc-login-btn').addEventListener('click', handleRequestEmailOtp);
    const verifyOtpBtn = document.getElementById('arc-verify-otp-btn');
    if (verifyOtpBtn) verifyOtpBtn.addEventListener('click', handleVerifyEmailOtp);
    const googleBtn = document.getElementById('arc-google-btn');
    if (googleBtn) googleBtn.addEventListener('click', () => { void handleSocialLogin(SOCIAL_GOOGLE); });
    const facebookBtn = document.getElementById('arc-facebook-btn');
    if (facebookBtn) facebookBtn.addEventListener('click', () => { void handleSocialLogin(SOCIAL_FACEBOOK); });
    void refreshSocialLoginButtons();
    document.getElementById('arc-unlock-btn').addEventListener('click', (event) => {
        // #region agent log
        const btn = document.getElementById('arc-unlock-btn');
        const btnRect = btn ? btn.getBoundingClientRect() : null;
        const topAtButton = btnRect
            ? document.elementFromPoint(btnRect.left + (btnRect.width / 2), btnRect.top + (btnRect.height / 2))
            : null;
        agentDebugLog('H1,H2', 'unlock button click listener fired', {
            isTipMode,
            btnDisabled: btn ? btn.disabled : null,
            btnClass: btn ? btn.className : null,
            topAtButtonTag: topAtButton ? topAtButton.tagName : null,
            topAtButtonId: topAtButton ? topAtButton.id : null,
            topAtButtonClass: topAtButton ? topAtButton.className : null,
        });
        // #endregion
        return handleUnlock(event);
    });
    document.getElementById('arc-copy-btn').addEventListener('click', copyWalletAddress);
    const withdrawBtn = document.getElementById('arc-withdraw-btn');
    if (withdrawBtn) withdrawBtn.addEventListener('click', () => { void openExternalWithdrawModal(); });
    const successWithdrawBtn = document.getElementById('arc-success-withdraw-btn');
    if (successWithdrawBtn) successWithdrawBtn.addEventListener('click', () => { void openExternalWithdrawModal(); });
    const successDoneBtn = document.getElementById('arc-success-done-btn');
    if (successDoneBtn) successDoneBtn.addEventListener('click', handleSuccessReturnHome);
    wireExternalWithdrawModal();
    const signoutBtn = document.getElementById('arc-signout-btn');
    if (signoutBtn) signoutBtn.addEventListener('click', handleLogout);

    // #region agent log
    overlay.addEventListener('click', (event) => {
        const btn = document.getElementById('arc-unlock-btn');
        const btnRect = btn ? btn.getBoundingClientRect() : null;
        const topAtButton = btnRect
            ? document.elementFromPoint(btnRect.left + (btnRect.width / 2), btnRect.top + (btnRect.height / 2))
            : null;
        agentDebugLog('H1,H2', 'overlay capture click', {
            isTipMode,
            targetTag: event.target ? event.target.tagName : null,
            targetId: event.target ? event.target.id : null,
            targetClass: event.target ? event.target.className : null,
            btnDisabled: btn ? btn.disabled : null,
            topAtButtonTag: topAtButton ? topAtButton.tagName : null,
            topAtButtonId: topAtButton ? topAtButton.id : null,
            topAtButtonClass: topAtButton ? topAtButton.className : null,
        });
    }, true);
    // #endregion

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

    // CCTP modal: Bridge Kit (extracted module)
    wireCctpBridgeModal({
        getRecipientAddress: () => viewerState.walletAddress,
        setFundStatus,
        onBridgeSubmitted: () => {
            if (balancePollingInterval) clearInterval(balancePollingInterval);
            startBalancePolling();
        },
    });
}

/** Refresh SDK credentials while refreshToken remains server-side in httpOnly cookies. */
async function refreshCircleAuthFromServer() {
    if (!viewerState.appId) {
        await loadCircleClientConfig();
    }
    ensureArcSdk();
    const deviceId = await arcSdk.getDeviceId();
    if (!deviceId) return false;

    const refreshRes = await fetch(ARC_API_BASE + '/api/core/circle/email-otp/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId }),
    });
    const refreshData = await refreshRes.json().catch(() => ({}));
    if (!refreshRes.ok || !refreshData.userToken || !refreshData.encryptionKey) {
        return false;
    }

    viewerState.userToken = refreshData.userToken;
    viewerState.encryptionKey = refreshData.encryptionKey;
    if (refreshData.appId) viewerState.appId = refreshData.appId;
    arcSdk.setAuthentication({
        userToken: viewerState.userToken,
        encryptionKey: viewerState.encryptionKey,
    });
    return true;
}

/** Ensure a fresh Circle session before creating a wallet challenge. */
async function ensureCircleAuthSession() {
    await ensureCircleAuthHydrated();
    if (await refreshCircleAuthFromServer()) return;

    clearCircleAuthTokens();
    const err = new Error('Session expired. Sign in with Google or email again.');
    err.code = 'AUTH_REQUIRED';
    throw err;
}

// ─── Phase 1: Email OTP login (Circle UCW) ───────────────────────────────────

function ensureArcSdk(onLoginComplete) {
    const appId = viewerState.appId || pendingEmailOtp?.appId;
    if (!appId) throw new Error('Missing Circle appId');

    if (!arcSdk) {
        arcSdk = new W3SSdk(
            { appSettings: { appId } },
            onLoginComplete || undefined
        );
    } else if (onLoginComplete) {
        arcSdk.updateConfigs({ appSettings: { appId } }, onLoginComplete);
    }
    return arcSdk;
}

/** Create a fresh W3SSdk with auth tokens pre-set (bypasses stale singleton). */
function ensureArcSdkWithAuth() {
    const appId = viewerState.appId || pendingEmailOtp?.appId;
    if (!appId) throw new Error('Missing Circle appId');
    const sdk = new W3SSdk({ appSettings: { appId } });
    if (viewerState.userToken && viewerState.encryptionKey) {
        sdk.setAuthentication({
            userToken: viewerState.userToken,
            encryptionKey: viewerState.encryptionKey,
        });
    }
    return sdk;
}

async function loadCircleClientConfig() {
    const appRes = await fetch(ARC_API_BASE + '/api/core/circle/app-id');
    const appData = await appRes.json();
    if (!appRes.ok || !appData.appId) throw new Error(appData.error || 'Missing Circle appId');
    viewerState.appId = appData.appId;
    socialAuthConfig.googleClientId = appData.googleClientId || '';
    socialAuthConfig.facebookAppId = appData.facebookAppId || '';
    return appData;
}

async function refreshSocialLoginButtons() {
    try {
        if (!viewerState.appId || (!socialAuthConfig.googleClientId && !socialAuthConfig.facebookAppId)) {
            await loadCircleClientConfig();
        }
    } catch (err) {
        console.warn('[Tessera] Could not load social login config:', err && err.message ? err.message : err);
    }
    const googleBtn = document.getElementById('arc-google-btn');
    const facebookBtn = document.getElementById('arc-facebook-btn');
    const divider = document.getElementById('arc-social-email-divider');
    const showGoogle = Boolean(socialAuthConfig.googleClientId);
    const showFacebook = Boolean(socialAuthConfig.facebookAppId);
    if (googleBtn) {
        googleBtn.style.display = showGoogle ? 'flex' : 'none';
    }
    if (facebookBtn) {
        facebookBtn.style.display = showFacebook ? 'block' : 'none';
    }
    if (divider) {
        divider.style.display = (showGoogle || showFacebook) ? 'flex' : 'none';
    }
}

function socialRedirectUri() {
    return window.location.origin;
}

function saveSocialPending(payload) {
    try {
        sessionStorage.setItem(SOCIAL_PENDING_KEY, JSON.stringify(payload));
    } catch (_) { /* ignore */ }
}

function readSocialPending() {
    try {
        const raw = sessionStorage.getItem(SOCIAL_PENDING_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}

function clearSocialPending() {
    try {
        sessionStorage.removeItem(SOCIAL_PENDING_KEY);
    } catch (_) { /* ignore */ }
}

const SOCIAL_RESUME_SPLASH_ID = 'arc-social-resume-splash';

function setOpaqueCoverFlag(provider) {
    try {
        sessionStorage.setItem(OPAQUE_COVER_KEY, provider || 'Google');
    } catch (_) { /* ignore */ }
}

function consumeOpaqueCoverFlag() {
    try {
        const v = sessionStorage.getItem(OPAQUE_COVER_KEY);
        sessionStorage.removeItem(OPAQUE_COVER_KEY);
        return v;
    } catch (_) {
        return null;
    }
}

function peekOpaqueCoverFlag() {
    try {
        return sessionStorage.getItem(OPAQUE_COVER_KEY);
    } catch (_) {
        return null;
    }
}

/** Fullscreen cover while Circle OAuth returns (hides PeerTube browse flash). */
function showSocialResumeSplash(provider) {
    if (typeof document === 'undefined') return;
    if (document.getElementById(SOCIAL_RESUME_SPLASH_ID)) return;
    const label = provider === SOCIAL_FACEBOOK
        ? 'Signing you in with Facebook…'
        : 'Signing you in with Google…';
    if (!document.getElementById('arc-social-resume-style')) {
        const style = document.createElement('style');
        style.id = 'arc-social-resume-style';
        style.textContent = '@keyframes arc-social-spin{to{transform:rotate(360deg)}}';
        (document.head || document.documentElement).appendChild(style);
    }
    const el = document.createElement('div');
    el.id = SOCIAL_RESUME_SPLASH_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483646',
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'justify-content:center',
        'gap:16px',
        'background:rgba(8,10,16,0.94)',
        'backdrop-filter:blur(8px)',
        '-webkit-backdrop-filter:blur(8px)',
        'font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif',
        'color:#fff',
        'pointer-events:all',
    ].join(';');
    el.innerHTML = ''
        + '<div style="width:28px;height:28px;border:3px solid rgba(255,255,255,0.12);'
        + 'border-top-color:#ffb300;border-radius:50%;'
        + 'animation:arc-social-spin 0.9s linear infinite;"></div>'
        + '<p style="margin:0;font-size:15px;font-weight:500;letter-spacing:0.01em;'
        + 'color:rgba(255,255,255,0.88);">' + label + '</p>';
    (document.body || document.documentElement).appendChild(el);
}

function hideSocialResumeSplash() {
    const el = document.getElementById(SOCIAL_RESUME_SPLASH_ID);
    if (el) el.remove();
}

async function handleSocialLogin(provider) {
    const isGoogle = provider === SOCIAL_GOOGLE;
    const btn = document.getElementById(isGoogle ? 'arc-google-btn' : 'arc-facebook-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="arc-spinner-sm" style="margin-right:8px;"></div> Redirecting…';
    }
    setLoginStatus('');

    try {
        await loadCircleClientConfig();
        if (isGoogle && !socialAuthConfig.googleClientId) {
            throw new Error('Google Client ID not configured (CIRCLE_GOOGLE_CLIENT_ID)');
        }
        if (!isGoogle && !socialAuthConfig.facebookAppId) {
            throw new Error('Facebook App ID not configured (CIRCLE_FACEBOOK_APP_ID)');
        }

        ensureArcSdk((error, result) => {
            void onAuthLoginComplete(error, result, 'social');
        });
        const deviceId = await arcSdk.getDeviceId();

        const tokenRes = await fetch(ARC_API_BASE + '/api/core/circle/social/device-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenRes.ok) throw new Error(tokenData.error || 'Failed to start social login');
        if (!tokenData.deviceToken || !tokenData.deviceEncryptionKey) {
            throw new Error('Incomplete social device token from Circle');
        }
        if (tokenData.googleClientId) socialAuthConfig.googleClientId = tokenData.googleClientId;
        if (tokenData.facebookAppId) socialAuthConfig.facebookAppId = tokenData.facebookAppId;

        const redirectUri = socialRedirectUri();
        const loginConfigs = {
            deviceToken: tokenData.deviceToken,
            deviceEncryptionKey: tokenData.deviceEncryptionKey,
        };
        if (isGoogle) {
            loginConfigs.google = {
                clientId: socialAuthConfig.googleClientId,
                redirectUri,
                selectAccountPrompt: true,
            };
        } else {
            loginConfigs.facebook = {
                appId: socialAuthConfig.facebookAppId,
                redirectUri,
            };
        }

        saveSocialPending({
            returnUrl: window.location.href,
            provider,
            deviceToken: tokenData.deviceToken,
            deviceEncryptionKey: tokenData.deviceEncryptionKey,
            appId: viewerState.appId,
            googleClientId: socialAuthConfig.googleClientId,
            facebookAppId: socialAuthConfig.facebookAppId,
            redirectUri,
        });

        arcSdk.updateConfigs(
            {
                appSettings: { appId: viewerState.appId },
                loginConfigs,
            },
            (error, result) => {
                void onAuthLoginComplete(error, result, 'social');
            }
        );

        setLoginStatus(isGoogle ? 'Opening Google…' : 'Opening Facebook…');
        await arcSdk.performLogin(provider);
    } catch (error) {
        console.error('[Tessera] Social login error:', error && error.message ? error.message : error);
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = isGoogle ? GOOGLE_CONTINUE_HTML : 'Continue with Facebook';
        }
        setLoginStatus('Error: ' + (error.message || 'Social login failed'), true);
    }
}

/** After Google/Facebook redirect, finish login if Circle returns tokens. */
async function tryResumeSocialLogin() {
    if (socialResumeInFlight) return socialResumeInFlight;
    socialResumeInFlight = doTryResumeSocialLogin().finally(() => {
        socialResumeInFlight = null;
    });
    return socialResumeInFlight;
}

async function doTryResumeSocialLogin() {
    await ensureCircleAuthHydrated();
    const pending = readSocialPending();
    if (!pending?.deviceToken || !pending?.appId) return false;

    // Mirror of the Circle SDK's own isValidHash gate (dist/src/index.js). If the
    // hash fails this pattern, the SDK silently does nothing on OAuth return.
    const sdkHashPattern = /^#(?:[a-zA-Z0-9-_.%]+=[^&]*&)*[a-zA-Z0-9-_.%]+=[^&]*$/;
    const hasOAuthHash = sdkHashPattern.test(window.location.hash || '');
    // Stale pending without OAuth hash: do not construct W3SSdk (Circle singleton
    // would then ignore a later constructor with the real callback/configs).
    if (!hasOAuthHash) {
        return false;
    }

    showSocialResumeSplash(pending.provider);

    viewerState.appId = pending.appId;
    socialAuthConfig.googleClientId = pending.googleClientId || '';
    socialAuthConfig.facebookAppId = pending.facebookAppId || '';

    const loginConfigs = {
        deviceToken: pending.deviceToken,
        deviceEncryptionKey: pending.deviceEncryptionKey,
    };
    if (pending.provider === SOCIAL_GOOGLE && pending.googleClientId) {
        loginConfigs.google = {
            clientId: pending.googleClientId,
            redirectUri: pending.redirectUri || socialRedirectUri(),
            selectAccountPrompt: true,
        };
    }
    if (pending.provider === SOCIAL_FACEBOOK && pending.facebookAppId) {
        loginConfigs.facebook = {
            appId: pending.facebookAppId,
            redirectUri: pending.redirectUri || socialRedirectUri(),
        };
    }

    const sdkConfigs = {
        appSettings: { appId: pending.appId },
        loginConfigs,
    };

    return await new Promise((resolve) => {
        let settled = false;
        let timeoutId = null;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            if (timeoutId != null) clearTimeout(timeoutId);
            window.removeEventListener('message', circleResumeProbe);
            if (!ok) hideSocialResumeSplash();
            resolve(ok);
        };

        const completeSocialResume = (error, result, source) => {
            // Claim synchronously so postMessage + sdk-callback cannot both run
            // onAuthLoginComplete, and so the wait-timeout cannot fire mid-setup.
            if (settled) return;
            if (error || !result?.userToken) {
                const errMsg = (error && error.message) ? error.message : 'no session';
                console.error('[Tessera] Social resume failed via ' + source + ': ' + errMsg);
                finish(false);
                return;
            }
            settled = true;
            if (timeoutId != null) clearTimeout(timeoutId);
            window.removeEventListener('message', circleResumeProbe);
            void (async () => {
                try {
                    await onAuthLoginComplete(error, result, 'social');
                    const returnUrl = pending.returnUrl;
                    if (returnUrl && returnUrl !== window.location.href) {
                        await createCircleAuthHandoff();
                        clearSocialPending();
                        // Cover survives navigation until paywall mounts on the video page.
                        setOpaqueCoverFlag(pending.provider);
                        window.location.replace(returnUrl);
                    } else {
                        clearSocialPending();
                        hideSocialResumeSplash();
                    }
                    resolve(true);
                } catch (err) {
                    console.error('[Tessera] Social resume post-setup error:', err && err.message ? err.message : err);
                    hideSocialResumeSplash();
                    resolve(false);
                }
            })();
        };

        // PeerTube/Zone can leave W3SSdk.onLoginComplete unset while the iframe still
        // verifies. Evidence: onSocialLoginVerified arrives with error=null but the SDK
        // never invokes the constructor callback. Complete from the postMessage directly.
        const circleResumeProbe = (event) => {
            if (event.origin !== 'https://pw-auth.circle.com') return;
            const data = event.data || {};
            const verified = data.onSocialLoginVerified;
            if (verified) {
                completeSocialResume(verified.error, verified.result, 'postMessage');
            }
        };
        window.addEventListener('message', circleResumeProbe);

        const onLoginComplete = (error, result) => {
            completeSocialResume(error, result, 'sdk-callback');
        };

        // Circle W3SSdk is a singleton: a second `new W3SSdk()` runs setupInstance on a
        // throwaway object and returns the old instance without applying loginConfigs.
        if (!arcSdk) {
            arcSdk = new W3SSdk(sdkConfigs, onLoginComplete);
        } else {
            arcSdk.updateConfigs(sdkConfigs, onLoginComplete);
        }

        // Circle's own verify-token network timeout is 10s and uses onComplete (not
        // onLoginComplete). Wait past that for the verify postMessage.
        timeoutId = setTimeout(() => {
            if (!settled) {
                console.warn('[Tessera] Social resume timed out after 15s.');
                finish(false);
            }
        }, 15000);
    });
}

async function handleRequestEmailOtp() {
    const btn = document.getElementById('arc-login-btn');
    const emailInput = document.getElementById('arc-email-input');
    const email = (emailInput?.value || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
        setLoginStatus('Enter a valid email address.', true);
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<div class="arc-spinner-sm" style="margin-right:8px;"></div> Sending…';
    setLoginStatus('');

    try {
        if (!viewerState.appId) {
            await loadCircleClientConfig();
        }

        ensureArcSdk((error, result) => {
            void onAuthLoginComplete(error, result, 'email');
        });

        const deviceId = await arcSdk.getDeviceId();
        setLoginStatus('Sending code to your email…');

        const otpRes = await fetch(ARC_API_BASE + '/api/core/circle/email-otp/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, deviceId }),
        });
        const otpData = await otpRes.json();
        if (!otpRes.ok) {
            throw new Error(otpData.error || 'Failed to send email OTP');
        }
        if (!otpData.deviceToken || !otpData.deviceEncryptionKey || !otpData.otpToken) {
            throw new Error('Incomplete OTP session from Circle');
        }

        if (otpData.appId) viewerState.appId = otpData.appId;
        pendingEmailOtp = {
            deviceToken: otpData.deviceToken,
            deviceEncryptionKey: otpData.deviceEncryptionKey,
            otpToken: otpData.otpToken,
            email: otpData.email || email,
            appId: viewerState.appId,
        };

        arcSdk.updateConfigs(
            {
                appSettings: { appId: viewerState.appId },
                loginConfigs: {
                    deviceToken: pendingEmailOtp.deviceToken,
                    deviceEncryptionKey: pendingEmailOtp.deviceEncryptionKey,
                    otpToken: pendingEmailOtp.otpToken,
                },
            },
            (error, result) => {
                void onAuthLoginComplete(error, result, 'email');
            }
        );

        const verifyBtn = document.getElementById('arc-verify-otp-btn');
        if (verifyBtn) verifyBtn.style.display = 'block';
        setLoginStatus('Code sent. Check your inbox, then tap Verify code.');
        btn.disabled = false;
        btn.innerHTML = `${LOCK_SVG} Resend code`;
    } catch (error) {
        console.error('[Tessera] Email OTP request error:', error && error.message ? error.message : error);
        btn.disabled = false;
        btn.innerHTML = `${LOCK_SVG} Send email code`;
        setLoginStatus('Error: ' + (error.message || 'Could not send code. Is SMTP set in Circle Console?'), true);
    }
}

function handleVerifyEmailOtp() {
    if (!pendingEmailOtp || !arcSdk) {
        setLoginStatus('Request a code first.', true);
        return;
    }
    const verifyBtn = document.getElementById('arc-verify-otp-btn');
    if (verifyBtn) {
        verifyBtn.disabled = true;
        verifyBtn.innerHTML = '<div class="arc-spinner-sm" style="margin-right:8px;"></div> Opening…';
    }
    setLoginStatus('Enter the code in the Circle window…');
    arcSdk.verifyOtp();
}

async function onAuthLoginComplete(error, result, authMethod) {
    const verifyBtn = document.getElementById('arc-verify-otp-btn');
    if (error || !result?.userToken) {
        console.error('[Tessera] Auth login failed:', error && error.message ? error.message : 'Login failed');
        if (verifyBtn) {
            verifyBtn.disabled = false;
            verifyBtn.innerHTML = 'Verify code';
        }
        const googleBtn = document.getElementById('arc-google-btn');
        if (googleBtn) {
            googleBtn.disabled = false;
            googleBtn.innerHTML = GOOGLE_CONTINUE_HTML;
        }
        const facebookBtn = document.getElementById('arc-facebook-btn');
        if (facebookBtn) {
            facebookBtn.disabled = false;
            facebookBtn.innerHTML = 'Continue with Facebook';
        }
        setLoginStatus('Error: ' + ((error && error.message) || 'Login failed.'), true);
        return;
    }

    try {
        // Email OTP and Google/Facebook are different Circle users. Never keep a
        // walletId from a previous method attached to the new userToken.
        viewerState.walletId = null;
        viewerState.walletAddress = null;
        viewerState.ephemeralPk = null;
        localStorage.removeItem('arc_circle_wallet_id');
        localStorage.removeItem('arc_circle_wallet_address');
        localStorage.removeItem('arc_ephemeral_pk');

        viewerState.userToken = result.userToken;
        viewerState.encryptionKey = result.encryptionKey;
        viewerState.authMethod = authMethod === 'social' ? 'social' : 'email';

        const oauthEmail = result.oAuthInfo?.socialUserInfo?.email
            ? String(result.oAuthInfo.socialUserInfo.email).trim().toLowerCase()
            : null;
        if (authMethod === 'social') {
            viewerState.email = oauthEmail || viewerState.email;
            // Keep social identity separate from email OTP (Circle does not merge them).
            const socialId = result.oAuthInfo?.socialUserUUID || oauthEmail || 'unknown';
            viewerState.userId = 'social:' + socialId;
        } else {
            viewerState.email = pendingEmailOtp?.email || viewerState.email;
            viewerState.userId = 'email:' + viewerState.email;
        }

        await persistCircleServerSession(result.userToken, result.refreshToken);
        persistCircleAuthSession();

        // Fresh SDK with auth tokens; the old singleton may never resolve getDeviceId.
        arcSdk = ensureArcSdkWithAuth();

        setLoginStatus('Setting up your Arc wallet…');
        await resolveAndBindArcWallet();

        setLoginStatus('Checking wallet balance…');
        await ensureEphemeralKey();
        const hasFunds = await checkArcBalance(viewerState.walletAddress);
        transitionToFundPhase();
        if (hasFunds) {
            enableUnlockButton();
        } else {
            startBalancePolling();
        }
    } catch (err) {
        console.error('[Tessera] Post-login wallet setup error:', err && err.message ? err.message : err);
        if (verifyBtn) {
            verifyBtn.disabled = false;
            verifyBtn.innerHTML = 'Verify code';
        }
        setLoginStatus('Error: ' + (err.message || 'Wallet setup failed'), true);
        // Social OAuth navigates away after this; do not swallow or cookies never land.
        if (authMethod === 'social') throw err;
    }
}

async function resolveAndBindArcWallet() {
    const walletData = await getOrCreateArcWallet();
    if (!walletData?.walletId || !walletData?.walletAddress) {
        throw new Error('Could not resolve Arc wallet for this login.');
    }
    viewerState.walletId = walletData.walletId;
    viewerState.walletAddress = walletData.walletAddress;
    persistCircleAuthSession();
    return walletData;
}

async function getOrCreateArcWallet(retries = 0) {
    if (retries > 10) {
        throw new Error('Could not set up the wallet. Please try again.');
    }

    const walletRes = await fetch(ARC_API_BASE + '/api/core/circle/get-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userId: viewerState.userId,
            userToken: viewerState.userToken,
            authMethod: viewerState.authMethod || 'email',
        }),
    });
    if (!walletRes.ok) throw new Error('Failed to resolve Arc wallet');
    const walletData = await walletRes.json();

    // First-time user: complete wallet creation challenge via Circle confirmation UI
    if (walletData.status === 'needs_creation') {
        setLoginStatus('Confirm wallet creation in the Circle window…');
        const execOutcome = await new Promise((resolve) => {
            arcSdk.execute(walletData.challengeId, (error, result) => {
                resolve({ error: error ?? null, result: result ?? null });
            });
        });

        if (execOutcome.error) {
            const recoveryRes = await fetch(ARC_API_BASE + '/api/core/circle/get-wallet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: viewerState.userId,
                    userToken: viewerState.userToken,
                    authMethod: viewerState.authMethod || 'email',
                }),
            });
            if (recoveryRes.ok) {
                const recoveryData = await recoveryRes.json();
                if (recoveryData.status === 'existing') return recoveryData;
                if (recoveryData.status === 'indexing') {
                    await new Promise((r) => setTimeout(r, 2000));
                    return getOrCreateArcWallet(retries + 1);
                }
            }
            throw new Error('Setup cancelled. Tap Verify code / Send email code to try again.');
        }

        await new Promise((r) => setTimeout(r, 1500));
        return getOrCreateArcWallet(retries + 1);
    }

    if (walletData.status === 'indexing') {
        await new Promise((r) => setTimeout(r, 2000));
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
        console.warn('[Tessera] Balance fetch via backend failed, using direct query fallback:', e && e.message ? e.message : e);
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
            console.warn('[Tessera] Direct query fallback also failed:', innerErr && innerErr.message ? innerErr.message : innerErr);
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

function transitionToLoginPhase(message, isError = true) {
    const fundPhase = document.getElementById('arc-phase-fund');
    const loginPhase = document.getElementById('arc-phase-login');
    if (fundPhase) fundPhase.style.display = 'none';
    if (loginPhase) loginPhase.style.display = 'block';

    const headerTitle = document.querySelector('#arc-paywall-header h2');
    if (headerTitle) {
        headerTitle.innerHTML = isTipMode ? 'Support the creator' : 'Pay to watch';
        headerTitle.className = '';
    }
    const headerSub = document.querySelector('#arc-paywall-header p');
    if (headerSub) headerSub.style.display = '';

    void refreshSocialLoginButtons();
    if (message) setLoginStatus(message, isError);
}

function transitionToFundPhase() {
    // Overlay may not be mounted yet (e.g. social resume finished on a
    // non-video page after the OAuth redirect). Bail out; initPaywall will
    // render the correct phase when the overlay mounts.
    const loginPhase = document.getElementById('arc-phase-login');
    const fundPhase = document.getElementById('arc-phase-fund');
    if (!loginPhase || !fundPhase) return;
    loginPhase.style.display = 'none';
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

    void refreshUcwBalanceDisplay();
}

/** Show UCW (Arc wallet) USDC balance on the deposit panel. */
async function refreshUcwBalanceDisplay() {
    const el = document.getElementById('arc-ucw-balance');
    if (!el) return;
    if (!viewerState.walletAddress) {
        el.textContent = '—';
        return;
    }
    el.textContent = '…';
    try {
        const bal = await getArcBalance(viewerState.walletAddress);
        const n = Number(bal);
        if (!Number.isFinite(n)) {
            el.textContent = '—';
            return;
        }
        el.textContent = n.toFixed(4) + ' USDC';
    } catch (_) {
        el.textContent = '—';
    }
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

let withdrawQuoteCache = null;

function setWithdrawStatus(elId, message, isError) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!message) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    el.style.display = 'block';
    el.textContent = message;
    el.style.color = isError ? '#f87171' : 'rgba(255,255,255,0.7)';
}

function showWithdrawStep(step) {
    const form = document.getElementById('arc-withdraw-step-form');
    const confirm = document.getElementById('arc-withdraw-step-confirm');
    const done = document.getElementById('arc-withdraw-step-done');
    if (form) form.style.display = step === 'form' ? 'block' : 'none';
    if (confirm) confirm.style.display = step === 'confirm' ? 'block' : 'none';
    if (done) done.style.display = step === 'done' ? 'block' : 'none';
}

function closeExternalWithdrawModal() {
    const modal = document.getElementById('arc-withdraw-modal');
    if (modal) modal.style.display = 'none';
    withdrawQuoteCache = null;
    setWithdrawStatus('arc-withdraw-form-status', '');
    setWithdrawStatus('arc-withdraw-confirm-status', '');
    showWithdrawStep('form');
}

async function openExternalWithdrawModal() {
    try {
        await ensureCircleAuthSession();
        await resolveAndBindArcWallet();
    } catch (err) {
        console.error('[Tessera] Withdraw open failed auth/wallet bind:', err);
        setFundStatus((err && err.message) || 'Sign in required to withdraw', true);
        return;
    }
    const modal = document.getElementById('arc-withdraw-modal');
    if (!modal) return;
    withdrawQuoteCache = null;
    setWithdrawStatus('arc-withdraw-form-status', '');
    setWithdrawStatus('arc-withdraw-confirm-status', '');
    showWithdrawStep('form');
    const reviewBtn = document.getElementById('arc-withdraw-review-btn');
    const confirmBtn = document.getElementById('arc-withdraw-confirm-btn');
    const backBtn = document.getElementById('arc-withdraw-back-btn');
    if (reviewBtn) reviewBtn.disabled = false;
    if (confirmBtn) confirmBtn.disabled = false;
    if (backBtn) backBtn.disabled = false;
    modal.style.display = 'flex';
    void refreshUcwBalanceDisplay();
}

function formatWithdrawFee(fee) {
    if (!fee) return 'Unavailable';
    if (typeof fee.networkFee === 'string' && fee.networkFee) {
        const n = Number(fee.networkFee);
        if (Number.isFinite(n)) {
            // Compact UI: 6 decimals max, trim trailing zeros (estimate only).
            const rounded = n.toFixed(6).replace(/\.?0+$/, '');
            return `~${rounded}`;
        }
        return fee.networkFee;
    }
    if (typeof fee.gasLimit === 'string') return 'gas ' + fee.gasLimit;
    return 'See Circle approval';
}

async function reviewExternalWithdraw() {
    const addrInput = document.getElementById('arc-withdraw-address');
    const amountInput = document.getElementById('arc-withdraw-amount');
    const reviewBtn = document.getElementById('arc-withdraw-review-btn');
    const destinationAddress = (addrInput && addrInput.value ? addrInput.value : '').trim();
    const amount = (amountInput && amountInput.value ? amountInput.value : '').trim();
    setWithdrawStatus('arc-withdraw-form-status', '');

    if (!/^0x[a-fA-F0-9]{40}$/.test(destinationAddress)) {
        setWithdrawStatus('arc-withdraw-form-status', 'Enter a valid 0x destination address', true);
        return;
    }
    if (!amount || !(Number(amount) > 0)) {
        setWithdrawStatus('arc-withdraw-form-status', 'Enter a positive USDC amount', true);
        return;
    }

    if (reviewBtn) reviewBtn.disabled = true;
    try {
        await ensureCircleAuthSession();
        await resolveAndBindArcWallet();
        setWithdrawStatus('arc-withdraw-form-status', 'Estimating fee…');
        const quoteRes = await fetch(ARC_API_BASE + '/api/core/circle/quote-external-withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userToken: viewerState.userToken,
                walletId: viewerState.walletId,
                destinationAddress,
                amount,
            }),
        });
        const quoteData = await quoteRes.json().catch(() => ({}));
        if (!quoteRes.ok) {
            throw new Error(quoteData.error || 'Failed to quote withdraw');
        }
        withdrawQuoteCache = quoteData;
        const toEl = document.getElementById('arc-withdraw-review-to');
        const amtEl = document.getElementById('arc-withdraw-review-amount');
        const feeEl = document.getElementById('arc-withdraw-review-fee');
        if (toEl) toEl.textContent = destinationAddress;
        if (amtEl) amtEl.textContent = amount + ' USDC';
        if (feeEl) feeEl.textContent = formatWithdrawFee(quoteData.estimatedFee);
        setWithdrawStatus('arc-withdraw-form-status', '');
        showWithdrawStep('confirm');
    } catch (err) {
        setWithdrawStatus('arc-withdraw-form-status', (err && err.message) || 'Quote failed', true);
    } finally {
        if (reviewBtn) reviewBtn.disabled = false;
    }
}

async function confirmExternalWithdraw() {
    if (!withdrawQuoteCache) {
        showWithdrawStep('form');
        return;
    }
    const confirmBtn = document.getElementById('arc-withdraw-confirm-btn');
    const backBtn = document.getElementById('arc-withdraw-back-btn');
    if (confirmBtn) confirmBtn.disabled = true;
    if (backBtn) backBtn.disabled = true;
    setWithdrawStatus('arc-withdraw-confirm-status', 'Preparing Circle approval…');

    try {
        await ensureCircleAuthSession();
        await resolveAndBindArcWallet();
        const prepRes = await fetch(ARC_API_BASE + '/api/core/circle/prepare-external-withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userToken: viewerState.userToken,
                walletId: viewerState.walletId,
                destinationAddress: withdrawQuoteCache.destinationAddress,
                amount: withdrawQuoteCache.amount,
            }),
        });
        const prepData = await prepRes.json().catch(() => ({}));
        if (!prepRes.ok || !prepData.challengeId) {
            throw new Error(prepData.error || 'Failed to prepare withdraw');
        }

        setWithdrawStatus('arc-withdraw-confirm-status', 'Approve in the Circle popup…');
        await new Promise((resolve, reject) => {
            arcSdk.execute(prepData.challengeId, (error, result) => {
                if (error) reject(new Error('Withdraw cancelled or failed'));
                else resolve(result);
            });
        });

        setWithdrawStatus('arc-withdraw-confirm-status', 'Confirming on-chain…');
        let txHash = '';
        let confirmed = false;
        for (let i = 0; i < 30; i++) {
            const pollRes = await fetch(ARC_API_BASE + '/api/core/circle/poll-challenge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userToken: viewerState.userToken, challengeId: prepData.challengeId }),
            });
            const pollData = await pollRes.json().catch(() => ({}));
            if (pollData.status === 'COMPLETE') {
                confirmed = true;
                txHash = pollData.txHash || '';
                break;
            }
            if (pollData.status === 'FAILED' || pollData.status === 'EXPIRED') {
                throw new Error('Withdraw transaction failed on-chain');
            }
            await new Promise((r) => setTimeout(r, 2000));
        }
        if (!confirmed) throw new Error('Withdraw timed out. Please try again.');

        const link = document.getElementById('arc-withdraw-tx-link');
        if (link) {
            link.href = txHash
                ? `https://testnet.arcscan.app/tx/${txHash}`
                : `https://testnet.arcscan.app/address/${viewerState.walletAddress || ''}`;
            link.textContent = txHash ? 'View Transaction on Arcscan ↗' : 'View Wallet on Arcscan ↗';
        }
        showWithdrawStep('done');
        void refreshUcwBalanceDisplay();
    } catch (err) {
        setWithdrawStatus('arc-withdraw-confirm-status', (err && err.message) || 'Withdraw failed', true);
        if (confirmBtn) confirmBtn.disabled = false;
        if (backBtn) backBtn.disabled = false;
    }
}

function wireExternalWithdrawModal() {
    const modal = document.getElementById('arc-withdraw-modal');
    if (!modal || modal.dataset.wired === '1') return;
    modal.dataset.wired = '1';

    const closeBtn = document.getElementById('arc-withdraw-close');
    if (closeBtn) closeBtn.addEventListener('click', closeExternalWithdrawModal);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) closeExternalWithdrawModal();
    });
    const reviewBtn = document.getElementById('arc-withdraw-review-btn');
    if (reviewBtn) reviewBtn.addEventListener('click', () => { void reviewExternalWithdraw(); });
    const backBtn = document.getElementById('arc-withdraw-back-btn');
    if (backBtn) backBtn.addEventListener('click', () => {
        setWithdrawStatus('arc-withdraw-confirm-status', '');
        showWithdrawStep('form');
    });
    const confirmBtn = document.getElementById('arc-withdraw-confirm-btn');
    if (confirmBtn) confirmBtn.addEventListener('click', () => { void confirmExternalWithdraw(); });
    const doneBtn = document.getElementById('arc-withdraw-done-btn');
    if (doneBtn) doneBtn.addEventListener('click', closeExternalWithdrawModal);
}

function handleSuccessReturnHome() {
    removeSessionManagerWidget();
    const successPhase = document.getElementById('arc-phase-success');
    if (successPhase) successPhase.style.display = 'none';

    const hasSession = Boolean(
        viewerState.userToken
        || localStorage.getItem('arc_circle_user_token')
        || localStorage.getItem('arc_cashier_user_id')
    );
    if (hasSession && (viewerState.walletAddress || localStorage.getItem('arc_circle_wallet_address'))) {
        transitionToFundPhase();
        return;
    }
    const loginPhase = document.getElementById('arc-phase-login');
    if (loginPhase) loginPhase.style.display = 'block';
}

// Local sign-out only. The server keeps the canonical session for this userId,
// so Gateway funds and the ephemeral key are recovered on the next login via
// sync-session. Nothing on the server side is deleted here.
function handleLogout() {
    if (balancePollingInterval) {
        clearInterval(balancePollingInterval);
        balancePollingInterval = null;
    }
    viewerState.userId = null;
    viewerState.email = null;
    viewerState.authMethod = 'email';
    viewerState.walletId = null;
    viewerState.walletAddress = null;
    viewerState.ephemeralPk = null;
    clearCircleAuthTokens();
    CIRCLE_AUTH_LS_KEYS.forEach((key) => localStorage.removeItem(key));
    localStorage.removeItem('arc_ephemeral_pk');
    clearSocialPending();
    setFundStatus('');
    transitionToLoginPhase('Signed out. Your balance stays linked to your account.', false);
    console.log('[Tessera] Signed out (local session cleared).');
}

function startBalancePolling() {
    const waitingEl = document.getElementById('arc-waiting-balance');
    if (waitingEl) waitingEl.style.display = 'flex';
    if (balancePollingInterval) clearInterval(balancePollingInterval);
    balancePollingInterval = setInterval(async () => {
        const minReq = getRequiredMinBalance();
        // Prefer Gateway: that is what billing spends. Same source as tip widget.
        try {
            const balRes = await fetch(ARC_API_BASE + '/api/core/session-balance?userId=' + viewerState.userId);
            if (balRes.ok) {
                const balData = await balRes.json();
                const gatewayAvailable = Number(balData.gatewayAvailable || '0');
                if (gatewayAvailable >= minReq) {
                    clearInterval(balancePollingInterval);
                    balancePollingInterval = null;
                    const waiting = document.getElementById('arc-waiting-balance');
                    if (waiting) waiting.style.display = 'none';
                    void checkAutoUnlock();
                    return;
                }
            }
        } catch (_) { /* fall through to wallet check */ }

        // Gateway still empty: wallet funds only mean the user can deposit.
        const walletCanDeposit = await checkArcBalance(viewerState.walletAddress);
        void refreshUcwBalanceDisplay();
        if (walletCanDeposit) {
            clearInterval(balancePollingInterval);
            balancePollingInterval = null;
            const waitingDone = document.getElementById('arc-waiting-balance');
            if (waitingDone) waitingDone.style.display = 'none';
            enableUnlockButton();
        }
    }, 4000);
}

function enableUnlockButton() {
    const btn = document.getElementById('arc-unlock-btn');
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('arc-btn-disabled');
    btn.innerHTML = isTipMode ? `${UNLOCK_SVG} Enable Tipping` : `${UNLOCK_SVG} Unlock Video`;
    const waiting = document.getElementById('arc-waiting-balance');
    if (waiting) waiting.style.display = 'none';
    // Small celebration pulse
    btn.classList.add('arc-pulse-once');
    setTimeout(() => btn.classList.remove('arc-pulse-once'), 600);
    void refreshUcwBalanceDisplay();
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

        setFundStatus('Preparing deposit to Gateway…');

        await ensureCircleAuthSession();
        // Re-bind wallet to the current Circle userToken (email OTP != Google user).
        setFundStatus('Resolving wallet…');
        await resolveAndBindArcWallet();

        setFundStatus('Checking wallet balance…');
        const currentBalance = await getArcBalance(viewerState.walletAddress);
        if (currentBalance < selectedAmount) {
            throw new Error(`Insufficient funds: Your wallet has $${currentBalance.toFixed(4)} USDC, but you chose to deposit $${selectedAmount.toFixed(2)} USDC.`);
        }

        // Ensure ephemeral key exists (needed for both deposit and register-session)
        await ensureEphemeralKey();

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
            if (!depositRes.ok) {
                const errJson = await depositRes.json().catch(() => ({}));
                throw new Error(errJson.error || 'Failed to prepare deposit');
            }
            const depositData = await depositRes.json();
            if (!depositData.challengeId) throw new Error('No deposit challenge received');

            // User approves in the Circle confirmation UI
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
            // Allow 2 seconds for Arc blockchain indexers to register the USDC transfer
            await new Promise(r => setTimeout(r, 2000));
        }

        // Register session with ephemeral key
        setFundStatus('Opening stream…');

        const { regRes, regData } = await registerViewerSession(getRequiredMinBalance());
        if (!regRes.ok) {
            throw new Error(regData.error || 'Backend failed to register session.');
        }

        // ✅ Unlock stream or Enable Tipping
        if (!isTipMode) {
            unlockMedia();
            document.body.classList.remove('arc-locked');
            const sm = document.getElementById('arc-session-manager');
            if (sm) sm.classList.remove('arc-hidden');
            startSessionTimer();
            if (typeof window.tesseraOnPaywallUnlocked === 'function') {
                void window.tesseraOnPaywallUnlocked();
            }
        } else {
            // Refresh tipping widget to reflect new wallet balance/card state
            if (typeof window.arcShowTipButton === 'function') {
                viewerState.userId = localStorage.getItem('arc_cashier_user_id');
                viewerState.walletId = localStorage.getItem('arc_circle_wallet_id');
                viewerState.walletAddress = localStorage.getItem('arc_circle_wallet_address');
                window.arcShowTipButton(tipCreatorWallet, tipAmountVal);
            }
            // Tip is sent only when the user clicks the tip button: not on enable.
        }

        const overlay = document.getElementById('arc-paywall-overlay');
        if (overlay) {
            overlay.style.pointerEvents = 'none';
            overlay.style.opacity = '0';
            setTimeout(() => overlay.remove(), 500);
        }

    } catch (error) {
        console.error('[Tessera] Unlock error:', error && error.message ? error.message : error);
        btn.disabled = false;
        btn.innerHTML = isTipMode ? `${UNLOCK_SVG} Enable Tipping` : `${UNLOCK_SVG} Unlock Video`;
        if (error && error.code === 'AUTH_REQUIRED') {
            transitionToLoginPhase(error.message || 'Sign in with Google or email to continue.');
            setFundStatus('');
            return;
        }
        setFundStatus('Error: ' + (error.message || 'Please retry.'), true);
        void refreshUcwBalanceDisplay();
    }
}

// CCTP bridge UI + Bridge Kit live in ./cctp-bridge.js (wired in initPaywall).

// ─── Session Manager (post-unlock) ───────────────────────────────────────────

function removeSessionManagerWidget() {
    const sm = document.getElementById('arc-session-manager');
    if (sm) sm.remove();
}

function renderSessionManager() {
    const existing = document.getElementById('arc-session-manager');
    if (existing) existing.remove();

    const sm = document.createElement('div');
    sm.id = 'arc-session-manager';
    sm.className = 'arc-tessera-root arc-hidden';
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
    // Always floats above everything, including a real fullscreen video —
    // no explicit container, so it is fullscreen-aware (see mountFloatingElement).
    mountFloatingElement(sm);

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

// Allows a connector to take control of media tracking instead of relying on global polling.
if (window.arcManualMediaControl === undefined) {
    window.arcManualMediaControl = false;
}
window.arcSetMediaPlaying = function (isPlaying) {
    playingMediaCount = isPlaying ? 1 : 0;
};

// Allow plugin to update rate when switching between videos with different prices
window.arcSetRate = function (ratePerSec) {
    if (ratePerSec && Number(ratePerSec) > 0) {
        currentRatePerSecond = Number(ratePerSec);
        // Paywall overlay rate display
        const el = document.getElementById('arc-display-rate');
        if (el) el.textContent = 'From $' + currentRatePerSecond.toFixed(4) + ' / sec';
        // Session manager rate display
        const rateEl = document.getElementById('arc-sm-rate');
        if (rateEl) rateEl.textContent = '$' + currentRatePerSecond.toFixed(4) + ' USDC / sec';
    }
};

// Called by the connector when the user navigates to a new resource.
// Resets the per-resource cost counter and updates the displayed rate
// without touching the global session or the gateway balance.
window.arcResetVideoSession = function (newRate) {
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
    if (displayRate) displayRate.textContent = 'From $' + currentRatePerSecond.toFixed(4) + ' / sec';

    // Auto-unlock if credentials exist and paywall is still locked
    if (document.body.classList.contains('arc-locked') && hasResumableCircleSession()) {
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

    // Ensure session manager is visible when starting timer
    const smEl = document.getElementById('arc-session-manager');
    if (smEl) smEl.classList.remove('arc-hidden');

    // Show initial rate in the session manager immediately
    const initialRateEl = document.getElementById('arc-sm-rate');
    if (initialRateEl) initialRateEl.textContent = '$' + currentRatePerSecond.toFixed(4) + ' USDC / sec';

    let lastWithdrawableBalance = null;

    // Fetch the initial gateway balance immediately so video cost is accurate and displayed from the start
    fetch(ARC_API_BASE + '/api/core/session-balance?userId=' + viewerState.userId)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
            if (data) {
                const withdrawable = Number(data.gatewayAvailable);
                initialGatewayBalance = withdrawable;
                lastWithdrawableBalance = withdrawable;
                const balEl = document.getElementById('arc-sm-balance');
                if (balEl) balEl.textContent = '$' + withdrawable.toFixed(4) + ' USDC';
                const videoCostEl = document.getElementById('arc-sm-video-cost');
                if (videoCostEl) videoCostEl.textContent = '$0.0000 USDC';
            }
        })
        .catch(function () { });

    window.sessionTimer = setInterval(async () => {
        tickCount++;
        let isMediaPlaying = playingMediaCount > 0;
        // Only fall back to scanning the DOM when the connector is NOT driving
        // play-state. Jellyfin/PeerTube set arcManualMediaControl so detail-page
        // trailers cannot keep the meter running after leaving the player.
        if (!isMediaPlaying && !window.arcManualMediaControl) {
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

        const liveSpent = secondsThisVideo * currentRatePerSecond;
        const videoCostEl = document.getElementById('arc-sm-video-cost');
        if (videoCostEl) {
            videoCostEl.textContent = '$' + liveSpent.toFixed(4) + ' USDC';
        }
        if (initialGatewayBalance !== null) {
            const projectedBalance = Math.max(0, initialGatewayBalance - liveSpent);
            const balEl = document.getElementById('arc-sm-balance');
            if (balEl) balEl.textContent = '$' + projectedBalance.toFixed(4) + ' USDC';

            const secondsLeft = projectedBalance / currentRatePerSecond;
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

        if (tickCount % 5 === 0) {
            try {
                const statusRes = await fetch(ARC_API_BASE + '/api/core/session-status?userId=' + viewerState.userId);
                if (statusRes.status === 404) {
                    clearInterval(window.sessionTimer);
                    const sm = document.getElementById('arc-session-manager');
                    if (sm) sm.classList.add('arc-hidden');
                    // Tip/free mode must never fall through into a locked paywall.
                    if (isTipMode) return;
                    initPaywall();
                } else if (statusRes.ok) {
                    const balanceRes = await fetch(ARC_API_BASE + '/api/core/session-balance?userId=' + viewerState.userId);
                    if (balanceRes.ok) {
                        const data = await balanceRes.json();
                        const withdrawable = Number(data.gatewayAvailable);
                        if (initialGatewayBalance === null) {
                            initialGatewayBalance = withdrawable;
                            lastWithdrawableBalance = withdrawable;
                        } else if (lastWithdrawableBalance !== null && withdrawable > lastWithdrawableBalance) {
                            initialGatewayBalance += (withdrawable - lastWithdrawableBalance);
                            lastWithdrawableBalance = withdrawable;
                        } else {
                            // Rebase the client ticker to the real Gateway balance so a
                            // refresh cannot "restore" funds that were already spent.
                            if (Number.isFinite(withdrawable) && initialGatewayBalance !== null) {
                                const actualSpent = Math.max(0, initialGatewayBalance - withdrawable);
                                if (currentRatePerSecond > 0) {
                                    secondsThisVideo = Math.max(secondsThisVideo, Math.round(actualSpent / currentRatePerSecond));
                                }
                            }
                            lastWithdrawableBalance = withdrawable;
                        }
                    }
                }
            } catch (e) { console.error('[Tessera] Heartbeat failed:', e && e.message ? e.message : e); }
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

        // Step 1: Refresh Circle session via refreshToken (email OTP / social login)
        await ensureCircleAuthSession();
        await resolveAndBindArcWallet();

        // Step 2: Create the transfer from the SCA wallet to the ephemeral wallet
        const prepRes = await fetch(ARC_API_BASE + '/api/core/circle/prepare-deposit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userToken: viewerState.userToken,
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
        console.error('[Tessera] Top-up failed:', error && error.message ? error.message : error);
        resetForm('Error (Retry)');
    }
}

// ─── Leave / Cash-Out ─────────────────────────────────────────────────────────

window.arcLeaveSession = async function () {
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
        // Tipping mode: reset tipping widget UI while keeping viewer session keys intact for next tips
        const container = document.getElementById('arc-tip-btn-container');
        if (container) {
            container.remove();
            if (typeof window.arcShowTipButton === 'function') {
                window.arcShowTipButton(tipCreatorWallet, tipAmountVal);
            }
        }
    } else {
        const sm = document.getElementById('arc-session-manager');
        if (sm) {
            sm.innerHTML = `
                <div style="padding:10px;text-align:center;">
                    <h3 style="color:#63b3ed;margin:0 0 8px 0;">⏸ Session Paused</h3>
                    <p style="font-size:12px;color:#a0aec0;margin:0 0 10px 0;">Your balance is safe in Circle Gateway.</p>
                    <button id="arc-resume-btn" onclick="window.arcResumeSession()" class="arc-btn arc-btn-primary" style="padding:6px 14px;font-size:12px;cursor:pointer;">▶ Resume Stream</button>
                </div>
            `;
        }
        document.body.classList.add('arc-locked');
        lockMedia();
    }
};

window.arcTeardownOnNavigate = async function () {
    const hadActiveUnlockedSession = !isTipMode
        && !document.body.classList.contains('arc-locked')
        && document.getElementById('arc-session-manager') !== null;

    clearInterval(window.sessionTimer);
    window.sessionTimer = null;
    if (window.arcPingInterval) {
        clearInterval(window.arcPingInterval);
        window.arcPingInterval = null;
    }
    if (balancePollingInterval) {
        clearInterval(balancePollingInterval);
        balancePollingInterval = null;
    }

    // Stop server-side billing for this paywall session (idempotent).
    if (hadActiveUnlockedSession && viewerState.userId) {
        try {
            await fetch(ARC_API_BASE + '/api/core/end-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: viewerState.userId }),
            });
        } catch (_) { }
    }

    const sm = document.getElementById('arc-session-manager');
    if (sm) sm.remove();

    const tipContainer = document.getElementById('arc-tip-btn-container');
    if (tipContainer) tipContainer.remove();

    const overlay = document.getElementById('arc-paywall-overlay');
    if (overlay) overlay.remove();

    // Leaving the player: drop lock + pause loop so preview pages are never charged/locked.
    if (mediaLockController) {
        unlockMedia();
    }
    document.body.classList.remove('arc-locked');
    playingMediaCount = 0;
    secondsThisVideo = 0;
    initialGatewayBalance = null;
};

window.arcResumeSession = async function () {
    const resumeBtn = document.getElementById('arc-resume-btn');
    if (resumeBtn) {
        resumeBtn.disabled = true;
        resumeBtn.innerText = 'Resuming…';
    }

    try {
        const { regRes } = await registerViewerSession(getRequiredMinBalance());

        if (regRes.ok) {
            console.log('[Tessera] Session resumed successfully.');
            unlockMedia();
            document.body.classList.remove('arc-locked');
            renderSessionManager();
            const sm = document.getElementById('arc-session-manager');
            if (sm) sm.classList.remove('arc-hidden');
            startSessionTimer();
            if (typeof window.tesseraOnPaywallUnlocked === 'function') {
                void window.tesseraOnPaywallUnlocked();
            }
            return;
        }
    } catch (err) {
        console.error('[Tessera] Resume session error:', err && err.message ? err.message : err);
    }

    // Fallback if silent resume fails: check auto unlock or open onboarding
    await checkAutoUnlock();
};

window.arcEndSession = async function () {
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

    xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
            localStorage.removeItem('arc_ephemeral_pk');
            viewerState.ephemeralPk = null;
            // We keep user identity (userId, walletId, walletAddress) so returning users do not have to reconnect their wallet.
            // These stay persistent for subsequent sessions or top-ups.

            removeSessionManagerWidget();
            initialGatewayBalance = null;
            secondsThisVideo = 0;

            // Lock screen
            document.body.classList.add('arc-locked');
            lockMedia();

            // Force render overlay
            renderPaywallOverlay();

            // Parse transaction hash from response
            let txHash = '';
            try {
                const resData = JSON.parse(xhr.responseText);
                txHash = resData.txHash || '';
            } catch (_) { }

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
                    doneBtn.onclick = handleSuccessReturnHome;
                }
                const withdrawBtn = document.getElementById('arc-success-withdraw-btn');
                if (withdrawBtn) {
                    withdrawBtn.onclick = () => { void openExternalWithdrawModal(); };
                }
            }
        } else {
            if (endBtn) { endBtn.disabled = false; endBtn.innerText = 'Error: Retry'; }
        }
        document.body.classList.add('arc-locked');
    };

    xhr.onerror = xhr.ontimeout = function () {
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
        return Number(data.gatewayAvailable) || 0;
    } catch (_) { return null; }
}

// Triggers the full Circle wallet onboarding overlay so the user can
// connect/create their wallet and fund it before tipping.
function openTipOnboarding() {
    if (isTipMode) {
        injectDependencies();
        document.body.classList.remove('arc-locked');
        renderPaywallOverlay();
        document.body.classList.remove('arc-locked');
        if (hasResumableCircleSession()) {
            transitionToFundPhase();
            void checkAutoUnlock();
        }
    } else if (window.ArcCashier && typeof window.ArcCashier.initPaywall === 'function') {
        window.ArcCashier.initPaywall();
    } else {
        document.body.classList.add('arc-locked');
    }
}

window.arcShowTipButton = function (creatorWallet, tipAmount) {
    if (creatorWallet) tipCreatorWallet = creatorWallet;
    if (tipAmount) tipAmountVal = tipAmount;

    // Remove any existing tip button
    const existing = document.getElementById('arc-tip-btn-container');
    if (existing) existing.remove();

    const amount = parseFloat(tipAmount) || 0.10;
    let tipCount = 0;

    const container = document.createElement('div');
    container.id = 'arc-tip-btn-container';
    container.classList.add('arc-tessera-root');

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
                <button id="arc-tip-end-btn">Cash Out &amp; Exit</button>
            </div>
        </div>
    `;

    // Always floats above everything, including a real fullscreen video —
    // no explicit container, so it is fullscreen-aware (see mountFloatingElement).
    mountFloatingElement(container);

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

    const endBtn = document.getElementById('arc-tip-end-btn');

    btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.03)'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = 'scale(1)'; });

    const refreshStatus = async () => {
        if (!viewerState.ephemeralPk && hasResumableCircleSession()) {
            try { await ensureEphemeralKey(); } catch (_) { /* ignore */ }
        }
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

        const balance = await fetchTipBalance();
        // No Gateway session / zero balance: do not show connected tip manager or cash-out.
        if (balance === null || balance <= 0) {
            container.classList.remove('arc-tip-connected');
            container.classList.add('arc-tip-unconnected');
            header.style.display = 'none';
            statusCard.style.display = 'none';
            walletActions.style.display = 'none';
            statusPill.style.display = 'block';
            statusPill.style.color = '#718096';
            statusPill.textContent = 'Fund wallet to tip';
            return;
        }

        updateContainerStyle();
        header.style.display = 'flex';
        statusCard.style.display = 'block';
        walletActions.style.display = 'flex';
        statusPill.style.display = 'none';
        balanceVal.textContent = `$${balance.toFixed(4)} USDC`;
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
                } catch (_) { }

                localStorage.removeItem('arc_ephemeral_pk');
                viewerState.ephemeralPk = null;
                // We keep user identity (userId, walletId, walletAddress) so returning users do not have to reconnect their wallet.
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
                    clearInterval(tipInterval);
                    container.remove();
                });
            } else {
                throw new Error('Cash-out failed on server');
            }
        } catch (err) {
            console.error('[Tessera] Cash-out failed:', err && err.message ? err.message : err);
            alert('Cash-out failed: ' + (err.message || 'Please try again.'));
            endBtn.disabled = false;
            endBtn.innerHTML = 'Cash Out & Exit';
        }
    });

    // ── Click handler ─────────────────────────────────────────────────────
    btn.addEventListener('click', async () => {
        await ensureCircleAuthHydrated();

        // No Circle session / no funds: go straight to deposit onboarding (no tip POST).
        if (!viewerState.userId || !hasResumableCircleSession()) {
            openTipOnboarding();
            return;
        }

        const tipBalance = await fetchTipBalance();
        if (tipBalance === null || tipBalance < amount) {
            openTipOnboarding();
            return;
        }

        if (!viewerState.ephemeralPk) {
            try { await ensureEphemeralKey(); } catch (_) { /* ignore */ }
        }
        if (!viewerState.ephemeralPk) {
            openTipOnboarding();
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Sending\u2026';

        const sendTip = async (attempt = 1) => {
            try {
                const res = await fetch(ARC_API_BASE + '/api/core/v1/tips', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: viewerState.userId,
                        payoutAddress: creatorWallet,
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
                    console.error('[Tessera] Tip failed: HTTP ' + res.status);

                    // 404/402: need deposit or session. Do not silent-register here
                    // (that delayed the deposit modal by seconds when unfunded).
                    if (res.status === 404 || res.status === 402) {
                        btn.textContent = `\u2764\uFE0F Support $${amount.toFixed(2)}`;
                        void refreshStatus();
                        openTipOnboarding();
                    } else {
                        if (attempt < 3) {
                            console.log('[Tessera] Tip failed with status ' + res.status + '. Retrying...');
                            await new Promise(resolve => setTimeout(resolve, 500));
                            await sendTip(attempt + 1);
                            return;
                        }
                        btn.textContent = 'Error \u2014 retry';
                    }
                }
            } catch (e) {
                console.error('[Tessera] Tip request error:', e && e.message ? e.message : e);
                if (attempt < 3) {
                    console.log('[Tessera] Tip network error. Retrying...');
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await sendTip(attempt + 1);
                    return;
                }
                btn.textContent = 'Error \u2014 retry';
            }
        };

        await sendTip();
        btn.disabled = false;
    });
};


// ─── Tip Mode (Free Resources) ───────────────────────────────────────────────
//
// Called by the connector for free resources.
// Does NOT lock media. Only renders the session manager and the tip button.

function initTipMode(creatorWallet, tipAmount) {
    isTipMode = true;
    tipCreatorWallet = creatorWallet;
    tipAmountVal = tipAmount;
    injectDependencies();
    void ensureCircleAuthHydrated();

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
    // OAuth cover/splash is for paid paywall resume only. Free tip videos must
    // keep playback visible while the user funds/enables tips.
    consumeOpaqueCoverFlag();
    hideSocialResumeSplash();
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
// paywall.js does NOT auto-initialize on load. The connector calls the
// appropriate method after resolving the resource's billing mode:
//
//   window.ArcCashier.initPaywall()               → pay-per-second (locks media)
//   window.ArcCashier.initTipMode(wallet, amount)  → free resource (tip button only)
//   window.ArcCashier.initCreatorEarnings(opts)    → creator Gateway balance + MetaMask withdraw

window.ArcCashier = {
    initPaywall,
    initTipMode,
    initCreatorEarnings: initCreatorEarningsUi,
    // Legacy alias kept for backwards compatibility with any external callers
    init: initPaywall,
};

// Complete Google/Facebook OAuth return even if paywall is not open yet (redirect lands on origin).
if (typeof window !== 'undefined') {
    const pendingBoot = readSocialPending();
    const coverBoot = peekOpaqueCoverFlag();
    if (pendingBoot?.deviceToken) {
        const bootHashOk = /^#(?:[a-zA-Z0-9-_.%]+=[^&]*&)*[a-zA-Z0-9-_.%]+=[^&]*$/.test(
            window.location.hash || ''
        );
        if (bootHashOk) showSocialResumeSplash(pendingBoot.provider);
        void tryResumeSocialLogin();
    } else if (coverBoot) {
        // Returning to the video after OAuth: cover until initPaywall mounts.
        showSocialResumeSplash(coverBoot);
    }
}
