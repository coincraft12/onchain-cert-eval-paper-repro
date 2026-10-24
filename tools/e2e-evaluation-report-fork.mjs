#!/usr/bin/env node
/**
 * e2e-evaluation-report-fork.mjs — EvaluationReport v1 / reportHash v2 / verify-credential 종단 검증.
 * 메인넷에는 아무것도 보내지 않는다. 로컬 anvil 포크(Polygon 복제)에서만 실행한다.
 * 발급 모듈은 이 저장소에 없으므로, 포크 위 테스트 발급은 일회용 키(실행마다 생성)와 viem으로 이 파일 안에서 직접 한다.
 *
 * 준비: anvil --fork-url <Polygon archive RPC> --port 8548 --chain-id 137 --silent   (포크 블록은 2026-10-24 이후여야 한다: 임계값 2·검증자 구성이 반영된 상태)
 * 사용: node scripts/e2e-evaluation-report-fork.mjs        (ANVIL_RPC_URL 기본 http://127.0.0.1:8548)
 *
 * 시나리오:
 *   A  경로 A 테스트 발급(v2) + 보고서 보관 → MATCH
 *   B  평가자가 불리한(실패) TX를 목록에서 뺀 채 발급 → MISMATCH (누락 탐지, 빠진 해시 출력)
 *   C  보관된 JSON에서 입력 TX 하나를 뺀 변조본 → MISMATCH (값 불일치)
 *   D  목록의 TX 하나를 RPC가 돌려주지 않음 → UNVERIFIABLE (조회 실패)
 *   E  독립 이력 출처 미지정 → UNVERIFIABLE (history-unavailable), MISMATCH 없음
 *   F  v1(12필드) 발급(경로 B 호환) → UNVERIFIABLE (legacy-v1)
 */
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, http as viemHttp, keccak256, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = await import(pathToFileURL(join(here, "..", "sdk", "dist", "index.js")).href);
const {
  computeRuleSetId, OnchainTxAdapter, normalize, constructSessions, extractFeatures, score, classifyGrade,
  buildEvaluationReport, computeEvaluationReportHash, computeReportHash, computeReportHashV2, aggregateSessionRoots, GRADE_INDEX, toEnvelope,
  competencyAttestationSBTV4Abi,
} = sdk;

// ── 테스트 전용 발급 헬퍼 (EIP-712 v4 12필드: 컨트랙트 typehash와 동일) ──
const REPORT_TYPES = { CompetencyReport: [
  { name: "reportHash", type: "bytes32" }, { name: "sessionRoot", type: "bytes32" }, { name: "ruleSetId", type: "bytes32" },
  { name: "userAddress", type: "address" }, { name: "missionId", type: "bytes32" }, { name: "score", type: "uint16" }, { name: "grade", type: "uint8" },
  { name: "applicantName", type: "string" }, { name: "chainId", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] };
function buildResultReport(base, version, evaluationReportHash) {
  const sessionRoot = aggregateSessionRoots(base.sessions);
  const score = Math.min(65535, Math.max(0, Math.round(base.scoring.score)));
  const f = { userAddress: base.userAddress, missionId: base.missionId, score, grade: GRADE_INDEX[base.scoring.grade], ruleSetId: base.sessions[0].ruleSetId,
    sessionRoot, nonce: base.nonce, expiry: base.expiry, timestamp: base.timestamp, applicantName: base.applicantName, courseId: base.courseId, issuerAddress: base.issuerAddress };
  const reportHash = version === 2 ? computeReportHashV2({ ...f, evaluationReportHash }) : computeReportHash(f);
  return { ...f, reportHash, chainId: base.chainId, referenceBlockNumber: base.referenceBlockNumber };
}
const signReport = (account, r, verifyingContract) => account.signTypedData({
  domain: { name: "CoinCraftCompetencyAttestation", version: "1", chainId: r.chainId, verifyingContract }, types: REPORT_TYPES, primaryType: "CompetencyReport",
  message: { reportHash: r.reportHash, sessionRoot: r.sessionRoot, ruleSetId: r.ruleSetId, userAddress: r.userAddress, missionId: r.missionId, score: r.score,
    grade: r.grade, applicantName: r.applicantName, chainId: BigInt(r.chainId), nonce: r.nonce, expiry: r.expiry, verifyingContract },
});
const { verifyCredential } = await import(pathToFileURL(join(here, "verify-credential.mjs")).href);

const RPC = process.env.ANVIL_RPC_URL ?? "http://127.0.0.1:8548";
const SBT = "0xb7e3B228308F97431de7d4d4b7690A35B23052Ba";
const REGISTRY = "0x07D7EB170964D555db1D270B2B7dDAc9A3C8fC67";
const TIMELOCK = "0x51caF45eB42eb648dee04f24271134E7046eA2a4";
const OUT = resolve(here, "..", ".e2e-eval-report");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "rulesets"), { recursive: true });

const pub = createPublicClient({ chain: polygon, transport: viemHttp(RPC) });
const wallet = createWalletClient({ chain: polygon, transport: viemHttp(RPC) });
const rpc = (method, params) => pub.transport.request({ method, params });
const GAS = { maxFeePerGas: 300_000_000_000n, maxPriorityFeePerGas: 40_000_000_000n };
const results = [];
const record = (name, ok, detail) => { results.push(ok); console.log(ok ? "PASS" : "FAIL", "-", name, detail ? `| ${detail}` : ""); };
const lc = (s) => s.toLowerCase();

// ── 0. 거버넌스 준비 (Timelock 가장 — 포크에서만) ──
const MISSION = "E2E-PATH-A";
const missionId = keccak256(stringToHex(MISSION));
const courseId = keccak256(stringToHex("E2E-PATH-A-COURSE"));
const body = {
  version: "e2e-1", missionId: MISSION, chainScope: [137], validFrom: 1_700_000_000,
  gradeThresholds: { professional: 90, associate: 75, basic: 50 },
  featureWeights: { efficiency: 0.2, stability: 0.2, coherence: 0.2, riskPattern: 0.2, excellence: 0.2 },
  sessionBoundaryRule: { timeoutSeconds: 600, minActionCount: 2 },
  evidenceMapping: [{ actionType: "constructor", contributions: { excellence: 0.2, efficiency: 0.2 } }],
  issuerSet: [],
};
const ruleSetId = computeRuleSetId(body);
writeFileSync(join(OUT, "rulesets", "e2e-path-a.json"), JSON.stringify(body, null, 2));

const relayer = privateKeyToAccount(generatePrivateKey());
const validators = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
await rpc("anvil_setBalance", [relayer.address, "0x56BC75E2D63100000"]);
await rpc("anvil_impersonateAccount", [TIMELOCK]);
await rpc("anvil_setBalance", [TIMELOCK, "0x56BC75E2D63100000"]);
const tl = async (address, abi, functionName, args) => {
  const hash = await wallet.writeContract({ account: TIMELOCK, address, abi, functionName, args, chain: polygon });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
};
const regAbi = [{ name: "addValidator", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "string" }], outputs: [] }];
const sbtGovAbi = [
  { name: "approveRuleSet", type: "function", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [] },
  { name: "setMissionSerialPrefix", type: "function", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "string" }], outputs: [] },
];
for (const [i, v] of validators.entries()) await tl(REGISTRY, regAbi, "addValidator", [v.address, `e2e-${i + 1}`]);
await tl(SBT, sbtGovAbi, "approveRuleSet", [missionId, ruleSetId]);
await tl(SBT, sbtGovAbi, "setMissionSerialPrefix", [missionId, "E2E"]);
console.log("setup: validators added, ruleSet approved on fork");

// ── 증거 TX 생성 (사용자별) ──
const INIT_OK = "0x6001600c60003960016000f300";
const INIT_FAIL = "0x60006000fd";
let clock = (await pub.getBlock()).timestamp + 100n;
async function evidence(user) {
  { const latest = (await pub.getBlock()).timestamp; if (clock <= latest) clock = latest + 100n; } // 이전 단계 소요 시간 동안 포크 시계가 앞서갈 수 있다
  await rpc("anvil_setBalance", [user.address, "0x56BC75E2D63100000"]);
  const plan = [[0, INIT_OK], [60, INIT_OK], [120, INIT_OK], [180, INIT_FAIL], [240, INIT_OK], [3000, INIT_OK], [3060, INIT_OK], [3120, INIT_OK]];
  const base = clock;
  const out = [];
  for (const [off, data] of plan) {
    await rpc("evm_setNextBlockTimestamp", [`0x${(base + BigInt(off)).toString(16)}`]);
    const hash = await wallet.sendTransaction({ account: user, data, gas: 100_000n, chain: polygon, ...GAS });
    const r = await pub.waitForTransactionReceipt({ hash });
    out.push({ hash: lc(hash), block: r.blockNumber, failed: r.status !== "success" });
  }
  clock = base + 4000n;
  await rpc("evm_setNextBlockTimestamp", [`0x${clock.toString(16)}`]);
  await rpc("evm_mine", []);
  clock += 10n;
  return out;
}

// ── 평가 파이프라인 (경로 A) ──
const adapter = new OnchainTxAdapter({ chainId: 137, apiKey: "offline", fetcher: async () => { throw new Error("offline"); } });
async function loadRaw(hash) {
  const [tx, rc] = await Promise.all([pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash })]);
  const blk = await pub.getBlock({ blockNumber: tx.blockNumber });
  const failed = rc.status !== "success";
  return { hash: tx.hash, blockNumber: String(tx.blockNumber), timeStamp: String(blk.timestamp), from: tx.from, to: tx.to ?? "", value: String(tx.value),
    gas: String(tx.gas), gasPrice: String(tx.gasPrice ?? rc.effectiveGasPrice), gasUsed: String(rc.gasUsed), input: tx.input,
    isError: failed ? "1" : "0", txreceipt_status: failed ? "0" : "1", contractAddress: rc.contractAddress ?? "", nonce: String(tx.nonce) };
}
async function evaluate(user, txs, { windowFrom, windowTo }) {
  const refBlock = await pub.getBlock();
  const raws = await Promise.all(txs.map((t) => loadRaw(t.hash)));
  const actions = raws.map((r) => adapter.normalize(r));
  const norm = normalize({ actions, anchor: { asOfTimestamp: Number(refBlock.timestamp), asOfBlockNumber: refBlock.number }, parentIntegrity: "skip" }).filter((a) => a.finalized);
  const sessions = constructSessions({ actions: norm, rule: body.sessionBoundaryRule, subject: lc(user.address), missionId: MISSION, ruleSetId, method: "combined" });
  const features = sessions.map((session) => extractFeatures({ session, evidenceMapping: body.evidenceMapping }));
  const per = features.map((f) => score({ features: f, weights: body.featureWeights, thresholds: body.gradeThresholds }));
  const avg = Math.round(per.reduce((s, r) => s + r.score, 0) / per.length);
  const scoring = { ...per[0], score: avg, grade: classifyGrade(avg, body.gradeThresholds) };
  const timestamp = refBlock.timestamp;
  const evalReport = buildEvaluationReport({
    sessions, features, scoring, chainId: 137, userAddress: lc(user.address), missionId, referenceBlockNumber: refBlock.number, referenceBlockHash: refBlock.hash,
    windowStart: windowFrom, windowEnd: windowTo, missionScope: { actor: lc(user.address), targetContracts: null, includeFailed: true },
    evaluatorCodeVersion: { sdk: "onchain-cert-eval-core", version: "0.1.0", commit: "0".repeat(40), dirty: false }, createdAt: timestamp,
  });
  return { sessions, scoring, evalReport, refBlock, timestamp };
}
const nonceFor = (() => { let n = 1n; return () => n++; })();
async function issueCredential(user, ev, version) {
  const base = {
    sessions: ev.sessions, scoring: ev.scoring, userAddress: lc(user.address), applicantName: "E2E Tester", missionId, courseId,
    issuerAddress: validators[0].address, nonce: nonceFor(), expiry: ev.timestamp + 604800n, timestamp: ev.timestamp, chainId: 137, referenceBlockNumber: ev.refBlock.number,
  };
  const evHash = computeEvaluationReportHash(ev.evalReport);
  const report = buildResultReport(base, version, evHash);
  const sigs = await Promise.all(validators.map(async (v) => ({ signer: v.address, signature: await signReport(v, report, SBT) })));
  sigs.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  const txHash = await wallet.writeContract({ account: relayer, address: SBT, abi: competencyAttestationSBTV4Abi, functionName: "issueOrUpdate", chain: polygon, ...GAS,
    args: [{ userAddress: report.userAddress, missionId: report.missionId, chainId: BigInt(report.chainId), referenceBlockNumber: report.referenceBlockNumber, score: report.score,
      grade: report.grade, ruleSetId: report.ruleSetId, sessionRoot: report.sessionRoot, reportHash: report.reportHash, nonce: report.nonce, expiry: report.expiry,
      timestamp: report.timestamp, applicantName: report.applicantName, courseId: report.courseId, issuerAddress: report.issuerAddress },
      { signers: sigs.map((x) => x.signer), signatures: sigs.map((x) => x.signature) }] });
  const rcpt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (rcpt.status !== "success") throw new Error("issueOrUpdate reverted");
  const tokenId = await pub.readContract({ address: SBT, abi: competencyAttestationSBTV4Abi, functionName: "computeTokenId", args: [report.userAddress, report.missionId] });
  const envelope = toEnvelope(ev.evalReport, report.reportHash, { tokenId: `0x${tokenId.toString(16)}`, issueTxHash: txHash });
  const file = join(OUT, `${report.reportHash}.json`);
  writeFileSync(file, JSON.stringify(envelope, null, 2));
  return { tokenId: tokenId.toString(), txHash, report, envelope, file };
}
const verify = (extra) => verifyCredential({ rpcs: [RPC], contract: SBT, chainId: 137, rulesetDirs: [join(OUT, "rulesets")], history: "rpc-scan", ...extra });
const reasonCodes = (r) => r.reasons.map((x) => `${x.verdict}/${x.kind}/${x.code}`).join(", ");

// ── 시나리오 A: 정상 ──
const u1 = privateKeyToAccount(generatePrivateKey());
const e1 = await evidence(u1);
const win1 = { windowFrom: e1[0].block, windowTo: e1[e1.length - 1].block };
const ev1 = await evaluate(u1, e1, win1);
const c1 = await issueCredential(u1, ev1, 2);
console.log(`A: issued token ${c1.tokenId.slice(0, 12)}… tx ${c1.txHash.slice(0, 12)}… included=${ev1.evalReport.includedTxHashes.length} sessions=${ev1.sessions.length}`);
const rA = await verify({ tokenId: c1.tokenId, reportFile: c1.file, reportUrls: [], issueTx: c1.txHash });
record("A 정상 발급 → MATCH", rA.verdict === "MATCH", `${rA.verdict} ${reasonCodes(rA)}`);

// ── B: 불리한 TX 누락 ──
const u2 = privateKeyToAccount(generatePrivateKey());
const e2 = await evidence(u2);
const failed2 = e2.find((t) => t.failed);
const win2 = { windowFrom: e2[0].block, windowTo: e2[e2.length - 1].block };
const ev2 = await evaluate(u2, e2.filter((t) => !t.failed), win2);
const c2 = await issueCredential(u2, ev2, 2);
const rB = await verify({ tokenId: c2.tokenId, reportFile: c2.file, reportUrls: [], issueTx: c2.txHash });
const om = rB.reasons.find((r) => r.code === "omission-detected");
record("B 불리한 TX 누락 → MISMATCH(누락 탐지) + 빠진 해시 출력", rB.verdict === "MISMATCH" && !!om && om.details.missing.length === 1 && om.details.missing[0] === failed2.hash,
  `${rB.verdict} ${reasonCodes(rB)} missing=${om?.details.missing.map((h) => h.slice(0, 12))}`);

// ── C: 보관된 JSON 변조(입력 TX 하나 삭제) ──
const tampered = JSON.parse(JSON.stringify(c1.envelope));
tampered.evaluationReport.includedTxHashes.pop();
const tfile = join(OUT, "tampered.json");
writeFileSync(tfile, JSON.stringify(tampered, null, 2));
const rC = await verify({ tokenId: c1.tokenId, reportFile: tfile, reportUrls: [], issueTx: c1.txHash });
record("C 입력 TX 하나 삭제한 JSON → MISMATCH(값 불일치)", rC.verdict === "MISMATCH" && rC.reasons.some((r) => r.code === "report-hash-v2"), `${rC.verdict} ${reasonCodes(rC)}`);

// ── D: 목록의 TX 하나를 RPC가 돌려주지 않음 ──
const hidden = ev1.evalReport.includedTxHashes[2];
const proxy = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", async () => {
    const msg = JSON.parse(buf);
    const withheld = (msg.method === "eth_getTransactionByHash" || msg.method === "eth_getTransactionReceipt") && lc(String(msg.params?.[0])) === hidden;
    if (withheld) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null })); return; }
    const up = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: buf });
    res.setHeader("content-type", "application/json");
    res.end(await up.text());
  });
});
await new Promise((r) => proxy.listen(8549, "127.0.0.1", r));
const rD = await verify({ tokenId: c1.tokenId, reportFile: c1.file, reportUrls: [], rpcs: ["http://127.0.0.1:8549"], contract: SBT, issueTx: c1.txHash });
proxy.close();
record("D 조회 불가 TX → UNVERIFIABLE(조회 실패), MISMATCH 없음", rD.verdict === "UNVERIFIABLE" && rD.reasons.some((r) => r.code === "tx-unavailable") && !rD.reasons.some((r) => r.verdict === "MISMATCH"), `${rD.verdict} ${reasonCodes(rD)}`);

// ── E: 독립 이력 출처 없음 ──
const rE = await verify({ tokenId: c1.tokenId, reportFile: c1.file, reportUrls: [], history: "none", issueTx: c1.txHash });
record("E 독립 출처 없음 → UNVERIFIABLE(history-unavailable)", rE.verdict === "UNVERIFIABLE" && rE.reasons.length === 1 && rE.reasons[0].code === "history-unavailable", `${rE.verdict} ${reasonCodes(rE)}`);

// ── F: v1 발급(경로 B 호환) ──
const u3 = privateKeyToAccount(generatePrivateKey());
const e3 = await evidence(u3);
const ev3 = await evaluate(u3, e3, { windowFrom: e3[0].block, windowTo: e3[e3.length - 1].block });
const c3 = await issueCredential(u3, ev3, 1);
const rF = await verify({ tokenId: c3.tokenId, reportUrls: [], issueTx: c3.txHash });
record("F v1(12필드) 발급 → UNVERIFIABLE(legacy-v1)", rF.verdict === "UNVERIFIABLE" && rF.reasons.some((r) => r.code === "legacy-v1"), `${rF.verdict} ${reasonCodes(rF)}`);

console.log(`\nSUMMARY: ${results.every(Boolean) ? "ALL PASS" : "SOME FAILED"} (${results.filter(Boolean).length}/${results.length})`);
writeFileSync(join(OUT, "summary.json"), JSON.stringify({ A: rA, B: rB, C: rC, D: rD, E: rE, F: rF }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
process.exit(results.every(Boolean) ? 0 : 1);
