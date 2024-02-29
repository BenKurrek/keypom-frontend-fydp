import {
  getDropInformation,
  getEnv,
  initKeypom,
  type ProtocolReturnedDrop,
  updateKeypomContractId,
  getFTMetadata,
  claim,
  getKeyInformation,
  hashPassword,
  getPubFromSecret,
  formatNearAmount,
  formatLinkdropUrl,
  generateKeys,
  getKeyInformationBatch,
  getKeySupplyForDrop,
  deleteKeys,
  getKeysForDrop,
  deleteDrops,
  getDropSupplyForOwner,
  getDrops,
  type ProtocolReturnedKeyInfo,
} from 'keypom-js';
import * as nearAPI from 'near-api-js';

import { truncateAddress } from '@/utils/truncateAddress';
import { CLOUDFLARE_IPFS, DROP_TYPE, MASTER_KEY } from '@/constants/common';
import getConfig from '@/config/config';
import { get } from '@/utils/localStorage';

import { type EventDropMetadata, isValidEventInfo, isValidTicketInfo } from './eventsHelpers';

let instance: KeypomJS;
const ACCOUNT_ID_REGEX = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const networkId = process.env.REACT_APP_NETWORK_ID ?? 'testnet';
const eventsContract = '1709145182592-kp-ticketing.testnet';

const myKeyStore = new nearAPI.keyStores.BrowserLocalStorageKeyStore();
const config = getConfig();

const connectionConfig = {
  networkId,
  keyStore: myKeyStore,
  nodeUrl: config.nodeUrl,
  walletUrl: config.walletUrl,
  helperUrl: config.helperUrl,
  explorerUrl: config.explorerUrl,
};

export interface EventDrop {
  drop_id: string;
  funder_id: string;
  drop_config: {
    metadata: string;
  };
}

export interface DropKeyItem {
  id: number;
  publicKey: string;
  link: string;
  slug: string;
  hasClaimed: boolean;
  keyInfo: ProtocolReturnedKeyInfo | undefined;
}

export interface AttendeeKeyItem {
  drop_id: string;
  pub_key: string;
  owner_id: string;
  metadata: string;
  uses_remaining: number;
  message_nonce: number;
}

const KEY_ITEMS_PER_QUERY = 30;
const DROP_ITEMS_PER_QUERY = 5;
class KeypomJS {
  static instance: KeypomJS;
  nearConnection: nearAPI.Near;
  viewAccount: nearAPI.Account;

  // Events
  totalEventDrops: number;
  // Maps the event ID to an array of EventDrops
  eventsStore: Record<string, EventDrop[]> = {};
  eventDrops: EventDrop[];
  eventById: Record<string, string> = {};
  eventsKeyStore: Record<
    string,
    {
      dropName: string;
      totalKeys: number;
      dropKeyItems: AttendeeKeyItem[];
    }
  > = {};

  // Drops
  totalDrops: number;
  dropStore: Record<string, ProtocolReturnedDrop[]> = {};
  keyStore: Record<
    string,
    {
      dropName: string;
      totalKeys: number;
      dropKeyItems: DropKeyItem[];
    }
  > = {};

  constructor() {
    if (instance !== undefined) {
      throw new Error('New instance cannot be created!!');
    }
  }

  async init() {
    await initKeypom({ network: networkId });
    this.nearConnection = await nearAPI.connect(connectionConfig);
    this.viewAccount = await this.nearConnection.account(config.contractId);
  }

  public static getInstance(): KeypomJS {
    if (!KeypomJS.instance) {
      KeypomJS.instance = new KeypomJS();
    }

    return KeypomJS.instance;
  }

  yoctoToNear = (yocto: string) => nearAPI.utils.format.formatNearAmount(yocto, 4);

  viewCall = async ({ contractId = eventsContract, methodName, args }) => {
    console.log('calling view function', contractId, methodName, args); // eslint-disable-line no-console
    return await this.viewAccount.viewFunctionV2({
      contractId,
      methodName,
      args,
    });
  };

  validateAccountId = async (accountId: string) => {
    if (!(accountId.length >= 2 && accountId.length <= 64 && ACCOUNT_ID_REGEX.test(accountId))) {
      throw new Error('Account Id is invalid');
    }

    try {
      const account = await this.nearConnection.account(accountId);
      await account.state();
    } catch (err) {
      throw new Error('Account Id does not exist');
    }
    return true;
  };

  verifyDrop = async (contractId: string, secretKey: string) => {
    const { networkId, supportedKeypomContracts } = getEnv();

    if (
      supportedKeypomContracts === undefined ||
      networkId === undefined ||
      contractId === undefined
    ) {
      throw new Error('Please supply supportedKeypomContracts, networkId and contractId');
    }

    if (supportedKeypomContracts[networkId][contractId] === undefined) {
      throw new Error("Linkdrop is invalid and isn't officially supported by Keypom contract.");
    }

    updateKeypomContractId({ keypomContractId: contractId });
  };

  getCurrentKeyUse = async (contractId: string, secretKey: string) => {
    await this.verifyDrop(contractId, secretKey);

    const keyInfo = await getKeyInformation({ secretKey });

    if (keyInfo === null || keyInfo === undefined) {
      throw new Error('Drop has been deleted or has already been claimed');
    }

    return keyInfo.cur_key_use;
  };

  checkIfDropExists = async (secretKey: string) => {
    try {
      await this.getDropInfo({ secretKey });
      return true;
    } catch (err) {
      return false;
    }
  };

  claimTicket = async (secretKey: string, password: string) => {
    let keyInfo = await getKeyInformation({ secretKey });
    const publicKey: string = getPubFromSecret(secretKey);
    const passwordForClaim = await hashPassword(
      password + publicKey + keyInfo.cur_key_use.toString(),
    );

    try {
      await claim({ secretKey, password: passwordForClaim, accountId: 'foo' });
    } catch (e) {
      console.warn(e);
    }

    keyInfo = await getKeyInformation({ secretKey });
    if (keyInfo.remaining_uses === 2) {
      throw new Error('Password is incorrect. Please try again.');
    }
  };

  // valid contract id -> v1-3.keypom.testnet
  // getEnv check for contractid validity
  // updateKeypomContractId
  // getDropInformation
  // check drop type
  /*
    ft -> Tokens
    fc -> Ticket (3 method calls)
    fc -> NFT (1 method call)
    simple -> simple drop?
  */
  getLinkdropType = async (drop: ProtocolReturnedDrop, contractId: string, secretKey: string) => {
    await this.verifyDrop(contractId, secretKey);
    return this.getDropType(drop);
  };

  getDropType = (drop: ProtocolReturnedDrop) => {
    if (drop.fc === undefined && drop.nft === undefined) {
      return DROP_TYPE.TOKEN;
    }

    if (drop.fc !== undefined) {
      if (drop.fc.methods.length === 3) {
        return DROP_TYPE.TICKET;
      }

      if (
        drop.fc.methods.length === 1 &&
        drop.fc.methods[0] !== undefined &&
        drop.fc.methods[0] !== null &&
        drop.fc.methods[0][0].method_name === 'nft_mint'
      ) {
        return DROP_TYPE.NFT;
      }
    }

    return DROP_TYPE.OTHER;
  };

  // Utility function to fetch drops for a specific page index
  async fetchDropsPage(accountId, pageIndex) {
    return await getDrops({
      accountId,
      start: pageIndex * DROP_ITEMS_PER_QUERY,
      limit: DROP_ITEMS_PER_QUERY,
      withKeys: false,
    });
  }

  // Main function to get drops, with caching logic for paginated values
  getAllDrops = async ({ accountId }: { accountId: string }) => {
    try {
      // If totalDrops is not known, fetch it
      if (!this.totalDrops) {
        this.totalDrops = await getDropSupplyForOwner({ accountId });
      }

      // Initialize the cache for this account if it doesn't exist
      if (!this.dropStore[accountId]) {
        this.dropStore[accountId] = [];
      }

      if (this.dropStore[accountId].length >= this.totalDrops) {
        return this.dropStore[accountId];
      }

      const totalQueries = Math.ceil(this.totalDrops / DROP_ITEMS_PER_QUERY);
      const pageIndices = Array.from({ length: totalQueries }, (_, index) => index);

      const allPagesDrops = await Promise.all(
        pageIndices.map(
          async (pageIndex) =>
            await getDrops({
              accountId,
              start: pageIndex * DROP_ITEMS_PER_QUERY,
              limit: DROP_ITEMS_PER_QUERY,
              withKeys: false,
            }),
        ),
      );
      this.dropStore[accountId] = allPagesDrops.flat();

      return this.dropStore[accountId];
    } catch (error) {
      console.error('Error fetching drops:', error);
      throw new Error('Failed to fetch drops.');
    }
  };

  groupDropsByEvent = (drops) => {
    const eventDrops = drops.filter((drop) => {
      const metadata = JSON.parse(drop.drop_config.metadata);
      return metadata.eventInfo !== undefined;
    });
    this.eventDrops = eventDrops;

    const eventById = {};
    for (const eventDrop of eventDrops) {
      const metadata = JSON.parse(eventDrop.drop_config.metadata);
      eventById[metadata.eventInfo.id] = eventDrop.drop_id;
    }
    this.eventById = eventById;

    const groupedByEventId = {};
    drops.forEach((drop) => {
      const metadata = JSON.parse(drop.drop_config.metadata);
      const { eventId } = metadata.ticketInfo;
      const dropId = eventById[eventId];
      if (!Object.hasOwn(groupedByEventId, dropId)) {
        groupedByEventId[dropId] = [];
      }
      groupedByEventId[dropId].push(drop); // Pushing parsed metadata instead of drop
    });
    this.eventsStore = groupedByEventId;
  };

  getKeySupplyForTicket = async (dropId: string) => {
    return await this.viewCall({
      contractId: eventsContract,
      methodName: 'get_key_supply_for_drop',
      args: { drop_id: dropId },
    });
  };

  getEventDrop = async ({
    accountId,
    eventId,
  }: {
    accountId: string;
    eventId: string;
  }): Promise<{ drop_config: { metadata: string } }> => {
    if (!Object.hasOwn(this.eventById, eventId)) {
      await this.getAllEventDrops({ accountId });
    }

    const dropId = this.eventById[eventId];
    return await this.viewCall({
      contractId: eventsContract,
      methodName: 'get_drop_information',
      args: { drop_id: dropId },
    });
  };

  getTicketsForEvent = async ({ accountId, eventId }: { accountId: string; eventId: string }) => {
    if (Object.hasOwn(this.eventById, eventId)) {
      const dropId = this.eventById[eventId];
      if (Object.hasOwn(this.eventsStore, dropId)) {
        return this.eventsStore[dropId];
      }
    }

    await this.getAllEventDrops({ accountId });
    return this.eventsStore[this.eventById[eventId]];
  };

  getAllEventDrops = async ({ accountId }: { accountId: string }) => {
    console.log('fetching all event drops: ', accountId); // eslint-disable-line no-console
    try {
      if (this.eventDrops?.length > 0) {
        return this.eventDrops;
      }

      // If totalDrops is not known, fetch it
      if (!this.totalEventDrops) {
        this.totalEventDrops = await this.viewCall({
          contractId: eventsContract,
          methodName: 'get_drop_supply_for_funder',
          args: { account_id: accountId },
        });
      }

      // Initialize the cache for this account if it doesn't exist
      if (Object.keys(this.eventsStore).length === 0) {
        this.eventsStore = {};
      }

      const totalQueries = Math.ceil(this.totalEventDrops / DROP_ITEMS_PER_QUERY);
      const pageIndices = Array.from({ length: totalQueries }, (_, index) => index);

      const allPagesDrops = await Promise.all(
        pageIndices.map(
          async (pageIndex) =>
            await this.viewCall({
              contractId: eventsContract,
              methodName: 'get_drops_for_funder',
              args: {
                account_id: accountId,
                from_index: (pageIndex * DROP_ITEMS_PER_QUERY).toString(),
                limit: DROP_ITEMS_PER_QUERY,
              },
            }),
        ),
      );

      let allDrops = allPagesDrops.flat(); // Assuming allPagesDrops is already defined and flattened.
      allDrops = allDrops.filter((drop) => {
        if (!drop.drop_id || !drop.funder_id || !drop.drop_config || !drop.drop_config.metadata) {
          return false; // Drop does not have the required top-level structure
        }

        try {
          const metadata = JSON.parse(drop.drop_config.metadata);

          // Check if metadata has required properties
          if (!metadata.dropName || !metadata.ticketInfo) {
            return false; // Metadata does not have required properties
          }

          // If there's eventInfo, optionally check its validity
          if (metadata.eventInfo && !isValidEventInfo(metadata.eventInfo)) {
            return false; // EventInfo is present but invalid
          }

          // Check ticketInfo's structure
          if (!isValidTicketInfo(metadata.ticketInfo)) {
            return false; // TicketInfo is invalid
          }

          return true; // Drop passes all checks
        } catch (e) {
          // JSON.parse failed, metadata is not a valid JSON string
          return false;
        }
      });

      this.groupDropsByEvent(allDrops);

      return this.eventDrops;
    } catch (error) {
      console.error('Error fetching drops:', error);
      throw new Error('Failed to fetch drops.');
    }
  };

  async getAllKeysForTicket({ dropId }) {
    try {
      const dropInfo = await this.viewCall({
        methodName: 'get_drop_information',
        args: { drop_id: dropId },
      });
      const meta: EventDropMetadata = JSON.parse(dropInfo.drop_config.metadata);
      const dropName = meta.dropName;
      const totalKeys = dropInfo.next_key_id;
      if (
        !Object.hasOwn(this.eventsKeyStore, dropId) ||
        this.eventsKeyStore[dropId]?.totalKeys !== totalKeys
      ) {
        // Initialize the cache for this drop
        this.eventsKeyStore[dropId] = {
          dropName,
          dropKeyItems: new Array(totalKeys).fill(null),
          totalKeys,
        };

        // Define how many batches are needed based on KEY_ITEMS_PER_QUERY
        const totalBatches = Math.ceil(totalKeys / KEY_ITEMS_PER_QUERY);
        const batchPromises: Array<Promise<AttendeeKeyItem[]>> = [];

        for (let i = 0; i < totalBatches; i++) {
          const start = i * KEY_ITEMS_PER_QUERY;
          const limit = Math.min(KEY_ITEMS_PER_QUERY, totalKeys - start);

          batchPromises.push(
            this.viewCall({
              methodName: 'get_keys_for_drop',
              args: { drop_id: dropId, from_index: start.toString(), limit },
            }),
          );
        }

        // Wait for all batches to resolve and process the results
        const batchResults = await Promise.all(batchPromises);
        this.eventsKeyStore[dropId].dropKeyItems = batchResults.flat(); // Use .flat()
      }

      return this.eventsKeyStore[dropId];
    } catch (error) {
      console.error('Failed to get keys info:', error);
      throw new Error('Failed to get keys info.');
    }
  }

  getPaginatedKeysForTicket = async ({
    dropId,
    start,
    limit,
  }: {
    dropId: string;
    start: number;
    limit: number;
  }) => {
    try {
      // Initialize or update the cache for this drop if it doesn't exist or if total keys have changed
      const dropInfo = await this.viewCall({
        methodName: 'get_drop_information',
        args: { drop_id: dropId },
      });
      const meta: EventDropMetadata = JSON.parse(dropInfo.drop_config.metadata);
      const dropName = meta.dropName;
      const totalKeys = dropInfo.next_key_id;

      if (
        !Object.hasOwn(this.eventsKeyStore, dropId) ||
        this.eventsKeyStore[dropId]?.totalKeys !== totalKeys
      ) {
        this.eventsKeyStore[dropId] = {
          dropName,
          dropKeyItems: new Array(totalKeys).fill(null),
          totalKeys,
        };
      }

      // Calculate the end index for the requested keys
      const endIndex = Math.min(start + limit, this.eventsKeyStore[dropId].totalKeys);

      // Fetch and cache only the needed batches
      for (let i = start; i < endIndex; i += KEY_ITEMS_PER_QUERY) {
        const batchStart = i;
        const batchEnd = Math.min(i + KEY_ITEMS_PER_QUERY, endIndex);
        if (
          this.eventsKeyStore[dropId].dropKeyItems
            .slice(batchStart, batchEnd)
            .some((item) => item === null)
        ) {
          // If any item in the range is null, fetch the batch
          const fetchedKeys = await this.viewCall({
            methodName: 'get_keys_for_drop',
            args: {
              drop_id: dropId,
              from_index: batchStart.toString(),
              limit: batchEnd - batchStart,
            },
          });
          // Assume fetchedKeys is an array of keys; adjust based on actual structure
          for (let j = 0; j < fetchedKeys.length; j++) {
            this.eventsKeyStore[dropId].dropKeyItems[batchStart + j] = fetchedKeys[j];
          }
        }
      }

      // Return the requested slice from the cache
      return this.eventsKeyStore[dropId].dropKeyItems.slice(start, endIndex);
    } catch (e) {
      console.error('Failed to get paginated keys info:', e);
      throw new Error('Failed to get paginated keys info.');
    }
  };

  // Main function to get drops, with caching logic for paginated values
  getPaginatedDrops = async ({
    accountId,
    start,
    limit,
  }: {
    accountId: string;
    start: number;
    limit: number;
  }) => {
    try {
      // If totalDrops is not known, fetch it
      if (!this.totalDrops) {
        this.totalDrops = await getDropSupplyForOwner({ accountId });
      }

      // Initialize the cache for this account if it doesn't exist
      if (!this.dropStore[accountId]) {
        this.dropStore[accountId] = [];
      }

      // Calculate the end index and the page index for start and end
      const endIndex = start + limit;
      const startPageIndex = Math.floor(start / DROP_ITEMS_PER_QUERY);
      const endPageIndex = Math.ceil(endIndex / DROP_ITEMS_PER_QUERY);

      // Fetch and cache pages as needed
      for (let pageIndex = startPageIndex; pageIndex < endPageIndex; pageIndex++) {
        const pageStart = pageIndex * DROP_ITEMS_PER_QUERY;

        // Only fetch if this page hasn't been cached yet
        if (!this.dropStore[accountId][pageStart]) {
          console.log('cache miss for: ', pageStart); // eslint-disable-line no-console
          const pageDrops = await this.fetchDropsPage(accountId, pageIndex);

          // Cache each item from the page with its index as the key
          pageDrops.forEach((drop, index) => {
            this.dropStore[accountId][pageStart + index] = drop;
          });
        }
      }

      // Return the requested slice from the cache
      return this.dropStore[accountId].slice(start, endIndex);
    } catch (error) {
      console.error('Error fetching drops:', error);
      throw new Error('Failed to fetch drops.');
    }
  };

  getDropSupplyForOwner = async ({ accountId }) => await getDropSupplyForOwner({ accountId });

  getDropMetadata = (metadata: string | undefined) => {
    const parsedObj = JSON.parse(metadata || '{}');
    if (Object.hasOwn(parsedObj, 'drop_name')) {
      parsedObj.dropName = parsedObj.drop_name;
    }

    if (!Object.hasOwn(parsedObj, 'dropName')) {
      parsedObj.dropName = 'Untitled';
    }
    return parsedObj;
  };

  getDropData = async ({
    drop,
    dropId,
  }: {
    drop?: ProtocolReturnedDrop;
    dropId?: string | number;
  }) => {
    if (drop === undefined && dropId === undefined) {
      throw new Error('drop or dropId must be provided.');
    }

    if (dropId !== undefined) {
      drop = await this.getDropInfo({ dropId: dropId.toString() });
    }
    const { drop_id: id, metadata, next_key_id: totalKeys } = drop!;
    const claimedKeys = await this.getAvailableKeys(id);
    const claimedText = `${totalKeys - claimedKeys} / ${totalKeys}`;

    const { dropName } = this.getDropMetadata(metadata);

    let type: string | null = '';
    try {
      type = this.getDropType(drop!);
    } catch (_) {
      type = DROP_TYPE.OTHER;
    }

    let nftHref: string | undefined;
    if (type === DROP_TYPE.NFT) {
      let nftMetadata = {
        media: '',
        title: '',
        description: '',
      };
      try {
        const fcMethods = drop!.fc?.methods;
        if (
          fcMethods === undefined ||
          fcMethods.length === 0 ||
          fcMethods[0] === undefined ||
          fcMethods[0][0] === undefined
        ) {
          throw new Error('Unable to retrieve function calls.');
        }

        const { nftData } = await this.getNFTorTokensMetadata(fcMethods[0][0], drop!.drop_id);

        nftMetadata = {
          media: `${CLOUDFLARE_IPFS}/${nftData?.metadata?.media}`, // eslint-disable-line
          title: nftData?.metadata?.title,
          description: nftData?.metadata?.description,
        };
      } catch (e) {
        console.error('failed to get nft metadata', e); // eslint-disable-line no-console
      }
      nftHref = nftMetadata?.media || 'assets/image-not-found.png';
    }

    return {
      id,
      name: truncateAddress(dropName, 'end', 48),
      type: type !== 'NFT' ? type?.toLowerCase() : type,
      media: nftHref,
      claimed: claimedText,
    };
  };

  deleteDrops = async ({ wallet, dropIds }) => await deleteDrops({ wallet, dropIds });

  deleteKeys = async ({ wallet, dropId, publicKeys }) =>
    await deleteKeys({ wallet, dropId, publicKeys });

  getDropInfo = async ({
    dropId,
    secretKey,
  }: {
    dropId?: string;
    secretKey?: string;
  }): Promise<ProtocolReturnedDrop> => {
    let drop: ProtocolReturnedDrop;

    if (!dropId && !secretKey) {
      throw new Error('dropId or secretKey must be provided.');
    }

    try {
      drop = await getDropInformation({ dropId, secretKey });
    } catch (err) {
      throw new Error('Unable to claim. This drop may have been claimed before.');
    }

    return drop;
  };

  getAvailableKeys = async (dropId: string) => await getKeySupplyForDrop({ dropId });

  getKeysForDrop = async ({ dropId, limit, start }) =>
    await getKeysForDrop({ dropId, limit, start });

  getLinksToExport = async (dropId) => {
    const drop = await this.getDropInfo({ dropId });
    const { secretKeys } = await generateKeys({
      numKeys: drop.next_key_id,
      rootEntropy: `${get(MASTER_KEY) as string}-${dropId as string}`,
      autoMetaNonceStart: 0,
    });

    const links = secretKeys.map(
      (key, i) =>
        `${window.location.origin}/claim/${getConfig().contractId}#${key.replace('ed25519:', '')}`,
    );

    return links;
  };

  // Utility function to fetch a batch of key information
  fetchKeyBatch = async (dropId: string, start: number, limit: number) => {
    const { publicKeys, secretKeys } = await generateKeys({
      numKeys: limit,
      rootEntropy: `${get(MASTER_KEY) as string}-${dropId}`,
      autoMetaNonceStart: start,
    });

    const keyInfos = await getKeyInformationBatch({ publicKeys });

    const dropKeyItems: DropKeyItem[] = [];
    keyInfos.forEach((info, index) => {
      const keyIndex = start + index;
      this.keyStore[dropId].dropKeyItems[keyIndex] = {
        id: keyIndex,
        link: `${window.location.origin}/claim/${getConfig().contractId}#${secretKeys[
          index
        ].replace('ed25519:', '')}`,
        slug: secretKeys[index].substring(8, 16),
        publicKey: publicKeys[index],
        hasClaimed: info === null, // Assuming the info contains data to determine this
        keyInfo: info,
      };
    });

    return dropKeyItems;
  };

  async getAllKeysInfo({ dropId }) {
    try {
      const dropInfo = await this.getDropInfo({ dropId });
      const dropName = this.getDropMetadata(dropInfo.metadata).dropName;
      const totalKeys = dropInfo.next_key_id;
      if (
        !this.keyStore[dropId] ||
        (this.keyStore[dropId] && this.keyStore[dropId].totalKeys !== totalKeys)
      ) {
        // Initialize the cache for this drop
        this.keyStore[dropId] = {
          dropName,
          dropKeyItems: new Array(totalKeys).fill(null),
          totalKeys,
        };

        // Define how many batches are needed based on KEY_ITEMS_PER_QUERY
        const totalBatches = Math.ceil(totalKeys / KEY_ITEMS_PER_QUERY);
        const batchPromises: Array<Promise<DropKeyItem[]>> = [];

        for (let i = 0; i < totalBatches; i++) {
          const start = i * KEY_ITEMS_PER_QUERY;
          const limit = Math.min(KEY_ITEMS_PER_QUERY, totalKeys - start);

          batchPromises.push(this.fetchKeyBatch(dropId, start, limit));
        }

        // Wait for all batches to resolve
        await Promise.all(batchPromises);
      }

      return this.keyStore[dropId];
    } catch (error) {
      console.error('Failed to get keys info:', error);
      throw new Error('Failed to get keys info.');
    }
  }

  // Main function to get key info, with caching logic for paginated values
  getPaginatedKeysInfo = async ({
    dropId,
    start,
    limit,
  }: {
    dropId: string;
    start: number;
    limit: number;
  }) => {
    try {
      // Initialize the cache for this drop if it doesn't exist
      if (!this.keyStore[dropId]) {
        const dropInfo = await this.getDropInfo({ dropId });
        const dropName = this.getDropMetadata(dropInfo.metadata).dropName;
        const totalKeys = dropInfo.next_key_id;

        this.keyStore[dropId] = {
          dropName,
          dropKeyItems: Array(totalKeys).fill(null), // Initialize with nulls
          totalKeys,
        };
      }

      // Calculate the end index
      const endIndex = Math.min(start + limit, this.keyStore[dropId].totalKeys);

      // Fetch and cache batches as needed
      for (let i = start; i < endIndex; i += KEY_ITEMS_PER_QUERY) {
        if (!this.keyStore[dropId].dropKeyItems[i]) {
          // Fetch the keys for this batch
          const batchLimit = Math.min(KEY_ITEMS_PER_QUERY, endIndex - i);
          await this.fetchKeyBatch(dropId, i, batchLimit);
        }
      }

      // Return the requested slice from the cache
      return this.keyStore[dropId].dropKeyItems.slice(start, endIndex);
    } catch (e) {
      console.error('Failed to get keys info:', e);
      throw new Error('Failed to get keys info.');
    }
  };

  generateExternalWalletLink = async (
    walletName: string,
    contractId: string,
    secretKey: string,
  ) => {
    // verify the drop first
    try {
      await this.getDropInfo({ secretKey });
    } catch (err) {
      console.error(err);
      throw new Error('This drop has been claimed.');
    }

    // generate the link to navigate to
    const urls = formatLinkdropUrl({
      claimPage: walletName,
      contractId,
      secretKeys: [secretKey],
    });

    return urls[0];
  };

  getTokenClaimInformation = async (contractId: string, secretKey: string) => {
    const drop = await this.getDropInfo({ secretKey });

    // verify if secretKey is a token drop
    const linkdropType = await this.getLinkdropType(drop, contractId, secretKey);
    if (linkdropType && !DROP_TYPE[linkdropType]) {
      throw new Error('This drop is not supported. Please contact the sender of this link.');
    }

    const dropMetadata = this.getDropMetadata(drop.metadata);
    let ftMetadata;
    if (drop.ft !== undefined) {
      ftMetadata = await getFTMetadata({ contractId: drop.ft.contract_id });
    }

    return {
      dropName: dropMetadata.dropName,
      wallets: dropMetadata.wallets,
      redirectUrl: dropMetadata.redirectUrl,
      ftMetadata,
      amountTokens: drop.ft?.balance_per_use, // TODO: format correctly with FT metadata
      amountNEAR: formatNearAmount(drop.deposit_per_use, 4),
    };
  };

  getNFTorTokensMetadata = async (
    fcMethod: { receiver_id: string },
    dropId: string,
    secretKey?: string,
    contractId?: string,
  ) => {
    let nftData;
    let tokensData;

    const { receiver_id: receiverId } = fcMethod;
    const { viewCall } = getEnv();

    try {
      nftData = await viewCall({
        contractId: receiverId,
        methodName: 'get_series_info',
        args: { mint_id: parseFloat(dropId) },
      });
    } catch (err) {
      console.error('NFT series not found');
      // throw new Error('NFT series not found');
    }

    // show tokens if NFT series not found
    if (nftData === undefined && contractId && secretKey) {
      tokensData = await this.getTokenClaimInformation(contractId, secretKey);
    }

    return {
      nftData,
      tokensData,
    };
  };

  getNFTClaimInformation = async (contractId: string, secretKey: string) => {
    // given fc
    const drop = await this.getDropInfo({ secretKey });

    // verify if secretKey is a nft drop
    const linkdropType = await this.getLinkdropType(drop, contractId, secretKey);
    if (linkdropType !== DROP_TYPE.NFT) {
      throw new Error('This drop is not an NFT drop. Please contact your drop creator.');
    }

    const dropMetadata = this.getDropMetadata(drop.metadata);

    const fcMethods = drop.fc?.methods;
    if (
      fcMethods === undefined ||
      fcMethods.length === 0 ||
      fcMethods[0] === undefined ||
      fcMethods[0][0] === undefined
    ) {
      throw new Error('Unable to retrieve function calls.');
    }

    const { nftData, tokensData } = await this.getNFTorTokensMetadata(
      fcMethods[0][0],
      drop.drop_id,
      secretKey,
      contractId,
    );

    return {
      type: nftData ? DROP_TYPE.NFT : DROP_TYPE.TOKEN,
      dropName: dropMetadata.dropName,
      wallets: dropMetadata.wallets,
      redirectUrl: dropMetadata.redirectUrl,
      ...(nftData
        ? {
            media: `${CLOUDFLARE_IPFS}/${nftData.metadata.media}`, // eslint-disable-line
            title: nftData.metadata.title,
            description: nftData.metadata.description,
          }
        : {}),
      ...(tokensData || {}),
    };
  };

  getTicketNftInformation = async (contractId: string, secretKey: string) => {
    const drop = await this.getDropInfo({ secretKey });

    // verify if secretKey is a ticket drop
    const linkdropType = await this.getLinkdropType(drop, contractId, secretKey);
    if (linkdropType !== DROP_TYPE.TICKET) {
      throw new Error('This drop is not a Ticket drop. Please contact your drop creator.');
    }

    const dropMetadata = this.getDropMetadata(drop.metadata);

    const fcMethods = drop.fc?.methods;
    if (
      fcMethods === undefined ||
      fcMethods.length < 3 ||
      fcMethods[2] === undefined ||
      fcMethods[2][0] === undefined
    ) {
      throw new Error('Unable to retrieve function calls.');
    }

    const fcMethod = fcMethods[2][0];

    const { nftData, tokensData } = await this.getNFTorTokensMetadata(
      fcMethod,
      drop.drop_id,
      secretKey,
      contractId,
    );

    return {
      type: nftData ? DROP_TYPE.NFT : DROP_TYPE.TOKEN,
      dropName: dropMetadata.dropName,
      wallets: dropMetadata.wallets,
      redirectUrl: dropMetadata.redirectUrl,
      ...(nftData
        ? {
            media: `${CLOUDFLARE_IPFS}/${nftData.metadata.media}`, // eslint-disable-line
            title: nftData.metadata.title,
            description: nftData.metadata.description,
          }
        : {}),
      ...(tokensData || {}),
    };
  };

  claim = async (secretKey: string, walletAddress: string, skipValidation = false) => {
    if (!skipValidation) {
      await this.validateAccountId(walletAddress);
    }
    await claim({ secretKey, accountId: walletAddress });
  };
}

const keypomInstance = KeypomJS.getInstance();

export default keypomInstance;
