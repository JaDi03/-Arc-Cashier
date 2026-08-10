/**
 * CCTP bridge UI + Circle Bridge Kit (browser MetaMask -> Arc Testnet via Forwarding).
 * Extracted from paywall.js so the viewer paywall does not own ABI/fee encoding.
 *
 * Docs: @circle-fin/bridge-kit + createViemAdapterFromProvider (adapter-setups).
 */

import { BridgeKit } from '@circle-fin/bridge-kit';
import {
    ArcTestnet,
    ArbitrumSepolia,
    BaseSepolia,
    EthereumSepolia,
} from '@circle-fin/bridge-kit/chains';
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { createPublicClient, http } from 'viem';

/** Destination for Tessera viewer funding (Circle chain name for kit.bridge). */
export const ARC_DEST_CHAIN = 'Arc_Testnet';

/**
 * Browser-safe RPC URLs from Bridge Kit chain defs (not viem defaults).
 * Ethereum Sepolia uses publicnode — avoids CORS on rpc.sepolia.org in the browser.
 */
const KIT_RPC_BY_CHAIN_ID = {
    [EthereumSepolia.chainId]: EthereumSepolia.rpcEndpoints[0],
    [BaseSepolia.chainId]: BaseSepolia.rpcEndpoints[0],
    [ArbitrumSepolia.chainId]: ArbitrumSepolia.rpcEndpoints[0],
    [ArcTestnet.chainId]: ArcTestnet.rpcEndpoints[0],
};

/**
 * Source chains for the modal (testnet).
 * kitChain: Bridge Kit string id. rpcUrl: MetaMask add + PublicClient override.
 */
export const CCTP_SOURCE_CHAINS = [
    {
        name: 'Ethereum Sepolia',
        kitChain: 'Ethereum_Sepolia',
        chainId: EthereumSepolia.chainId,
        chainIdHex: '0xaa36a7',
        rpcUrl: KIT_RPC_BY_CHAIN_ID[EthereumSepolia.chainId],
        blockExplorer: 'https://sepolia.etherscan.io',
    },
    {
        name: 'Base Sepolia',
        kitChain: 'Base_Sepolia',
        chainId: BaseSepolia.chainId,
        chainIdHex: '0x14a34',
        rpcUrl: KIT_RPC_BY_CHAIN_ID[BaseSepolia.chainId],
        blockExplorer: 'https://base-sepolia.blockscout.com',
    },
    {
        name: 'Arbitrum Sepolia',
        kitChain: 'Arbitrum_Sepolia',
        chainId: ArbitrumSepolia.chainId,
        chainIdHex: '0x66eee',
        rpcUrl: KIT_RPC_BY_CHAIN_ID[ArbitrumSepolia.chainId],
        blockExplorer: 'https://sepolia.arbiscan.io',
    },
];

async function ensureSourceChain(ethereum, chain) {
    try {
        await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: chain.chainIdHex }],
        });
    } catch (switchErr) {
        if (switchErr && switchErr.code === 4902) {
            await ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId: chain.chainIdHex,
                    chainName: chain.name,
                    rpcUrls: [chain.rpcUrl],
                    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                    blockExplorerUrls: [chain.blockExplorer],
                }],
            });
        } else {
            throw switchErr;
        }
    }
}

function formatAmountString(amountFloat) {
    // Bridge Kit expects a decimal string (e.g. "2" or "2.00"), not wei.
    const rounded = Math.round(amountFloat * 1e6) / 1e6;
    return String(rounded);
}

/**
 * Bridge USDC from a MetaMask source chain to Arc Testnet using Forwarding Service.
 *
 * @param {object} opts
 * @param {typeof CCTP_SOURCE_CHAINS[number]} opts.chain
 * @param {number} opts.amountFloat
 * @param {string} opts.recipientAddress Arc UCW address that receives minted USDC
 * @param {(msg: string) => void} [opts.onProgress]
 * @param {(stepId: string, status: 'pending'|'done'|'error') => void} [opts.onStep]
 * @returns {Promise<object>} kit.bridge result
 */
export async function executeBridgeViaKit(opts) {
    const {
        chain,
        amountFloat,
        recipientAddress,
        onProgress,
        onStep,
    } = opts;

    if (!window.ethereum) {
        throw new Error('MetaMask is not installed. Please install MetaMask to use the bridge.');
    }
    if (!recipientAddress || !/^0x[a-fA-F0-9]{40}$/.test(recipientAddress)) {
        throw new Error('Arc wallet address is missing. Sign in before bridging.');
    }
    if (!amountFloat || amountFloat < 0.1) {
        throw new Error('Please enter a valid amount (min 0.1 USDC).');
    }

    const ethereum = window.ethereum;
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    const step = typeof onStep === 'function' ? onStep : () => {};

    progress('Connecting wallet…');
    await ethereum.request({ method: 'eth_requestAccounts' });
    await ensureSourceChain(ethereum, chain);

    progress('Preparing Bridge Kit…');
    const adapter = await createViemAdapterFromProvider({
        provider: ethereum,
        // Canteen adapter-setups: override default HTTP RPC (avoids rpc.sepolia.org CORS in browser).
        getPublicClient: ({ chain }) => {
            const rpcUrl = KIT_RPC_BY_CHAIN_ID[chain.id]
                || (chain.rpcUrls && chain.rpcUrls.default && chain.rpcUrls.default.http
                    ? chain.rpcUrls.default.http[0]
                    : null);
            if (!rpcUrl) {
                throw new Error(`No RPC configured for chain id ${chain.id}`);
            }
            return createPublicClient({
                chain,
                transport: http(rpcUrl, { retryCount: 2, timeout: 20_000 }),
            });
        },
    });

    const kit = new BridgeKit();
    const amount = formatAmountString(amountFloat);

    const mark = (name, status) => {
        if (name === 'approve') step('arc-step-approve-status', status);
        else if (name === 'burn') step('arc-step-burn-status', status);
        else if (name === 'fetchAttestation' || name === 'mint') {
            step('arc-step-mint-status', status);
        }
    };

    kit.on('approve', () => {
        mark('approve', 'done');
        step('arc-step-burn-status', 'pending');
        progress('Burning USDC on source chain…<br>Confirm in your wallet if prompted.');
    });
    kit.on('burn', (payload) => {
        mark('burn', 'done');
        step('arc-step-mint-status', 'pending');
        const txHash = payload?.values?.txHash || payload?.txHash;
        progress(
            txHash
                ? `Minting on Arc via Circle Forwarding…<br>Burn: ${txHash}`
                : 'Minting on Arc via Circle Forwarding…<br>This may take 1–2 minutes.',
        );
        if (txHash) {
            console.log(`[CCTP] Burn tx: ${txHash}`);
        }
    });
    kit.on('fetchAttestation', () => {
        progress('Attestation received. Completing mint on Arc…');
    });
    kit.on('mint', (payload) => {
        mark('mint', 'done');
        const txHash = payload?.values?.txHash || payload?.txHash;
        if (txHash) {
            console.log(`[CCTP] Mint/forward tx: ${txHash}`);
        }
    });

    step('arc-step-approve-status', 'pending');
    progress('Approving USDC…<br>Confirm in your wallet.');

    const result = await kit.bridge({
        from: { adapter, chain: chain.kitChain },
        to: {
            recipientAddress,
            chain: ARC_DEST_CHAIN,
            useForwarder: true,
        },
        amount,
        config: {
            transferSpeed: 'FAST',
        },
    });

    if (result && result.state === 'error') {
        const failed = Array.isArray(result.steps)
            ? result.steps.find((s) => s.state === 'error')
            : null;
        const detail = failed?.error || failed?.name || 'Bridge failed';
        throw new Error(typeof detail === 'string' ? detail : 'Bridge failed');
    }

    mark('approve', 'done');
    mark('burn', 'done');
    mark('mint', 'done');
    return result;
}

/**
 * Wire CCTP modal DOM already present in the paywall overlay.
 *
 * @param {object} deps
 * @param {() => string|null|undefined} deps.getRecipientAddress
 * @param {() => void} deps.onBridgeSubmitted  after kit returns success (start balance poll, etc.)
 * @param {(msg: string, isError?: boolean) => void} [deps.setFundStatus]
 */
export function wireCctpBridgeModal(deps) {
    const {
        getRecipientAddress,
        onBridgeSubmitted,
        setFundStatus,
    } = deps;

    let selectedChain = null;
    let bridgeGeneration = 0;
    let bridgeInFlight = false;

    const list = document.getElementById('arc-cctp-network-list');
    if (list && !list.dataset.cctpWired) {
        list.dataset.cctpWired = '1';
        CCTP_SOURCE_CHAINS.forEach((chain) => {
            const btn = document.createElement('button');
            btn.className = 'arc-network-btn';
            btn.dataset.chainId = String(chain.chainId);
            btn.innerHTML = `<span>${chain.name}</span>`;
            btn.addEventListener('click', () => {
                selectedChain = chain;
                document.querySelectorAll('.arc-network-btn').forEach((b) => {
                    b.classList.remove('arc-network-btn-selected');
                });
                btn.classList.add('arc-network-btn-selected');
                const bridgeBtn = document.getElementById('arc-cctp-bridge-btn');
                if (bridgeBtn) {
                    bridgeBtn.disabled = false;
                    bridgeBtn.textContent = `Bridge to Arc via ${chain.name}`;
                }
            });
            list.appendChild(btn);
        });
    }

    function resetCctpStepsUi() {
        const selectStep = document.getElementById('arc-cctp-step-select');
        const progressStep = document.getElementById('arc-cctp-step-progress');
        if (selectStep) selectStep.style.display = 'block';
        if (progressStep) progressStep.style.display = 'none';
        setStepStatus('arc-step-approve-status', '');
        setStepStatus('arc-step-burn-status', '');
        setStepStatus('arc-step-mint-status', '');
        setCctpProgress('');
    }

    function openCctpModal() {
        const modal = document.getElementById('arc-cctp-modal');
        if (modal) modal.style.display = 'flex';
    }

    function closeCctpModal() {
        // Always allow exit, even while Bridge Kit is still loading / hung on RPC.
        bridgeGeneration += 1;
        bridgeInFlight = false;
        resetCctpStepsUi();
        const modal = document.getElementById('arc-cctp-modal');
        if (modal) modal.style.display = 'none';
    }

    function toggleCctpInfo() {
        const popup = document.getElementById('arc-cctp-info-popup');
        if (!popup) return;
        popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
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

    async function onBridgeClick() {
        if (bridgeInFlight) return;
        if (!selectedChain) {
            alert('Select a source network first.');
            return;
        }

        const amountInput = document.getElementById('arc-cctp-amount');
        const amountFloat = amountInput ? parseFloat(amountInput.value) : NaN;
        const recipient = getRecipientAddress();

        const selectStep = document.getElementById('arc-cctp-step-select');
        const progressStep = document.getElementById('arc-cctp-step-progress');
        if (selectStep) selectStep.style.display = 'none';
        if (progressStep) progressStep.style.display = 'block';
        setStepStatus('arc-step-approve-status', '');
        setStepStatus('arc-step-burn-status', '');
        setStepStatus('arc-step-mint-status', '');
        setCctpProgress('Connecting wallet…');

        const generation = bridgeGeneration;
        bridgeInFlight = true;

        try {
            const result = await executeBridgeViaKit({
                chain: selectedChain,
                amountFloat,
                recipientAddress: recipient,
                onProgress: setCctpProgress,
                onStep: setStepStatus,
            });

            // User closed the modal while the kit was still running: ignore success side effects.
            if (generation !== bridgeGeneration) {
                console.log('[CCTP] Bridge finished after modal close; ignoring UI side effects.');
                return;
            }

            if (!result || result.state !== 'success') {
                throw new Error('Bridge did not complete successfully');
            }

            console.log('[CCTP] Bridge Kit result:', result?.state, result);
            closeCctpModal();

            const waiting = document.getElementById('arc-waiting-balance');
            if (waiting) waiting.style.display = 'flex';

            if (typeof onBridgeSubmitted === 'function') {
                onBridgeSubmitted(result);
            }
        } catch (error) {
            if (generation !== bridgeGeneration) return;
            console.error(
                '[Tessera] CCTP bridge error:',
                error && error.message ? error.message : error,
            );
            setCctpProgress('Error: ' + ((error && error.message) || 'Bridge failed. Please retry.'));
            if (typeof setFundStatus === 'function') {
                setFundStatus(
                    'Bridge error: ' + ((error && error.message) || 'Please retry.'),
                    true,
                );
            }
            resetCctpStepsUi();
        } finally {
            if (generation === bridgeGeneration) {
                bridgeInFlight = false;
            }
        }
    }

    const bridgeOpenBtn = document.getElementById('arc-bridge-btn');
    if (bridgeOpenBtn) bridgeOpenBtn.addEventListener('click', openCctpModal);

    const closeBtn = document.getElementById('arc-cctp-close');
    if (closeBtn) closeBtn.addEventListener('click', closeCctpModal);

    const modal = document.getElementById('arc-cctp-modal');
    if (modal && !modal.dataset.cctpBackdropClose) {
        modal.dataset.cctpBackdropClose = '1';
        modal.addEventListener('click', (event) => {
            if (event.target === modal) closeCctpModal();
        });
    }

    const infoBtn = document.getElementById('arc-cctp-info-btn');
    if (infoBtn) infoBtn.addEventListener('click', toggleCctpInfo);

    const bridgeBtn = document.getElementById('arc-cctp-bridge-btn');
    if (bridgeBtn) bridgeBtn.addEventListener('click', () => { void onBridgeClick(); });

    return { openCctpModal, closeCctpModal };
}
