import { getBytes, hexlify, ZeroHash } from 'ethers';

/** matter-labs `L2_TO_L1_LOG_SERIALIZE_SIZE` */
export const L2_TO_L1_LOG_SERIALIZE_SIZE = 88;

const L2_LOG_KEY_OFFSET = 24;
const L2_LOG_VALUE_OFFSET = 56;

/**
 * `SystemLogKey.L2_TO_L1_LOGS_TREE_ROOT_KEY` — value becomes `StoredBatchInfo.l2LogsTreeRoot`
 * at commit time (matter-labs `Executor._processL2Logs`).
 */
export const L2_TO_L1_LOGS_TREE_ROOT_KEY = 0n;

/**
 * `SystemLogKey.MESSAGE_ROOT_ROLLING_HASH_KEY` — value becomes `StoredBatchInfo.dependencyRootsRollingHash`
 * (see matter-labs `Executor._processL2Logs`).
 */
export const MESSAGE_ROOT_ROLLING_HASH_KEY = 7n;

function readLogKey(u8: Uint8Array, recordStart: number): bigint {
    let key = 0n;
    for (let j = 0; j < 32; j++) {
        key = (key << 8n) + BigInt(u8[recordStart + L2_LOG_KEY_OFFSET + j]);
    }
    return key;
}

function readLogValue(u8: Uint8Array, recordStart: number): string {
    return hexlify(
        u8.slice(
            recordStart + L2_LOG_VALUE_OFFSET,
            recordStart + L2_LOG_VALUE_OFFSET + 32,
        ),
    );
}

function forEachSystemLog(
    systemLogs: string | Uint8Array,
    fn: (key: bigint, valueHex: string, recordStart: number) => void,
): void {
    const u8 =
        typeof systemLogs === 'string' ? getBytes(systemLogs) : systemLogs;
    if (u8.length === 0) {
        return;
    }
    if (u8.length % L2_TO_L1_LOG_SERIALIZE_SIZE !== 0) {
        throw new Error(
            `systemLogs length ${u8.length} is not a multiple of ${L2_TO_L1_LOG_SERIALIZE_SIZE}`,
        );
    }
    for (let i = 0; i < u8.length; i += L2_TO_L1_LOG_SERIALIZE_SIZE) {
        const key = readLogKey(u8, i);
        fn(key, readLogValue(u8, i), i);
    }
}

/**
 * L2 logs tree root from `CommitBatchInfo.systemLogs` (key 0). Executor uses this in `StoredBatchInfo`, which
 * can differ from `Diamond.l2LogsRootHash(batch)` (e.g. latter may stay zero while commit used a non-zero root).
 * @returns `{ found, root }` — `found === false` if key 0 is absent (then caller may fall back to `l2LogsRootHash`).
 */
export function parseL2LogsTreeRootFromSystemLogs(
    systemLogs: string | Uint8Array,
): { found: boolean; root: string } {
    let found = false;
    let root = ZeroHash;
    forEachSystemLog(systemLogs, (key, valueHex) => {
        if (key === L2_TO_L1_LOGS_TREE_ROOT_KEY) {
            found = true;
            root = valueHex;
        }
    });
    return { found, root };
}

/**
 * Parses `CommitBatchInfo.systemLogs` and returns the MESSAGE_ROOT rolling hash bytes32 (hex).
 * Returns {@link ZeroHash} if the log is absent (legacy batches).
 */
export function parseDependencyRootsRollingHashFromSystemLogs(
    systemLogs: string | Uint8Array,
): string {
    let out = ZeroHash;
    forEachSystemLog(systemLogs, (key, valueHex) => {
        if (key === MESSAGE_ROOT_ROLLING_HASH_KEY) {
            out = valueHex;
        }
    });
    return out;
}
