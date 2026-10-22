#!/usr/bin/env node
/**
 * 폐기 트랜잭션(scheduleBatch/executeBatch) 영수증, 테스트 토큰 현재 상태, 누적 발급 이력, 규칙 집합 승인 대조.
 * 읽기 전용(getLogs 좁은 범위 / getTransactionReceipt / eth_call). 트랜잭션을 보내지 않는다.
 *
 * 입력 : results/raw/exp2_mainnet_test_issuance_gas.json(테스트 발급), 온체인 스캔 결과 JSON(첫 번째 인자),
 *        results/raw/exp2_burn_timelock_scheduleBatch.json(폐기 operationId/tokenIds)
 * 출력 : stdout JSON
 * 환경변수: ALCHEMY_POLYGON_RPC_URL
 */
import { createPublicClient, http, parseAbi, formatEther } from "viem";
import { polygon } from "viem/chains";
import { readFileSync } from "node:fs";

process.on("uncaughtException", (e) => { console.error(String(e.shortMessage ?? e.message).replace(/https?:\/\/\S+/g, "<url>").slice(0, 300)); process.exit(1); });
const RPC = process.env.ALCHEMY_POLYGON_RPC_URL;
if (!RPC) throw new Error("ALCHEMY_POLYGON_RPC_URL not set");
const c = createPublicClient({ chain: polygon, transport: http(RPC, { retryCount: 4, retryDelay: 800 }) });

const scan = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const sched = JSON.parse(readFileSync(process.argv[3], "utf-8"));
const PROXY = "0xb7e3B228308F97431de7d4d4b7690A35B23052Ba";
const TIMELOCK = "0x51caF45eB42eb648dee04f24271134E7046eA2a4";
const SCHED_BLOCK = 95270941n, EXEC_BLOCK = 95349427n;

const tlAbi = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function isOperationDone(bytes32) view returns (bool)",
]);
const sbtAbi = parseAbi([
  "function revoked(uint256) view returns (bool)",
  "function ownerOf(uint256) view returns (address)",
  "function revocationReason(uint256) view returns (uint8)",
  "function revokedAt(uint256) view returns (uint64)",
]);
const ev = (name) => tlAbi.find((x) => x.type === "event" && x.name === name);
const out = {};
const toGwei = (w) => Number(w) / 1e9;

async function receiptInfo(hash) {
  const [r, t] = await Promise.all([c.getTransactionReceipt({ hash }), c.getTransaction({ hash })]);
  const blk = await c.getBlock({ blockNumber: r.blockNumber });
  const wei = r.gasUsed * r.effectiveGasPrice;
  return {
    txHash: hash, blockNumber: Number(r.blockNumber), blockTimestampUtc: new Date(Number(blk.timestamp) * 1000).toISOString(),
    status: r.status, gasUsed: Number(r.gasUsed), effectiveGasPriceGwei: toGwei(r.effectiveGasPrice),
    costPOL: formatEther(wei), to: r.to,
  };
}

// ---- 폐기 트랜잭션
const opId = sched.operationId;
const sLogs = await c.getLogs({ address: TIMELOCK, event: ev("CallScheduled"), args: { id: opId }, fromBlock: SCHED_BLOCK - 4n, toBlock: SCHED_BLOCK + 4n });
const eLogs = await c.getLogs({ address: TIMELOCK, event: ev("CallExecuted"), args: { id: opId }, fromBlock: EXEC_BLOCK - 4n, toBlock: EXEC_BLOCK + 4n });
out.revocation = { operationId: opId, scheduleLogsFound: sLogs.length, executeLogsFound: eLogs.length };
const sTxs = [...new Set(sLogs.map((l) => l.transactionHash))];
const eTxs = [...new Set(eLogs.map((l) => l.transactionHash))];
out.revocation.scheduleTx = sTxs.length === 1 ? await receiptInfo(sTxs[0]) : { error: `schedule tx count=${sTxs.length}`, txs: sTxs };
out.revocation.executeTx = eTxs.length === 1 ? await receiptInfo(eTxs[0]) : { error: `execute tx count=${eTxs.length}`, txs: eTxs };
out.revocation.isOperationDone = await c.readContract({ address: TIMELOCK, abi: tlAbi, functionName: "isOperationDone", args: [opId] });

// ---- 테스트 토큰 10건의 현재 상태
out.testTokens = [];
for (const id of sched.tokenIds) {
  const tid = BigInt(id);
  const revoked = await c.readContract({ address: PROXY, abi: sbtAbi, functionName: "revoked", args: [tid] });
  let ownerOfReverts = false;
  try { await c.readContract({ address: PROXY, abi: sbtAbi, functionName: "ownerOf", args: [tid] }); } catch { ownerOfReverts = true; }
  const reason = revoked ? Number(await c.readContract({ address: PROXY, abi: sbtAbi, functionName: "revocationReason", args: [tid] })) : null;
  const at = revoked ? Number(await c.readContract({ address: PROXY, abi: sbtAbi, functionName: "revokedAt", args: [tid] })) : null;
  const burnEv = scan.revokedEvents.find((e) => e.tokenId === id);
  out.testTokens.push({
    tokenId: id, revoked, ownerOfReverts, revocationReason: reason, revokedAtUtc: at ? new Date(at * 1000).toISOString() : null,
    revokedEventTx: burnEv?.tx ?? null, revokedEventBlock: burnEv?.block ?? null,
  });
}

// ---- 누적 발급 14건 분류 (운영 1 / 테스트 10 / 기타)
const testIds = new Set(sched.tokenIds);
const gasFile = JSON.parse(readFileSync(process.argv[4], "utf-8"));
out.issuance = { totalMintedEvents: scan.mintedEvents.length, items: [] };
for (const m of scan.mintedEvents) {
  const r = await receiptInfo(m.tx);
  let state = { revoked: await c.readContract({ address: PROXY, abi: sbtAbi, functionName: "revoked", args: [BigInt(m.tokenId)] }) };
  try { state.currentOwnerExists = !!(await c.readContract({ address: PROXY, abi: sbtAbi, functionName: "ownerOf", args: [BigInt(m.tokenId)] })); } catch { state.currentOwnerExists = false; }
  out.issuance.items.push({
    category: testIds.has(m.tokenId) ? "test(폐기 대상 10건)" : "other", mintBlock: m.block, mintTx: m.tx, tokenId: m.tokenId,
    missionId: m.missionId, ruleSetId: m.ruleSetId, grade: m.grade, gasUsed: r.gasUsed, effectiveGasPriceGwei: r.effectiveGasPriceGwei, costPOL: r.costPOL,
    blockTimestampUtc: r.blockTimestampUtc, ...state,
  });
}
out.issuance.fromGasFileHashes = JSON.stringify(gasFile).match(/0x[0-9a-fA-F]{64}/g)?.length ?? 0;

// ---- 규칙 집합 승인 대조
out.ruleSetApprovals = scan.ruleSetApproved;
const scDevId = "0xdb2378ffc4ecd58bb08c7d4a99b034d27aaeccef0cf59efb002aee0f05563dc0";
out.scDevProM1 = {
  ruleSetId: scDevId,
  ruleSetIdAmongApprovedEvents: scan.ruleSetApproved.some((a) => a.ruleSetId.toLowerCase() === scDevId),
  ruleSetIdAmongMintedEvents: scan.mintedEvents.some((a) => a.ruleSetId.toLowerCase() === scDevId),
};

// ---- 타임락 실행자 역할 (오픈 실행자 = address(0) 여부)
const execRole = await c.readContract({ address: TIMELOCK, abi: tlAbi, functionName: "EXECUTOR_ROLE" });
out.timelockExecutor = {
  zeroAddressHasExecutorRole: await c.readContract({ address: TIMELOCK, abi: tlAbi, functionName: "hasRole", args: [execRole, "0x0000000000000000000000000000000000000000"] }),
};
process.stdout.write(JSON.stringify(out, null, 2));
