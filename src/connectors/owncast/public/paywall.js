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
        <h3>🟢 Arc Premium Session</h3>
        <div class="arc-sm-stats">
            <div><span>Time:</span> <span id="arc-sm-time">0s</span></div>
            <div><span>Cost:</span> <span id="arc-sm-cost">$0.0000 USDC</span></div>
            <div><span>Balance:</span> <span id="arc-sm-balance">$1.0000 USDC</span></div>
        </div>
        <button id="arc-sm-end-btn" class="arc-btn arc-btn-danger">End Session & Withdraw</button>
    `;
    document.body.appendChild(sessionManager);

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
        window.sessionTimer = setInterval(() => {
            seconds++;
            document.getElementById('arc-sm-time').innerText = seconds + 's';
            document.getElementById('arc-sm-cost').innerText = '$' + (seconds * 0.0001).toFixed(4) + ' USDC';
            document.getElementById('arc-sm-balance').innerText = '$' + (1.0000 - (seconds * 0.0001)).toFixed(4) + ' USDC';
        }, 1000);

        // Handle End Session Button
        document.getElementById('arc-sm-end-btn').addEventListener('click', () => {
            clearInterval(window.sessionTimer);
            if (window.owncastPingInterval) {
                clearInterval(window.owncastPingInterval);
            }
            sessionManager.innerHTML = `
                <h3>🔴 Session Ended</h3>
                <p style="font-size: 13px; color: #a0aec0; margin-top: 10px;">Your refund is being processed automatically.</p>
                <a href="https://testnet.arcscan.app/address/${userAddress}" target="_blank" style="display: inline-block; margin-top: 10px; font-size: 12px; color: #4facfe; text-decoration: underline;">
                    🧾 Check your wallet balance on Arcscan
                </a>
            `;
            document.body.classList.add('arc-locked');
        });

    } catch (error) {
        console.error(error);
        const btn = document.getElementById('arc-connect-btn');
        btn.disabled = false;
        
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

// Start the paywall once the page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPaywall);
} else {
    initPaywall();
}
