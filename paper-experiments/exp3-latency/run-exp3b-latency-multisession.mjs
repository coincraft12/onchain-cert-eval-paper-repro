#!/usr/bin/env node
/**
 * 실험 3b — 처리 시간(latency), 다세션(multi-session) 스케일링 보강 측정.
 *
 * 배경: run-exp3-latency.mjs(본편)는 실험1 라우터 TX 1000건이 전부 417초 안에 몰려 있어
 * GENERIC-R1의 timeoutSeconds=1800을 넘지 않아 항상 단일 세션(sessionCount=1)으로만 측정됐다
 * (feature/score가 N에 비례하지 않는 이유). 이 한계를 보완하기 위해, 실제로 "며칠~몇 달"에 걸쳐
 * 활동한 공개 지갑 2개의 전체 실거래 이력(Etherscan V2 API 실측, 합성 데이터 아님)을 신규 수집해
 * N=500/1000 구간에서 다세션 상황의 처리 시간을 재측정한다.
 *
 * 대상 지갑(모두 Polygon 메인넷, QuickSwap 라우터 TX 상위 발신자 중 장기간 활동 확인된 주소):
 *   - wallet1 (0xed1f2f77...312a5): 2025-03-24 ~ 2025-09-05 (약 5.5개월), 실거래 1000건 전부
 *   - wallet2 (0x411f5007...4537d8b): 2025-11-13 ~ 2026-03-22 (약 4.3개월), 실거래 1000건 전부
 *
 * 기존 run-exp3-latency.mjs, exp3_latency.csv/json은 건드리지 않음 — 별도 파일로 분리.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OnchainTxAdapter, normalize, constructSessions, extractFeatures, score } from "../../sdk/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const RAW_DIR = resolve(REPO_ROOT, "paper-experiments/results/raw");
const RESULTS_DIR = resolve(REPO_ROOT, "paper-experiments/results");

const CHAIN_ID = 137;
const MISSION_ID = "GENERIC-R1";
const WALLETS = [
  { key: "wallet1_ed1f2f77", address: "0xed1f2f77ec28edea2cf91efdbbd869f0e84312a5", file: "exp3b_wallet1_ed1f2f77_txlist_raw.json" },
  { key: "wallet2_411f5007", address: "0x411f5007d60c87e6654158e9208c94a8f4537d8b", file: "exp3b_wallet2_411f5007_txlist_raw.json" },
];
const TX_COUNTS = [500, 1000];
const REPS = 10;
const WARMUP_REPS = 1;

function nowNs() { return process.hrtime.bigint(); }
function msSince(start) { return Number(process.hrtime.bigint() - start) / 1e6; }
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr) { const m = mean(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

const ruleSetFile = JSON.parse(readFileSync(resolve(REPO_ROOT, "rulesets/GENERIC-R1.json"), "utf-8"));
const { ruleSetBody, ruleSetId } = ruleSetFile;
const adapter = new OnchainTxAdapter({ chainId: CHAIN_ID, apiKey: "unused-local-conversion-only" });

function runOnce(rawTxs, subject) {
  const stageMs = {};
  const tN0 = nowNs();
  const standardActions = rawTxs.map((rt) => adapter.normalize(rt));
  const normalized = normalize({ actions: standardActions, anchor: { asOfTimestamp: Math.floor(Date.now() / 1000) }, parentIntegrity: "drop-orphans" });
  stageMs.normalize = msSince(tN0);

  const tS0 = nowNs();
  const sessions = constructSessions({ actions: normalized, rule: ruleSetBody.sessionBoundaryRule, subject, missionId: MISSION_ID, ruleSetId, method: "combined" });
  stageMs.session = msSince(tS0);

  const tF0 = nowNs();
  const perSessionFeatures = sessions.map((session) => extractFeatures({ session, evidenceMapping: ruleSetBody.evidenceMapping }));
  stageMs.feature = msSince(tF0);

  const tSc0 = nowNs();
  for (const features of perSessionFeatures) {
    score({ features, weights: ruleSetBody.featureWeights, thresholds: ruleSetBody.gradeThresholds });
  }
  stageMs.score = msSince(tSc0);

  stageMs.total = stageMs.normalize + stageMs.session + stageMs.feature + stageMs.score;
  stageMs.sessionCount = sessions.length;
  return stageMs;
}

async function main() {
  const startedAtKst = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  console.log(`[ENV] 측정시작(KST)=${startedAtKst} — 다세션 보강 측정(실제 공개 지갑 이력)`);

  const rawResults = {};
  const summaryRows = [];

  for (const w of WALLETS) {
    const allRawTxs = JSON.parse(readFileSync(resolve(RAW_DIR, w.file), "utf-8"));
    allRawTxs.sort((a, b) => {
      const bn = Number(a.blockNumber) - Number(b.blockNumber);
      if (bn !== 0) return bn;
      return Number(a.transactionIndex ?? 0) - Number(b.transactionIndex ?? 0);
    });
    console.log(`[DATA] ${w.key} (${w.address}) — 실제 이력 ${allRawTxs.length}건 재사용(신규 수집, 2026-10-10 Etherscan V2 실측)`);

    for (const n of TX_COUNTS) {
      if (allRawTxs.length < n) {
        console.error(`[SKIP] ${w.key}: 이력(${allRawTxs.length})이 N=${n}보다 적음`);
        continue;
      }
      const batch = allRawTxs.slice(0, n);
      for (let wup = 0; wup < WARMUP_REPS; wup++) runOnce(batch, w.address);

      const reps = [];
      for (let r = 0; r < REPS; r++) reps.push(runOnce(batch, w.address));

      const key = `${w.key}_n${n}`;
      rawResults[key] = reps;

      for (const stage of ["normalize", "session", "feature", "score", "total"]) {
        const vals = reps.map((r) => r[stage]);
        summaryRows.push({
          wallet: w.key,
          txCount: n,
          stage,
          mean_ms: mean(vals).toFixed(4),
          stddev_ms: stddev(vals).toFixed(4),
          sessionCount: reps[0].sessionCount,
        });
      }
      const sessionCounts = reps.map((r) => r.sessionCount);
      console.log(`[진행] ${w.key} N=${n} total 평균=${mean(reps.map((r) => r.total)).toFixed(3)}ms sessionCount=${sessionCounts[0]} (10회 전부 동일: ${new Set(sessionCounts).size === 1})`);
    }
  }

  writeFileSync(
    resolve(RAW_DIR, "exp3b_latency_multisession_raw.json"),
    JSON.stringify({ measuredAtKst: startedAtKst, node: process.version, platform: process.platform, repsPerCell: REPS, warmupReps: WARMUP_REPS, wallets: WALLETS.map((w) => ({ key: w.key, address: w.address })), rawResults }, null, 2),
  );

  const header = "wallet,txCount,stage,mean_ms,stddev_ms,sessionCount";
  const csvLines = [header, ...summaryRows.map((r) => [r.wallet, r.txCount, r.stage, r.mean_ms, r.stddev_ms, r.sessionCount].join(","))];
  writeFileSync(resolve(RESULTS_DIR, "exp3b_latency_multisession.csv"), csvLines.join("\n"));

  console.log(`\n측정종료(KST)=${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
  console.log(`결과: paper-experiments/results/exp3b_latency_multisession.csv, paper-experiments/results/raw/exp3b_latency_multisession_raw.json`);
}

main().catch((err) => { console.error("exp3b 실패:", err); process.exit(1); });
