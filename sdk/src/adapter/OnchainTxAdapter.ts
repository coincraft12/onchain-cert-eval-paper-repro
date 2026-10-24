/**
 * OnchainTxAdapter — C-2 실시례 (특허 C-1 §3-1의 EVM 온체인 TX 구현).
 *
 * Etherscan V2 API (multichain) 로 지정 주소의 트랜잭션 목록 · 내부 호출 · ERC-20 이벤트를
 * 수집해 StandardAction[] 로 정규화한다.
 *
 * 설계 원칙:
 *   - 하위 파이프라인(120→180)은 domainMetadata를 읽지 않는다 (C-1 무관성)
 *   - HTTP fetcher를 DI로 받아 테스트 시 mock 주입 가능
 *   - collect() 는 순수 조회. 상태 변경 금지 (재현성 확보)
 *   - internal / token 병합 시 actionType 접두어로 소스 구분 ("internal:call", "erc20:transfer")
 */

import { keccak256 } from "viem";
import { lookupSelector } from "./known-selectors.js";
import type {
  CollectParams,
  DomainAdapter,
  StandardAction,
} from "./types.js";

/**
 * Etherscan V2 `account.txlist` 응답 원소 (필요 필드만).
 * 참고: https://docs.etherscan.io/etherscan-v2/api-endpoints/accounts#get-a-list-of-normal-transactions-by-address
 */
export interface EtherscanRawTx {
  readonly hash: string;
  readonly blockNumber: string;
  readonly timeStamp: string;
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly gas: string;
  readonly gasPrice: string;
  readonly gasUsed: string;
  readonly input: string;
  readonly functionName?: string;
  readonly methodId?: string;
  readonly isError: string; // "0" = success, "1" = fail
  readonly txreceipt_status?: string;
  readonly contractAddress?: string;
  readonly nonce?: string;
}

/**
 * Etherscan V2 `account.txlistinternal` 응답 원소.
 * traceId는 내부 호출 트리 상의 경로 식별자 (같은 tx 안에서 유일).
 */
export interface EtherscanInternalTx {
  readonly hash: string;
  readonly blockNumber: string;
  readonly timeStamp: string;
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly contractAddress: string;
  readonly input: string;
  readonly type: string;         // "call" | "create" | "suicide" | "delegatecall" | ...
  readonly gas: string;
  readonly gasUsed: string;
  readonly traceId: string;
  readonly isError: string;
  readonly errCode: string;
}

/**
 * Etherscan V2 `account.tokentx` 응답 원소 (ERC-20 Transfer event).
 */
export interface EtherscanTokenTx {
  readonly hash: string;
  readonly blockNumber: string;
  readonly timeStamp: string;
  readonly nonce: string;
  readonly blockHash: string;
  readonly from: string;
  readonly to: string;
  readonly value: string;         // token base units
  readonly contractAddress: string;
  readonly tokenName: string;
  readonly tokenSymbol: string;
  readonly tokenDecimal: string;
  readonly transactionIndex: string;
  readonly gas: string;
  readonly gasPrice: string;
  readonly gasUsed: string;
  readonly input: string;
  readonly confirmations: string;
}

interface EtherscanResponse<T> {
  readonly status: string;
  readonly message: string;
  readonly result: readonly T[] | string;
}

/** 최소 fetch 시그니처 — Node/브라우저/mock 공용 */
export type FetchLike = (
  input: string,
  init?: { readonly signal?: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number; json: () => Promise<unknown> }>;

export interface OnchainTxAdapterConfig {
  /** 체인 ID (1=Ethereum, 137=Polygon, 11155111=Sepolia, ...) */
  readonly chainId: number;
  /** Etherscan V2 API key */
  readonly apiKey: string;
  /** Etherscan V2 base URL (기본: https://api.etherscan.io/v2/api) */
  readonly baseUrl?: string;
  /** fetch 함수 (기본: globalThis.fetch) — 테스트 시 mock */
  readonly fetcher?: FetchLike;
  /** 페이지당 최대 결과 (기본: 1000, Etherscan V2 상한) */
  readonly offset?: number;
  /** 요청 타임아웃 ms (기본: 15000) */
  readonly timeoutMs?: number;
  /** collectAndNormalize 에서 내부 호출 병합 여부 (기본 false) */
  readonly includeInternal?: boolean;
  /** collectAndNormalize 에서 ERC-20 이벤트 병합 여부 (기본 false) */
  readonly includeToken?: boolean;
}

const DEFAULT_BASE_URL = "https://api.etherscan.io/v2/api";
const DEFAULT_OFFSET = 1000;
const DEFAULT_TIMEOUT_MS = 15000;

export class OnchainTxAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnchainTxAdapterError";
  }
}

export class OnchainTxAdapter implements DomainAdapter<EtherscanRawTx> {
  readonly domainId = "onchain-evm";
  readonly sourceInterface = "etherscan-v2";

  private readonly chainId: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;
  private readonly offset: number;
  private readonly timeoutMs: number;
  private readonly includeInternal: boolean;
  private readonly includeToken: boolean;

  constructor(config: OnchainTxAdapterConfig) {
    if (!Number.isInteger(config.chainId) || config.chainId <= 0) {
      throw new OnchainTxAdapterError(`invalid chainId: ${config.chainId}`);
    }
    if (!config.apiKey) throw new OnchainTxAdapterError("apiKey required");
    this.chainId = config.chainId;
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetcher = config.fetcher ?? (globalThis.fetch as FetchLike);
    this.offset = config.offset ?? DEFAULT_OFFSET;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.includeInternal = config.includeInternal ?? false;
    this.includeToken = config.includeToken ?? false;
    if (!this.fetcher) {
      throw new OnchainTxAdapterError("no fetch implementation available");
    }
  }

  // ---------- collect (raw) ----------

  async collect(params: CollectParams): Promise<readonly EtherscanRawTx[]> {
    return this.fetchPaginated<EtherscanRawTx>({
      module: "account",
      action: "txlist",
      params,
    });
  }

  async collectInternal(params: CollectParams): Promise<readonly EtherscanInternalTx[]> {
    return this.fetchPaginated<EtherscanInternalTx>({
      module: "account",
      action: "txlistinternal",
      params,
    });
  }

  async collectToken(params: CollectParams): Promise<readonly EtherscanTokenTx[]> {
    return this.fetchPaginated<EtherscanTokenTx>({
      module: "account",
      action: "tokentx",
      params,
    });
  }

  // ---------- normalize ----------

  normalize(rawTx: EtherscanRawTx): StandardAction {
    const timestamp = parseTimestamp(rawTx.timeStamp);
    const isError = rawTx.isError === "1";
    const receiptFailed = rawTx.txreceipt_status === "0";
    const status: StandardAction["status"] = isError || receiptFailed ? "fail" : "success";
    const actionType = deriveNormalActionType(rawTx);
    const hasInputData = rawTx.input && rawTx.input !== "0x";

    const domainMetadata: Record<string, unknown> = {
      chainId: this.chainId,
      source: "normal",
      blockNumber: BigInt(rawTx.blockNumber),
      to: rawTx.to?.toLowerCase() ?? "",
      value: BigInt(rawTx.value),
      gas: BigInt(rawTx.gas),
      gasPrice: BigInt(rawTx.gasPrice),
      gasUsed: BigInt(rawTx.gasUsed),
      rawInput: rawTx.input,
    };
    if (rawTx.contractAddress) domainMetadata.contractAddress = rawTx.contractAddress.toLowerCase();
    if (rawTx.nonce) domainMetadata.nonce = BigInt(rawTx.nonce);

    return {
      actionId: rawTx.hash.toLowerCase(),
      timestamp,
      actor: rawTx.from.toLowerCase(),
      actionType,
      status,
      domainMetadata,
      ...(hasInputData
        ? { inputDigest: keccak256(rawTx.input as `0x${string}`) }
        : {}),
    };
  }

  normalizeInternal(itx: EtherscanInternalTx): StandardAction {
    const timestamp = parseTimestamp(itx.timeStamp);
    const status: StandardAction["status"] = itx.isError === "1" ? "fail" : "success";
    const parentHash = itx.hash.toLowerCase();
    const hasInputData = itx.input && itx.input !== "0x";

    const domainMetadata: Record<string, unknown> = {
      chainId: this.chainId,
      source: "internal",
      parentTxHash: parentHash,
      blockNumber: BigInt(itx.blockNumber),
      to: itx.to?.toLowerCase() ?? "",
      value: BigInt(itx.value),
      gas: BigInt(itx.gas),
      gasUsed: BigInt(itx.gasUsed),
      callType: itx.type,
      traceId: itx.traceId,
      errCode: itx.errCode,
      rawInput: itx.input,
    };
    if (itx.contractAddress) domainMetadata.contractAddress = itx.contractAddress.toLowerCase();

    return {
      actionId: `${parentHash}-internal-${itx.traceId}`,
      timestamp,
      actor: itx.from.toLowerCase(),
      actionType: `internal:${itx.type}`,
      status,
      domainMetadata,
      parentActions: [parentHash], // 부모 tx 참조 (DAG)
      ...(hasInputData
        ? { inputDigest: keccak256(itx.input as `0x${string}`) }
        : {}),
    };
  }

  /**
   * Token 이벤트 정규화.
   * @param ttx  Etherscan tokentx 원소
   * @param seq  같은 tx 안에서 몇 번째 token event 인지 (0-based). 호출자가 안정 정렬 후 부여.
   */
  normalizeToken(ttx: EtherscanTokenTx, seq: number): StandardAction {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new OnchainTxAdapterError(`invalid token seq: ${seq}`);
    }
    const timestamp = parseTimestamp(ttx.timeStamp);
    const parentHash = ttx.hash.toLowerCase();

    const domainMetadata: Record<string, unknown> = {
      chainId: this.chainId,
      source: "token",
      parentTxHash: parentHash,
      blockNumber: BigInt(ttx.blockNumber),
      contractAddress: ttx.contractAddress.toLowerCase(),
      tokenName: ttx.tokenName,
      tokenSymbol: ttx.tokenSymbol,
      tokenDecimal: Number(ttx.tokenDecimal),
      from: ttx.from.toLowerCase(),
      to: ttx.to.toLowerCase(),
      value: BigInt(ttx.value),
      transactionIndex: Number(ttx.transactionIndex),
      seq,
    };

    return {
      actionId: `${parentHash}-erc20-${ttx.contractAddress.toLowerCase()}-${seq}`,
      timestamp,
      actor: ttx.from.toLowerCase(),
      actionType: "erc20:transfer",
      status: "success", // event = 성공 tx에서만 emit
      domainMetadata,
      parentActions: [parentHash],
    };
  }

  // ---------- orchestration ----------

  async collectAndNormalize(
    params: CollectParams,
  ): Promise<readonly StandardAction[]> {
    const tasks: Promise<StandardAction[]>[] = [];

    tasks.push(this.collect(params).then((txs) => txs.map((tx) => this.normalize(tx))));

    if (this.includeInternal) {
      tasks.push(
        this.collectInternal(params).then((itxs) => itxs.map((i) => this.normalizeInternal(i))),
      );
    }

    if (this.includeToken) {
      tasks.push(
        this.collectToken(params).then((ttxs) => {
          // 안정 정렬 후 seq 부여: (blockNumber, transactionIndex, arrayOrder)
          const indexed = ttxs.map((t, i) => ({ t, arrayOrder: i }));
          indexed.sort((a, b) => {
            const bn = BigInt(a.t.blockNumber) - BigInt(b.t.blockNumber);
            if (bn !== 0n) return bn < 0n ? -1 : 1;
            const ti = Number(a.t.transactionIndex) - Number(b.t.transactionIndex);
            if (ti !== 0) return ti;
            return a.arrayOrder - b.arrayOrder;
          });
          // seq는 hash별로 부여 (같은 tx 내 몇 번째 token event 인지)
          const seqMap = new Map<string, number>();
          return indexed.map(({ t }) => {
            const key = t.hash.toLowerCase();
            const seq = seqMap.get(key) ?? 0;
            seqMap.set(key, seq + 1);
            return this.normalizeToken(t, seq);
          });
        }),
      );
    }

    const batches = await Promise.all(tasks);
    return batches.flat();
  }

  // ---------- internals ----------

  private async fetchPaginated<T>(opts: {
    module: string;
    action: string;
    params: CollectParams;
  }): Promise<readonly T[]> {
    if (!opts.params.actor) throw new OnchainTxAdapterError("actor required");
    const startblock = opts.params.windowStart ?? 0;
    const endblock = opts.params.windowEnd ?? 99999999;

    const collected: T[] = [];
    let page = 1;
    while (page <= 10) {
      const url = this.buildUrl({
        module: opts.module,
        action: opts.action,
        address: opts.params.actor,
        startblock: String(startblock),
        endblock: String(endblock),
        page: String(page),
        offset: String(this.offset),
        sort: "asc",
      });
      const batch = await this.fetchList<T>(url);
      if (batch.length === 0) break;
      collected.push(...batch);
      if (batch.length < this.offset) break;
      page += 1;
    }
    return collected;
  }

  private buildUrl(query: Record<string, string>): string {
    const params = new URLSearchParams({
      chainid: String(this.chainId),
      apikey: this.apiKey,
      ...query,
    });
    return `${this.baseUrl}?${params.toString()}`;
  }

  private async fetchList<T>(url: string): Promise<readonly T[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(url, { signal: controller.signal });
      if (!res.ok) throw new OnchainTxAdapterError(`etherscan HTTP ${res.status}`);
      const body = (await res.json()) as EtherscanResponse<T>;

      if (body.status !== "1") {
        if (typeof body.result === "string" && /no.*found/i.test(body.result)) return [];
        if (Array.isArray(body.result) && body.result.length === 0) return [];
        throw new OnchainTxAdapterError(
          `etherscan status=${body.status} message=${body.message} result=${
            typeof body.result === "string" ? body.result : "[array]"
          }`,
        );
      }
      return Array.isArray(body.result) ? body.result : [];
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseTimestamp(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new OnchainTxAdapterError(`invalid timeStamp: ${raw}`);
  }
  return n;
}

function deriveNormalActionType(rawTx: EtherscanRawTx): string {
  // 1. 컨트랙트 배포 tx (contractAddress 유무 · to 비어있음)
  //    → verify 여부 무관하게 "constructor"
  if (isContractCreation(rawTx)) return "constructor";

  // 2. Verified 컨트랙트 → Etherscan/Polygonscan functionName 사용
  if (rawTx.functionName) {
    const idx = rawTx.functionName.indexOf("(");
    return idx > 0 ? rawTx.functionName.slice(0, idx) : rawTx.functionName;
  }

  // 3. Unverified 라도 알려진 selector 는 매핑 → semantic actionType
  const selector = extractSelector(rawTx);
  if (selector) {
    const known = lookupSelector(selector);
    if (known) return known;
    return selector; // 알려지지 않은 selector 는 raw 로 유지 (감사 흔적)
  }

  // 4. 순수 ETH 전송 (input 없음)
  return "0x00000000";
}

function isContractCreation(rawTx: EtherscanRawTx): boolean {
  // Etherscan V2 규약: 배포 tx 는 contractAddress 필드가 채워짐, to 는 빈 문자열
  if (rawTx.contractAddress && rawTx.contractAddress.length > 0) return true;
  if (!rawTx.to || rawTx.to === "") return true;
  return false;
}

function extractSelector(rawTx: EtherscanRawTx): string | undefined {
  if (rawTx.methodId && rawTx.methodId !== "0x" && rawTx.methodId.length >= 10) {
    return rawTx.methodId.slice(0, 10);
  }
  if (rawTx.input && rawTx.input !== "0x" && rawTx.input.length >= 10) {
    return rawTx.input.slice(0, 10);
  }
  return undefined;
}
