import { BigNumber } from 'ethers';
import { Redis } from 'ioredis';

import { BountyStatus } from 'src/store/types/bounty.enum';
import { AmbMessage, Bounty, BountyJson } from 'src/store/types/store.types';

// Monkey patch BigInt. https://github.com/GoogleChromeLabs/jsbi/issues/30#issuecomment-1006086291
(BigNumber.prototype as any).toJSON = function () {
  return this.toString();
};

const redis_port = 6379;
const DB_INDEX = 4;

//---------- STORE LAYOUT ----------//
// The redis store is used for 2 things:
// 1. Storing bounty information.
// 2. pub/sub for communication between workers.

// For the storage, bounties are stored against their messageIdentifier.

// For pub/sub, below are a list of the channels being used:
// 'submit-<chainid>': { messageIdentifier, destinationChain, message, messageCtx, priority? }
// 'amb': { messageIdentifier, destinationChain, payload }
// 'key': { key, action}

// Below is a list of general todos on this library.
// TODO: add chainId to the index.
// TODO: Carify storage types: Move Bounty type here?
// TODO: Fix cases where bounty doesn't exist.

export class Store {
  readonly redis: Redis;
  // When a redis connection is used to listen for subscriptions, it cannot be
  // used for anything except to modify the subscription set which is being listened
  // to. As a result, we need a dedicated connection if we ever decide to listen to
  // subscriptions.
  redisSubscriptions: Redis | undefined;

  readonly host: string | undefined;

  static readonly relayerStorePrefix: string = 'relayer';
  static readonly bountyMidfix: string = 'bounty';
  static readonly ambMidfix: string = 'amb';
  static readonly proofMidfix: string = 'proof';
  static readonly wordConnecter: string = ':';

  readonly chainId: string | null;

  // If chainId is set to null, this should only be used for reading.
  constructor(chainId: string | null = null) {
    this.chainId = chainId;
    this.host = process.env.USE_DOCKER ? 'redis' : undefined;
    this.redis = new Redis(redis_port, {
      db: DB_INDEX,
      host: this.host,
    });
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }

  // ----- Translation -----

  async scan(callback: (key: string) => void) {
    const stream = this.redis.scanStream({
      match: `${Store.relayerStorePrefix}:*`,
    });

    stream.on('data', (keys) => {
      for (const key of keys) {
        callback(key);
      }
    });
  }

  async get(key: string) {
    return this.redis.get(key);
  }

  async set(key: string, value: string) {
    // We want to notify a potential subscribed that there has been a change to this key.
    // Lets set the key first.
    await this.redis.set(key, value);
    // Then post that message.
    await this.postMessage('key', { key, action: 'set' });
  }

  async del(key: string) {
    await this.redis.del(key);
    await this.postMessage('key', { key, action: 'del' });
  }

  // ----- Subscriptions ------

  /**
   * @notice Use this function to get a redis connection for any subscriptions.
   * This is because when a SUBSCRIBE calls goes out to redis, the connection can
   * only be used to modify the subscriptions or receive them. As a result, any
   * redis.get or redis.set or redis.del does not work.
   */
  getOrOpenSubscription(): Redis {
    if (!this.redisSubscriptions) {
      this.redisSubscriptions = new Redis(redis_port, {
        db: DB_INDEX,
        host: this.host,
      });
    }
    return this.redisSubscriptions;
  }

  static getChannel(channel: string, describer: string): string {
    return Store.combineString(channel, describer);
  }

  static combineString(...vals: string[]): string {
    return vals.join(Store.wordConnecter);
  }

  async postMessage(channel: string, payload: { [key: string]: any }) {
    return this.redis.publish(
      Store.combineString(Store.relayerStorePrefix, channel),
      JSON.stringify(payload),
    );
  }

  on(channel: string, callback: (payload: { [key: string]: any }) => void) {
    const redisSubscriptions = this.getOrOpenSubscription();
    // Subscribe to the channel so that we get messages.
    const channelWithprefix = Store.combineString(
      Store.relayerStorePrefix,
      channel,
    );
    redisSubscriptions.subscribe(channelWithprefix);
    // Set the callback when we receive messages function.
    redisSubscriptions.on('message', (redis_channel, redis_message) => {
      if (redis_channel === channelWithprefix)
        callback(JSON.parse(redis_message));
    });
  }

  // ----- Bounties ------

  //TODO also filter by chain?
  async getBounty(messageIdentifier: string): Promise<Bounty | null> {
    const query: string | null = await this.redis.get(
      Store.combineString(
        Store.relayerStorePrefix,
        Store.bountyMidfix,
        messageIdentifier,
      ),
    );
    const bounty: Bounty | null =
      query === null ? undefined : JSON.parse(query);
    if (
      bounty != null &&
      bounty.priceOfDeliveryGas &&
      bounty.priceOfAckGas &&
      bounty.targetDelta
    ) {
      bounty.priceOfDeliveryGas = BigNumber.from(bounty.priceOfDeliveryGas);
      bounty.priceOfAckGas = BigNumber.from(bounty.priceOfAckGas);
      bounty.targetDelta = BigNumber.from(bounty.targetDelta);
    } else {
      // TODO: handle this case better.
      return null;
    }
    return bounty;
  }

  /**
   * @dev This is generally assumed to be the first time that a bounty is ever seen.
   * However, we also wanna be able to run the relayer in a way where registerBountyPlaced might be called
   * AFTER it has already been stored. (say the relayer is rerun from scratch on an already populated redis store)
   */
  async registerBountyPlaced(event: {
    messageIdentifier: string;
    incentive: any;
    incentivesAddress: string;
    transactionHash: string;
  }) {
    const chainId = this.chainId;
    if (chainId === null)
      throw new Error('ChainId is not set: This connection is readonly');
    const messageIdentifier = event.messageIdentifier;
    const incentive = event.incentive;
    const address = event.incentivesAddress;

    let bounty: Bounty = {
      messageIdentifier: messageIdentifier,
      fromChainId: chainId,
      maxGasDelivery: incentive.maxGasDelivery,
      maxGasAck: incentive.maxGasAck,
      refundGasTo: incentive.refundGasTo,
      priceOfDeliveryGas: incentive.priceOfDeliveryGas,
      priceOfAckGas: incentive.priceOfAckGas,
      targetDelta: incentive.targetDelta,
      status: BountyStatus.BountyPlaced,
      address,
      finalised: false,
      submitTransactionHash: event.transactionHash,
    };

    //TODO evaluate bounty

    // TODO: Also set key for the AMB being used.
    const key = Store.combineString(
      Store.relayerStorePrefix,
      Store.bountyMidfix,
      messageIdentifier,
    );

    // Check if there exists an object already here.
    const existingValue = await this.get(key);
    if (existingValue) {
      // There are 2 ways for there to already be a key here.
      // 1. The key was set by another event on another chain because the origin chain is too slow / we missed the event.
      // 2. We are going over blocks again and hit this event. Either way, we should set the key again but not modify anything which could have
      // been entered or modified.
      // As a result, fill out the bounty but override the bounty information by anything which might already be present.
      bounty = {
        ...bounty, // Init the dictionary with the bounty.
        ...JSON.parse(existingValue), // Then overwrite with anything that is already stored.
      };
    }
    await this.set(key, JSON.stringify(bounty));
  }

  /**
   * @dev This is generally assumed to be the first time the event is seen and the second time that a bounty is seen.
   * However, we also wanna be able to run the relayer in a way where the event is seen for the second time AND/OR
   * it is the first time the bounty has been seen.
   */
  async registerMessageDelivered(event: {
    messageIdentifier: string;
    incentivesAddress: string;
    transactionHash: string;
  }) {
    const chainId = this.chainId;
    if (chainId === null)
      throw new Error('ChainId is not set: This connection is readonly');
    const messageIdentifier = event.messageIdentifier;

    // Lets get the bounty.
    // TODO: Also set key for the AMB being used.
    const key = Store.combineString(
      Store.relayerStorePrefix,
      Store.bountyMidfix,
      messageIdentifier,
    );
    const existingValue = await this.redis.get(key);
    if (!existingValue) {
      // Then we need to create some kind of baseline with the information we know.
      const bounty = {
        messageIdentifier: messageIdentifier, // we know the ID. The ID isn't going to change.
        status: BountyStatus.MessageDelivered, // Well, we know the the message has now been delivered.
        execTransactionHash: event.transactionHash,
        toChainId: this.chainId,
      };
      // We can set this value now.
      return this.set(key, JSON.stringify(bounty));
    }
    // Okay, we know a bounty exists at this value. Lets try to update it without destorying any information.
    const bountyAsRead: BountyJson = JSON.parse(existingValue);
    const bounty = {
      ...bountyAsRead,
      status: Math.max(bountyAsRead.status, BountyStatus.MessageDelivered),
      execTransactionHash: event.transactionHash,
      toChainId: this.chainId,
    };
    await this.set(key, JSON.stringify(bounty));
  }

  /**
   * @dev This is generally assumed to be the first time the event is seen and the third time that a bounty is seen.
   * However, we also wanna be able to run the relayer in a way where the event is seen for the second time AND/OR
   * it is the first time the bounty has been seen.
   */
  async registerBountyClaimed(event: {
    messageIdentifier: string;
    incentivesAddress: string;
    transactionHash: string;
  }) {
    const chainId = this.chainId;
    if (chainId === null)
      throw new Error('ChainId is not set: This connection is readonly');
    const messageIdentifier = event.messageIdentifier;

    // Lets get the bounty.
    // TODO: Also set key for the AMB being used.
    const key = Store.combineString(
      Store.relayerStorePrefix,
      Store.bountyMidfix,
      messageIdentifier,
    );
    const existingValue = await this.redis.get(key);
    if (!existingValue) {
      // Then we need to create some kind of baseline with the information we know.
      const bounty = {
        messageIdentifier: messageIdentifier, // we know the ID. The ID isn't going to change.
        // TODO: We technically also know the chainid, do we want to set?
        status: BountyStatus.BountyClaimed, // Well, we know the the message has now been delivered.
        ackTransactionHash: event.transactionHash,
        fromChainId: this.chainId,
      };
      // We can set this value now.
      return this.set(key, JSON.stringify(bounty));
    }
    // Okay, we know a bounty exists at this value. Lets try to update it without destorying any information.
    const bountyAsRead: BountyJson = JSON.parse(existingValue);
    const bounty = {
      ...bountyAsRead,
      status: Math.max(BountyStatus.BountyClaimed, bountyAsRead.status),
      ackTransactionHash: event.transactionHash,
      fromChainId: this.chainId,
    };
    await this.set(key, JSON.stringify(bounty));
  }

  /**
   * @dev This is STRICTLY assumed to be the second time that a bounty is seen.
   * This function cannot handle the case where it is the first time that the bounty is seen.
   */
  async registerBountyIncreased(event: {
    messageIdentifier: string;
    newDeliveryGasPrice: BigNumber;
    newAckGasPrice: BigNumber;
    incentivesAddress: string;
    transactionHash: string;
  }) {
    const chainId = this.chainId;
    if (chainId === null)
      throw new Error('ChainId is not set: This connection is readonly');
    const messageIdentifier = event.messageIdentifier;
    const newDeliveryGasPrice: BigNumber = event.newDeliveryGasPrice;
    const newAckGasPrice: BigNumber = event.newAckGasPrice;

    // Lets get the bounty.
    // TODO: Also set key for the AMB being used.
    const key = Store.combineString(
      Store.relayerStorePrefix,
      Store.bountyMidfix,
      messageIdentifier,
    );
    const existingValue = await this.redis.get(key);
    if (!existingValue) {
      // Then we need to create some kind of baseline with the information we know.
      const bounty = {
        messageIdentifier: messageIdentifier, // we know the ID. The ID isn't going to change.
        priceOfDeliveryGas: newDeliveryGasPrice,
        priceOfAckGas: newAckGasPrice,
      };
      // We can set this value now.
      return this.set(key, JSON.stringify(bounty));
    }
    // We know a bounty exists at this value.
    const bountyAsRead: BountyJson = JSON.parse(existingValue);
    // Lets check if there exists values for it, otherwise set to 0. Remember, these are stored as strings.
    const currentDeliveryGasPrice = BigNumber.from(
      bountyAsRead.priceOfDeliveryGas ?? '0',
    );
    const currentAckGasPrice = BigNumber.from(
      bountyAsRead.priceOfAckGas ?? '0',
    );
    // Otherwise we need to check get the maximums of current and observed new values.
    const hasDeliveryGasPriceIncreased =
      currentDeliveryGasPrice.lt(newDeliveryGasPrice);
    const hasAckGasPriceIncreased = currentAckGasPrice.lt(newAckGasPrice);
    const hasChanged = hasDeliveryGasPriceIncreased || hasAckGasPriceIncreased;
    // If hasChanged is false, then we don't need to do anything.
    if (hasChanged) {
      const newBounty = {
        ...bountyAsRead,
        priceOfDeliveryGas: hasDeliveryGasPriceIncreased
          ? newDeliveryGasPrice
          : currentDeliveryGasPrice,
        priceOfAckGas: hasAckGasPriceIncreased
          ? newAckGasPrice
          : currentAckGasPrice,
      };

      //TODO evaluate

      await this.set(key, JSON.stringify(newBounty));
    }
  }

  // ----- AMB ------

  async getAmb(swapIdentifier: string): Promise<AmbMessage | null> {
    const query: string | null = await this.redis.get(
      Store.combineString(
        Store.relayerStorePrefix,
        Store.ambMidfix,
        swapIdentifier,
      ),
    );
    const amb: AmbMessage | null =
      query === null ? undefined : JSON.parse(query);

    return amb;
  }

  async setAmb(amb: AmbMessage): Promise<void> {
    const key = Store.combineString(
      Store.relayerStorePrefix,
      Store.ambMidfix,
      amb.messageIdentifier,
    );
    return this.set(key, JSON.stringify(amb));
  }
}
