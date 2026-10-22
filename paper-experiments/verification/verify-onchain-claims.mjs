#!/usr/bin/env node
/**
 * 원고 V장 수치의 온체인 근거 확인 — 읽기 전용(eth_call / getLogs / getTransactionReceipt / getCode).
 * 트랜잭션을 보내지 않는다. 결과는 stdout에 JSON 한 덩어리로 낸다(파일 저장은 호출자가 한다).
 *
 * 사용: ALCHEMY_POLYGON_RPC_URL=... node verify-onchain-claims.mjs > out.json
 * 아카이브 노드(getCode 이력 조회, 과거 블록 getLogs)가 필요하다.
 */
import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { polygon } from "viem/chains";

process.on("uncaughtException", (e) => { console.error(String(e.shortMessage ?? e.message).replace(/https?:\/\/\S+/g, "<url>").slice(0, 300)); process.exit(1); });
const RPC = process.env.ALCHEMY_POLYGON_RPC_URL;
if (!RPC) throw new Error("ALCHEMY_POLYGON_RPC_URL not set");
const c = createPublicClient({ chain: polygon, transport: http(RPC, { retryCount: 4, retryDelay: 800 }) });

const PROXY = "0xb7e3B228308F97431de7d4d4b7690A35B23052Ba";
const TIMELOCK = "0x51caF45eB42eb648dee04f24271134E7046eA2a4";
const SAFE = "0x2A04904440D4C340dBEd5031b31CBDCEd19b0dF5";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const sbtAbi = parseAbi([
  "function validatorRegistry() view returns (address)",
  "function owner() view returns (address)",
  "function supportsInterface(bytes4) view returns (bool)",
  "event TokenMinted(address indexed user, bytes32 indexed missionId, uint256 indexed tokenId, uint8 grade, bytes32 ruleSetId)",
  "event RuleSetApproved(bytes32 indexed missionId, bytes32 indexed ruleSetId)",
  "event RuleSetRevoked(bytes32 indexed missionId, bytes32 indexed ruleSetId)",
  "event Revoked(uint256 indexed tokenId, address indexed previousOwner, uint8 reason, uint256 timestamp)",
]);
const regAbi = parseAbi([
  "function threshold() view returns (uint256)",
  "function activeCount() view returns (uint256)",
  "function owner() view returns (address)",
  "function isActive(address) view returns (bool)",
  "event ValidatorAdded(address indexed validator, string nodeId)",
  "event ValidatorRemoved(address indexed validator)",
  "event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold)",
]);
const tlAbi = parseAbi([
  "function getMinDelay() view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
]);
const safeAbi = parseAbi([
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
]);


// getLogs는 무료 RPC의 블록 범위 제한(10,000)에 맞춰 나눠 조회한다. 로그 조회용 RPC는 별도(INFURA_POLYGON_RPC_URL).
const LOGS_RPC = process.env.INFURA_POLYGON_RPC_URL;
if (!LOGS_RPC) throw new Error("INFURA_POLYGON_RPC_URL not set (getLogs용)");
const lc = createPublicClient({ chain: polygon, transport: http(LOGS_RPC, { retryCount: 0 }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function logsChunked(params, from, to, step = 10000n) {
  const all = [];
  for (let a = from; a <= to; a += step) {
    const b = a + step - 1n > to ? to : a + step - 1n;
    for (let attempt = 0; ; attempt++) {
      try { all.push(...(await lc.getLogs({ ...params, fromBlock: a, toBlock: b }))); break; }
      catch (e) { if (attempt >= 8) throw e; await sleep(1500 * (attempt + 1)); }
    }
    await sleep(120);
  }
  return all;
}

const out = {};
const tryit = async (f) => {
  try { return await f(); } catch (e) { return { error: String(e.shortMessage ?? e.message).slice(0, 200) }; }
};
const latest = await c.getBlockNumber();
out.latestBlock = Number(latest);

// 배포 블록: 코드가 처음 존재하는 블록(이분 탐색, 아카이브 getCode)
async function hasCode(addr, bn) {
  const code = await c.getCode({ address: addr, blockNumber: bn });
  return !!code && code !== "0x";
}
async function firstCodeBlock(addr) {
  let lo = 1n, hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await hasCode(addr, mid)) hi = mid; else lo = mid + 1n;
  }
  return lo;
}
const proxyBlock = await firstCodeBlock(PROXY);
out.proxyFirstCodeBlock = Number(proxyBlock);
out.timelockFirstCodeBlock = Number(await firstCodeBlock(TIMELOCK));
out.safeFirstCodeBlock = Number(await firstCodeBlock(SAFE));

// 구현 컨트랙트 / owner / ERC-5192
const implRaw = await c.getStorageAt({ address: PROXY, slot: IMPL_SLOT });
out.implementation = getAddress("0x" + implRaw.slice(-40));
out.proxyOwner = await tryit(() => c.readContract({ address: PROXY, abi: sbtAbi, functionName: "owner" }));
out.erc5192 = await tryit(() => c.readContract({ address: PROXY, abi: sbtAbi, functionName: "supportsInterface", args: ["0xb45a3c0e"] }));

// 검증자 레지스트리
const registry = await c.readContract({ address: PROXY, abi: sbtAbi, functionName: "validatorRegistry" });
out.registry = { address: registry };
out.registry.threshold = String(await c.readContract({ address: registry, abi: regAbi, functionName: "threshold" }));
out.registry.activeCount = String(await c.readContract({ address: registry, abi: regAbi, functionName: "activeCount" }));
out.registry.owner = await c.readContract({ address: registry, abi: regAbi, functionName: "owner" });
const regFrom = await firstCodeBlock(registry);
out.registry.firstCodeBlock = Number(regFrom);
const ev = (abi, name) => abi.find((x) => x.type === "event" && x.name === name);
// 프록시와 레지스트리는 같은 시기에 배포됐으므로 한 번의 스캔으로 이벤트를 모두 가져온다.
const scanFrom = proxyBlock < regFrom ? proxyBlock : regFrom;
const scan = await logsChunked(
  {
    address: [PROXY, registry],
    events: [
      ev(regAbi, "ValidatorAdded"), ev(regAbi, "ValidatorRemoved"), ev(regAbi, "ThresholdUpdated"),
      ev(sbtAbi, "TokenMinted"), ev(sbtAbi, "RuleSetApproved"), ev(sbtAbi, "RuleSetRevoked"), ev(sbtAbi, "Revoked"),
    ],
  },
  scanFrom, latest,
);
const by = (name) => scan.filter((l) => l.eventName === name);
const added = by("ValidatorAdded");
const removed = by("ValidatorRemoved");
const thr = by("ThresholdUpdated");
const validators = [...new Set(added.map((l) => l.args.validator))];
out.registry.validators = [];
for (const v of validators) {
  out.registry.validators.push({
    address: v,
    nodeId: added.find((l) => l.args.validator === v).args.nodeId,
    active: await c.readContract({ address: registry, abi: regAbi, functionName: "isActive", args: [v] }),
  });
}
out.registry.removedEvents = removed.length;
out.registry.thresholdHistory = thr.map((l) => ({
  block: Number(l.blockNumber), old: String(l.args.oldThreshold), new: String(l.args.newThreshold), tx: l.transactionHash,
}));

// 타임락
out.timelock = {};
out.timelock.minDelay = String(await c.readContract({ address: TIMELOCK, abi: tlAbi, functionName: "getMinDelay" }));
const roles = {};
for (const r of ["PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE", "DEFAULT_ADMIN_ROLE"]) {
  const id = await c.readContract({ address: TIMELOCK, abi: tlAbi, functionName: r });
  roles[r] = {
    safeHasRole: await c.readContract({ address: TIMELOCK, abi: tlAbi, functionName: "hasRole", args: [id, SAFE] }),
    timelockSelfHasRole: await c.readContract({ address: TIMELOCK, abi: tlAbi, functionName: "hasRole", args: [id, TIMELOCK] }),
  };
}
out.timelock.roles = roles;
out.timelock.proxyOwnerIsTimelock =
  typeof out.proxyOwner === "string" && out.proxyOwner.toLowerCase() === TIMELOCK.toLowerCase();

// Safe
out.safe = {};
out.safe.threshold = String(await c.readContract({ address: SAFE, abi: safeAbi, functionName: "getThreshold" }));
const owners = await c.readContract({ address: SAFE, abi: safeAbi, functionName: "getOwners" });
out.safe.ownerCount = owners.length;
out.safe.version = await tryit(() => c.readContract({ address: SAFE, abi: safeAbi, functionName: "VERSION" }));

// 발급 이력(TokenMinted) / 규칙 집합 승인·철회 / 폐기 이벤트
const minted = by("TokenMinted");
out.mintedEvents = minted.map((l) => ({
  block: Number(l.blockNumber), tx: l.transactionHash, missionId: l.args.missionId,
  tokenId: String(l.args.tokenId), grade: Number(l.args.grade), ruleSetId: l.args.ruleSetId,
}));
const appr = by("RuleSetApproved");
const rev = by("RuleSetRevoked");
out.ruleSetApproved = appr.map((l) => ({ block: Number(l.blockNumber), tx: l.transactionHash, missionId: l.args.missionId, ruleSetId: l.args.ruleSetId }));
out.ruleSetRevoked = rev.map((l) => ({ block: Number(l.blockNumber), tx: l.transactionHash, missionId: l.args.missionId, ruleSetId: l.args.ruleSetId }));
const burned = by("Revoked");
out.revokedEvents = burned.map((l) => ({ block: Number(l.blockNumber), tx: l.transactionHash, tokenId: String(l.args.tokenId), reason: Number(l.args.reason) }));

process.stdout.write(JSON.stringify(out, null, 2));
