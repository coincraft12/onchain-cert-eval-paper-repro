#!/usr/bin/env node
/**
 * 입력 완전성 검사 — exp1b 체인 끝 관찰에서 드러난 "조용한 데이터 누락" 문제의 수정판.
 *
 * 문제: run-exp1-chaintip.mjs(및 run-exp1.mjs)는 일부 TX를 RPC가 못 찾으면(unavailable) 그냥 나머지만으로
 * sessionRoot를 계산했다 — 검증자가 보기엔 "정상적으로 계산된 다른 값"이라 마치 데이터가 조작된 것처럼
 * 오판할 위험이 있다(실제로는 특정 공개 RPC의 과거 데이터 보존 범위 문제였을 뿐인데).
 *
 * 수정: 평가 대상 TX 해시 목록을 먼저 고정하고, 그중 단 하나라도 조회 실패하면 sessionRoot를 계산하지 않고
 * "UNVERIFIABLE"을 명시적으로 반환한다. 기존 run-exp1*.mjs 파일은 건드리지 않음 — 새 스크립트로 분리.
 *
 * 입력: exp1b_chaintip_wallets.json (지갑 + 고정 해시 목록 — run-exp1-chaintip.mjs 실행 결과를 재사용)
 */
import { readFileSync, writeFileSync } from "node:fs";
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
const PROVIDERS = [
  { key: "alchemy", url: env.ALCHEMY_POLYGON_RPC_URL },
  { key: "publicnode", url: env.PUBLICNODE_POLYGON_RPC_URL },
];
const CHAIN_ID = 137;
const MISSION_ID = "GENERIC-R1";
const CONCURRENCY = 3;

async function rpcCall(url, method, params, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const json = await res.json();
      const errObj = json.error ?? (json.code !== undefined ? json : undefined);
      if (res.status === 429 || errObj?.code === -32005) {
        if (attempt === retries) throw new Error(`rate-limited: ${JSON.stringify(errObj)}`);
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
  async function worker() { while (idx < items.length) { const i = idx++; results[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
function toEtherscanShape(tx, receipt, blockTimestamp) {
  if (!tx) return null;
  const gasUsed = receipt ? BigInt(receipt.gasUsed) : 0n;
  return {
    hash: tx.hash, blockNumber: String(BigInt(tx.blockNumber)), timeStamp: String(blockTimestamp),
    from: tx.from, to: tx.to ?? "", value: String(BigInt(tx.value ?? "0x0")), gas: String(BigInt(tx.gas ?? "0x0")),
    gasPrice: String(BigInt(tx.gasPrice ?? "0x0")), gasUsed: String(gasUsed), input: tx.input ?? "0x",
    isError: receipt ? (receipt.status === "0x0" ? "1" : "0") : "0",
    txreceipt_status: receipt ? (receipt.status === "0x1" ? "1" : "0") : "1",
    nonce: tx.nonce !== undefined ? String(BigInt(tx.nonce)) : undefined,
  };
}

/**
 * 입력 완전성 검사 포함 fetch — 기존 fetchWalletActionsFromProvider와 달리
 * "요청한 해시 개수 == 성공적으로 받은 개수" 를 엄격히 확인하고, 하나라도 모자라면
 * complete:false 를 반환(그러면 호출부는 sessionRoot 계산을 하지 않고 UNVERIFIABLE 처리).
 */
async function fetchWithIntegrityCheck(url, expectedHashes, blockTimestampCache) {
  const fetched = await mapLimit(expectedHashes, CONCURRENCY, async (hash) => {
    let tx, receipt;
    try {
      [tx, receipt] = await Promise.all([
        rpcCall(url, "eth_getTransactionByHash", [hash]),
        rpcCall(url, "eth_getTransactionReceipt", [hash]),
      ]);
    } catch (err) {
      return { hash, ok: false, reason: String(err?.message ?? err) };
    }
    if (!tx) return { hash, ok: false, reason: "null (not found)" };
    return { hash, ok: true, tx, receipt };
  });

  const missing = fetched.filter((f) => !f.ok);
  if (missing.length > 0) {
    return { complete: false, missing: missing.map((m) => ({ hash: m.hash, reason: m.reason })), rawTxs: [] };
  }

  const valid = fetched;
  const blockNumbers = [...new Set(valid.map((v) => BigInt(v.tx.blockNumber)))];
  await mapLimit(blockNumbers, CONCURRENCY, async (bn) => {
    const cacheKey = `${url}::${bn}`;
    if (blockTimestampCache.has(cacheKey)) return;
    const blk = await rpcCall(url, "eth_getBlockByNumber", [`0x${bn.toString(16)}`, false]);
    blockTimestampCache.set(cacheKey, blk ? BigInt(blk.timestamp) : null);
  });
  const rawTxs = valid.map((v) => toEtherscanShape(v.tx, v.receipt, blockTimestampCache.get(`${url}::${BigInt(v.tx.blockNumber)}`))).filter(Boolean);
  return { complete: true, missing: [], rawTxs };
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

async function main() {
  const startedAtKst = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  console.log(`[ENV] 측정시작(KST)=${startedAtKst} — 입력 완전성 검사 포함 재실행`);

  const ruleSetFile = JSON.parse(readFileSync(resolve(REPO_ROOT, "rulesets/GENERIC-R1.json"), "utf-8"));
  const { ruleSetBody, ruleSetId } = ruleSetFile;

  const dataset = JSON.parse(readFileSync(resolve(RAW_DIR, "exp1b_chaintip_wallets.json"), "utf-8"));
  const wallets = dataset.wallets;
  const walletHashes = dataset.walletHashes;
  console.log(`[DATA] exp1b_chaintip_wallets.json 재사용 — 지갑 ${wallets.length}개 (재수집 없음, 고정 해시 목록 그대로)`);

  const blockTimestampCache = new Map();
  const perWalletResult = [];

  // finalized 앵커는 한 번만 조회(완전성 검사가 핵심이라 시점 반복은 생략 — t=0 해당)
  const anchors = {};
  for (const p of PROVIDERS) {
    const finBlk = await rpcCall(p.url, "eth_getBlockByNumber", ["finalized", false]);
    anchors[p.key] = { number: BigInt(finBlk.number), timestamp: BigInt(finBlk.timestamp) };
  }

  for (const wallet of wallets) {
    const walletHash = createHash("sha256").update(wallet).digest("hex").slice(0, 16);
    const hashes = walletHashes[wallet] || [];
    if (hashes.length === 0) continue;

    const perProvider = {};
    for (const p of PROVIDERS) {
      const { complete, missing, rawTxs } = await fetchWithIntegrityCheck(p.url, hashes, blockTimestampCache);
      if (!complete) {
        perProvider[p.key] = { complete: false, missingCount: missing.length, missing };
        continue;
      }
      const anchor = anchors[p.key];
      const condA = runPipeline(rawTxs, wallet, ruleSetBody, ruleSetId, Number(anchor.timestamp), anchor.number);
      perProvider[p.key] = { complete: true, sessionRoot: condA.sessionRoot, avgScore: condA.avgScore };
    }

    // 분류: 둘 다 complete면 "일치"/"조용한 불일치"(구 방식이면 그냥 비교됐을 것) 판정, 하나라도 incomplete면 UNVERIFIABLE
    let verdict;
    if (!perProvider.alchemy.complete || !perProvider.publicnode.complete) {
      verdict = "UNVERIFIABLE";
    } else if (perProvider.alchemy.sessionRoot === perProvider.publicnode.sessionRoot && perProvider.alchemy.avgScore === perProvider.publicnode.avgScore) {
      verdict = "MATCH";
    } else {
      verdict = "SILENT_MISMATCH"; // 둘 다 데이터는 완전했는데 실제로 값이 다른 경우 — 이건 진짜 문제가 될 신호
    }

    perWalletResult.push({ wallet_hash: walletHash, verdict, alchemy: perProvider.alchemy, publicnode: perProvider.publicnode });
  }

  const counts = { MATCH: 0, UNVERIFIABLE: 0, SILENT_MISMATCH: 0 };
  for (const r of perWalletResult) counts[r.verdict]++;

  console.log(`\n[요약 — 입력 완전성 검사 적용 후]`);
  console.log(`  일치(MATCH): ${counts.MATCH}건`);
  console.log(`  UNVERIFIABLE(데이터 불완전 — 비교 자체를 하지 않음): ${counts.UNVERIFIABLE}건`);
  console.log(`  조용한 불일치(SILENT_MISMATCH — 데이터 완전한데 값이 다름): ${counts.SILENT_MISMATCH}건`);
  console.log(`  합계: ${perWalletResult.length}개 지갑`);

  writeFileSync(resolve(RAW_DIR, "exp1c_integrity_check_result.json"), JSON.stringify({ counts, perWalletResult, measuredAtKst: startedAtKst }, null, 2));
  console.log(`\n측정종료(KST)=${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
}

main().catch((err) => { console.error("[FATAL]", err); process.exit(1); });
