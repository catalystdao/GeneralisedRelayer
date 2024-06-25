import { BountyStatus } from './bounty.enum';

export type AmbMessage = {
    messageIdentifier: string;
    amb: string;
    sourceChain: string;
    destinationChain: string;
    sourceEscrow: string;
    payload: string; // This is specifically Generalised Incentive payload.
    recoveryContext?: string; // Normally we would listen for the proofs but sometimes we might miss or somethings goes wrong. If this field is set, then it can be used to recover the tx. The encoding scheme depends entirely on the amb.
    priority?: boolean;
    blockNumber?: number;               // The block number as returned by the rpc.
    transactionBlockNumber?: number;    // The block number as seen by the transaction.
    blockHash?: string;
    transactionHash?: string;
};

export type AmbPayload = {
    messageIdentifier: string;
    amb: string;
    destinationChainId: string;
    message: string;
    messageCtx?: string;
    priority?: boolean;
};

export type PrioritiseMessage = {
    messageIdentifier: string;
    amb: string;
    sourceChainId: string;
    destinationChainId: string;
};

export type Bounty = {
    messageIdentifier: string;
    fromChainId: string;
    toChainId?: string;
    maxGasDelivery: number;
    maxGasAck: number;
    refundGasTo: string;
    priceOfDeliveryGas: bigint;
    priceOfAckGas: bigint;
    targetDelta: bigint;
    status: BountyStatus;
    sourceAddress: string;
    destinationAddress?: string;
    finalised?: boolean;
    submitTransactionHash?: string;
    execTransactionHash?: string;
    ackTransactionHash?: string;
    deliveryGasCost?: bigint;
};

export type BountyJson = {
    messageIdentifier: string;
    fromChainId?: string;
    toChainId?: string;
    maxGasDelivery?: number;
    maxGasAck?: number;
    refundGasTo?: string;
    priceOfDeliveryGas?: string;
    priceOfAckGas?: string;
    targetDelta?: string;
    status: BountyStatus;
    sourceAddress?: string;
    destinationAddress?: string;
    finalised?: boolean;
    submitTransactionHash?: string;
    execTransactionHash?: string;
    ackTransactionHash?: string;
    deliveryGasCost?: string;
};
