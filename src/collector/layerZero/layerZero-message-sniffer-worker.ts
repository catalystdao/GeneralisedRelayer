import pino, { LoggerOptions } from 'pino';
import {
    LayerZeroEnpointV2,
    LayerZeroEnpointV2__factory,
} from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { workerData, MessagePort } from 'worker_threads';
import { tryErrorToString, wait } from '../../common/utils';
import { AbiCoder, JsonRpcProvider, Log, ethers, zeroPadValue } from 'ethers6';
import { MonitorInterface, MonitorStatus } from 'src/monitor/monitor.interface';
import { Resolver, loadResolver } from 'src/resolvers/resolver';
import { LayerZeroWorkerData } from './layerZero';
import { arrayify } from 'ethers/lib/utils';
import { LayerZeroEnpointV2Interface } from 'src/contracts/LayerZeroEnpointV2';



const defaultAbiCoder = AbiCoder.defaultAbiCoder();
type GARPDecodedMessage = {
  context: string; // Context of the message, returned as a hexadecimal string
  messageIdentifier: string; // Unique identifier of the message, as a hex string
  sender: string; // Ethereum address of the sender
  destination: string; // Ethereum address of the destination
  payload: string; // The actual message content as a string
};
class SendMessageSnifferWorker {
  
    private readonly store: Store;
    private readonly logger: pino.Logger;
    private readonly endpointAddress: string;
    private readonly filterTopics: string[][];
    private readonly config: LayerZeroWorkerData;

    private readonly provider: JsonRpcProvider;

    private readonly chainId: string;
    private readonly layerZeroEnpointV2: LayerZeroEnpointV2;
    private readonly layerZeroEnpointV2Interface: LayerZeroEnpointV2Interface;

    private readonly resolver: Resolver;

    private currentStatus: MonitorStatus | null = null;
    private monitor: MonitorInterface;

    constructor() {
        this.config = workerData as LayerZeroWorkerData;

        this.chainId = this.config.chainId;

        this.store = new Store(this.chainId);
        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );
        this.provider = this.initializeProvider(this.config.rpc);
        this.resolver = this.loadResolver(
            this.config.resolver,
            this.provider,
            this.logger,
        );

        this.layerZeroEnpointV2 = this.initializeLayerZeroEndpointContract(
            this.config.endpointAddress,
            this.provider,
        );
        this.endpointAddress = this.config.endpointAddress;
        this.layerZeroEnpointV2Interface = LayerZeroEnpointV2__factory.createInterface();
        this.filterTopics = [
            [
                this.layerZeroEnpointV2Interface.getEvent('PacketSent').topicHash,
                zeroPadValue(this.endpointAddress, 32),
            ],
        ];

        this.monitor = this.startListeningToMonitor(this.config.monitorPort);
    }

    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(
        chainId: string,
        loggerOptions: LoggerOptions,
    ): pino.Logger {
        return pino(loggerOptions).child({
            worker: 'collector-layerzero-message-sniffer',
            chain: chainId,
        });
    }

    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
    }

    private loadResolver(
        resolver: string | null,
        provider: JsonRpcProvider,
        logger: pino.Logger,
    ): Resolver {
        return loadResolver(resolver, provider, logger);
    }

    private initializeLayerZeroEndpointContract(
        endpointAddress: string,
        provider: JsonRpcProvider,
    ): LayerZeroEnpointV2 {
        return LayerZeroEnpointV2__factory.connect(endpointAddress, provider);
    }


    private startListeningToMonitor(port: MessagePort): MonitorInterface {
        const monitor = new MonitorInterface(port);

        monitor.addListener((status: MonitorStatus) => {
            this.currentStatus = status;
        });

        return monitor;
    }

    // Main handler
    // ********************************************************************************************
    async run(): Promise<void> {
        this.logger.info(
            { endpointAddress: this.config.endpointAddress },
            `Layer Zero Message Sniffer Worker started.`,
        );

        let fromBlock = null;
        this.logger.info('Initializing fromBlock...');
        while (fromBlock == null) {
            this.logger.info('Waiting for currentStatus to be set...');
            if (this.currentStatus != null) {
                this.logger.info('Current status is not null. Setting fromBlock...');
                fromBlock = this.config.startingBlock ?? this.currentStatus.blockNumber;
                this.logger.info(`fromBlock set to ${fromBlock}`);
            } else {
                this.logger.info('Current status is still null.');
            }
            await wait(this.config.processingInterval);
        }
        this.logger.info('fromBlock initialized.');

        const stopBlock = this.config.stoppingBlock ?? Infinity;
        this.logger.info(`Stop block set to ${stopBlock}`);

        while (true) {
            try {
                let toBlock = this.currentStatus?.blockNumber;
                if (!toBlock || fromBlock > toBlock) {
                    await wait(this.config.processingInterval);
                    continue;
                }
    
                if (toBlock > stopBlock) {
                    toBlock = stopBlock;
                }
    
                const blocksToProcess = toBlock - fromBlock;
                if (this.config.maxBlocks != null && blocksToProcess > this.config.maxBlocks) {
                    toBlock = fromBlock + this.config.maxBlocks;
                }
    
                this.logger.info(
                    {
                        fromBlock,
                        toBlock,
                    },
                    `Scanning LayerZero Endpoint messages.`,
                );
    
                await this.queryAndProcessEvents(fromBlock, toBlock);
              
    
                if (toBlock >= stopBlock) {
                    this.logger.info(
                        { stopBlock: toBlock },
                        `Finished processing blocks. Exiting worker.`,
                    );
                    break;
                }
    
                fromBlock = toBlock + 1;
            } catch (error) {
                this.logger.error(error, `Error on Layer Zero worker`);
                await wait(this.config.retryInterval);
            }
    
            await wait(this.config.processingInterval);
        }
    
        // Cleanup worker
        this.monitor.close();
        await this.store.quit();
    }

    private async queryAndProcessEvents(fromBlock: number, toBlock: number): Promise<void> {
        const logs = await this.queryLogs(fromBlock, toBlock);
        console.info(logs);
        for (const log of logs) {
            try {
                await this.handleLogPacketSentEvent(log);
            } catch (error) {
                this.logger.error(
                    { log, error },
                    'Failed to process LogPacketSentEvent on Layer Zero Message Sniffer Worker.',
                );
            }
        }
    }
    
    private async queryLogs(fromBlock: number, toBlock: number): Promise<Log[]> {
        const filter = {
            address: this.endpointAddress,
            topics: this.filterTopics,
            fromBlock,
            toBlock,
        };
        let logs: Log[] | undefined;
        let i = 0;
        while (logs === undefined) {
            try {
                logs = await this.provider.getLogs(filter);
            } catch (error) {
                i++;
                this.logger.warn(
                    { ...filter, error: tryErrorToString(error), try: i },
                    `Failed to 'getLogs' on Layer Zero Message Sniffer Worker. Worker blocked until successful query.`,
                );
                await wait(this.config.retryInterval);
            }
        }
        return logs;
    }
    
    

    private async handleLogPacketSentEvent(log: Log): Promise<void> {
        try {
            const decodedLog = new ethers.Interface([
                'event PacketSent(bytes encodedPacket, bytes options, address sendLibrary)',
            ]).parseLog(log);
    
            if (decodedLog !== null) {
                const encodedPacket = decodedLog.args['encodedPacket'];
                const options = decodedLog.args['options'];
                const sendLibrary = decodedLog.args['sendLibrary'];
    
                // Decode the packet details
                const packet = this.decodePacket(encodedPacket);
                const decodedMessage = await decodeMessageWithContext(packet.message);
    
                this.logger.info(
                    {
                        transactionHash: log.transactionHash,
                        packet,
                        options,
                        sendLibrary,
                    },
                    'PacketSent event processed.',
                );
    
                if (packet.sender === this.config.incentivesAddress) {
                    this.logger.info(
                        {
                            sender: packet.sender,
                            message: packet.message,
                        },
                        'Processing packet from specific sender.',
                    );
    
                    const transactionBlockNumber = await this.resolver.getTransactionBlockNumber(
                        log.blockNumber,
                    );
    
                    // Create the initial AMB message
                    await this.store.setAmb(
                        {
                            messageIdentifier: decodedMessage.messageIdentifier,
                            amb: 'LayerZero',
                            sourceChain: packet.srcEid,
                            destinationChain: packet.dstEid,
                            sourceEscrow: packet.sender,
                            payload: decodedMessage.payload,
                            recoveryContext: decodedMessage.context,
                            blockNumber: log.blockNumber,
                            transactionBlockNumber,
                            blockHash: log.blockHash,
                            transactionHash: log.transactionHash,
                        },
                        log.transactionHash,
                    );
    
                    // Calculate payload hash
                    const payloadHash = this.calculatePayloadHash(packet.guid, packet.message);
    
                    // Create the secondary AMB message using setPayloadLayerZeroAmb
                    await this.store.setPayloadLayerZeroAmb(
                        payloadHash,
                        {
                            messageIdentifier: decodedMessage.messageIdentifier,
                            amb: 'LayerZero',
                            sourceChain: packet.srcEid,
                            destinationChain: packet.dstEid,
                            sourceEscrow: packet.sender,
                            payload: decodedMessage.payload,
                            recoveryContext: decodedMessage.context,
                            blockNumber: log.blockNumber,
                            transactionBlockNumber,
                            blockHash: log.blockHash,
                            transactionHash: log.transactionHash,
                        }
                    );
    
                    this.logger.info(
                        {
                            payloadHash,
                            transactionHash: log.transactionHash,
                        },
                        'Secondary AMB message created with payload hash as key using setPayloadLayerZeroAmb.',
                    );
                }
            }
        } catch (error) {
            this.logger.error(
                {
                    error: tryErrorToString(error),
                    log,
                },
                'Error processing PacketSent event.',
            );
        }
    }
    
    
    private calculatePayloadHash(guid: string, message: string): string {
        const payload = defaultAbiCoder.encode(['bytes32', 'bytes'], [guid, message]);
        return ethers.keccak256(payload);
    }
    

    // Helper function to decode the packet data
    private decodePacket(encodedPacket: string): any {
        const decodedBytes = arrayify(encodedPacket);
        const decoded = defaultAbiCoder.decode(
            ['uint64', 'uint32', 'address', 'uint32', 'address', 'bytes32', 'bytes'],
            decodedBytes,
        );
        return {
            nonce: decoded[0],
            srcEid: decoded[1],
            sender: ethers.getAddress(decoded[2]),
            dstEid: decoded[3],
            receiver: ethers.getAddress(decoded[4]),
            guid: decoded[5],
            message: decoded[6],
        };
    }
    /**
   * Decodes a message with context from a given encoded string.
   * 
   * @param {string} encodedMessage - The encoded message as a hex string.
   * @returns {GARPDecodedMessage} - The decoded message components.
   */
  
}
async function decodeMessageWithContext(
    encodedMessage: string,
): Promise<GARPDecodedMessage> {
    // Convert the encoded message string to a byte array
    const messageBytes = arrayify(encodedMessage);

    // Decode parts of the message
    const context = messageBytes[0] || ''; // First byte for context
    const messageIdentifier = ethers.hexlify(messageBytes.slice(1, 33)); // Next 32 bytes for message identifier
    const sender = ethers.getAddress(ethers.hexlify(messageBytes.slice(33, 53))); // Next 20 bytes for sender address
    const destination = ethers.getAddress(
        ethers.hexlify(messageBytes.slice(53, 73)),
    ); // Next 20 bytes for destination address
    const payload = ethers.toUtf8String(messageBytes.slice(73)); // Remaining bytes for message payload

    return {
        context: context.toString(16), // Convert context byte to hex string
        messageIdentifier,
        sender,
        destination,
        payload,
    };
}
void new SendMessageSnifferWorker().run();
