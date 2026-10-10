#!/usr/bin/env node
/**
 * 실험 1 — 체인 끝(chain tip) 관찰 기반 조건 A/B 차이 측정.
 * Amoy 테스트넷 없이, Polygon 메인넷에서 "방금 채굴된 TX"를 그대로 반복 관찰해 조건 A(finalized 고정)와
 * 조건 B(latest, finality 필터 사실상 없음)가 실제로 다르게 나오는지 본다.
 *
 * 설계: TX를 직접 만들지 않는다 — QuickSwap Router와 막 상호작용한 "남의" TX를 체인 끝 근처에서 골라
 * 그 지갑들을 t=0/5s/30s/최종화 후 4개 시점에 걸쳐 Alchemy·PublicNode 두 RPC × 두 조건으로 반복 조회한다.
 * 조건 A는 같은 finalized 블록을 참조하는 한 시점이 달라도 sessionRoot가 그대로여야 하고,
 * 조건 B는 매 시점 latest가 바뀌므로 asOfTimestamp가 달라져 sessionRoot가 달라질 수 있다 — 이 차이 자체가 실험 질문의 답.
 *
 * 절대 규칙 준수: 추정/보간 없음. 전부 실측. 기존 SDK 파이프라인 함수 재사용, 새 로직 없음(RPC 셰이프 변환만 신규).
 *
 * 실행마다 QuickSwap Router 최근 TX와 지갑들을 실시간으로 새로 수집한다 — 재현 시점의 최신 체인 끝
 * 데이터로 자연스럽게 재실행된다(원 실험과 동일 방법론, 동일 TX를 재사용하는 것이 아님에 유의).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  OnchainTxAdapter,
  normalize,
  constructSessions,
  extractFeatures,
  score,
  aggregateSessionRoots,
} from "../../sdk/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const RAW_DIR = resolve(REPO_ROOT, "paper-experiments/results/raw");
mkdirSync(RAW_DIR, { recursive: true });

function loadEnvFile(path) {
  const text = readFileSync(path, "utf-8");
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = loadEnvFile(resolve(REPO_ROOT, "paper-experiments/.env"));
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? env.ETHERSCAN_API_KEY;
if (!ETHERSCAN_API_KEY) {
  console.error("ETHERSCAN_API_KEY 를 찾을 수 없음 — paper-experiments/.env 에 설정하거나 환경변수로 전달하세요 (.env.example 참고).");
  process.exit(1);
}

const PROVIDERS = [
  { key: "alchemy", label: "Alchemy (Alchemy Insights, Inc.)", url: env.ALCHEMY_POLYGON_RPC_URL },
  { key: "publicnode", label: "PublicNode (Allnodes Inc.)", url: env.PUBLICNODE_POLYGON_RPC_URL },
];
const CHAIN_ID = 137;
const MISSION_ID = "GENERIC-R1";
const CONCURRENCY = 3;
const ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"; // QuickSwap V2 Router
const N_WALLETS = 25;
const TIME_POINTS_SEC = [0, 5, 30, 120]; // t=0 / 5s / 30s / 120s(추가 확정 여유)

// ---------- JSON-RPC helpers (run-exp1.mjs와 동일 로직) ----------
async function rpcCall(url, method, params, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      const errObj = json.error ?? (json.code !== undefined ? json : undefined);
      if (res.status === 429 || errObj?.code === -32005 || /too many requests/i.test(errObj?.message ?? "")) {
        if (attempt === retries) throw new Error(`RPC rate-limited after ${retries} retries (${method}): ${JSON.stringify(errObj)}`);
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      if (errObj) throw new Error(`RPC error ${method}: ${JSON.stringify(errObj)}`);
      return json.result;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
function toEtherscanShape(tx, receipt, blockTimestamp) {
  if (!tx) return null;
  const gasUsed = receipt ? BigInt(receipt.gasUsed) : 0n;
  const isError = receipt ? (receipt.status === "0x0" ? "1" : "0") : "0";
  const txreceiptStatus = receipt ? (receipt.status === "0x1" ? "1" : "0") : "1";
  return {
    hash: tx.hash,
    blockNumber: String(BigInt(tx.blockNumber)),
    timeStamp: String(blockTimestamp),
    from: tx.from,
    to: tx.to ?? "",
    value: String(BigInt(tx.value ?? "0x0")),
    gas: String(BigInt(tx.gas ?? "0x0")),
    gasPrice: String(BigInt(tx.gasPrice ?? "0x0")),
    gasUsed: String(gasUsed),
    input: tx.input ?? "0x",
    isError,
    txreceipt_status: txreceiptStatus,
    contractAddress: receipt && receipt.contractAddress ? receipt.contractAddress : undefined,
    nonce: tx.nonce !== undefined ? String(BigInt(tx.nonce)) : undefined,
  };
}
async function fetchWalletActionsFromProvider(url, hashes, blockTimestampCache) {
  const unavailable = [];
  const fetched = await mapLimit(hashes, CONCURRENCY, async (hash) => {
    let tx, receipt;
    try {
      [tx, receipt] = await Promise.all([
        rpcCall(url, "eth_getTransactionByHash", [hash]),
        rpcCall(url, "eth_getTransactionReceipt", [hash]),
      ]);
    } catch (err) {
      unavailable.push({ hash, reason: String(err?.message ?? err) });
      return null;
    }
    if (!tx) { unavailable.push({ hash, reason: "eth_getTransactionByHash returned null" }); return null; }
    return { tx, receipt };
  });
  const valid = fetched.filter(Boolean);
  const blockNumbers = [...new Set(valid.map((v) => BigInt(v.tx.blockNumber)))];
  await mapLimit(blockNumbers, CONCURRENCY, async (bn) => {
    const cacheKey = `${url}::${bn}`;
    if (blockTimestampCache.has(cacheKey)) return;
    const blk = await rpcCall(url, "eth_getBlockByNumber", [`0x${bn.toString(16)}`, false]);
    blockTimestampCache.set(cacheKey, blk ? BigInt(blk.timestamp) : null);
  });
  const rawTxs = valid
    .map(({ tx, receipt }) => toEtherscanShape(tx, receipt, blockTimestampCache.get(`${url}::${BigInt(tx.blockNumber)}`)))
    .filter(Boolean);
  return { rawTxs, unavailable };
}

const adapter = new OnchainTxAdapter({ chainId: CHAIN_ID, apiKey: "unused-local-conversion-only" });
function runPipeline(rawTxs, subject, ruleSetBody, ruleSetId, asOfTimestamp, referenceBlockNumber) {
  const standardActions = rawTxs.map((rt) => adapter.normalize(rt));
  const normalized = normalize({ actions: standardActions, anchor: { asOfTimestamp }, parentIntegrity: "drop-orphans" });
  const sessions = constructSessions({
    actions: normalized, rule: ruleSetBody.sessionBoundaryRule, subject, missionId: MISSION_ID, ruleSetId,
    method: "combined", ...(referenceBlockNumber !== undefined ? { referenceBlockNumber } : {}),
  });
  if (sessions.length === 0) return { sessionCount: 0, sessionRoot: null, avgScore: null };
  const perSession = sessions.map((session) => {
    const features = extractFeatures({ session, evidenceMapping: ruleSetBody.evidenceMapping });
    const result = score({ features, weights: ruleSetBody.featureWeights, thresholds: ruleSetBody.gradeThresholds });
    return { score: result.score, grade: result.grade };
  });
  const avgScore = Math.round(perSession.reduce((s, r) => s + r.score, 0) / perSession.length);
  return { sessionCount: sessions.length, sessionRoot: aggregateSessionRoots(sessions), avgScore };
}

// ---------- 1) 체인 끝 근처 지갑 수집 (Etherscan V2, QuickSwap Router 최근 TX) ----------
async function fetchRouterRecentWallets() {
  const url = `https://api.etherscan.io/v2/api?chainid=137&module=account&action=txlist&address=${ROUTER}&sort=desc&page=1&offset=1000&apikey=${ETHERSCAN_API_KEY}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== "1" && !(Array.isArray(json.result))) {
    throw new Error(`Etherscan router txlist 실패: ${JSON.stringify(json).slice(0, 300)}`);
  }
  const txs = json.result;
  writeFileSync(resolve(RAW_DIR, "exp1b_router_txlist_raw.json"), JSON.stringify(txs, null, 2));
  // "최신 블록" 순서(desc) 그대로에서 중복 없는 from 주소를 앞에서부터 N_WALLETS개 추출 — 셔플 없음(체인 끝에 가장 가까운 것 우선)
  const seen = new Set();
  const wallets = [];
  for (const tx of txs) {
    const from = tx.from?.toLowerCase();
    if (!from || seen.has(from)) continue;
    seen.add(from);
    wallets.push(from);
    if (wallets.length >= N_WALLETS) break;
  }
  return { wallets, latestBlock: txs[0]?.blockNumber, latestTxTime: txs[0]?.timeStamp };
}

async function fetchOwnRecentHashes(wallet) {
  const url = `https://api.etherscan.io/v2/api?chainid=137&module=account&action=txlist&address=${wallet}&sort=desc&page=1&offset=15&apikey=${ETHERSCAN_API_KEY}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== "1" && !(Array.isArray(json.result))) return [];
  return json.result.map((t) => t.hash);
}

// ---------- main ----------
async function main() {
  const startedAtKst = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  console.log(`[ENV] OS=${process.platform} Node=${process.version} 측정시작(KST)=${startedAtKst}`);

  const ruleSetFile = JSON.parse(readFileSync(resolve(REPO_ROOT, "rulesets/GENERIC-R1.json"), "utf-8"));
  const ruleSetBody = ruleSetFile.ruleSetBody;
  const ruleSetId = ruleSetFile.ruleSetId;

  console.log(`[STEP1] QuickSwap Router 최근 TX에서 체인 끝 근처 지갑 ${N_WALLETS}개 수집...`);
  const { wallets, latestBlock, latestTxTime } = await fetchRouterRecentWallets();
  console.log(`[STEP1] 수집 완료 — router 최신 TX 블록=${latestBlock}, ts=${latestTxTime}, 고유 지갑=${wallets.length}개`);

  console.log(`[STEP2] 각 지갑 자신의 최근 TX 해시(최대 15건) 수집...`);
  const walletHashes = {};
  for (const w of wallets) {
    walletHashes[w] = await fetchOwnRecentHashes(w);
    await new Promise((r) => setTimeout(r, 210)); // Etherscan free tier: 5 req/s 제한 회피
  }
  writeFileSync(resolve(RAW_DIR, "exp1b_chaintip_wallets.json"), JSON.stringify({ wallets, latestBlock, latestTxTime, walletHashes }, null, 2));

  const t0 = Date.now();
  const timeSeriesRows = []; // {tSec, wallet_hash, provider, condition, sessionRoot, avgScore, finalizedBlock, latestBlock, finalizedHash}
  const blockTimestampCache = new Map();

  for (const tSec of TIME_POINTS_SEC) {
    const waitMs = t0 + tSec * 1000 - Date.now();
    if (waitMs > 0) {
      console.log(`[WAIT] t=${tSec}s 시점까지 ${Math.round(waitMs / 1000)}초 대기...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    console.log(`\n[시점 t=${tSec}s] ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} — 측정 시작`);

    for (const p of PROVIDERS) {
      const [finBlk, latBlk] = await Promise.all([
        rpcCall(p.url, "eth_getBlockByNumber", ["finalized", false]),
        rpcCall(p.url, "eth_getBlockByNumber", ["latest", false]),
      ]);
      const finalizedNumber = BigInt(finBlk.number);
      const finalizedTs = BigInt(finBlk.timestamp);
      const latestTs = BigInt(latBlk.timestamp);
      console.log(`  [${p.key}] finalized=#${finalizedNumber}(hash=${finBlk.hash.slice(0,10)}..) latest=#${BigInt(latBlk.number)}`);

      for (const wallet of wallets) {
        const walletHash = createHash("sha256").update(wallet).digest("hex").slice(0, 16);
        const hashes = walletHashes[wallet];
        if (!hashes || hashes.length === 0) continue;
        const { rawTxs } = await fetchWalletActionsFromProvider(p.url, hashes, blockTimestampCache);
        const condA = runPipeline(rawTxs, wallet, ruleSetBody, ruleSetId, Number(finalizedTs), finalizedNumber);
        const condB = runPipeline(rawTxs, wallet, ruleSetBody, ruleSetId, Number(latestTs), undefined);
        timeSeriesRows.push({ tSec, provider: p.key, wallet_hash: walletHash, condition: "A_finalized", sessionRoot: condA.sessionRoot, avgScore: condA.avgScore, finalizedBlock: finalizedNumber.toString(), finalizedHash: finBlk.hash });
        timeSeriesRows.push({ tSec, provider: p.key, wallet_hash: walletHash, condition: "B_latest", sessionRoot: condB.sessionRoot, avgScore: condB.avgScore, finalizedBlock: finalizedNumber.toString(), finalizedHash: finBlk.hash });
      }
    }
  }

  writeFileSync(resolve(RAW_DIR, "exp1b_chaintip_timeseries.json"), JSON.stringify(timeSeriesRows, null, 2));

  // ---------- 분석: 조건별로 시점 간 sessionRoot가 안정적인지, RPC 간 매 시점 일치하는지 ----------
  const wallets_ = [...new Set(timeSeriesRows.map((r) => r.wallet_hash))];
  let condA_stableAcrossTime = 0, condB_stableAcrossTime = 0;
  let condA_matchAcrossProvider = 0, condB_matchAcrossProvider = 0, totalProviderChecks = 0;

  for (const wh of wallets_) {
    for (const cond of ["A_finalized", "B_latest"]) {
      const rowsForWallet = timeSeriesRows.filter((r) => r.wallet_hash === wh && r.condition === cond);
      // 시점 간 안정성 (provider 고정, alchemy만 기준)
      const alchemyRows = rowsForWallet.filter((r) => r.provider === "alchemy").sort((a, b) => a.tSec - b.tSec);
      const stable = alchemyRows.every((r) => r.sessionRoot === alchemyRows[0].sessionRoot);
      if (cond === "A_finalized" && stable) condA_stableAcrossTime++;
      if (cond === "B_latest" && stable) condB_stableAcrossTime++;
      // provider 간 매 시점 일치
      for (const tSec of TIME_POINTS_SEC) {
        const a = rowsForWallet.find((r) => r.provider === "alchemy" && r.tSec === tSec);
        const b = rowsForWallet.find((r) => r.provider === "publicnode" && r.tSec === tSec);
        if (!a || !b) continue;
        totalProviderChecks++;
        const match = a.sessionRoot === b.sessionRoot && a.avgScore === b.avgScore;
        if (cond === "A_finalized" && match) condA_matchAcrossProvider++;
        if (cond === "B_latest" && match) condB_matchAcrossProvider++;
      }
    }
  }

  console.log(`\n[요약]`);
  console.log(`  조건 A(finalized) — 시점 간(0/5/30/120s) sessionRoot 안정(동일) 지갑: ${condA_stableAcrossTime}/${wallets_.length}`);
  console.log(`  조건 B(latest)    — 시점 간 sessionRoot 안정(동일) 지갑: ${condB_stableAcrossTime}/${wallets_.length}`);
  console.log(`  조건 A — RPC(alchemy↔publicnode) 매 시점 일치: ${condA_matchAcrossProvider}/${totalProviderChecks / 2}`);
  console.log(`  조건 B — RPC(alchemy↔publicnode) 매 시점 일치: ${condB_matchAcrossProvider}/${totalProviderChecks / 2}`);

  writeFileSync(resolve(RAW_DIR, "exp1b_chaintip_summary.json"), JSON.stringify({
    nWallets: wallets_.length,
    timePoints: TIME_POINTS_SEC,
    condA_stableAcrossTime, condB_stableAcrossTime,
    condA_matchAcrossProvider, condB_matchAcrossProvider, totalProviderChecksPerCondition: totalProviderChecks / 2,
    measuredAtKst: startedAtKst,
  }, null, 2));

  console.log(`\n측정종료(KST)=${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
}

main().catch((err) => { console.error("[FATAL]", err); process.exit(1); });
