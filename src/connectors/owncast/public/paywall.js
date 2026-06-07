// arc-paywall.js - Injected by Reverse Proxy

// Include ethers.js via CDN dynamically if not present
if (!window.ethers) {
    const script = document.createElement('script');
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.0/ethers.umd.min.js";
    document.head.appendChild(script);
}

// Arc Testnet uses Native USDC for gas and payments, so no ERC20 ABI is needed.

let ephemeralWallet = null;

function initPaywall() {
    // Inject CSS if not present
    if (!document.getElementById('arc-paywall-css')) {
        const link = document.createElement('link');
        link.id = 'arc-paywall-css';
        link.rel = 'stylesheet';
        link.href = '/owncast-assets/paywall.css'; // Served by our proxy
        document.head.appendChild(link);
    }

    // Lock the body
    document.body.classList.add('arc-locked');

    // Create the overlay and modal
    const overlay = document.createElement('div');
    overlay.id = 'arc-paywall-overlay';

    overlay.innerHTML = `
        <div id="arc-paywall-modal">
            <h2>Premium Stream</h2>
            <p>To watch this stream seamlessly, please deposit your initial guarantee. We use Circle Nanopayments (x402) so you only pay exactly for the seconds you watch.</p>
            <div style="background: rgba(0,0,0,0.3); border-radius: 8px; padding: 15px; margin-bottom: 25px; text-align: left;">
                <p style="margin: 0 0 8px; color: #fff; font-weight: bold;">Initial Deposit: <span style="color: #00f2fe; float: right;">1.00 USDC</span></p>
                <p style="margin: 0; color: #a0aec0; font-size: 13px;">Streaming Rate: <span style="float: right;">$0.0001 USDC / sec</span></p>
                <p style="margin: 5px 0 0; color: #a0aec0; font-size: 11px;">(Unused funds remain safely in the Gateway Contract)</p>
            </div>
            <button id="arc-connect-btn" class="arc-btn">Connect Wallet & Deposit 1 USDC</button>
            <p id="arc-paywall-status" style="margin-top: 15px; font-size: 12px; color: #63b3ed; display: none;"></p>
        </div>
    `;

    document.body.appendChild(overlay);

    // Create the Session Manager UI (Hidden initially)
    const sessionManager = document.createElement('div');
    sessionManager.id = 'arc-session-manager';
    sessionManager.className = 'arc-hidden';
    sessionManager.innerHTML = `
        <div id="arc-sm-header">
            <h3><span class="arc-pulse-dot"></span> Active Session</h3>
            <button id="arc-sm-minimize-btn" title="Minimize/Maximize">−</button>
        </div>
        <div id="arc-sm-content">
            <div class="arc-sm-stats">
                <div><span>Time:</span> <span id="arc-sm-time">0s</span></div>
                <div><span>Cost:</span> <span id="arc-sm-cost">$0.0000 USDC</span></div>
                <div><span>Balance:</span> <span id="arc-sm-balance">$1.0000 USDC</span></div>
            </div>
            <button id="arc-sm-end-btn" class="arc-btn arc-btn-danger" onclick="window.arcEndSession()">End Session & Withdraw</button>
        </div>
    `;
    document.body.appendChild(sessionManager);

    // Draggable Logic
    let isDragging = false, startX, startY, initialX, initialY;
    const header = document.getElementById('arc-sm-header');

    header.addEventListener('mousedown', (e) => {
        if (e.target.id === 'arc-sm-minimize-btn') return;
        isDragging = true;
        const rect = sessionManager.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;
        startX = e.clientX;
        startY = e.clientY;
        sessionManager.style.right = 'auto'; // Disable right anchoring
        sessionManager.style.bottom = 'auto';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        sessionManager.style.left = `${initialX + dx}px`;
        sessionManager.style.top = `${initialY + dy}px`;
    });

    document.addEventListener('mouseup', () => { isDragging = false; });

    // Minimize Logic
    document.getElementById('arc-sm-minimize-btn').addEventListener('click', () => {
        sessionManager.classList.toggle('arc-sm-minimized');
        const btn = document.getElementById('arc-sm-minimize-btn');
        btn.innerText = sessionManager.classList.contains('arc-sm-minimized') ? '+' : '−';
    });

    document.getElementById('arc-connect-btn').addEventListener('click', handleFundSession);
}

async function updateStatus(htmlContent, isWarning = false) {
    const status = document.getElementById('arc-paywall-status');
    status.style.display = 'block';
    status.innerHTML = htmlContent;
    if (isWarning) {
        status.className = 'arc-warning';
    } else {
        status.className = '';
        status.style.color = '#63b3ed';
    }
}

async function handleFundSession() {
    const btn = document.getElementById('arc-connect-btn');
    btn.disabled = true;
    btn.innerText = "Please confirm in wallet...";

    try {
        if (!window.ethereum) {
            throw new Error("NO_WALLET");
        }

        await updateStatus(`
            <div style="display: flex; align-items: center; justify-content: center; margin-bottom: 8px;">
                <div class="arc-spinner"></div>
                <span style="color: #fff;">Please open your wallet and Confirm...</span>
            </div>
            <div style="font-size: 11px; color: #a0aec0;">Don't worry, unused funds are automatically refunded.</div>
        `);
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();

        // Ensure we are on Arc Testnet (Chain ID 5042002 -> 0x4cef52)
        const network = await provider.getNetwork();
        if (network.chainId !== 5042002n) {
            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: '0x4cef52' }]
                });
            } catch (switchError) {
                // This error code indicates that the chain has not been added to MetaMask.
                if (switchError.code === 4902) {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [{
                            chainId: '0x4cef52',
                            chainName: 'Arc Testnet',
                            rpcUrls: ['https://rpc.testnet.arc.network'],
                            nativeCurrency: {
                                name: 'USDC',
                                symbol: 'USDC',
                                decimals: 18
                            },
                            blockExplorerUrls: ['https://testnet.arcscan.app']
                        }]
                    });
                } else {
                    throw switchError;
                }
            }
        }



        ephemeralWallet = ethers.Wallet.createRandom();
        console.log("Ephemeral Address:", ephemeralWallet.address);

        // On Arc Testnet, USDC IS the native gas token. It has 18 decimals.
        // We transfer 1 Native USDC directly (no ERC20 contract needed)
        const amount = ethers.parseUnits("1", 18);

        btn.innerText = "Confirming on network...";
        // Execute a standard native transfer to the ephemeral wallet
        const tx = await signer.sendTransaction({
            to: ephemeralWallet.address,
            value: amount
        });

        const ARCSCAN_URL = 'https://testnet.arcscan.app';
        await updateStatus(`
            <div style="display: flex; align-items: center; justify-content: center; margin-bottom: 8px;">
                <div class="arc-spinner"></div>
                <span style="color: #fff;">Network is processing your deposit...</span>
            </div>
            <div style="font-size: 12px; margin-bottom: 8px;">
                👉 <a href="${ARCSCAN_URL}/tx/${tx.hash}" target="_blank" style="color: #4facfe; text-decoration: underline;">Track transaction live on Arcscan</a>
            </div>
            <div style="font-size: 11px;">⚠️ DO NOT CLOSE THIS TAB OR YOUR DEPOSIT WILL BE LOST!</div>
        `, true);
        await tx.wait();

        btn.innerText = "Opening Stream...";
        await updateStatus("Funding Gateway and Opening Stream...");
        const viewerId = localStorage.getItem('owncast_viewer_id');
        const userAddress = await signer.getAddress();

        // Send the ephemeral private key to the Sidecar so it can deposit to Gateway and settle later
        const response = await fetch('/api/core/register-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: viewerId,
                privateKey: ephemeralWallet.privateKey,
                address: ephemeralWallet.address,
                returnAddress: userAddress
            })
        });

        if (!response.ok) {
            throw new Error("Backend failed to register session.");
        }

        // Success! Remove the paywall
        document.body.classList.remove('arc-locked');
        const overlay = document.getElementById('arc-paywall-overlay');
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 500);

        // Show and Start the Session Manager UI
        const sessionManager = document.getElementById('arc-session-manager');
        sessionManager.classList.remove('arc-hidden');

        let seconds = 0;
        window.sessionTimer = setInterval(async () => {
            seconds++;
            document.getElementById('arc-sm-time').innerText = seconds + 's';
            document.getElementById('arc-sm-cost').innerText = '$' + (seconds * 0.0001).toFixed(4) + ' USDC';
            document.getElementById('arc-sm-balance').innerText = '$' + (1.0000 - (seconds * 0.0001)).toFixed(4) + ' USDC';

            // Heartbeat: Check if the backend killed the session every 5 seconds
            if (seconds % 5 === 0) {
                try {
                    const statusRes = await fetch('/api/core/session-status?userId=' + viewerId);
                    if (statusRes.status === 404) {
                        console.warn("[Arc Cashier] Session was cleared by the backend due to inactivity. Re-locking screen.");
                        clearInterval(window.sessionTimer);
                        
                        // Hide session manager
                        const sm = document.getElementById('arc-session-manager');
                        if (sm) sm.classList.add('arc-hidden');
                        
                        // Remove the old overlay if it exists so we don't duplicate
                        const oldOverlay = document.getElementById('arc-paywall-overlay');
                        if (oldOverlay) oldOverlay.remove();

                        // Re-initialize the paywall to force a new deposit
                        initPaywall();
                    }
                } catch (e) {
                    console.error("[Arc Cashier] Heartbeat failed", e);
                }
            }
        }, 1000);

        // Tell the user it's ready in console
        console.log("[Arc Cashier] Session is active. Listener for End Session is ready via delegation.");

    } catch (error) {
        console.error(error);
        const btn = document.getElementById('arc-connect-btn');
        btn.disabled = false;
        btn.innerText = "Connect Wallet & Deposit 1 USDC";

        if (error.message === 'NO_WALLET') {
            await updateStatus(`
                Wallet not found. Please <a href="https://metamask.io" target="_blank" style="color: #fc8181; text-decoration: underline;">Download MetaMask</a> to watch this stream.
            `, true);
            return;
        }

        let humanError = "The network is busy or an unknown error occurred. Please try again.";
        const rawError = error?.message?.toLowerCase() || "";

        if (error.code === 'ACTION_REJECTED' || rawError.includes('user denied')) {
            humanError = "You cancelled the transaction in your wallet. Click connect to try again.";
        } else if (rawError.includes('insufficient funds')) {
            humanError = "You don't have enough testnet USDC to cover the deposit. Please request funds from the Arc Faucet.";
        } else if (rawError.includes('network') || error.code === 4902) {
            humanError = "You must switch to the Arc Testnet in your wallet to proceed.";
        }

        await updateStatus("Error: " + humanError, true);
    }
}

// Global end-session function attached to window so inline onclick always works
window.arcEndSession = async function() {
    console.log("[Arc Cashier] >>> arcEndSession() CALLED <<<");

    const endBtn = document.getElementById('arc-sm-end-btn');
    if (endBtn) {
        endBtn.disabled = true;
        endBtn.innerHTML = '<div class="arc-spinner" style="width:14px;height:14px;border-width:2px;margin-right:5px;"></div> Withdrawing...';
    }

    clearInterval(window.sessionTimer);
    if (window.owncastPingInterval) {
        clearInterval(window.owncastPingInterval);
    }

    const viewerId = localStorage.getItem('owncast_viewer_id');
    const userAddress = ephemeralWallet ? ephemeralWallet.address : '';

    console.log("[Arc Cashier] Viewer ID:", viewerId);

    // Use XMLHttpRequest instead of fetch — fetch is being silently intercepted
    const xhr = new XMLHttpRequest();
    const url = window.location.protocol + '//' + window.location.host + '/api/core/end-session';
    console.log("[Arc Cashier] XHR URL:", url);

    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');

    xhr.onreadystatechange = function() {
        console.log("[Arc Cashier] XHR readyState:", xhr.readyState, "status:", xhr.status);
    };

    xhr.onload = function() {
        console.log("[Arc Cashier] XHR COMPLETE. Status:", xhr.status, "Body:", xhr.responseText);

        if (xhr.status >= 200 && xhr.status < 300) {
            const sessionManager = document.getElementById('arc-session-manager');
            if (sessionManager) {
                sessionManager.innerHTML = `
                    <div style="padding: 10px;">
                        <h3 style="color:#68d391;margin:0 0 10px 0;">✅ Session Ended</h3>
                        <p style="font-size: 13px; color: #a0aec0; margin: 0 0 10px 0;">Your refund was processed to your wallet.</p>
                        <a href="https://testnet.arcscan.app/address/${userAddress}" target="_blank" style="font-size: 12px; color: #4facfe; text-decoration: underline;">
                            🧾 View Balance on Arcscan
                        </a>
                    </div>
                `;
            }
        } else {
            console.error("[Arc Cashier] Server error:", xhr.responseText);
            if (endBtn) {
                endBtn.disabled = false;
                endBtn.innerText = "Error: " + xhr.responseText;
            }
        }

        document.body.classList.add('arc-locked');
    };

    xhr.onerror = function() {
        console.error("[Arc Cashier] XHR NETWORK ERROR - request never reached server");
        if (endBtn) {
            endBtn.disabled = false;
            endBtn.innerText = "Network Error - Retry";
        }
    };

    xhr.ontimeout = function() {
        console.error("[Arc Cashier] XHR TIMEOUT");
        if (endBtn) {
            endBtn.disabled = false;
            endBtn.innerText = "Timeout - Retry";
        }
    };

    xhr.timeout = 15000; // 15 second timeout

    const payload = JSON.stringify({ userId: viewerId });
    console.log("[Arc Cashier] Sending XHR with payload:", payload);
    xhr.send(payload);
};

// Start the paywall once the page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPaywall);
} else {
    initPaywall();
}
