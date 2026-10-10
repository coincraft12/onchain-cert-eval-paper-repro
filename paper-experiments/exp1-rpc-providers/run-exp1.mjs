#!/usr/bin/env node
/**
 * 실험 1 — 독립 RPC 3곳 간 재현성.
 * 절대 규칙 준수: 추정/보간 없음. 전부 실측 RPC 응답. 기존 SDK(normalize/constructSessions/
 * extractFeatures/score/computeRuleSetId/aggregateSessionRoots) 재사용, 새 파이프라인 로직 없음.
 * 새로 작성한 부분은 "RPC 원시 응답 → EtherscanRawTx 호환 셰이프 변환"뿐 (OnchainTxAdapter.normalize가
 * 그 셰이프를 기대하므로).
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
const RESULTS_DIR = resolve(REPO_ROOT, "paper-experiments/results");
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

const ALL_PROVIDERS = [
  { key: "alchemy", label: "Alchemy (Alchemy Insights, Inc.)", url: env.ALCHEMY_POLYGON_RPC_URL },
  { key: "publicnode", label: "PublicNode (Allnodes Inc.)", url: env.PUBLICNODE_POLYGON_RPC_URL },
  { key: "infura", label: "Infura (Consensys Software Inc.)", url: env.INFURA_POLYGON_RPC_URL },
  { key: "drpc", label: "dRPC (운영 법인 공식 확인 불가 — drpc.org 사이트에 법인명 미게재, 2026-10-10 기준)", url: env.DRPC_POLYGON_RPC_URL },
];
// 원 실험에서: Infura는 2026-10-07 지속적 429(쿼터 소진 추정)로 제외, Ankr(polygon-rpc.com)는 다운.
// dRPC를 3번째 제공자로 대체 사용. 이 재현 저장소에서는 사용자가 보유한 RPC 키 조합에 맞춰
// EXP1_EXCLUDE_PROVIDERS 환경변수로 활성 제공자를 자유롭게 선택하면 된다(기본: infura 제외).
const EXCLUDE = (process.env.EXP1_EXCLUDE_PROVIDERS ?? "infura").split(",").filter(Boolean);
const PROVIDERS = ALL_PROVIDERS.filter((p) => p.url && !EXCLUDE.includes(p.key));
console.log(`[PROVIDERS] 활성: ${PROVIDERS.map((p) => p.key).join(", ")}` + (EXCLUDE.length ? ` | 제외: ${EXCLUDE.join(", ")}` : ""));
if (PROVIDERS.length < 2) {
  console.error("[FATAL] 활성 RPC 제공자가 2개 미만입니다. paper-experiments/.env.example 참고해 .env를 채워주세요.");
  process.exit(1);
}

const CHAIN_ID = 137;
const MISSION_ID = "GENERIC-R1";
const CONCURRENCY = 3;

// ---------- JSON-RPC helpers ----------

async function rpcCall(url, method, params, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      // 두 가지 에러 셰이프 모두 처리: {error:{...}} (Alchemy/PublicNode 표준) / {code,message} (Infura 429 등 최상위)
      const errObj = json.error ?? (json.code !== undefined ? json : undefined);
      if (res.status === 429 || errObj?.code === -32005 || /too many requests/i.test(errObj?.message ?? "")) {
        if (attempt === retries) throw new Error(`RPC rate-limited after ${retries} retries (${method}): ${JSON.stringify(errObj)}`);
        const backoff = 1000 * Math.pow(2, attempt); // 1s,2s,4s,8s,16s
        await new Promise((r) => setTimeout(r, backoff));
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

// ---------- RPC raw tx -> EtherscanRawTx shape ----------

function toEtherscanShape(tx, receipt, blockTimestamp) {
  if (!tx) return null; // tx not found (e.g. pending/dropped) — measured-unavailable
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
    if (!tx) {
      unavailable.push({ hash, reason: "eth_getTransactionByHash returned null" });
      return null;
    }
    return { tx, receipt };
  });

  const valid = fetched.filter(Boolean);
  const blockNumbers = [...new Set(valid.map((v) => BigInt(v.tx.blockNumber)))];
  await mapLimit(blockNumbers, CONCURRENCY, async (bn) => {
    const cacheKey = `${url}::${bn}`;
    if (blockTimestampCache.has(cacheKey)) return;
    const blk = await rpcCall(url, "eth_getBlockByNumber", [`0x${bn.toString(16)}`, false]);
    if (!blk) {
      console.error(`[WARN] eth_getBlockByNumber(${bn}) via ${url} returned falsy:`, blk);
      blockTimestampCache.set(cacheKey, null);
      return;
    }
    blockTimestampCache.set(cacheKey, BigInt(blk.timestamp));
  });

  const rawTxs = valid
    .map(({ tx, receipt }) => {
      const ts = blockTimestampCache.get(`${url}::${BigInt(tx.blockNumber)}`);
      return toEtherscanShape(tx, receipt, ts);
    })
    .filter(Boolean);

  return { rawTxs, unavailable };
}

// ---------- pipeline (reuses SDK only) ----------

const adapter = new OnchainTxAdapter({ chainId: CHAIN_ID, apiKey: "unused-local-conversion-only" });

function runPipeline(rawTxs, subject, ruleSetBody, ruleSetId, asOfTimestamp, referenceBlockNumber) {
  const standardActions = rawTxs.map((rt) => adapter.normalize(rt));
  const normalized = normalize({
    actions: standardActions,
    anchor: { asOfTimestamp },
    parentIntegrity: "drop-orphans",
  });
  const sessions = constructSessions({
    actions: normalized,
    rule: ruleSetBody.sessionBoundaryRule,
    subject,
    missionId: MISSION_ID,
    ruleSetId,
    method: "combined",
    ...(referenceBlockNumber !== undefined ? { referenceBlockNumber } : {}),
  });
  if (sessions.length === 0) {
    return { sessionCount: 0, sessionRoot: null, avgScore: null };
  }
  const perSession = sessions.map((session) => {
    const features = extractFeatures({ session, evidenceMapping: ruleSetBody.evidenceMapping });
    const result = score({ features, weights: ruleSetBody.featureWeights, thresholds: ruleSetBody.gradeThresholds });
    return { score: result.score, grade: result.grade };
  });
  const avgScore = Math.round(perSession.reduce((s, r) => s + r.score, 0) / perSession.length);
  const sessionRoot = aggregateSessionRoots(sessions);
  return { sessionCount: sessions.length, sessionRoot, avgScore, perSession };
}

// ---------- main ----------

async function main() {
  const startedAtKst = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  console.log(`[ENV] OS=${process.platform} Node=${process.version} 측정시작(KST)=${startedAtKst}`);

  const ruleSetFile = JSON.parse(readFileSync(resolve(REPO_ROOT, "rulesets/GENERIC-R1.json"), "utf-8"));
  const ruleSetBody = ruleSetFile.ruleSetBody;
  const ruleSetId = ruleSetFile.ruleSetId;
  console.log(`[RULESET] GENERIC-R1 id=${ruleSetId}`);

  const walletTxListFile = process.argv[2] ?? "exp1_wallet_txlists.json";
  const walletTxLists = JSON.parse(readFileSync(resolve(RAW_DIR, walletTxListFile), "utf-8"));
  const wallets = Object.keys(walletTxLists).filter((w) => (walletTxLists[w].hashes ?? []).length > 0);
  console.log(`[WALLETS] ${wallets.length}개 (해시 1건 이상)`);

  // ---------- 1) 제공자별 finalized/latest 블록 1회 조회 ----------
  const providerAnchors = {};
  for (const p of PROVIDERS) {
    if (!p.url) {
      console.error(`[FATAL] ${p.key}: URL 이 비어있음 (.env 확인 필요)`);
      process.exit(1);
    }
    let finBlk, latBlk;
    try {
      [finBlk, latBlk] = await Promise.all([
        rpcCall(p.url, "eth_getBlockByNumber", ["finalized", false]),
        rpcCall(p.url, "eth_getBlockByNumber", ["latest", false]),
      ]);
    } catch (err) {
      console.error(`[FATAL] ${p.key} anchor 조회 실패:`, err.message);
      process.exit(1);
    }
    if (!finBlk || !latBlk) {
      console.error(`[FATAL] ${p.key}: anchor 응답이 비어있음 fin=${JSON.stringify(finBlk)} lat=${JSON.stringify(latBlk)}`);
      process.exit(1);
    }
    providerAnchors[p.key] = {
      finalized: { number: BigInt(finBlk.number), timestamp: BigInt(finBlk.timestamp), hash: finBlk.hash },
      latest: { number: BigInt(latBlk.number), timestamp: BigInt(latBlk.timestamp), hash: latBlk.hash },
    };
    console.log(`[ANCHOR] ${p.key}: finalized=#${BigInt(finBlk.number)} latest=#${BigInt(latBlk.number)}`);
  }
  writeFileSync(
    resolve(RAW_DIR, "exp1_provider_anchors.json"),
    JSON.stringify(providerAnchors, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );

  // ---------- 2) 지갑 x 제공자별 실제 조회 + 파이프라인 실행 ----------
  const rows = []; // csv rows: wallet_hash, rpc_a, rpc_b, condition, sessionRoot_a, sessionRoot_b, match, score_a, score_b
  const perWalletRaw = {};
  const unavailableLog = {};
  const blockTimestampCache = new Map();

  let walletIdx = 0;
  for (const wallet of wallets) {
    walletIdx++;
    const hashes = walletTxLists[wallet].hashes;
    const walletHash = createHash("sha256").update(wallet).digest("hex").slice(0, 16);
    const perProviderResult = {};

    for (const p of PROVIDERS) {
      const { rawTxs, unavailable } = await fetchWalletActionsFromProvider(p.url, hashes, blockTimestampCache);
      if (unavailable.length > 0) {
        unavailableLog[`${wallet}::${p.key}`] = unavailable;
      }
      const anchors = providerAnchors[p.key];
      const condA = runPipeline(rawTxs, wallet, ruleSetBody, ruleSetId, Number(anchors.finalized.timestamp), anchors.finalized.number);
      const condB = runPipeline(rawTxs, wallet, ruleSetBody, ruleSetId, Number(anchors.latest.timestamp), undefined);
      perProviderResult[p.key] = { fetchedTxCount: rawTxs.length, unavailableCount: unavailable.length, condA, condB };
    }

    perWalletRaw[wallet] = perProviderResult;

    // RPC 쌍 비교 — 활성 PROVIDERS 목록에서 동적 생성 (제외된 제공자는 자동으로 빠짐)
    const activeKeys = PROVIDERS.map((p) => p.key);
    const pairs = [];
    for (let i = 0; i < activeKeys.length; i++) {
      for (let j = i + 1; j < activeKeys.length; j++) pairs.push([activeKeys[i], activeKeys[j]]);
    }
    for (const [a, b] of pairs) {
      for (const cond of ["condA", "condB"]) {
        const ra = perProviderResult[a][cond];
        const rb = perProviderResult[b][cond];
        const match = ra.sessionRoot === rb.sessionRoot && ra.avgScore === rb.avgScore;
        rows.push({
          wallet_hash: walletHash,
          rpc_a: a,
          rpc_b: b,
          condition: cond === "condA" ? "A_finalized" : "B_latest",
          sessionRoot_a: ra.sessionRoot ?? "null",
          sessionRoot_b: rb.sessionRoot ?? "null",
          match: match ? "1" : "0",
          score_a: ra.avgScore ?? "null",
          score_b: rb.avgScore ?? "null",
        });
      }
    }

    if (walletIdx % 5 === 0) console.log(`[진행] ${walletIdx}/${wallets.length} 지갑 완료`);
  }

  writeFileSync(
    resolve(RAW_DIR, "exp1_per_wallet_raw.json"),
    JSON.stringify(perWalletRaw, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  writeFileSync(resolve(RAW_DIR, "exp1_unavailable_log.json"), JSON.stringify(unavailableLog, null, 2));

  // ---------- CSV 출력 ----------
  const header = "wallet_hash,rpc_a,rpc_b,condition,sessionRoot_a,sessionRoot_b,match,score_a,score_b";
  const csvLines = [header, ...rows.map((r) => [r.wallet_hash, r.rpc_a, r.rpc_b, r.condition, r.sessionRoot_a, r.sessionRoot_b, r.match, r.score_a, r.score_b].join(","))];
  writeFileSync(resolve(RESULTS_DIR, "exp1_reproducibility.csv"), csvLines.join("\n"));

  // ---------- 요약 ----------
  const byCondition = { A_finalized: { total: 0, match: 0 }, B_latest: { total: 0, match: 0 } };
  for (const r of rows) {
    byCondition[r.condition].total++;
    if (r.match === "1") byCondition[r.condition].match++;
  }
  console.log("\n[요약]");
  for (const [cond, v] of Object.entries(byCondition)) {
    console.log(`  ${cond}: 일치 ${v.match}/${v.total} (${((v.match / v.total) * 100).toFixed(1)}%)`);
  }
  console.log(`\n불일치/조회불가 상세: exp1_unavailable_log.json, exp1_per_wallet_raw.json 참고`);
  console.log(`측정종료(KST)=${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
}

main().catch((err) => {
  console.error("exp1 실패:", err);
  process.exit(1);
});
