import {
    Provider as L1Provider,
    JsonRpcProvider as L1JsonRpcProvider,
    AbiCoder,
    Contract,
} from 'ethers';
import { Provider as L2Provider } from 'zksync-ethers';
import {
    BatchMetadata,
    CommitBatchInfo,
    RpcProof,
    StorageProof,
    StorageProofBatch,
    StoredBatchInfo,
} from './types.js';
import {
    ZKSYNC_DIAMOND_INTERFACE,
    STORAGE_VERIFIER_INTERFACE,
    STORED_BATCH_INFO_ABI_STRING,
    COMMIT_BATCH_INFO_ABI_STRING,
} from './interfaces.js';

/** Omits batch hash from stored batch info */
const formatStoredBatchInfo = (batchInfo: StoredBatchInfo): BatchMetadata => {
    const { batchHash, ...metadata } = batchInfo;
    return metadata;
};

/** Storage proof provider for zkSync */
export class StorageProofProvider {
    /**
    Estimation of difference between latest L2 batch and latest verified L1
    batch. Assuming a 30 hour delay, divided to 12 minutes per block.
  */
    /**
     * When `getProof` / `getProofs` omits `batchNumber`, we use `latestL1Batch - blockQueryOffset`.
     * Sepolia public L1 nodes often omit very recent `commitTx` from `eth_getTransactionByHash`;
     * the exported `SepoliaStorageProofProvider` sets a larger default.
     */
    blockQueryOffset = 150;

    public diamondContract: Contract;

    constructor(
        public l1Provider: L1Provider,
        public l2Provider: L2Provider,
        public diamondAddress: string,
        public verifierAddress?: string,
    ) {
        this.diamondContract = new Contract(
            diamondAddress,
            ZKSYNC_DIAMOND_INTERFACE,
            l1Provider,
        );
    }

    /** Updates L1 provider */
    public setL1Provider(provider: L1Provider) {
        this.l1Provider = provider;
        this.diamondContract = new Contract(
            this.diamondAddress,
            ZKSYNC_DIAMOND_INTERFACE,
            provider,
        );
    }

    /** Updates L2 provider */
    public setL2Provider(provider: L2Provider) {
        this.l2Provider = provider;
    }

    /** Returns logs root hash stored in L1 contract */
    private async getL2LogsRootHash(batchNumber: number): Promise<string> {
        const l2RootsHash =
            await this.diamondContract.l2LogsRootHash(batchNumber);
        return String(l2RootsHash);
    }

    /** Returns ZkSync proof response */
    private async getL2Proof(
        account: string,
        storageKeys: Array<string>,
        batchNumber: number,
    ): Promise<Array<RpcProof>> {
        type ZksyncProofResponse = {
            key: string;
            proof: Array<string>;
            value: string;
            index: number;
        };

        try {
            // Account proofs don't exist in zkSync, so we're only using storage proofs
            const { storageProof: storageProofs } = await this.l2Provider.send(
                'zks_getProof',
                [account, storageKeys, batchNumber],
            );

            return storageProofs.map((storageProof: ZksyncProofResponse) => {
                const { proof, ...rest } = storageProof;
                return { account, path: proof, ...rest };
            });
        } catch (e) {
            throw new Error(`Failed to get proof from L2 provider, ${e}`);
        }
    }

    /** Parses the transaction where batch is committed and returns commit info */
    private async parseCommitTransaction(
        txHash: string,
        batchNumber: number,
    ): Promise<{ commitBatchInfo: CommitBatchInfo; commitment: string }> {
        const transactionData = await this.l1Provider.getTransaction(txHash);
        if (transactionData == null) {
            throw new Error(`Commit transaction ${txHash} not found on L1`);
        }

        const selector = transactionData.data.slice(0, 10);
        let commitBatchInfos: any[];

        if (selector === '0x701f58c5') {
            const decoded = ZKSYNC_DIAMOND_INTERFACE.decodeFunctionData(
                'commitBatches',
                transactionData.data,
            );
            commitBatchInfos = decoded[1] as any[];
        } else if (selector === '0x98f81962') {
            const decoded = ZKSYNC_DIAMOND_INTERFACE.decodeFunctionData(
                'commitBatchesSharedBridge(uint256,uint256,uint256,bytes)',
                transactionData.data,
            );
            const { commitBatchInfos: cbi } = this.decodeCommitData(
                decoded[3],
            );
            commitBatchInfos = cbi;
        } else if (selector === '0x0db9eb87') {
            const decoded = ZKSYNC_DIAMOND_INTERFACE.decodeFunctionData(
                'commitBatchesSharedBridge(address,uint256,uint256,bytes)',
                transactionData.data,
            );
            const { commitBatchInfos: cbi } = this.decodeCommitData(
                decoded[3],
            );
            commitBatchInfos = cbi;
        } else {
            throw new Error(
                `Unsupported commit transaction selector ${selector} (tx ${txHash})`,
            );
        }

        const batchBn = BigInt(batchNumber);
        const batch = commitBatchInfos.find((b: any) => {
            return BigInt(b[0]) === batchBn;
        });
        if (batch == undefined) {
            throw new Error(`Batch ${batchNumber} not found in calldata`);
        }

        const commitBatchInfo: CommitBatchInfo = {
            batchNumber: batch[0],
            timestamp: batch[1],
            indexRepeatedStorageChanges: batch[2],
            newStateRoot: batch[3],
            numberOfLayer1Txs: batch[4],
            priorityOperationsHash: batch[5],
            bootloaderHeapInitialContentsHash: batch[6],
            eventsQueueStateHash: batch[7],
            systemLogs: batch[8],
            totalL2ToL1Pubdata: batch[9],
        };

        const receipt = await this.l1Provider.getTransactionReceipt(txHash);
        if (receipt == undefined) {
            throw new Error(`Receipt for commit tx ${txHash} not found`);
        }

        // Parse event logs of the transaction to find commitment
        const blockCommitFilter = ZKSYNC_DIAMOND_INTERFACE.encodeFilterTopics(
            'BlockCommit',
            [batchNumber],
        );
        const commitLog = receipt.logs.find(
            (log) =>
                log.address === this.diamondAddress &&
                blockCommitFilter.every((topic, i) => topic === log.topics[i]),
        );
        if (commitLog == undefined) {
            throw new Error(`Commit log for batch ${batchNumber} not found`);
        }
        const { commitment } = ZKSYNC_DIAMOND_INTERFACE.decodeEventLog(
            'BlockCommit',
            commitLog.data,
            commitLog.topics,
        );

        return { commitBatchInfo, commitment };
    }

    /**
     * Returns the stored batch info for the given batch number.
     * Returns null if the batch is not stored.
     * @param batchNumber
     */
    async getStoredBatchInfo(batchNumber: number): Promise<StoredBatchInfo> {
        const { commitTxHash, proveTxHash } =
            await this.l2Provider.getL1BatchDetails(batchNumber);

        // If batch is not committed or proved, return null
        if (commitTxHash == undefined) {
            throw new Error(`Batch ${batchNumber} is not committed`);
        } else if (proveTxHash == undefined) {
            throw new Error(`Batch ${batchNumber} is not proved`);
        }

        // Parse commit calldata from commit transaction
        const { commitBatchInfo, commitment } =
            await this.parseCommitTransaction(commitTxHash, batchNumber);
        const l2LogsTreeRoot = await this.getL2LogsRootHash(batchNumber);

        const storedBatchInfo: StoredBatchInfo = {
            batchNumber: commitBatchInfo.batchNumber,
            batchHash: commitBatchInfo.newStateRoot,
            indexRepeatedStorageChanges:
                commitBatchInfo.indexRepeatedStorageChanges,
            numberOfLayer1Txs: commitBatchInfo.numberOfLayer1Txs,
            priorityOperationsHash: commitBatchInfo.priorityOperationsHash,
            l2LogsTreeRoot,
            timestamp: commitBatchInfo.timestamp,
            commitment,
        };
        return storedBatchInfo;
    }

    async verifyOnChain(proof: StorageProof) {
        if (this.verifierAddress == undefined) {
            throw new Error('Verifier address is not provided');
        }

        const { metadata, account, key, path, value, index } = proof;
        const verifierContract = new Contract(
            this.verifierAddress,
            STORAGE_VERIFIER_INTERFACE,
            this.l1Provider,
        );

        return await verifierContract.verify({
            metadata,
            account,
            key,
            path,
            value,
            index,
        });
    }

    /**
     * Gets the proof and related data for the given batch number, address and storage keys.
     * @param address
     * @param storageKeys
     * @param batchNumber
     * @returns
     */
    async getProofs(
        address: string,
        storageKeys: Array<string>,
        batchNumber?: number,
    ): Promise<StorageProofBatch> {
        const userPickedBatch = batchNumber !== undefined;
        let attemptBatch = batchNumber;
        if (attemptBatch == undefined) {
            const latestBatchNumber = await this.l2Provider.getL1BatchNumber();
            attemptBatch = latestBatchNumber - this.blockQueryOffset;
        }

        const maxStepBack = 80;
        let lastError: unknown;

        for (let step = 0; step < maxStepBack; step++) {
            try {
                const metadata = await this.getStoredBatchInfo(attemptBatch).then(
                    formatStoredBatchInfo,
                );
                const proofs = await this.getL2Proof(
                    address,
                    storageKeys,
                    attemptBatch,
                );
                return { metadata, proofs };
            } catch (e) {
                lastError = e;
                const msg = e instanceof Error ? e.message : String(e);
                const canRetry =
                    !userPickedBatch &&
                    (msg.includes('not found on L1') ||
                        (msg.includes('Transaction ') &&
                            msg.includes('not found')));
                if (canRetry && attemptBatch > 1) {
                    attemptBatch -= 1;
                    continue;
                }
                throw e;
            }
        }

        throw lastError instanceof Error
            ? lastError
            : new Error(String(lastError));
    }

    /**
     * Gets a single proof
     * @param address
     * @param storageKey
     * @param batchNumber
     * @returns
     */
    async getProof(
        address: string,
        storageKey: string,
        batchNumber?: number,
    ): Promise<StorageProof> {
        const { metadata, proofs } = await this.getProofs(
            address,
            [storageKey],
            batchNumber,
        );
        return { metadata, ...proofs[0] };
    }

    decodeCommitData(commitData: string) {
        // Remove the version prefix (0x00)
        const encodedDataWithoutVersion = commitData.slice(4);

        // Decode the data
        const decoded = AbiCoder.defaultAbiCoder().decode(
            [STORED_BATCH_INFO_ABI_STRING, `${COMMIT_BATCH_INFO_ABI_STRING}[]`],
            '0x' + encodedDataWithoutVersion,
        );

        return {
            storedBatchInfo: decoded[0],
            commitBatchInfos: decoded[1],
        };
    }
}

export const MainnetStorageProofProvider = new StorageProofProvider(
    new L1JsonRpcProvider('https://eth.llamarpc.com'),
    new L2Provider('https://mainnet.era.zksync.io'),
    '0x32400084C286CF3E17e7B677ea9583e60a000324',
);

export const SepoliaStorageProofProvider = new StorageProofProvider(
    new L1JsonRpcProvider('https://eth-sepolia.g.alchemy.com/v2/BViqld61MeSIZzHJG8dJc'),
    new L2Provider('https://sepolia.era.zksync.dev'),
    '0x9A6DE0f62Aa270A8bCB1e2610078650D539B1Ef9',
    '0x5490D0FE20E9F93a847c1907f7Fd2adF217bF534',
);
/** See `blockQueryOffset` on {@link StorageProofProvider}. */
SepoliaStorageProofProvider.blockQueryOffset = 5200;

export * from './types';
