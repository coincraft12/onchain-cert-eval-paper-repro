#!/usr/bin/env node
/**
 * 실험 3 — 처리 시간(latency) 측정.
 *
 * 실험1에서 이미 수집한 실제 메인넷 TX 데이터(exp1_router_txlist_raw.json, QuickSwap V2 Router
 * 최근 TX 1000건, Etherscan V2 API 실측)를 로컬에서 그대로 재사용한다. 네트워크 재요청 없음 —
 * normalize/constructSessions/extractFeatures/score SDK 함수 호출 자체의 순수 계산 시간만 측정.
 * 절대 규칙 준수: 합성 데이터 없음(전부 실제 TX), 추정 없음, 기존 run-exp1*.mjs 파일은 건드리지 않음.
 *
 * "입력 완전성 검사" 시간 분리 기록: 실험1c(run-exp1-integrity-check.mjs)는 RPC 응답 누락을 검사했지만,
 * 본 실험은 네트워크 호출이 전혀 없는 순수 계산 벤치마크이므로 그 개념을 로컬 버전으로 치환했다 —
 * 입력 슬라이스가 기대한 건수·해시 집합과 정확히 일치하는지 검증하는 단계(checkInputCompleteness)를
 * 추가해 그 오버헤드 자체를 측정한다. (동일한 "검증 안 하면 조용히 통과" 문제의 계산 비용 측면.)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OnchainTxAdapter, normalize, constructSessions, extractFeatures, score } from "../../sdk/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const RAW_DIR = resolve(REPO_ROOT, "paper-experiments/results/raw");
const RESULTS_DIR = resolve(REPO_ROOT, "paper-experiments/results");
mkdirSync(RAW_DIR, { recursive: true });

const CHAIN_ID = 137;
const MISSION_ID = "GENERIC-R1";
const SUBJECT = "exp3-latency-benchmark"; // 세션 그룹핑용 라벨일 뿐 — constructSessions는 subject로 필터링하지 않음(SessionConstructor.js 확인됨)
const TX_COUNTS = [10, 50, 100, 500, 1000];
const REPS = 10;
const WARMUP_REPS = 1; // JIT 예열, 측정에서 제외

function nowNs() { return process.hrtime.bigint(); }
function msSince(start) { return Number(process.hrtime.bigint() - start) / 1e6; }
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

const ruleSetFile = JSON.parse(readFileSync(resolve(REPO_ROOT, "rulesets/GENERIC-R1.json"), "utf-8"));
const { ruleSetBody, ruleSetId } = ruleSetFile;

const allRawTxs = JSON.parse(readFileSync(resolve(RAW_DIR, "exp1_router_txlist_raw.json"), "utf-8"));
allRawTxs.sort((a, b) => {
  const bn = Number(a.blockNumber) - Number(b.blockNumber);
  if (bn !== 0) return bn;
  return Number(a.transactionIndex) - Number(b.transactionIndex);
});
console.log(`[DATA] exp1_router_txlist_raw.json 재사용 — 실제 메인넷 TX ${allRawTxs.length}건 (재수집·재요청 없음)`);
if (allRawTxs.length < Math.max(...TX_COUNTS)) {
  console.error(`[FATAL] 캐시된 TX(${allRawTxs.length}건)가 최대 구간(${Math.max(...TX_COUNTS)})보다 적음 — 추가 수집 필요(합성 데이터 금지)`);
  process.exit(1);
}

const adapter = new OnchainTxAdapter({ chainId: CHAIN_ID, apiKey: "unused-local-conversion-only" });
const expectedAllHashes = new Set(allRawTxs.map((t) => t.hash));

function checkInputCompleteness(rawTxs, expectedN) {
  if (rawTxs.length !== expectedN) throw new Error("incomplete input slice");
  const seen = new Set();
  for (const tx of rawTxs) {
    if (!expectedAllHashes.has(tx.hash)) throw new Error(`unexpected hash ${tx.hash}`);
    seen.add(tx.hash);
  }
  if (seen.size !== expectedN) throw new Error("duplicate hash in input slice");
  return true;
}

function runOnce(rawTxs, withCheck) {
  const stageMs = {};

  let checkMs = 0;
  if (withCheck) {
    const t0 = nowNs();
    checkInputCompleteness(rawTxs, rawTxs.length);
    checkMs = msSince(t0);
  }
  stageMs.inputCheck = checkMs;

  const tN0 = nowNs();
  const standardActions = rawTxs.map((rt) => adapter.normalize(rt));
  const normalized = normalize({
    actions: standardActions,
    anchor: { asOfTimestamp: Math.floor(Date.now() / 1000) },
    parentIntegrity: "drop-orphans",
  });
  stageMs.normalize = msSince(tN0);

  const tS0 = nowNs();
  const sessions = constructSessions({
    actions: normalized,
    rule: ruleSetBody.sessionBoundaryRule,
    subject: SUBJECT,
    missionId: MISSION_ID,
    ruleSetId,
    method: "combined",
  });
  stageMs.session = msSince(tS0);

  const tF0 = nowNs();
  const perSessionFeatures = sessions.map((session) => extractFeatures({ session, evidenceMapping: ruleSetBody.evidenceMapping }));
  stageMs.feature = msSince(tF0);

  const tSc0 = nowNs();
  for (const features of perSessionFeatures) {
    score({ features, weights: ruleSetBody.featureWeights, thresholds: ruleSetBody.gradeThresholds });
  }
  stageMs.score = msSince(tSc0);

  stageMs.total = stageMs.inputCheck + stageMs.normalize + stageMs.session + stageMs.feature + stageMs.score;
  stageMs.sessionCount = sessions.length;
  return stageMs;
}

async function main() {
  const startedAtKst = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  console.log(`[ENV] OS=${process.platform} Node=${process.version} 측정시작(KST)=${startedAtKst}`);
  console.log(`[RULESET] GENERIC-R1 id=${ruleSetId}`);

  const rawResults = {};
  const summaryRows = [];

  for (const n of TX_COUNTS) {
    const batch = allRawTxs.slice(0, n);
    for (const withCheck of [false, true]) {
      for (let w = 0; w < WARMUP_REPS; w++) runOnce(batch, withCheck);

      const reps = [];
      for (let r = 0; r < REPS; r++) reps.push(runOnce(batch, withCheck));

      const key = `n${n}_${withCheck ? "withCheck" : "noCheck"}`;
      rawResults[key] = reps;

      for (const stage of ["inputCheck", "normalize", "session", "feature", "score", "total"]) {
        const vals = reps.map((r) => r[stage]);
        summaryRows.push({
          txCount: n,
          inputCompletenessCheck: withCheck ? "1" : "0",
          stage,
          mean_ms: mean(vals).toFixed(4),
          stddev_ms: stddev(vals).toFixed(4),
          min_ms: Math.min(...vals).toFixed(4),
          max_ms: Math.max(...vals).toFixed(4),
          sessionCount: reps[0].sessionCount,
        });
      }
      console.log(`[진행] N=${n} withCheck=${withCheck} total 평균=${mean(reps.map((r) => r.total)).toFixed(3)}ms (${REPS}회, warmup ${WARMUP_REPS}회 제외) sessionCount=${reps[0].sessionCount}`);
    }
  }

  writeFileSync(
    resolve(RAW_DIR, "exp3_latency_raw.json"),
    JSON.stringify({ measuredAtKst: startedAtKst, node: process.version, platform: process.platform, repsPerCell: REPS, warmupReps: WARMUP_REPS, sourceData: "exp1_router_txlist_raw.json", rawResults }, null, 2),
  );

  const header = "txCount,inputCompletenessCheck,stage,mean_ms,stddev_ms,min_ms,max_ms,sessionCount";
  const csvLines = [header, ...summaryRows.map((r) => [r.txCount, r.inputCompletenessCheck, r.stage, r.mean_ms, r.stddev_ms, r.min_ms, r.max_ms, r.sessionCount].join(","))];
  writeFileSync(resolve(RESULTS_DIR, "exp3_latency.csv"), csvLines.join("\n"));

  console.log(`\n측정종료(KST)=${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
  console.log(`결과: paper-experiments/results/exp3_latency.csv, paper-experiments/results/raw/exp3_latency_raw.json`);
}

main().catch((err) => {
  console.error("exp3 실패:", err);
  process.exit(1);
});
