// Adapted from the live demo of evoo-carbon-ledger (https://github.com/sotkaretsos/evoo-carbon-ledger),
// MIT License, Copyright (c) 2026 Sotirios Karetsos, Konstantinos Demestichas, Constantina Costopoulou.
//
// In-browser Ethereum chain for the live demo.
//
// An EIP-1193 provider over the EthereumJS VM with the settings of the prototype's test network:
// London rules, zero base fee and gas price, one block per transaction, and the accounts of the
// public Hardhat test mnemonic. It implements the JSON-RPC subset used by ethers v6, plus
// time control (evm_setNextBlockTimestamp, evm_mine) and state snapshots (evm_snapshot,
// evm_revert) so that demonstrations of rejected transactions leave the replayed state intact.

import { createVM, runTx } from "@ethereumjs/vm";
import { createCustomCommon, Mainnet, Hardfork } from "@ethereumjs/common";
import { createBlock } from "@ethereumjs/block";
import { createFeeMarket1559Tx } from "@ethereumjs/tx";
import { createAddressFromString, createAddressFromPrivateKey, hexToBytes, bytesToHex } from "@ethereumjs/util";

const BLOCK_GAS_LIMIT = 30_000_000n;
const TX_GAS_LIMIT = 29_000_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x" + "00".repeat(32);
const EMPTY_BLOOM = "0x" + "00".repeat(256);

const q = (n) => "0x" + BigInt(n).toString(16); // JSON-RPC quantity
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const lower = (s) => String(s).toLowerCase();
const addr = (s) => createAddressFromString(lower(s));

export class RpcError extends Error {
  constructor(message, code = -32000, data) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export class LocalChain {
  /**
   * @param {object} opts
   * @param {Uint8Array[]} opts.privateKeys  keys of the unlocked accounts (eth_accounts order)
   * @param {number} [opts.chainId=31337]
   * @param {number} opts.genesisTime         Unix seconds of the genesis block
   */
  constructor({ privateKeys, chainId = 31337, genesisTime }) {
    this.chainId = BigInt(chainId);
    this.privateKeys = privateKeys;
    this.genesisTime = BigInt(genesisTime);
  }

  async init() {
    this.common = createCustomCommon({ chainId: Number(this.chainId), name: "pork-demo" }, Mainnet, { hardfork: Hardfork.London });
    // BLOCKHASH must read the same sealed headers returned by JSON-RPC. The VM's
    // default mock blockchain returns zero hashes and cannot validate snapshots.
    this.blocks = [];
    const history = {
      getBlock: async (number) => {
        const entry = this.blocks[Number(number)];
        if (!entry) throw new RpcError(`Unknown historical block ${number}`);
        return { hash: () => entry.hash };
      },
      putBlock: async () => {}, // LocalChain owns sealing and snapshot rollback.
      shallowCopy: () => history,
    };
    this.vm = await createVM({ common: this.common, blockchain: history });
    this.keys = new Map();
    this.accounts = [];
    for (const pk of this.privateKeys) {
      const a = createAddressFromPrivateKey(pk).toString();
      this.keys.set(a, pk);
      this.accounts.push(a);
    }
    this.txs = new Map();
    this.receipts = new Map();
    this.txOrder = [];
    this.logs = [];
    this.snapshots = new Map();
    this.nextSnapshot = 1;
    this.pendingTimestamp = null;
    this._seal([], this.genesisTime, null);
    return this;
  }

  // ------------------------------------------------------------------ blocks and time

  latestBlock() {
    return this.blocks[this.blocks.length - 1];
  }

  latestTimestamp() {
    return Number(this.latestBlock().timestamp);
  }

  _nextTimestamp() {
    const prev = this.latestBlock().timestamp;
    if (this.pendingTimestamp !== null && this.pendingTimestamp > prev) return this.pendingTimestamp;
    return prev + 1n;
  }

  _header(number, timestamp, gasUsed = 0n) {
    const parent = this.blocks.length ? this.blocks[this.blocks.length - 1] : null;
    return {
      parentHash: parent ? parent.hash : new Uint8Array(32),
      number,
      timestamp,
      gasLimit: BLOCK_GAS_LIMIT,
      gasUsed,
      baseFeePerGas: 0n,
      coinbase: addr(ZERO_ADDRESS),
      difficulty: 0n,
    };
  }

  _seal(txs, timestamp, result) {
    const number = BigInt(this.blocks.length);
    const gasUsed = result ? result.totalGasSpent : 0n;
    const block = createBlock({ header: this._header(number, timestamp, gasUsed), transactions: txs }, { common: this.common });
    const entry = {
      number,
      timestamp,
      gasUsed,
      hash: block.hash(),
      hashHex: bytesToHex(block.hash()),
      parentHashHex: bytesToHex(block.header.parentHash),
      txHashes: [],
    };
    this.blocks.push(entry);
    this.pendingTimestamp = null;
    return entry;
  }

  /** Mines an empty block, at `timestamp` (Unix seconds) if given. */
  mine(timestamp) {
    if (timestamp !== undefined) this.setNextBlockTimestamp(timestamp);
    return this._seal([], this._nextTimestamp(), null);
  }

  setNextBlockTimestamp(timestamp) {
    const t = BigInt(timestamp);
    if (t <= this.latestBlock().timestamp) throw new RpcError(`Timestamp ${t} is not after the latest block`);
    this.pendingTimestamp = t;
  }

  /** Equivalent of Hardhat's time.increaseTo: mines a block at `timestamp`. */
  increaseTo(timestamp) {
    this.mine(timestamp);
  }

  // ------------------------------------------------------------------ execution

  _contextBlock() {
    const number = BigInt(this.blocks.length);
    return createBlock({ header: this._header(number, this._nextTimestamp()) }, { common: this.common });
  }

  /** Executes a call on a throw-away state checkpoint (eth_call, eth_estimateGas). */
  async _simulate(tx) {
    const sm = this.vm.stateManager;
    await sm.checkpoint();
    try {
      const from = tx.from ? addr(tx.from) : addr(ZERO_ADDRESS);
      const result = await this.vm.evm.runCall({
        caller: from,
        origin: from,
        to: tx.to ? addr(tx.to) : undefined,
        data: hexToBytes(tx.data ?? tx.input ?? "0x"),
        gasLimit: TX_GAS_LIMIT,
        value: BigInt(tx.value ?? 0),
        block: this._contextBlock(),
        skipBalance: true,
      });
      const err = result.execResult.exceptionError;
      if (err) {
        const data = bytesToHex(result.execResult.returnValue);
        if (err.error === "revert") throw new RpcError("execution reverted", 3, data);
        throw new RpcError(`execution failed: ${err.error}`, -32000, data);
      }
      return result;
    } finally {
      await sm.revert();
    }
  }

  async _sendTransaction(params) {
    const from = lower(params.from);
    const key = this.keys.get(from);
    if (!key) throw new RpcError(`Unknown account ${params.from}`, -32602);
    const account = await this.vm.stateManager.getAccount(addr(from));
    const tx = createFeeMarket1559Tx(
      {
        chainId: this.chainId,
        nonce: account ? account.nonce : 0n,
        maxFeePerGas: 0n,
        maxPriorityFeePerGas: 0n,
        gasLimit: params.gas ? BigInt(params.gas) : TX_GAS_LIMIT,
        to: params.to ? addr(params.to) : undefined,
        value: BigInt(params.value ?? 0),
        data: hexToBytes(params.data ?? params.input ?? "0x"),
      },
      { common: this.common }
    ).sign(key);
    const timestamp = this._nextTimestamp();
    const number = BigInt(this.blocks.length);
    const context = createBlock({ header: this._header(number, timestamp) }, { common: this.common });
    const result = await runTx(this.vm, { tx, block: context, skipBlockGasLimitValidation: true, skipHardForkValidation: true });
    const block = this._seal([tx], timestamp, result);
    const hash = bytesToHex(tx.hash());
    block.txHashes.push(hash);
    const status = result.execResult.exceptionError ? 0 : 1;
    const to = params.to ? lower(params.to) : null;
    const contractAddress = !to && status === 1 && result.createdAddress ? result.createdAddress.toString() : null;
    const logs = (status === 1 ? result.execResult.logs ?? [] : []).map(([address, topics, data], i) => {
      const log = {
        address: bytesToHex(address),
        topics: topics.map((t) => bytesToHex(t)),
        data: bytesToHex(data),
        blockNumber: q(number),
        blockHash: block.hashHex,
        transactionHash: hash,
        transactionIndex: "0x0",
        logIndex: q(i),
        removed: false,
      };
      this.logs.push({ ...log, _block: number });
      return log;
    });
    this.txs.set(hash, {
      hash,
      blockHash: block.hashHex,
      blockNumber: q(number),
      transactionIndex: "0x0",
      type: "0x2",
      from,
      to,
      nonce: q(tx.nonce),
      gas: q(tx.gasLimit),
      gasPrice: "0x0",
      maxFeePerGas: "0x0",
      maxPriorityFeePerGas: "0x0",
      value: q(tx.value),
      input: bytesToHex(tx.data),
      chainId: q(this.chainId),
      v: q(tx.v),
      yParity: q(tx.v),
      r: word(tx.r),
      s: word(tx.s),
      accessList: [],
    });
    this.receipts.set(hash, {
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash: block.hashHex,
      blockNumber: q(number),
      from,
      to,
      contractAddress,
      cumulativeGasUsed: q(result.totalGasSpent),
      gasUsed: q(result.totalGasSpent),
      effectiveGasPrice: "0x0",
      logs,
      logsBloom: result.bloom ? bytesToHex(result.bloom.bitvector) : EMPTY_BLOOM,
      status: q(status),
      type: "0x2",
    });
    this.txOrder.push(hash);
    return hash;
  }

  // ------------------------------------------------------------------ snapshots

  async snapshot() {
    const id = this.nextSnapshot++;
    this.snapshots.set(id, {
      root: await this.vm.stateManager.getStateRoot(),
      blocks: this.blocks.length,
      txs: this.txOrder.length,
      logs: this.logs.length,
      pendingTimestamp: this.pendingTimestamp,
    });
    return id;
  }

  async revert(id) {
    const snap = this.snapshots.get(Number(id));
    if (!snap) return false;
    await this.vm.stateManager.setStateRoot(snap.root);
    this.blocks.length = snap.blocks;
    for (const hash of this.txOrder.splice(snap.txs)) {
      this.txs.delete(hash);
      this.receipts.delete(hash);
    }
    this.logs.length = snap.logs;
    this.pendingTimestamp = snap.pendingTimestamp;
    for (const k of [...this.snapshots.keys()]) if (k >= Number(id)) this.snapshots.delete(k);
    return true;
  }

  // ------------------------------------------------------------------ JSON-RPC views

  _blockNumber(tag) {
    const latest = BigInt(this.blocks.length - 1);
    if (tag === undefined || tag === null || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized") return latest;
    if (tag === "earliest") return 0n;
    const n = BigInt(tag);
    return n > latest ? latest : n;
  }

  _blockJson(b, full) {
    return {
      number: q(b.number),
      hash: b.hashHex,
      parentHash: b.parentHashHex,
      nonce: "0x0000000000000000",
      sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
      logsBloom: EMPTY_BLOOM,
      transactionsRoot: ZERO_HASH,
      stateRoot: ZERO_HASH,
      receiptsRoot: ZERO_HASH,
      miner: ZERO_ADDRESS,
      difficulty: "0x0",
      totalDifficulty: "0x0",
      extraData: "0x",
      size: "0x0",
      gasLimit: q(BLOCK_GAS_LIMIT),
      gasUsed: q(b.gasUsed),
      timestamp: q(b.timestamp),
      baseFeePerGas: "0x0",
      mixHash: ZERO_HASH,
      uncles: [],
      transactions: full ? b.txHashes.map((h) => this.txs.get(h)) : [...b.txHashes],
    };
  }

  _getLogs(filter = {}) {
    let from;
    let to;
    if (filter.blockHash) {
      const b = this.blocks.find((x) => x.hashHex === lower(filter.blockHash));
      if (!b) return [];
      from = to = b.number;
    } else {
      from = this._blockNumber(filter.fromBlock ?? "latest");
      to = this._blockNumber(filter.toBlock ?? "latest");
    }
    const addresses = filter.address ? (Array.isArray(filter.address) ? filter.address : [filter.address]).map(lower) : null;
    const topics = filter.topics ?? [];
    return this.logs
      .filter(
        (l) =>
          l._block >= from &&
          l._block <= to &&
          (!addresses || addresses.includes(l.address)) &&
          topics.every((t, i) => t == null || (Array.isArray(t) ? t.map(lower).includes(l.topics[i]) : lower(t) === l.topics[i]))
      )
      .map(({ _block, ...log }) => ({ ...log, topics: [...log.topics] }));
  }

  // ------------------------------------------------------------------ EIP-1193

  async request({ method, params = [] }) {
    switch (method) {
      case "eth_chainId":
        return q(this.chainId);
      case "net_version":
        return this.chainId.toString();
      case "web3_clientVersion":
        return "pork-demo/EthereumJS-VM";
      case "eth_accounts":
      case "eth_requestAccounts":
        return [...this.accounts];
      case "eth_blockNumber":
        return q(this.blocks.length - 1);
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas":
        return "0x0";
      case "eth_feeHistory":
        return { oldestBlock: q(this.blocks.length - 1), baseFeePerGas: ["0x0", "0x0"], gasUsedRatio: [0], reward: [["0x0"]] };
      case "eth_getBalance": {
        const a = await this.vm.stateManager.getAccount(addr(params[0]));
        return q(a ? a.balance : 0n);
      }
      case "eth_getTransactionCount": {
        const a = await this.vm.stateManager.getAccount(addr(params[0]));
        return q(a ? a.nonce : 0n);
      }
      case "eth_getCode":
        return bytesToHex(await this.vm.stateManager.getCode(addr(params[0])));
      case "eth_getStorageAt": {
        const value = await this.vm.stateManager.getStorage(addr(params[0]), hexToBytes(word(params[1])));
        return word(value.length ? BigInt(bytesToHex(value)) : 0n);
      }
      case "eth_getBlockByNumber": {
        const n = this._blockNumber(params[0]);
        const b = this.blocks[Number(n)];
        return b ? this._blockJson(b, !!params[1]) : null;
      }
      case "eth_getBlockByHash": {
        const b = this.blocks.find((x) => x.hashHex === lower(params[0]));
        return b ? this._blockJson(b, !!params[1]) : null;
      }
      case "eth_getTransactionByHash":
        return this.txs.get(lower(params[0])) ?? null;
      case "eth_getTransactionReceipt": {
        const r = this.receipts.get(lower(params[0]));
        return r ? { ...r, logs: r.logs.map((l) => ({ ...l })) } : null;
      }
      case "eth_getLogs":
        return this._getLogs(params[0]);
      case "eth_call": {
        const result = await this._simulate(params[0]);
        return bytesToHex(result.execResult.returnValue);
      }
      case "eth_estimateGas":
        await this._simulate(params[0]);
        return q(TX_GAS_LIMIT);
      case "eth_sendTransaction":
        return this._sendTransaction(params[0]);
      case "evm_snapshot":
        return q(await this.snapshot());
      case "evm_revert":
        return this.revert(BigInt(params[0]));
      case "evm_mine":
        this.mine(params[0] !== undefined ? Number(params[0]) : undefined);
        return "0x0";
      case "evm_setNextBlockTimestamp":
        this.setNextBlockTimestamp(Number(params[0]));
        return null;
      default:
        throw new RpcError(`Method ${method} is not supported by the demo chain`, 4200);
    }
  }
}
