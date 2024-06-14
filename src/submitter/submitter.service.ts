import { Injectable } from '@nestjs/common';
import { join } from 'path';
import { Worker, MessagePort } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { ChainConfig } from 'src/config/config.types';
import { LoggerService } from 'src/logger/logger.service';
import { LoggerOptions } from 'pino';
import { WalletService } from 'src/wallet/wallet.service';
import { Wallet } from 'ethers6';
import { tryErrorToString } from 'src/common/utils';

const RETRY_INTERVAL_DEFAULT = 30000;
const PROCESSING_INTERVAL_DEFAULT = 100;
const MAX_TRIES_DEFAULT = 3;
const MAX_PENDING_TRANSACTIONS = 50;
const NEW_ORDERS_DELAY_DEFAULT = 0;

interface GlobalSubmitterConfig {
    enabled: boolean;
    newOrdersDelay: number;
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    gasLimitBuffer: Record<string, number> & { default?: number };
    walletPublicKey: string;
}

export interface SubmitterWorkerData {
    chainId: string;
    rpc: string;
    relayerPrivateKey: string;
    incentivesAddresses: Map<string, string>;
    packetCosts: Map<string, bigint>;
    newOrdersDelay: number;
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    gasLimitBuffer: Record<string, number>;
    walletPublicKey: string;
    walletPort: MessagePort;
    loggerOptions: LoggerOptions;
}

@Injectable()
export class SubmitterService {
    private readonly workers = new Map<string, Worker>();

    constructor(
        private readonly configService: ConfigService,
        private readonly walletService: WalletService,
        private readonly loggerService: LoggerService,
    ) {}

    async onModuleInit(): Promise<void> {
        this.loggerService.info(`Starting the submitter on all chains...`);

        const globalSubmitterConfig = this.loadGlobalSubmitterConfig();

        // check if the submitter has been disabled.
        if (!globalSubmitterConfig.enabled) {
            this.loggerService.info(`Submitter has been disabled. Ending init early`);
            return;
        }

        // Initialize the submitter states
        for (const [, chainConfig] of this.configService.chainsConfig) {
            // Load the worker chain override config or set the defaults if missing
            const workerData = await this.loadWorkerData(
                chainConfig,
                globalSubmitterConfig,
            );

            const worker = new Worker(join(__dirname, 'submitter.worker.js'), {
                workerData,
                transferList: [workerData.walletPort]
            });

            worker.on('error', (error) =>
                this.loggerService.fatal(
                    { error: tryErrorToString(error), chainId: chainConfig.chainId },
                    `Error on submitter worker.`,
                ),
            );

            worker.on('exit', (exitCode) =>
                this.loggerService.fatal(
                    { exitCode, chainId: chainConfig.chainId },
                    `Submitter worker exited.`,
                ),
            );

            this.workers.set(chainConfig.chainId, worker);
        }

        // Add a small delay to wait for the workers to be initialized
        //TODO the following should not be delay-based.
        await new Promise((r) => setTimeout(r, 5000));
    }

    private loadGlobalSubmitterConfig(): GlobalSubmitterConfig {
        const submitterConfig = this.configService.globalConfig.submitter;

        const enabled = submitterConfig['enabled'] ?? true;

        const newOrdersDelay =
            submitterConfig.newOrdersDelay ?? NEW_ORDERS_DELAY_DEFAULT;
        const retryInterval =
            submitterConfig.retryInterval ?? RETRY_INTERVAL_DEFAULT;
        const processingInterval =
            submitterConfig.processingInterval ?? PROCESSING_INTERVAL_DEFAULT;
        const maxTries = submitterConfig.maxTries ?? MAX_TRIES_DEFAULT;
        const maxPendingTransactions =
            submitterConfig.maxPendingTransactions ?? MAX_PENDING_TRANSACTIONS;

        const gasLimitBuffer = submitterConfig.gasLimitBuffer ?? {};
        if (!('default' in gasLimitBuffer)) {
            gasLimitBuffer['default'] = 0;
        }

        const walletPublicKey = (new Wallet(this.configService.globalConfig.privateKey)).address;

        return {
            enabled,
            newOrdersDelay,
            retryInterval,
            processingInterval,
            maxTries,
            maxPendingTransactions,
            gasLimitBuffer,
            walletPublicKey,
        };
    }

    private async loadWorkerData(
        chainConfig: ChainConfig,
        globalConfig: GlobalSubmitterConfig,
    ): Promise<SubmitterWorkerData> {
        const chainId = chainConfig.chainId;
        const rpc = chainConfig.rpc;
        const relayerPrivateKey = this.configService.globalConfig.privateKey;

        const incentivesAddresses = new Map<string, string>();
        this.configService.ambsConfig.forEach((amb) => {
            const incentiveAddress = amb.getIncentivesAddress(chainConfig.chainId);
            if (incentiveAddress != undefined) {
                incentivesAddresses.set(
                    amb.name,
                    amb.getIncentivesAddress(chainConfig.chainId),
                );
            }
        });

        const packetCosts = new Map<string, bigint>();
        this.configService.ambsConfig.forEach((amb) => {
            const packetCost: string = this.configService.getAMBConfig(
                amb.name,
                'packetCost',
                chainConfig.chainId
            );
            if (packetCost != undefined) {
                packetCosts.set(
                    amb.name,
                    BigInt(packetCost), //TODO add log error if this fails
                );
            }
        });

        return {
            chainId,
            rpc,
            relayerPrivateKey,
            incentivesAddresses,
            packetCosts,

            newOrdersDelay:
                chainConfig.submitter.newOrdersDelay ?? globalConfig.newOrdersDelay,

            retryInterval:
                chainConfig.submitter.retryInterval ?? globalConfig.retryInterval,

            processingInterval:
                chainConfig.submitter.processingInterval ??
                globalConfig.processingInterval,

            maxTries: chainConfig.submitter.maxTries ?? globalConfig.maxTries,

            maxPendingTransactions:
                chainConfig.submitter.maxPendingTransactions ??
                globalConfig.maxPendingTransactions,

            gasLimitBuffer: this.getChainGasLimitBufferConfig(
                globalConfig.gasLimitBuffer,
                chainConfig.submitter.gasLimitBuffer ?? {},
            ),

            walletPublicKey: globalConfig.walletPublicKey,
            walletPort: await this.walletService.attachToWallet(chainId),
            loggerOptions: this.loggerService.loggerOptions,
        };
    }

    private getChainGasLimitBufferConfig(
        defaultGasLimitBufferConfig: Record<string, number>,
        chainGasLimitBufferConfig: Record<string, number>,
    ): Record<string, number> {
        const gasLimitBuffers: Record<string, number> = {};

        // Apply defaults
        for (const key in defaultGasLimitBufferConfig) {
            gasLimitBuffers[key] = defaultGasLimitBufferConfig[key]!;
        }

        // Apply chain overrides
        for (const key in chainGasLimitBufferConfig) {
            gasLimitBuffers[key] = chainGasLimitBufferConfig[key]!;
        }

        return gasLimitBuffers;
    }
}
