#!/usr/bin/env node
/**
 * executeBatch(검증자 교체 + threshold 2 + 테스트 3건 폐기) 이후 온체인 상태 확인 — 읽기 전용.
 * 트랜잭션을 보내지 않는다. 결과는 stdout JSON 한 덩어리(파일 저장은 호출자가 한다).
 *
 * 입력 : argv[2] = 이전 스캔(results/raw/onchain_verification_2026-10-22.json, `scan` 키 사용)
 *        argv[3] = executeBatch 트랜잭션 해시
 *        argv[4] = 타임락 operationId
 * 환경변수: POLYGON_RPC (getLogs 10,000블록 제한을 지키며 이전 스캔 이후 구간만 조회)
 * 공개 출력에는 검증자·Safe 소유자·영수증 from/to 주소를 넣지 않는다(검증자는 인덱스, 비교 결과는 불리언).
 */
import { createPublicClient, http, parseAbi, formatEther, getAddress } from "viem";
import { polygon } from "viem/chains";
import { readFileSync } from "node:fs";

process.on("uncaughtException", (e) => { console.error(String(e.shortMessage ?? e.message).replace(/https?:\/\/\S+/g, "<url>").slice(0, 300)); process.exit(1); });
const RPC = process.env.POLYGON_RPC;
if (!RPC) throw new Error("POLYGON_RPC not set");
const c = createPublicClient({ chain: polygon, transport: http(RPC, { retryCount: 4, retryDelay: 800 }) });

const prev = JSON.parse(readFileSync(process.argv[2], "utf-8")).scan;
const EXEC_TX = process.argv[3];
const OP_ID = process.argv[4];
const PROXY = "0xb7e3B228308F97431de7d4d4b7690A35B23052Ba";
const TIMELOCK = "0x51caF45eB42eb648dee04f24271134E7046eA2a4";
const SAFE = "0x2A04904440D4C340dBEd5031b31CBDCEd19b0dF5";
const REGISTRY = "0x07D7EB170964D555db1D270B2B7dDAc9A3C8fC67";
// 기대 활성 검증자(운영 발급자 키, 새 KMS 키)와 교체된 옛 검증자 — 주소는 출력하지 않는다.
const EXPECT_ACTIVE = ["0xe17f4698277cedaf0c0991eadb9614b87ba3f11d", "0x08b89d7dbdb57101906b9151ac5cc571db848e22"];
const EXPECT_INACTIVE = ["0x402a8ec6e432ef3293d88cee5d886335689f7a3f"];

const regAbi = parseAbi([
  "function threshold() view returns (uint256)",
  "function activeCount() view returns (uint256)",
  "function isActive(address) view returns (bool)",
  "event ValidatorAdded(address indexed validator, string nodeId)",
  "event ValidatorRemoved(address indexed validator)",
  "event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold)",
]);
const sbtAbi = parseAbi([
  "function revoked(uint256) view returns (bool)",
  "function revocationReason(uint256) view returns (uint8)",
  "event TokenMinted(address indexed user, bytes32 indexed missionId, uint256 indexed tokenId, uint8 grade, bytes32 ruleSetId)",
  "event Revoked(uint256 indexed tokenId, address indexed previousOwner, uint8 reason, uint256 timestamp)",
]);
const tlAbi = parseAbi([
  "function isOperationDone(bytes32) view returns (bool)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
]);
const safeAbi = parseAbi(["function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"]);
const ev = (abi, name) => abi.find((x) => x.type === "event" && x.name === name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function logsChunked(params, from, to, step = 10000n) {
  const all = [];
  for (let a = from; a <= to; a += step) {
    const b = a + step - 1n > to ? to : a + step - 1n;
    for (let attempt = 0; ; attempt++) {
      try { all.push(...(await c.getLogs({ ...params, fromBlock: a, toBlock: b }))); break; }
      catch (e) { if (attempt >= 8) throw e; await sleep(1500 * (attempt + 1)); }
    }
    await sleep(120);
  }
  return all;
}

const out = {};
const latest = await c.getBlockNumber();
out.latestBlock = Number(latest);
out.previousScanBlock = prev.latestBlock;

// ---- executeBatch 영수증 (from/to는 비공개 보조 필드로 분리)
const [r, t] = await Promise.all([c.getTransactionReceipt({ hash: EXEC_TX }), c.getTransaction({ hash: EXEC_TX })]);
const blk = await c.getBlock({ blockNumber: r.blockNumber });
out.executeTx = {
  txHash: EXEC_TX, blockNumber: Number(r.blockNumber), blockTimestampUtc: new Date(Number(blk.timestamp) * 1000).toISOString(),
  status: r.status, gasUsed: Number(r.gasUsed), effectiveGasPriceGwei: Number(r.effectiveGasPrice) / 1e9,
  costPOL: formatEther(r.gasUsed * r.effectiveGasPrice),
};
out.operation = {
  operationId: OP_ID,
  isOperationDone: await c.readContract({ address: TIMELOCK, abi: tlAbi, functionName: "isOperationDone", args: [OP_ID] }),
  callExecutedLogsInTx: r.logs.filter((l) => l.address.toLowerCase() === TIMELOCK.toLowerCase() && l.topics[1]?.toLowerCase() === OP_ID.toLowerCase()).length,
};

// ---- 레지스트리 현재 상태
const act = {};
for (const a of [...EXPECT_ACTIVE, ...EXPECT_INACTIVE]) act[a] = await c.readContract({ address: REGISTRY, abi: regAbi, functionName: "isActive", args: [a] });
out.registry = {
  threshold: String(await c.readContract({ address: REGISTRY, abi: regAbi, functionName: "threshold" })),
  activeCount: String(await c.readContract({ address: REGISTRY, abi: regAbi, functionName: "activeCount" })),
  expectedActiveAllActive: EXPECT_ACTIVE.every((a) => act[a] === true),
  replacedValidatorInactive: EXPECT_INACTIVE.every((a) => act[a] === false),
};

// ---- 이전 스캔 이후 이벤트 병합
const from = BigInt(prev.latestBlock) + 1n;
const scan = await logsChunked(
  { address: [PROXY, REGISTRY], events: [ev(regAbi, "ValidatorAdded"), ev(regAbi, "ValidatorRemoved"), ev(regAbi, "ThresholdUpdated"), ev(sbtAbi, "TokenMinted"), ev(sbtAbi, "Revoked")] },
  from, latest,
);
const by = (n) => scan.filter((l) => l.eventName === n);
out.newEventsSincePreviousScan = {
  ValidatorAdded: by("ValidatorAdded").length, ValidatorRemoved: by("ValidatorRemoved").length,
  ThresholdUpdated: by("ThresholdUpdated").map((l) => ({ block: Number(l.blockNumber), old: String(l.args.oldThreshold), new: String(l.args.newThreshold), tx: l.transactionHash })),
  TokenMinted: by("TokenMinted").length, Revoked: by("Revoked").length,
};
const minted = [...prev.mintedEvents.map((m) => String(m.tokenId)), ...by("TokenMinted").map((l) => String(l.args.tokenId))];
const revokedEv = [...prev.revokedEvents.map((e) => ({ tokenId: String(e.tokenId), reason: e.reason })),
  ...by("Revoked").map((l) => ({ tokenId: String(l.args.tokenId), reason: Number(l.args.reason) }))];
out.registry.addedEventsTotal = (prev.registry.validators?.length ?? 0) + by("ValidatorAdded").length;
out.registry.removedEventsTotal = prev.registry.removedEvents + by("ValidatorRemoved").length;

// ---- 토큰 상태 (revoked() 직접 조회)
const tokens = [];
for (const id of minted) {
  const revoked = await c.readContract({ address: PROXY, abi: sbtAbi, functionName: "revoked", args: [BigInt(id)] });
  const reason = revoked ? Number(await c.readContract({ address: PROXY, abi: sbtAbi, functionName: "revocationReason", args: [BigInt(id)] })) : null;
  tokens.push({ tokenId: id, revoked, reason, revokedEvent: revokedEv.some((e) => e.tokenId === id) });
}
out.tokens = {
  totalMinted: minted.length,
  revokedCount: tokens.filter((x) => x.revoked).length,
  validCount: tokens.filter((x) => !x.revoked).length,
  validTokenIds: tokens.filter((x) => !x.revoked).map((x) => x.tokenId),
  revokedByReason: tokens.filter((x) => x.revoked).reduce((m, x) => ((m[x.reason] = (m[x.reason] ?? 0) + 1), m), {}),
  items: tokens,
};
out.safe = { threshold: String(await c.readContract({ address: SAFE, abi: safeAbi, functionName: "getThreshold" })) };

// ---- 비공개 보조: 영수증 from/to, Safe 소유자 여부 (공개 파일에는 넣지 않는다)
const owners = (await c.readContract({ address: SAFE, abi: safeAbi, functionName: "getOwners" })).map((o) => o.toLowerCase());
out._private = {
  receiptFrom: t.from, receiptTo: t.to, selector: t.input.slice(0, 10),
  fromIsSafeOwner: owners.includes(t.from.toLowerCase()), safeOwnerCount: owners.length,
};
process.stdout.write(JSON.stringify(out, null, 2));
