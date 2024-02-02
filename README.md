# Generalised Relayer

The Generalised Relayer is built to act as a relayer for Arbitrary Message Bridges (AMBs) using the [Generalised Incentives](https://github.com/catalystdao/GeneralisedIncentives) scheme. 

The goal for the Generalised Relayer is 2 fold:

1. Acts as a reference implementation of a relayer that understands [Generalised Incentives](https://github.com/catalystdao/GeneralisedIncentives).
2. Lower the barrier to entry resulting in greater competition which will improve relaying speed, robustness, and resistance to censorship.

Currently, the Relayer supports the following AMBs:

- Wormhole

It also supports a 'Mock' AMB implementation that operates with signed messages (see the [Generalised Incentives](https://github.com/catalystdao/GeneralisedIncentives) repository for more information).

## Dependencies
Aside from the npm packages specified within `package.json`, the Generalised Relayer relies on the following dependencies:
- Redis

> ℹ️ There is no need to manually install/run any dependencies when running the Relayer with Docker.
## Relayer Configuration

The Relayer configuration is split into 2 distinct files.
> ⚠️ The Relayer will not run without the following configuration files.

### 1. Main configuration `.yaml` file
Most of the Relayer configuration is specified within a `.yaml` file located at the project's root directory. The configuration file must be named using the `config.{$NODE_ENV}.yaml` format according to the environment variable `NODE_ENV` of the runtime (e.g. on a production machine where `NODE_ENV=production`, the configuration file must be named `config.production.yaml`).

> The `NODE_ENV` variable should ideally be set on the shell configuration file (i.e. `.bashrc` or equivalent), but may also be set by prepending it to the launch command, e.g. `NODE_ENV=production docker compose up`. For more information see the [Node documentation](https://nodejs.org/en/learn/getting-started/nodejs-the-difference-between-development-and-production).

The `.yaml` configuration file is divided into the following sections:
- `relayer`: Defines the global relayer configuration.
    - The `privateKey` of the account that will submit the relay transactions on all chains must be defined at this point. 
    - Default configuration for the `getter` and `submitter` can also be specified at this point.
- `ambs`: The AMBs that are enabled.
- `chains`: Defines the configuration for each of the chains to be supported by the relayer.
    - This includes the `chainId` and the `rpc` to be used for the chain.
    - Each chain may override the global `getter` and `submitter` configurations (those defined under the global `relayer` configuration), and `amb` configurations.
- `$ambName`: AMB specific configuration can be specified under the name of the AMB. Every AMB configuration must have at least the address of the Generalised Incentives contract that implements the AMB (`incentivesAddress`) at this point, or otherwise within the chain-specific AMB configuration (under `chains -> $ambName -> incentivesAddress`).

> ℹ️ For a full reference of the configuration file, see `config.example.yaml`.

### 2. Environment variables `.env` file
Ports and docker specific configuration is set on a `.env` file within the project's root directory. This includes the `COMPOSE_PROFILES` environment variable which defines the docker services to enable (e.g. to enable the `docker-compose.yaml` services tagged with the `wormhole` profile set `COMPOSE_PROFILES=wormhole`).
> ℹ️ See `.env.example` for the required environment variables.

## Running the relayer
### Option A: Using Docker
The simplest way to run the relayer is via `docker compose` (refer to the [Docker documentation](https://docs.docker.com/) for installation instructions). Run the Relayer with:

```bash
docker compose up [-d]
```
The `-d` option detaches the process to the background.

### Option B: Manual operation
Install the required dependencies with:

```bash
yarn install
```
- **NOTE**: The `devDependencies` are required to build the project. If running on a production machine where `NODE_ENV=production`, use `yarn install --prod=false` 

Initiate a Redis database with:
```bash
docker container run -p 6379:6379 redis
```
- This command sets `6379` as the port for Redis communication. Make sure this port is correctly set on the `.env` configuration file.

Build and start the Relayer with:
```bash
yarn start
```

For further insight into the requirements for running the Relayer see the `docker-compose.yaml` file.

## Relayer Structure

The Relayer is devided into 4 main services: `Getter`, `Evaluator`, `Collector`, and `Submitter`. These services work together to get the *GeneralisedIncentives* message bounties, evaluate their value, collect the message proofs, and submit them on the destination chain. The services are run in parallel and communicate using Redis. Wherever it makes sense, chains are allocated seperate workers to ensure a chain fault doesn't propagate and impact the performance on other chains.

### Getter

The Getter service is responsible for fetching on-chain bounties and messages. It works by searching for relevant EVM events triggered by the *GeneralisedIncentives* contract:

- `BountyPlaced`: Signals that a message has been sent and contains the associated relaying incentives.
- `MessageDelivered`: Signals that a message has been relayed from the source chain to the destination chain (event published on the destination chain).
- `BountyClaimed`: Signals that a message has been relayed from the destination chain to the source chain, and the bounty has been distributed.
- `BountyIncreased`: Signals that the associated relaying incentive has been updated.

The incentive information gathered with these events is sent to the common Redis database for later use by the other services.

### Evaluator

The Evaluator takes in messages along with their incentive parameters to estimate if it is worth relaying them. It exposes a method which is called on the submittor for evaluations.
> ⚠️ The Evaluator is not implemented yet. Currently, simple evaluation logic is written within the Submitter.

### Collector

The Collector service collects the information to relay the cross-chain messages directly from the various AMB's, as for example the AMB's proofs. Every proof collected is sent to the Submitter via Redis to request the relay of the packet.

### Submitter

The Submitter service gets packets that need relaying from Redis. For every packet received, the submitter:
1. Gets the associated bounty information (i.e. the relaying incentive) from Redis.
2. Simulates the transaction to get a gas estimate.
3. Evaluates whether the relaying bounty covers the gas cost of the packet submission.
4. Submits the packet if the evaluation is successful using the [processPacket](https://github.com/catalystdao/GeneralisedIncentives/blob/903891f4acdf514eb558767d9a3d431dd627ce5b/src/IncentivizedMessageEscrow.sol#L238) method of the IncentivizedMessageEscrow contract.
5. Confirms that the submission transaction is mined.

To make the Submitter as resilitent as possible to RPC failures/connection errors, each evaluation, submission and confirmation step is tried up to `maxTries` times with a `retryInterval` delay between tries (these default to `3` and `2000` ms, but can be modified on the Relayer config).

The Submitter additionally limits the maximum number of transactions within the 'submission' pipeline (i.e. transactions that have been started to be processed and are not completed), and will not accept any further relay orders once reached. If a submitted transactions fails to commit within the number of specified tries and timeout, the Submitter will attempt to cancel the transaction.
> ⚠️ If the Submitter fails to cancel a transaction, the Submitter pipeline will stall and no further orders will be processed until the stuck transaction is resolved.

## Further features

### Automatic transaction pricing
The Relayer has the ability to automatically set the relay transactions gas pricing.
#### EIP-1559 transactions
- The `maxFeePerGas` configuration sets the transaction `maxFeePerGas` property. This defines the maximum fee to be paid per gas for a transaction (including both the base fee and the miner fee). If not set, no `maxFeePerGas` is set on the transaction.
- The `maxPriorityFeeAdjustmentFactor` determines the amount by which to modify the queried recommended `maxPriorityFee` from the rpc. If not set, no `maxPriorityFee` is set on the transaction.
- The `maxAllowedPriorityFeePerGas` sets the maximum value that `maxPriorityFee` may be set to (after applying the `maxPriorityFeeAdjustmentFactor`).

#### Legacy transaction
- The `gasPriceAdjustmentFactor` determines the amount by which to modify the queried recommended `gasPrice` from the rpc. If not set, no `gasPrice` is set on the transaction.
- The `maxAllowedGasPrice` sets the maximum value that `gasPrice` may be set to (after applying the `gasPriceAdjustmentFactor`).

> ⚠️ If the above gas configuration is not specified, the transactions will be submitted using the `ethers`/rpc defaults.

#### Transaction repricing
If a transaction does not mine in time (`maxTries * (confirmationTimeout + retryInterval)` approximately), the Relayer will attempt to reprice the transaction by resubmitting the transaction with higher gas price values. The gas prices are adjusted according to the `priorityAdjustmentFactor` configuration. If not set, it defaults to `1.1` (i.e +10%).

### Low balance warning
The Relayer keeps an estimate of the Relayer account gas balance for each chain. A warning is emitted to the logs if the gas balance falls below a configurable threshold `lowBalanceWarning` (in Wei).

### The `Store` library
The distinct services of the Relayer communicate with each other using a Redis database. To abstract the Redis implementation away, a helper library, `store.lib.ts`, is provided. 

### Integration with other services
The Relayer makes available a `getAMBs` endpoint with which an external service may query the AMB messages corresponding to a transaction hash.

### Persister
> TODO

## Development

### Adding an AMB

In order to add support for a new AMB, a new service folder under [`collector/`](https://github.com/catalystdao/GeneralisedRelayer/blob/main/src/collector) named after the AMB must be added, within which the service file, also named after the AMB, must define the service that collects the AMB proofs. The collector service must send the collected AMB data to Redis using the `submitProof` helper of the `store/store.lib.ts` library.
> ⚠️ The Collector service must not block the main event loop in any manner (e.g. make use of [worker threads](https://nodejs.org/api/worker_threads.html)). See the [Mock collector](https://github.com/catalystdao/GeneralisedRelayer/blob/main/src/collector/mock/mock.ts) implementation for further reference.

The AMB configuration must be added to the `.yaml` configuration file under the AMB name. This configuration will be automatically passed to the service once it is instantiated by the main Collector controller (see [here](https://github.com/catalystdao/GeneralisedRelayer/blob/425df37cecb13c7f1ad83ce9addbf278638cd0d2/src/collector/collector.controller.ts#L39)).


It is recommended to update the `docker-compose.yaml` file with any image/service that is required by the AMB to have a completely standalone implementation when running the Relayer with Docker.
> ℹ️ It is also recommended to add a new Docker Compose profile for any image/service added to the `docker-compose.yaml` file so that it can be disabled at the user's will.

> ℹ️ Update `config.example.yaml` with the new AMB details for future reference.


### Using the Mock implementation
The mock implementation is proof-of-authentication (PoA) scheme which works well for developing and testing. To use it, deploy a [Mock Generalised Incentive](https://github.com/catalystdao/GeneralisedIncentives/tree/main/src/apps/mock) implementation using a known key. Then set the key in the Mock AMB config and run the Relayer.

### Typechain Types
The Relayer uses `ethers` types for the contracts that it interacts with (e.g. the Generalised Incentives contract). These types are generated with the `typechain` package using the contract *abis* (under the `abis/` folder) upon installation of the `npm` packages. If the contract *abis* change the types must be regenerated (see the `postinstall` script on `package.json`).