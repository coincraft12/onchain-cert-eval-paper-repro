// node --test tests/   (먼저 `cd sdk && npm run build`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = await import(pathToFileURL(join(here, "..", "sdk", "dist", "index.js")).href);
const {
  constructSessions, extractFeatures, buildEvaluationReport, computeEvaluationReportHash, toEnvelope, actionToTxHash,
  extractIncludedTxHashes, computeReportHash, computeReportHashV2, EvaluationReportError, HASH_SCHEME_V2,
} = sdk;

const RULESET_ID = "0x" + "11".repeat(32);
const MISSION_ID = "0x" + "22".repeat(32);
const USER = "0x2bfe227fdfa9e0c83169198ebbd076e1ab95db15";
const REF_HASH = "0x" + "ab".repeat(32);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const T0 = 1_720_000_000;
const tx = (n) => "0x" + n.toString(16).padStart(64, "0");
const mk = (n, ts, o = {}) => ({
  actionId: tx(n), timestamp: T0 + ts, actor: USER, actionType: "constructor", status: "success",
  domainMetadata: { blockNumber: 1000n + BigInt(n) }, finalized: true, ingestOrder: 0, ...o,
});
const rule = { timeoutSeconds: 600, minActionCount: 1 };
const sessions = constructSessions({
  actions: [mk(1, 0), mk(2, 60), mk(3, 120), mk(4, 180), mk(5, 240), mk(6, 5000), mk(7, 5060)],
  rule, subject: USER, missionId: "TEST", ruleSetId: RULESET_ID,
});
const features = sessions.map((session) => extractFeatures({ session }));
const scoring = { score: 72, grade: "Basic" };
const input = () => ({
  sessions, features, scoring, chainId: 137, userAddress: USER, missionId: MISSION_ID,
  referenceBlockNumber: 5000n, referenceBlockHash: REF_HASH, windowStart: 1000n, windowEnd: 4990n,
  missionScope: { actor: USER, targetContracts: null, includeFailed: true },
  evaluatorCodeVersion: { sdk: "onchain-cert-eval-core", version: "0.1.0", commit: COMMIT, dirty: false },
  createdAt: 1_720_003_600n,
});

test("fixture splits into two sessions", () => assert.equal(sessions.length, 2));

test("report has ordered tx hashes and no name fields", () => {
  const r = buildEvaluationReport(input());
  assert.deepEqual(r.includedTxHashes, [1, 2, 3, 4, 5, 6, 7].map(tx));
  assert.equal(r.txActionTypes[tx(3)], "constructor");
  assert.equal(r.grade, 1);
  assert.doesNotMatch(JSON.stringify(r), /applicantName|email|name/i);
});

test("hash is deterministic and independent of key order", () => {
  const a = buildEvaluationReport(input());
  assert.equal(computeEvaluationReportHash(a), computeEvaluationReportHash(buildEvaluationReport(input())));
  const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(a))).reverse());
  assert.equal(computeEvaluationReportHash(reordered), computeEvaluationReportHash(a));
});

test("any change to tx list, window, scope, score or code commit changes the hash", () => {
  const a = buildEvaluationReport(input());
  const h = computeEvaluationReportHash(a);
  for (const changed of [
    { ...a, includedTxHashes: a.includedTxHashes.slice(1) },
    { ...a, windowStart: "999" },
    { ...a, score: a.score + 1 },
    { ...a, missionScope: { ...a.missionScope, includeFailed: false } },
    { ...a, evaluatorCodeVersion: { ...a.evaluatorCodeVersion, commit: "f".repeat(40) } },
  ]) assert.notEqual(computeEvaluationReportHash(changed), h);
});

test("refuses dirty code version, bad window, actor mismatch", () => {
  const i = input();
  assert.throws(() => buildEvaluationReport({ ...i, evaluatorCodeVersion: { ...i.evaluatorCodeVersion, dirty: true } }), EvaluationReportError);
  assert.throws(() => buildEvaluationReport({ ...i, windowEnd: 6000n }), /windowEnd/);
  assert.throws(() => buildEvaluationReport({ ...i, windowStart: 5000n }), /windowStart/);
  assert.throws(() => buildEvaluationReport({ ...i, missionScope: { ...i.missionScope, actor: "0x" + "00".repeat(20) } }), /actor/);
});

test("derives tx hashes from derived action ids and parentTxHash", () => {
  assert.equal(actionToTxHash(`${tx(9)}-internal-0_1`), tx(9));
  assert.equal(actionToTxHash(`${tx(9)}-erc20-0xabc-0`), tx(9));
  assert.equal(actionToTxHash("not-a-hash", { parentTxHash: tx(9) }), tx(9));
  assert.equal(actionToTxHash("not-a-hash"), null);
  const s = constructSessions({
    actions: [mk(1, 0), mk(1, 1, { actionId: `${tx(1)}-internal-0` }), mk(2, 2)],
    rule, subject: USER, missionId: "TEST", ruleSetId: RULESET_ID,
  });
  assert.deepEqual(extractIncludedTxHashes(s), [tx(1), tx(2)]);
});

test("parity vector locks evaluationReportHash, reportHash v1 and v2 (same vector as the production backend)", () => {
  const vec = JSON.parse(readFileSync(join(here, "..", "sdk", "test", "fixtures", "evaluation-report-vector.json"), "utf8"));
  const f = vec.resultReportFields;
  const fields = { ...f, nonce: BigInt(f.nonce), expiry: BigInt(f.expiry), timestamp: BigInt(f.timestamp) };
  assert.equal(computeEvaluationReportHash(vec.evaluationReport), vec.evaluationReportHash);
  assert.equal(computeReportHash(fields), vec.reportHashV1);
  assert.equal(computeReportHashV2({ ...fields, evaluationReportHash: vec.evaluationReportHash }), vec.reportHashV2);
  assert.notEqual(vec.reportHashV1, vec.reportHashV2);
});

test("envelope carries scheme and recomputable hash", () => {
  const report = buildEvaluationReport(input());
  const env = toEnvelope(report, tx(77), { tokenId: "0x1" });
  assert.equal(env.hashScheme, HASH_SCHEME_V2);
  assert.equal(env.evaluationReportHash, computeEvaluationReportHash(report));
  assert.equal(env.tokenId, "0x1");
});
