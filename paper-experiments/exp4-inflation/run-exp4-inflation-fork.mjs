#!/usr/bin/env node
/**
 * 실험 4 — 부풀리기(inflation) 내성, Polygon 메인넷 로컬 포크(anvil) 실측.
 * 미션 정의: paper-experiments/exp4-inflation/mission-definition.md (FORK-MISSION-1) 참조.
 *
 * 사전 조건: `anvil --fork-url <POLYGON_RPC_URL> --port 8546 --chain-id 137` 이 떠 있어야 함.
 * 절대 규칙 준수: 합성 TX 없음(전부 포크 상의 실제 EVM 실행·revert 포함), 추정 없음.
 *
 * SDK 파이프라인 함수만 재사용(새 채점 로직 없음) — ../../sdk/dist/index.js.
 *
 * 블록 타임스탬프: anvil `evm_setNextBlockTimestamp`로 제어하되, 모든 TX가 하나의 체인 위에서
 * 순차 채굴되므로(여러 "지갑"이라도 같은 anvil 인스턴스) 전역 단조증가 clock을 공유해야 한다
 * (한 번 설정한 타임스탬프보다 과거로 되돌릴 수 없음 — anvil 제약).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData } from "viem";
import { OnchainTxAdapter, normalize, constructSessions, extractFeatures, score } from "../../sdk/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const RAW_DIR = resolve(REPO_ROOT, "paper-experiments/results/raw");
const RESULTS_DIR = resolve(REPO_ROOT, "paper-experiments/results");
mkdirSync(RAW_DIR, { recursive: true });

const ANVIL_RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8546";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const CHAIN_ID = 137;
const MISSION_ID = "FORK-MISSION-1";
const FIXED_DEADLINE = 1893456000n; // 2030-01-01 — scenario(b) 바이트동일 calldata용 고정값

const depositAbi = [{ name: "deposit", type: "function", stateMutability: "payable", inputs: [], outputs: [] }];
const approveAbi = [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }];
const transferAbi = [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }];
const swapAbi = [{ name: "swapExactTokensForTokens", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "address[]" }, { type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256[]" }] }];

async function rpc(method, params) {
  const res = await fetch(ANVIL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function waitReceipt(hash) {
  for (let i = 0; i < 50; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`receipt timeout ${hash}`);
}

/** anvil에서 실제 TX를 보내고, 채굴된 블록 타임스탬프를 nextTimestamp로 고정한 뒤 Etherscan 호환 raw 셰이프로 변환 */
async function sendAndCapture({ from, to, data, value, gas, nextTimestamp, functionName }) {
  await rpc("evm_setNextBlockTimestamp", [`0x${nextTimestamp.toString(16)}`]);
  const txParams = { from, to, data, gas: `0x${gas.toString(16)}` };
  if (value !== undefined) txParams.value = `0x${value.toString(16)}`;
  const hash = await rpc("eth_sendTransaction", [txParams]);
  const receipt = await waitReceipt(hash);
  const tx = await rpc("eth_getTransactionByHash", [hash]);
  const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  return {
    hash,
    blockNumber: String(BigInt(receipt.blockNumber)),
    timeStamp: String(BigInt(block.timestamp)),
    from: tx.from,
    to: tx.to ?? "",
    value: String(BigInt(tx.value ?? "0x0")),
    gas: String(BigInt(tx.gas ?? "0x0")),
    gasPrice: String(BigInt(tx.gasPrice ?? "0x0")),
    gasUsed: String(BigInt(receipt.gasUsed)),
    input: tx.input ?? "0x",
    isError: receipt.status === "0x0" ? "1" : "0",
    txreceipt_status: receipt.status === "0x1" ? "1" : "0",
    nonce: tx.nonce !== undefined ? String(BigInt(tx.nonce)) : undefined,
    functionName, // ground-truth: 우리가 실제로 호출한 함수 시그니처 (explorer 없는 로컬 포크용 수기 기입)
  };
}

async function fundWallet(addr) {
  await rpc("anvil_impersonateAccount", [addr]);
  await rpc("anvil_setBalance", [addr, "0x152D02C7E14AF6800000"]); // 100,000 ether(POL) — 가스·wrap용
}

function randomAddress(seed) {
  // 재현 가능한 결정적 테스트 주소 — 실제 사용자 지갑 아님(프라이버시 무관성)
  const hex = seed.toString(16).padStart(40, "0");
  return `0x${hex}`;
}

/** 전역 단조증가 clock — anvil은 블록 타임스탬프를 과거로 되돌릴 수 없으므로 모든 TX(모든 지갑 포함)가 공유. */
function advance(clock, gapSeconds) {
  clock.t += gapSeconds;
  return clock.t;
}

async function depositSetup({ wallet, clock, gapBefore }) {
  const depositData = encodeFunctionData({ abi: depositAbi, functionName: "deposit", args: [] });
  const ts = advance(clock, gapBefore);
  return sendAndCapture({ from: wallet, to: WMATIC, data: depositData, value: 10000000000000000000n, gas: 100000n, nextTimestamp: ts, functionName: "deposit()" });
}

/** mission step 1~3 (approve/transfer/swap) 1회 실행 */
async function runMissionOnce({ wallet, second, clock, gapBefore, gapApproveTransfer, gapTransferSwap }) {
  const approveData = encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [ROUTER, 5000000000000000000n] });
  const transferData = encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [second, 100000000000000000n] });
  const swapData = encodeFunctionData({ abi: swapAbi, functionName: "swapExactTokensForTokens", args: [1000000000000000000n, 0n, [WMATIC, USDCE], wallet, FIXED_DEADLINE] });

  const tsApprove = advance(clock, gapBefore);
  const rawApprove = await sendAndCapture({ from: wallet, to: WMATIC, data: approveData, gas: 100000n, nextTimestamp: tsApprove, functionName: "approve(address,uint256)" });
  const tsTransfer = advance(clock, gapApproveTransfer);
  const rawTransfer = await sendAndCapture({ from: wallet, to: WMATIC, data: transferData, gas: 100000n, nextTimestamp: tsTransfer, functionName: "transfer(address,uint256)" });
  const tsSwap = advance(clock, gapTransferSwap);
  const rawSwap = await sendAndCapture({ from: wallet, to: ROUTER, data: swapData, gas: 5000000n, nextTimestamp: tsSwap, functionName: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)" });
  return [rawApprove, rawTransfer, rawSwap];
}

async function runFailedRetryBurst({ wallet, second, clock, gapBefore, count, gapSeconds }) {
  const badTransferData = encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [second, 1000000000000000000000n] }); // 잔고 초과 → 항상 revert
  const out = [];
  let ts = advance(clock, gapBefore);
  out.push(await sendAndCapture({ from: wallet, to: WMATIC, data: badTransferData, gas: 100000n, nextTimestamp: ts, functionName: "transfer(address,uint256)" }));
  for (let i = 1; i < count; i++) {
    ts = advance(clock, gapSeconds);
    out.push(await sendAndCapture({ from: wallet, to: WMATIC, data: badTransferData, gas: 100000n, nextTimestamp: ts, functionName: "transfer(address,uint256)" }));
  }
  return out;
}

// ---------- pipeline (SDK 재사용, 신규 채점 로직 없음) ----------
const ruleSetFile = JSON.parse(readFileSync(resolve(REPO_ROOT, "rulesets/GENERIC-R1.json"), "utf-8"));
const { ruleSetBody, ruleSetId } = ruleSetFile;
const adapter = new OnchainTxAdapter({ chainId: CHAIN_ID, apiKey: "unused-local-conversion-only" });

function runPipeline(rawTxs, subject, asOfTimestamp) {
  const standardActions = rawTxs.map((rt) => adapter.normalize(rt));
  const normalized = normalize({ actions: standardActions, anchor: { asOfTimestamp }, parentIntegrity: "drop-orphans" });
  const sessions = constructSessions({ actions: normalized, rule: ruleSetBody.sessionBoundaryRule, subject, missionId: MISSION_ID, ruleSetId, method: "combined" });
  if (sessions.length === 0) return { sessionCount: 0, sessions: [] };
  const perSession = sessions.map((session) => {
    const features = extractFeatures({ session, evidenceMapping: ruleSetBody.evidenceMapping });
    const result = score({ features, weights: ruleSetBody.featureWeights, thresholds: ruleSetBody.gradeThresholds });
    return {
      sessionId: session.sessionId,
      actionCount: session.actions.length,
      features: { efficiency: features.efficiency, stability: features.stability, coherence: features.coherence, riskPattern: features.riskPattern, excellence: features.excellence },
      score: result.score,
      grade: result.grade,
    };
  });
  return { sessionCount: sessions.length, sessions: perSession };
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stddev(arr) { const m = mean(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length); }

async function main() {
  const startedAtKst = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  console.log(`[ENV] 측정시작(KST)=${startedAtKst} — Polygon 메인넷 로컬 포크(anvil, ${ANVIL_RPC}) 실측`);
  const chainIdHex = await rpc("eth_chainId", []);
  const blockNumHex = await rpc("eth_blockNumber", []);
  const currentBlock = await rpc("eth_getBlockByNumber", [blockNumHex, false]);
  const clock = { t: Number(BigInt(currentBlock.timestamp)) + 10 }; // 전역 단조증가 clock, 포크 현재 시각 기준 시작
  console.log(`[FORK] chainId=${parseInt(chainIdHex, 16)} blockNumber=${parseInt(blockNumHex, 16)} currentTimestamp=${currentBlock.timestamp} clockStart=${clock.t}`);

  const results = { a_normal: [], b_duplicate_input: [], c_rapid_failed_retry: [] };
  const allRawTxLog = {};
  let walletSeed = 0x1000;

  // ---------- 시나리오 (a) 정상 수행 — 5지갑 ----------
  for (let i = 0; i < 5; i++) {
    const wallet = randomAddress(walletSeed++);
    const second = randomAddress(walletSeed++);
    await fundWallet(wallet);
    await depositSetup({ wallet, clock, gapBefore: 50 }); // 설정 단계(세션 미포함)
    const missionTxs = await runMissionOnce({ wallet, second, clock, gapBefore: 10, gapApproveTransfer: 90, gapTransferSwap: 110 });
    const walletHash = wallet.slice(0, 10);
    allRawTxLog[`a_${walletHash}`] = missionTxs;
    const pipelineResult = runPipeline(missionTxs, wallet, clock.t + 100000);
    results.a_normal.push({ wallet, ...pipelineResult.sessions[0], sessionCount: pipelineResult.sessionCount });
    console.log(`[a 정상] wallet=${walletHash} score=${pipelineResult.sessions[0]?.score} grade=${pipelineResult.sessions[0]?.grade}`);
  }

  // ---------- 시나리오 (b) 같은 입력 반복 — 5지갑 ----------
  for (let i = 0; i < 5; i++) {
    const wallet = randomAddress(walletSeed++);
    const second = randomAddress(walletSeed++);
    await fundWallet(wallet);
    await depositSetup({ wallet, clock, gapBefore: 50 });
    const pass1 = await runMissionOnce({ wallet, second, clock, gapBefore: 10, gapApproveTransfer: 90, gapTransferSwap: 110 });
    // 동일 calldata(동일 금액·수신자·고정 deadline) 반복 — pass1 종료 후 320s 뒤(봇 페이스 패널티와 분리)
    const pass2 = await runMissionOnce({ wallet, second, clock, gapBefore: 320, gapApproveTransfer: 90, gapTransferSwap: 110 });
    const allTxs = [...pass1, ...pass2];
    const walletHash = wallet.slice(0, 10);
    allRawTxLog[`b_${walletHash}`] = allTxs;
    const pipelineResult = runPipeline(allTxs, wallet, clock.t + 100000);
    results.b_duplicate_input.push({ wallet, ...pipelineResult.sessions[0], sessionCount: pipelineResult.sessionCount });
    console.log(`[b 중복입력] wallet=${walletHash} score=${pipelineResult.sessions[0]?.score} grade=${pipelineResult.sessions[0]?.grade} efficiency=${pipelineResult.sessions[0]?.features.efficiency}`);
  }

  // ---------- 시나리오 (c) 5초 이내 실패 재시도 — 5지갑 ----------
  for (let i = 0; i < 5; i++) {
    const wallet = randomAddress(walletSeed++);
    const second = randomAddress(walletSeed++);
    await fundWallet(wallet);
    await depositSetup({ wallet, clock, gapBefore: 50 });
    const normalTxs = await runMissionOnce({ wallet, second, clock, gapBefore: 10, gapApproveTransfer: 90, gapTransferSwap: 110 });
    const retryTxs = await runFailedRetryBurst({ wallet, second, clock, gapBefore: 320, count: 4, gapSeconds: 3 });
    const allTxs = [...normalTxs, ...retryTxs];
    const walletHash = wallet.slice(0, 10);
    allRawTxLog[`c_${walletHash}`] = allTxs;
    const pipelineResult = runPipeline(allTxs, wallet, clock.t + 100000);
    results.c_rapid_failed_retry.push({ wallet, ...pipelineResult.sessions[0], sessionCount: pipelineResult.sessionCount });
    console.log(`[c 급속재시도] wallet=${walletHash} score=${pipelineResult.sessions[0]?.score} grade=${pipelineResult.sessions[0]?.grade} riskPattern=${pipelineResult.sessions[0]?.features.riskPattern}`);
  }

  // ---------- 요약 ----------
  const summary = {};
  for (const [key, rows] of Object.entries(results)) {
    const feats = ["efficiency", "stability", "coherence", "riskPattern", "excellence"];
    const featSummary = {};
    for (const f of feats) {
      const vals = rows.map((r) => r.features[f]);
      featSummary[f] = { mean: mean(vals), stddev: stddev(vals), values: vals };
    }
    const scores = rows.map((r) => r.score);
    summary[key] = { featSummary, score: { mean: mean(scores), stddev: stddev(scores), values: scores }, actionCounts: rows.map((r) => r.actionCount) };
  }

  writeFileSync(resolve(RAW_DIR, "exp4_inflation_raw.json"), JSON.stringify({ measuredAtKst: startedAtKst, forkBlockNumber: parseInt(blockNumHex, 16), chainId: parseInt(chainIdHex, 16), ruleSetId, results, rawTxLog: allRawTxLog }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  writeFileSync(resolve(RAW_DIR, "exp4_inflation_summary.json"), JSON.stringify(summary, null, 2));

  const header = "scenario,wallet,sessionCount,actionCount,efficiency,stability,coherence,riskPattern,excellence,score,grade";
  const csvRows = [header];
  for (const [key, rows] of Object.entries(results)) {
    for (const r of rows) {
      csvRows.push([key, r.wallet, r.sessionCount, r.actionCount, r.features.efficiency, r.features.stability, r.features.coherence, r.features.riskPattern, r.features.excellence, r.score, r.grade].join(","));
    }
  }
  writeFileSync(resolve(RESULTS_DIR, "exp4_inflation.csv"), csvRows.join("\n"));

  console.log("\n[요약 — 시나리오별 평균(5지갑)]");
  for (const [key, s] of Object.entries(summary)) {
    console.log(`  ${key}: score=${s.score.mean.toFixed(2)}±${s.score.stddev.toFixed(2)}, efficiency=${s.featSummary.efficiency.mean.toFixed(3)}, riskPattern=${s.featSummary.riskPattern.mean.toFixed(3)}`);
  }
  console.log(`\n측정종료(KST)=${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
  console.log(`결과: paper-experiments/results/exp4_inflation.csv, paper-experiments/results/raw/exp4_inflation_raw.json, exp4_inflation_summary.json`);
}

main().catch((err) => { console.error("exp4 실패:", err); process.exit(1); });
