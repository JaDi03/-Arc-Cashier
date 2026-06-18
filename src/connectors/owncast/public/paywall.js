// arc-paywall.js - Injected by Reverse Proxy

// Include ethers.js via CDN dynamically if not present
if (!window.ethers) {
    const script = document.createElement('script');
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.0/ethers.umd.min.js";
    document.head.appendChild(script);
}

// Arc Testnet uses Native USDC for gas and payments, so no ERC20 ABI is needed.

let ephemeralWallet = null;
const ARC_API_BASE = (document.currentScript && document.currentScript.src) ? new URL(document.currentScript.src).origin : '';

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
            <div style="background: rgba(0,0,0,0.3); border-radius: 8px; padding: 15px; margin-bottom: 15px; text-align: left;">
                <p style="margin: 0 0 8px; color: #fff; font-weight: bold;">Initial Deposit: <span style="color: #00f2fe; float: right;">1.00 USDC</span></p>
                <p style="margin: 0; color: #a0aec0; font-size: 13px;">Streaming Rate: <span style="float: right;">$0.0001 USDC / sec</span></p>
                <p style="margin: 5px 0 0; color: #a0aec0; font-size: 11px;">(Unused funds remain safely in the Gateway Contract)</p>
            </div>
            
            <div style="margin-bottom: 20px; text-align: left;">
                <label for="arc-network-select" style="display:block; margin-bottom: 5px; font-size: 13px; color: #cbd5e0;">Deposit Network</label>
                <select id="arc-network-select" style="width: 100%; padding: 10px; background: #2d3748; color: white; border: 1px solid #4a5568; border-radius: 4px;">
                    <option value="arc">Arc Testnet (Native USDC)</option>
                    <option value="baseSepolia">Base Sepolia → Arc (CCTP Forwarding)</option>
                    <option value="arbSepolia">Arbitrum Sepolia → Arc (CCTP Forwarding)</option>
                </select>
            </div>

            <button id="arc-connect-btn" class="arc-btn">Connect Wallet & Deposit</button>
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
            <div id="arc-sm-warning" class="arc-hidden" style="background: rgba(255,165,0,0.2); border: 1px solid orange; padding: 10px; margin-top: 10px; margin-bottom: 10px; border-radius: 4px; text-align: center;">
                <p style="margin: 0 0 5px; color: orange; font-size: 12px; font-weight: bold;">⚠️ Low Balance: <span id="arc-sm-time-left"></span> left</p>
                <button id="arc-sm-topup-btn" class="arc-btn" style="padding: 5px 10px; font-size: 11px; margin: 0 auto; display: inline-block;">Top Up +30 Mins</button>
            </div>
            <div style="display: flex; gap: 8px; margin-top: 10px;">
                <button id="arc-sm-leave-btn" class="arc-btn" onclick="window.arcLeaveSession()" style="flex: 1; background: #4a5568; font-size: 11px; padding: 8px 4px;">⏸ Just Leave</button>
                <button id="arc-sm-end-btn" class="arc-btn arc-btn-danger" onclick="window.arcEndSession()" style="flex: 2; font-size: 11px; padding: 8px 4px;">💸 Cash Out & Exit</button>
            </div>
            <p style="margin: 6px 0 0; font-size: 10px; color: #718096; text-align: center;">Leave keeps funds for next time. Cash Out withdraws to your wallet.</p>
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
    document.getElementById('arc-sm-topup-btn').addEventListener('click', handleTopUp);

    // --- ARC MEDIA LOCK ---
    // Globally prevent any video/audio from playing while paywall is active
    document.addEventListener('play', (e) => {
        if (document.body.classList.contains('arc-locked') && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
            e.target.pause();
        }
    }, true); // Capture phase to intercept before player UI

    setInterval(() => {
        if (document.body.classList.contains('arc-locked')) {
            document.querySelectorAll('video, audio').forEach(media => {
                if (!media.paused) media.pause();
            });
        }
    }, 500); // Aggressive fallback
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
        if (!window.ethereum) throw new Error("NO_WALLET");

        await updateStatus(`
            <div style="display: flex; align-items: center; justify-content: center; margin-bottom: 8px;">
                <div class="arc-spinner"></div>
                <span style="color: #fff;">Connecting to wallet...</span>
            </div>
            <div style="font-size: 11px; color: #a0aec0;">You may be asked to sign a message to recover your session.</div>
        `);
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();
        const userAddress = await signer.getAddress();
        let viewerId = localStorage.getItem('owncast_viewer_id') || localStorage.getItem('arc_cashier_user_id');

        // 1. Session Recovery
        let savedPk = localStorage.getItem('arc_ephemeral_pk');
        if (!savedPk) {
            try {
                const signature = await signer.signMessage('Login to Arc-Cashier to recover or create your session.');
                const recoverRes = await fetch(ARC_API_BASE + '/api/core/recover-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ returnAddress: userAddress, signature })
                });
                if (recoverRes.ok) {
                    const data = await recoverRes.json();
                    savedPk = data.privateKey;
                    viewerId = data.userId;
                    localStorage.setItem('arc_ephemeral_pk', savedPk);
                    localStorage.setItem('arc_cashier_user_id', viewerId);
                    console.log("Recovered session from backend.");
                }
            } catch (e) { console.log('Recovery skipped or failed', e); }
        }

        if (savedPk) {
            ephemeralWallet = new ethers.Wallet(savedPk);
        } else {
            ephemeralWallet = ethers.Wallet.createRandom();
            localStorage.setItem('arc_ephemeral_pk', ephemeralWallet.privateKey);
        }

        // 2. Check existing balance to skip deposit
        let needsDeposit = true;
        try {
            const balRes = await fetch(ARC_API_BASE + '/api/core/session-balance?userId=' + viewerId);
            if (balRes.ok) {
                const balData = await balRes.json();
                if (Number(balData.gatewayAvailable) > 0.01) {
                    console.log("Session already funded! Skipping on-chain deposit.");
                    needsDeposit = false;
                }
            }
        } catch (e) { console.log('Balance check failed, proceeding to deposit'); }

        const networkSelect = document.getElementById('arc-network-select');
        const selectedNetwork = networkSelect ? networkSelect.value : 'arc';
        let isCCTP = false;

        // 3. Perform Deposit if needed
        if (needsDeposit) {
            if (selectedNetwork === 'arc') {
                const network = await provider.getNetwork();
                if (network.chainId !== 5042002n) {
                    try {
                        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x4cef52' }] });
                    } catch (e) {
                        if (e.code === 4902) {
                            await window.ethereum.request({
                                method: 'wallet_addEthereumChain',
                                params: [{
                                    chainId: '0x4cef52', chainName: 'Arc Testnet', rpcUrls: ['https://rpc.testnet.arc.network'],
                                    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, blockExplorerUrls: ['https://testnet.arcscan.app']
                                }]
                            });
                        } else throw e;
                    }
                }
                const amount = ethers.parseUnits("1", 18);
                btn.innerText = "Confirming on network...";
                const tx = await signer.sendTransaction({ to: ephemeralWallet.address, value: amount });
                await updateStatus(`Processing native deposit... <a href="https://testnet.arcscan.app/tx/${tx.hash}" target="_blank">Track TX</a>`, true);
                await tx.wait();
            } else if (selectedNetwork === 'baseSepolia' || selectedNetwork === 'arbSepolia') {
                isCCTP = true;

                // Network-specific config
                const CCTP_NETWORKS = {
                    baseSepolia: {
                        chainId: 84532n,
                        chainIdHex: '0x14a34',
                        chainName: 'Base Sepolia',
                        rpcUrls: ['https://sepolia.base.org'],
                        tmAddress: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5',
                        usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                    },
                    arbSepolia: {
                        chainId: 421614n,
                        chainIdHex: '0x66EEE',
                        chainName: 'Arbitrum Sepolia',
                        rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc'],
                        tmAddress: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5',
                        usdcAddress: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
                    }
                };

                const net = CCTP_NETWORKS[selectedNetwork];
                const network = await provider.getNetwork();
                if (network.chainId !== net.chainId) {
                    try {
                        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: net.chainIdHex }] });
                    } catch (e) {
                        if (e.code === 4902) {
                            await window.ethereum.request({
                                method: 'wallet_addEthereumChain',
                                params: [{ chainId: net.chainIdHex, chainName: net.chainName, rpcUrls: net.rpcUrls, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 } }]
                            });
                        } else throw e;
                    }
                }

                const amount = ethers.parseUnits('5.0', 6); // 5 USDC
                const maxFee = ethers.parseUnits('0.2', 6);  // 0.20 USDC Circle Forwarding fee
                const destDomain = 26;                        // Arc Testnet domain
                const mintRecipient = ethers.zeroPadValue(ephemeralWallet.address, 32);
                const hookData = '0x636374702d666f72776172640000000000000000000000000000000000000000';

                const usdcContract = new ethers.Contract(net.usdcAddress, ['function approve(address spender, uint256 amount) public returns (bool)'], signer);
                await updateStatus(`Approving 5 USDC on ${net.chainName} for CCTP...`);
                const approveTx = await usdcContract.approve(net.tmAddress, amount);
                await approveTx.wait();

                const tmContract = new ethers.Contract(net.tmAddress, ['function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, uint256 maxFee, bytes hookData) returns (uint64 _nonce)'], signer);
                await updateStatus(`Initiating CCTP Cross-Chain Deposit from ${net.chainName}... (Fee: 0.20 USDC)`);
                const depositTx = await tmContract.depositForBurnWithHook(amount, destDomain, mintRecipient, net.usdcAddress, maxFee, hookData);
                await updateStatus(`CCTP Burn TX sent from ${net.chainName}! Waiting for block confirmation...`, true);
                await depositTx.wait();
            }
        }

        btn.innerText = "Opening Stream...";
        await updateStatus(isCCTP ? "Waiting for Circle Forwarding (up to 3 mins)..." : "Funding Gateway and Opening Stream...");

        // 4. Register Session
        const response = await fetch(ARC_API_BASE + '/api/core/register-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: viewerId,
                privateKey: ephemeralWallet.privateKey,
                returnAddress: userAddress,
                isCCTP: isCCTP
            })
        });

        if (!response.ok) {
            const errJson = await response.json().catch(() => ({}));
            throw new Error(errJson.error || "Backend failed to register session.");
        }

        // Success! Remove the paywall
        document.body.classList.remove('arc-locked');
        const overlay = document.getElementById('arc-paywall-overlay');
        if(overlay) {
            overlay.style.opacity = '0';
            setTimeout(() => overlay.remove(), 500);
        }

        // Show and Start the Session Manager UI
        const sessionManager = document.getElementById('arc-session-manager');
        if(sessionManager) sessionManager.classList.remove('arc-hidden');

        let seconds = 0;
        window.sessionTimer = setInterval(async () => {
            seconds++;
            const timeEl = document.getElementById('arc-sm-time');
            const costEl = document.getElementById('arc-sm-cost');
            if(timeEl) timeEl.innerText = seconds + 's';
            if(costEl) costEl.innerText = '$' + (seconds * 0.0001).toFixed(4) + ' USDC';

            if (seconds % 5 === 0) {
                try {
                    const statusRes = await fetch(ARC_API_BASE + '/api/core/session-status?userId=' + viewerId);
                    if (statusRes.status === 404) {
                        clearInterval(window.sessionTimer);
                        if (sessionManager) sessionManager.classList.add('arc-hidden');
                        const oldOverlay = document.getElementById('arc-paywall-overlay');
                        if (oldOverlay) oldOverlay.remove();
                        initPaywall();
                    } else if (statusRes.ok) {
                        const balanceRes = await fetch(ARC_API_BASE + '/api/core/session-balance?userId=' + viewerId);
                        if (balanceRes.ok) {
                            const data = await balanceRes.json();
                            const withdrawable = Number(data.gatewayWithdrawable);
                            const balEl = document.getElementById('arc-sm-balance');
                            if(balEl) balEl.innerText = '$' + withdrawable.toFixed(4) + ' USDC';
                            
                            const secondsLeft = withdrawable / 0.0001;
                            const warningDiv = document.getElementById('arc-sm-warning');
                            if (warningDiv) {
                                if (secondsLeft <= 300 && secondsLeft > 0) {
                                    warningDiv.classList.remove('arc-hidden');
                                    document.getElementById('arc-sm-time-left').innerText = `${Math.floor(secondsLeft / 60)}m ${Math.floor(secondsLeft % 60)}s`;
                                } else {
                                    warningDiv.classList.add('arc-hidden');
                                }
                            }
                        }
                    }
                } catch (e) { console.error("Heartbeat failed", e); }
            }
        }, 1000);

    } catch (error) {
        console.error(error);
        const btn = document.getElementById('arc-connect-btn');
        if(btn) {
            btn.disabled = false;
            btn.innerText = "Connect Wallet & Deposit";
        }

        if (error.message === 'NO_WALLET') {
            await updateStatus(`Wallet not found. Please <a href="https://metamask.io" target="_blank" style="color: #fc8181; text-decoration: underline;">Download MetaMask</a>.`, true);
            return;
        }

        let humanError = error.message || "An unknown error occurred.";
        const rawError = error?.message?.toLowerCase() || "";

        if (error.code === 'ACTION_REJECTED' || rawError.includes('user denied')) {
            humanError = "You cancelled the transaction in your wallet.";
        } else if (rawError.includes('insufficient funds')) {
            humanError = "You don't have enough funds to cover the deposit.";
        } else if (rawError.includes('network') || error.code === 4902) {
            humanError = "You must switch network in your wallet to proceed.";
        }

        await updateStatus("Error: " + humanError, true);
    }
}

async function handleTopUp() {
    const btn = document.getElementById('arc-sm-topup-btn');
    btn.disabled = true;
    btn.innerText = "Confirming...";

    try {
        const provider = new ethers.BrowserProvider(window.ethereum);
        const signer = await provider.getSigner();

        // Calculate amount for 30 minutes + 0.1 for gas buffer
        const RATE_PER_SEC = 0.0001;
        const extraSeconds = 30 * 60; // 30 minutes
        const amountToDeposit = RATE_PER_SEC * extraSeconds;
        const amountWithGas = amountToDeposit + 0.1;
        const amountWei = ethers.parseUnits(amountWithGas.toFixed(6), 18);

        const tx = await signer.sendTransaction({
            to: ephemeralWallet.address,
            value: amountWei
        });

        btn.innerText = "Processing...";
        await tx.wait();

        const viewerId = localStorage.getItem('owncast_viewer_id') || localStorage.getItem('arc_cashier_user_id');
        const response = await fetch(ARC_API_BASE + '/api/core/topup-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: viewerId })
        });

        if (!response.ok) {
            throw new Error("Top-up API failed");
        }

        btn.innerText = "Top Up +30 Mins";
        btn.disabled = false;
        document.getElementById('arc-sm-warning').classList.add('arc-hidden');

    } catch (error) {
        console.error("[Arc Cashier] Top-up failed", error);
        btn.innerText = "Error (Retry)";
        btn.disabled = false;
    }
}

// Global leave function — stops billing but keeps funds in Gateway for next visit
window.arcLeaveSession = async function() {
    const leaveBtn = document.getElementById('arc-sm-leave-btn');
    if (leaveBtn) {
        leaveBtn.disabled = true;
        leaveBtn.innerText = 'Leaving...';
    }

    clearInterval(window.sessionTimer);
    if (window.owncastPingInterval) clearInterval(window.owncastPingInterval);

    const viewerId = localStorage.getItem('owncast_viewer_id') || localStorage.getItem('arc_cashier_user_id');

    try {
        await fetch(ARC_API_BASE + '/api/core/end-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: viewerId })
        });
    } catch (e) {
        console.warn('[Arc Cashier] Could not notify backend of leave, billing will stop on next heartbeat timeout.');
    }

    // Update UI — funds remain, they can come back
    const sessionManager = document.getElementById('arc-session-manager');
    if (sessionManager) {
        sessionManager.innerHTML = `
            <div style="padding: 10px;">
                <h3 style="color:#63b3ed;margin:0 0 8px 0;">⏸ Session Paused</h3>
                <p style="font-size: 12px; color: #a0aec0; margin: 0 0 10px 0;">Your balance is safe in the Gateway. Connect again with the same wallet to resume.</p>
                <p style="font-size: 11px; color: #718096; margin: 0;">Billing has stopped.</p>
            </div>
        `;
    }

    document.body.classList.add('arc-locked');
    console.log('[Arc Cashier] User left session. Funds remain in Gateway for next visit.');
};

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

    const viewerId = localStorage.getItem('owncast_viewer_id') || localStorage.getItem('arc_cashier_user_id');
    const userAddress = ephemeralWallet ? ephemeralWallet.address : '';

    console.log("[Arc Cashier] Viewer ID:", viewerId);

    // Use XMLHttpRequest instead of fetch — fetch is being silently intercepted
    const xhr = new XMLHttpRequest();
    const url = ARC_API_BASE + '/api/core/cash-out';
    console.log("[Arc Cashier] XHR URL:", url);

    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');

    xhr.onreadystatechange = function() {
        console.log("[Arc Cashier] XHR readyState:", xhr.readyState, "status:", xhr.status);
    };

    xhr.onload = function() {
        console.log("[Arc Cashier] XHR COMPLETE. Status:", xhr.status, "Body:", xhr.responseText);

        if (xhr.status >= 200 && xhr.status < 300) {
            // Also remove the ephemeral pk from localStorage so they can't reuse a cashed-out session
            localStorage.removeItem('arc_ephemeral_pk');
            
            const sessionManager = document.getElementById('arc-session-manager');
            if (sessionManager) {
                sessionManager.innerHTML = `
                    <div style="padding: 10px;">
                        <h3 style="color:#68d391;margin:0 0 10px 0;">✅ Session Ended & Cashed Out</h3>
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
