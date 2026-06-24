import { randomBytes } from 'crypto';
import {
    encodeFunctionData,
    formatUnits,
    isAddress,
    maxUint256,
    pad,
    parseUnits,
    type Address,
    type Hex,
} from 'viem';

const GATEWAY_API_TESTNET = 'https://gateway-api-testnet.circle.com/v1';
const ARC_DOMAIN = 26;
const ARC_CHAIN_ID = 5042002;
const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as Address;
const GATEWAY_MINTER = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B' as Address;
const ARC_USDC = '0x3600000000000000000000000000000000000000' as Address;

const GATEWAY_MINTER_ABI = [{
    type: 'function',
    name: 'gatewayMint',
    stateMutability: 'nonpayable',
    inputs: [
        { name: 'attestation', type: 'bytes' },
        { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
}] as const;

export const BURN_INTENT_EIP712_TYPES = {
    EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
    ],
    TransferSpec: [
        { name: 'version', type: 'uint32' },
        { name: 'sourceDomain', type: 'uint32' },
        { name: 'destinationDomain', type: 'uint32' },
        { name: 'sourceContract', type: 'bytes32' },
        { name: 'destinationContract', type: 'bytes32' },
        { name: 'sourceToken', type: 'bytes32' },
        { name: 'destinationToken', type: 'bytes32' },
        { name: 'sourceDepositor', type: 'bytes32' },
        { name: 'destinationRecipient', type: 'bytes32' },
        { name: 'sourceSigner', type: 'bytes32' },
        { name: 'destinationCaller', type: 'bytes32' },
        { name: 'value', type: 'uint256' },
        { name: 'salt', type: 'bytes32' },
        { name: 'hookData', type: 'bytes' },
    ],
    BurnIntent: [
        { name: 'maxBlockHeight', type: 'uint256' },
        { name: 'maxFee', type: 'uint256' },
        { name: 'spec', type: 'TransferSpec' },
    ],
} as const;

export const BURN_INTENT_EIP712_DOMAIN = {
    name: 'GatewayWallet',
    version: '1',
} as const;

export interface CreatorGatewayBalance {
    formattedAvailable: string;
    formattedWithdrawable: string;
    formattedTotal: string;
}

export interface CreatorBurnIntent {
    maxBlockHeight: bigint;
    maxFee: bigint;
    spec: {
        version: number;
        sourceDomain: number;
        destinationDomain: number;
        sourceContract: Hex;
        destinationContract: Hex;
        sourceToken: Hex;
        destinationToken: Hex;
        sourceDepositor: Hex;
        destinationRecipient: Hex;
        sourceSigner: Hex;
        destinationCaller: Hex;
        value: bigint;
        salt: Hex;
        hookData: Hex;
    };
}

function addressToBytes32(addr: Address): Hex {
    return pad(addr.toLowerCase() as Address, { size: 32 });
}

function serializeBigInts(_key: string, value: unknown): unknown {
    return typeof value === 'bigint' ? value.toString() : value;
}

export function isValidEvmAddress(address: string): boolean {
    return isAddress(address);
}

export async function getCreatorGatewayBalance(address: Address): Promise<CreatorGatewayBalance> {
    const response = await fetch(`${GATEWAY_API_TESTNET}/balances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            token: 'USDC',
            sources: [{ depositor: address, domain: ARC_DOMAIN }],
        }),
    });

    const data = await response.json() as {
        message?: string;
        balances?: Array<{ balance?: string; withdrawable?: string; withdrawing?: string }>;
    };

    if (!response.ok) {
        throw new Error(data.message ?? `Gateway balance fetch failed (${response.status})`);
    }

    if (!data.balances?.length) {
        return {
            formattedAvailable: '0',
            formattedWithdrawable: '0',
            formattedTotal: '0',
        };
    }

    const balanceData = data.balances[0];
    const available = parseUnits(balanceData.balance ?? '0', 6);
    const withdrawing = parseUnits(balanceData.withdrawing ?? '0', 6);

    return {
        formattedAvailable: formatUnits(available, 6),
        formattedWithdrawable: formatUnits(parseUnits(balanceData.withdrawable ?? balanceData.balance ?? '0', 6), 6),
        formattedTotal: formatUnits(available + withdrawing, 6),
    };
}

export function createCreatorBurnIntent(
    creatorAddress: Address,
    amountUsdc: string,
    recipient?: Address,
): { burnIntent: CreatorBurnIntent; formattedAmount: string } {
    const withdrawAmount = parseUnits(amountUsdc, 6);
    const maxFee = parseUnits('2.01', 6);
    const targetRecipient = recipient ?? creatorAddress;

    const burnIntent: CreatorBurnIntent = {
        maxBlockHeight: maxUint256,
        maxFee,
        spec: {
            version: 1,
            sourceDomain: ARC_DOMAIN,
            destinationDomain: ARC_DOMAIN,
            sourceContract: addressToBytes32(GATEWAY_WALLET),
            destinationContract: addressToBytes32(GATEWAY_MINTER),
            sourceToken: addressToBytes32(ARC_USDC),
            destinationToken: addressToBytes32(ARC_USDC),
            sourceDepositor: addressToBytes32(creatorAddress),
            destinationRecipient: addressToBytes32(targetRecipient),
            sourceSigner: addressToBytes32(creatorAddress),
            destinationCaller: addressToBytes32('0x0000000000000000000000000000000000000000'),
            value: withdrawAmount,
            salt: `0x${randomBytes(32).toString('hex')}` as Hex,
            hookData: '0x',
        },
    };

    return { burnIntent, formattedAmount: amountUsdc };
}

export async function submitCreatorWithdraw(
    burnIntent: CreatorBurnIntent,
    signature: Hex,
): Promise<{ attestation: Hex; operatorSignature: Hex; transferId?: string }> {
    const response = await fetch(`${GATEWAY_API_TESTNET}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ burnIntent, signature }], serializeBigInts),
    });

    const result = await response.json() as {
        success?: boolean;
        error?: string;
        message?: string;
        attestation?: Hex;
        signature?: Hex;
        transferId?: string;
    };

    if (!response.ok || result.success === false || result.error || !result.attestation || !result.signature) {
        throw new Error(result.message ?? result.error ?? 'Gateway transfer attestation failed');
    }

    return {
        attestation: result.attestation,
        operatorSignature: result.signature,
        transferId: result.transferId,
    };
}

export function buildGatewayMintTransaction(attestation: Hex, operatorSignature: Hex) {
    const data = encodeFunctionData({
        abi: GATEWAY_MINTER_ABI,
        functionName: 'gatewayMint',
        args: [attestation, operatorSignature],
    });

    return {
        chainId: `0x${ARC_CHAIN_ID.toString(16)}`,
        to: GATEWAY_MINTER,
        data,
        value: '0x0',
    };
}
