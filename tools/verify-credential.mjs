#!/usr/bin/env node
/**
 * verify-credential.mjs <tokenId> — SBT가 가리키는 평가 보고서를 제3자가 검증한다 (읽기 전용).
 *
 * 판정: MATCH / MISMATCH / UNVERIFIABLE. 판정 사유는 항상 함께 출력한다:
 *   조회 실패(UNVERIFIABLE) · 누락 탐지(MISMATCH, 빠진 TX 해시 출력) · 값 불일치(MISMATCH).
 * 우선순위 MISMATCH > UNVERIFIABLE > MATCH. 종료 코드: 0 MATCH, 2 MISMATCH, 3 UNVERIFIABLE, 1 실행 오류.
 *
 * 사용:
 *   node tools/verify-credential.mjs <tokenId> --rpc <url> [--rpc <url> ...] \
 *        [--contract 0x..] [--chain-id 137] [--report-url <base>] [--mirror-url <base>] \
 *        [--report-file <envelope.json>] [--issue-tx 0x..] [--scan-limit-blocks 400000] \
 *        [--ruleset-dir <dir> ...] \
 *        [--history none|rpc-scan|etherscan] [--history-scan-limit 20000] \
 *        [--etherscan-url <v2 api url>] [--etherscan-key-env ETHERSCAN_API_KEY] [--json]
 *   환경변수: VERIFY_RPCS(쉼표 구분 RPC 목록)
 *
 * 전제/한계 (README "Credential verification" 절):
 *  - 입력 완전성(빠진 TX 없음)은 해시로 증명되지 않는다. 독립 출처(--history)가 전체 이력을 줄 때만 판정한다.
 *  - 재현은 정상 TX(normal tx) 기반 파이프라인만 지원한다(internal/erc20 파생 액션은 UNVERIFIABLE).
 *  - actionType이 탐색기 functionName 기반이면 RPC만으로는 재도출되지 않아, 보고서의 txActionTypes를 사용하고 경고만 남긴다.
 *  - RPC URL(키 포함 가능)은 출력하지 않는다.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, http, decodeFunctionData, keccak256, parseAbiItem } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const sdk = await import(pathToFileURL(join(here, "..", "sdk", "dist", "index.js")).href);
const {
  competencyAttestationSBTV4Abi, computeEvaluationReportHash, computeReportHash, computeReportHashV2,
  computeRuleSetId, OnchainTxAdapter, normalize, constructSessions, extractFeatures, score, classifyGrade,
  aggregateSessionRoots, GRADE_INDEX,
} = sdk;

// 컨트랙트 주소는 --contract 또는 VERIFY_CONTRACT 로 반드시 지정한다(심사용 브랜치: 기본값 없음).
export const DEFAULT_CONTRACT = "";
// 기본 보고서 API 없음(심사용 브랜치). --report-url / --mirror-url / --report-file 을 주지 않으면 UNVERIFIABLE 로 끝난다.
const DEFAULT_REPORT_URL = "";
const REPORT_CONSUMED = parseAbiItem(
  "event ReportConsumed(address indexed user, bytes32 indexed reportHash, bytes32 indexed ruleSetId, uint256 nonce)",
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => String(s).toLowerCase();

async function retry(fn, tries = 4, base = 400) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(base * (i + 1)); }
  }
  throw last;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** 결과 수집기 */
function makeResult() {
  const steps = [];
  const reasons = [];
  const warnings = [];
  return {
    steps, reasons, warnings,
    step: (n, name, status, detail) => steps.push({ n, name, status, detail }),
    // kind: "조회 실패" | "누락 탐지" | "값 불일치"
    unverifiable: (code, message, details) => reasons.push({ verdict: "UNVERIFIABLE", kind: "조회 실패", code, message, details }),
    mismatch: (kind, code, message, details) => reasons.push({ verdict: "MISMATCH", kind, code, message, details }),
    warn: (m) => warnings.push(m),
    verdict() {
      if (reasons.some((r) => r.verdict === "MISMATCH")) return "MISMATCH";
      if (reasons.some((r) => r.verdict === "UNVERIFIABLE")) return "UNVERIFIABLE";
      return "MATCH";
    },
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function loadRuleSets(dirs) {
  const found = new Map();
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(readFileSync(join(d, f), "utf8"));
        const body = j.ruleSetBody ?? j;
        const id = lc(computeRuleSetId(body));
        if (!found.has(id)) found.set(id, { body, file: f });
      } catch { /* 규칙 파일이 아닌 JSON은 건너뛴다 */ }
    }
  }
  return found;
}

/** RPC 응답 → Etherscan 호환 raw tx (OnchainTxAdapter.normalize 입력) */
function toRawTx(tx, receipt, blockTimestamp) {
  const failed = receipt.status !== "success";
  return {
    hash: tx.hash, blockNumber: String(tx.blockNumber), timeStamp: String(blockTimestamp), from: tx.from,
    to: tx.to ?? "", value: String(tx.value), gas: String(tx.gas), gasPrice: String(tx.gasPrice ?? receipt.effectiveGasPrice ?? 0n),
    gasUsed: String(receipt.gasUsed), input: tx.input, isError: failed ? "1" : "0", txreceipt_status: failed ? "0" : "1",
    contractAddress: receipt.contractAddress ?? "", nonce: String(tx.nonce),
  };
}

export async function verifyCredential(opts) {
  const R = makeResult();
  const rpcs = opts.rpcs ?? [];
  if (rpcs.length === 0) throw new Error("at least one --rpc is required");
  const clients = rpcs.map((url, i) => ({ id: `rpc#${i + 1}`, c: createPublicClient({ transport: http(url, { retryCount: 2, retryDelay: 600 }) }) }));
  const contract = opts.contract || process.env.VERIFY_CONTRACT || DEFAULT_CONTRACT;
  if (!contract) throw new Error("--contract (or VERIFY_CONTRACT) is required");
  if (rpcs.length < 2) R.warn("RPC가 1곳뿐이다 — 평가자와 독립된 노드 2곳 이상을 권장한다");

  // first-success read helper
  const readAny = async (fn) => {
    let lastErr;
    for (const cl of clients) {
      try { return await retry(() => fn(cl.c), 2, 300); } catch (e) { lastErr = e; }
    }
    throw lastErr;
  };
  // 모든 RPC에서 읽어 합의 확인 (null 허용)
  const readAll = async (fn) => (await Promise.all(clients.map(async (cl) => {
    try { return { id: cl.id, v: await retry(() => fn(cl.c), 2, 300) }; } catch (e) { return { id: cl.id, err: String(e.shortMessage ?? e.message).slice(0, 120) }; }
  })));

  // ── 1. 온체인 조회
  let meta;
  try {
    const chainIdSeen = await readAny((c) => c.getChainId());
    if (opts.chainId && chainIdSeen !== opts.chainId) {
      R.mismatch("값 불일치", "chain-id", `RPC chainId=${chainIdSeen} expected=${opts.chainId}`);
      return finish(R, opts);
    }
    meta = await readAny((c) => c.readContract({ address: contract, abi: competencyAttestationSBTV4Abi, functionName: "getMetadata", args: [BigInt(opts.tokenId)] }));
  } catch (e) {
    R.unverifiable("onchain-unavailable", `온체인 조회 실패: ${String(e.shortMessage ?? e.message).slice(0, 160)}`);
    R.step(1, "onchain", "fail");
    return finish(R, opts);
  }
  let isRevoked = false;
  try { isRevoked = await readAny((c) => c.readContract({ address: contract, abi: competencyAttestationSBTV4Abi, functionName: "revoked", args: [BigInt(opts.tokenId)] })); } catch { /* 선택 정보 */ }
  const onchainReportHash = lc(meta.reportHash);
  const haveMeta = lc(meta.userAddress) !== "0x0000000000000000000000000000000000000000";
  R.step(1, "onchain", haveMeta ? "ok" : "no-metadata", { revoked: isRevoked, active: haveMeta ? meta.active : null });
  if (!haveMeta && !opts.issueTx) {
    R.unverifiable("metadata-unavailable", isRevoked
      ? "토큰이 폐기되어 온체인 메타데이터가 삭제됐다 — --issue-tx 로 발급 트랜잭션을 지정해야 검증할 수 있다"
      : "토큰이 존재하지 않는다");
    return finish(R, opts);
  }

  // 발급 트랜잭션 calldata (nonce/expiry/timestamp/courseId/issuerAddress/applicantName 은 여기에만 있다)
  let issueTx = opts.issueTx;
  if (!issueTx) {
    const latest = await readAny((c) => c.getBlockNumber());
    const limit = BigInt(opts.scanLimitBlocks ?? 400000);
    const lowest = latest > limit ? latest - limit : 0n;
    outer: for (let hi = latest; hi >= lowest; hi -= 10000n) {
      const lo = hi - 9999n > lowest ? hi - 9999n : lowest;
      let logs;
      try {
        logs = await readAny((c) => c.getLogs({ address: contract, event: REPORT_CONSUMED, args: { reportHash: onchainReportHash }, fromBlock: lo, toBlock: hi }));
      } catch { continue; }
      if (logs.length) { issueTx = logs[0].transactionHash; break outer; }
      if (lo === lowest) break;
    }
  }
  if (!issueTx) {
    R.unverifiable("issue-tx-not-found", "발급 트랜잭션을 찾지 못했다 — --issue-tx 또는 --scan-limit-blocks 확대가 필요하다");
    return finish(R, opts);
  }
  let rep;
  let issueBlock;
  try {
    const tx = await readAny((c) => c.getTransaction({ hash: issueTx }));
    issueBlock = tx.blockNumber;
    const dec = decodeFunctionData({ abi: competencyAttestationSBTV4Abi, data: tx.input });
    if (dec.functionName !== "issueOrUpdate") throw new Error(`unexpected function ${dec.functionName}`);
    rep = dec.args[0];
  } catch (e) {
    R.unverifiable("calldata-undecodable", `발급 calldata 디코딩 실패: ${String(e.shortMessage ?? e.message).slice(0, 120)}`);
    return finish(R, opts);
  }
  if (haveMeta && lc(rep.reportHash) !== onchainReportHash) {
    R.mismatch("값 불일치", "calldata-vs-state", "발급 calldata의 reportHash와 온체인 메타데이터 reportHash가 다르다", { calldata: rep.reportHash, state: meta.reportHash });
    return finish(R, opts);
  }
  const reportHash = lc(rep.reportHash);
  R.step(1, "issue-calldata", "ok", { issueTx, block: String(issueBlock) });

  // ── 2. 보고서 JSON 받기 (API → 미러 → 파일)
  let envelope = null;
  const tried = [];
  const sources = [];
  if (opts.reportFile) sources.push({ kind: "file", v: opts.reportFile });
  for (const b of (opts.reportUrls ?? [DEFAULT_REPORT_URL]).filter(Boolean)) sources.push({ kind: "api", v: `${b.replace(/\/$/, "")}/${reportHash}` });
  for (const b of opts.mirrorUrls ?? []) sources.push({ kind: "mirror", v: `${b.replace(/\/$/, "")}/${reportHash}.json` });
  for (const s of sources) {
    try {
      const j = s.kind === "file" ? JSON.parse(readFileSync(s.v, "utf8")) : await fetchJson(s.v);
      const e = j.envelope ?? j;
      if (e && e.evaluationReport) { envelope = e; tried.push(`${s.kind}:ok`); break; }
      tried.push(`${s.kind}:no-report`);
    } catch (err) { tried.push(`${s.kind}:${String(err.message).slice(0, 40)}`); }
  }
  if (!envelope) {
    const v1 = lc(computeReportHash({ ...rep }));
    if (v1 === reportHash) {
      R.unverifiable("legacy-v1", "reportHash가 v1(12필드) 방식이다 — 기준 블록·입력 TX를 담은 평가 보고서가 존재하지 않는 발급(증거 없음)", { tried });
    } else {
      R.unverifiable("report-unavailable", "보고서 JSON을 받지 못했다(보관소 조회 실패)", { tried });
    }
    R.step(2, "fetch-report", "fail", { tried });
    return finish(R, opts);
  }
  R.step(2, "fetch-report", "ok", { tried });
  const er = envelope.evaluationReport;

  // ── 3. 해시 대조
  const evHash = lc(computeEvaluationReportHash(er));
  if (envelope.evaluationReportHash && lc(envelope.evaluationReportHash) !== evHash) {
    R.mismatch("값 불일치", "evaluation-report-hash", "envelope의 evaluationReportHash가 본문 재계산과 다르다", { claimed: envelope.evaluationReportHash, recomputed: evHash });
  }
  const v2 = lc(computeReportHashV2({ ...rep, evaluationReportHash: evHash }));
  if (v2 !== reportHash) {
    R.mismatch("값 불일치", "report-hash-v2", "calldata 12필드 + evaluationReportHash 로 재계산한 reportHash가 온체인 값과 다르다", { onchain: reportHash, recomputed: v2 });
    R.step(3, "hash", "mismatch");
  } else {
    R.step(3, "hash", "ok", { evaluationReportHash: evHash });
  }

  // ── 4. 교차 필드
  const cross = [
    ["userAddress", lc(er.userAddress), lc(rep.userAddress)],
    ["missionId", lc(er.missionId), lc(rep.missionId)],
    ["ruleSetId", lc(er.ruleSetId), lc(rep.ruleSetId)],
    ["sessionRoot", lc(er.sessionRoot), lc(rep.sessionRoot)],
    ["score", String(er.score), String(rep.score)],
    ["grade", String(er.grade), String(rep.grade)],
    ["chainId", String(er.chainId), String(rep.chainId)],
    ["referenceBlockNumber", String(er.referenceBlockNumber), String(rep.referenceBlockNumber)],
    ["createdAt", String(er.createdAt), String(rep.timestamp)],
  ];
  const bad = cross.filter(([, a, b]) => a !== b);
  if (bad.length) bad.forEach(([f, a, b]) => R.mismatch("값 불일치", "cross-field", `${f}: 보고서=${a} 온체인=${b}`));
  R.step(4, "cross-fields", bad.length ? "mismatch" : "ok");
  if (BigInt(er.windowEnd) > BigInt(er.referenceBlockNumber) || BigInt(er.windowStart) > BigInt(er.windowEnd)) {
    R.mismatch("값 불일치", "window", "평가 구간이 올바르지 않다(windowStart <= windowEnd <= referenceBlockNumber 위반)", { windowStart: er.windowStart, windowEnd: er.windowEnd, ref: er.referenceBlockNumber });
  }
  if (issueBlock !== undefined && BigInt(er.referenceBlockNumber) > issueBlock) {
    R.mismatch("값 불일치", "reference-after-issue", "기준 블록이 발급 블록보다 뒤다", { ref: er.referenceBlockNumber, issueBlock: String(issueBlock) });
  }

  // ── 5. 기준 블록 해시
  const refBn = BigInt(er.referenceBlockNumber);
  const refs = await readAll((c) => c.getBlock({ blockNumber: refBn }));
  const refOk = refs.filter((x) => x.v);
  if (refOk.length === 0) {
    R.unverifiable("ref-block-unavailable", "기준 블록을 어느 RPC에서도 조회할 수 없다", { errors: refs.map((x) => `${x.id}:${x.err ?? "null"}`) });
    R.step(5, "reference-block", "unavailable");
  } else if (new Set(refOk.map((x) => lc(x.v.hash))).size > 1) {
    R.unverifiable("rpc-disagreement", "RPC들이 기준 블록 해시에 대해 서로 다른 값을 돌려줬다");
    R.step(5, "reference-block", "disagree");
  } else if (lc(refOk[0].v.hash) !== lc(er.referenceBlockHash)) {
    R.mismatch("값 불일치", "reference-block-hash", "referenceBlockHash가 체인의 해당 블록 해시와 다르다", { report: er.referenceBlockHash, chain: refOk[0].v.hash });
    R.step(5, "reference-block", "mismatch");
  } else {
    R.step(5, "reference-block", "ok", { confirmedBy: refOk.length });
  }
  const refTimestamp = refOk[0]?.v.timestamp;

  // ── 6. 질문 ① 목록의 TX를 모두 조회할 수 있는가
  const included = er.includedTxHashes.map(lc);
  if (new Set(included).size !== included.length) R.mismatch("값 불일치", "duplicate-tx", "includedTxHashes에 중복이 있다");
  const winStart = BigInt(er.windowStart), winEnd = BigInt(er.windowEnd);
  const txData = new Map();
  const unreachable = [];
  await pool(included, 8, async (h) => {
    const results = await readAll(async (c) => {
      const [tx, receipt] = await Promise.all([c.getTransaction({ hash: h }), c.getTransactionReceipt({ hash: h })]);
      const blk = await c.getBlock({ blockNumber: tx.blockNumber });
      return { tx, receipt, ts: blk.timestamp };
    });
    const oks = results.filter((x) => x.v);
    if (oks.length === 0) { unreachable.push(h); return; }
    if (new Set(oks.map((x) => lc(x.v.tx.from) + ":" + String(x.v.tx.blockNumber) + ":" + x.v.receipt.status + ":" + keccak256(x.v.tx.input))).size > 1) {
      R.unverifiable("rpc-disagreement", `RPC들이 TX ${h} 에 대해 서로 다른 값을 돌려줬다`);
      return;
    }
    txData.set(h, oks[0].v);
  });
  if (unreachable.length) {
    R.unverifiable("tx-unavailable", `목록의 TX ${unreachable.length}건을 조회할 수 없다`, { hashes: unreachable });
    R.step(6, "tx-fetch", "unavailable", { unreachable: unreachable.length });
  } else {
    let n = 0;
    for (const [h, d] of txData) {
      const bn = BigInt(d.tx.blockNumber);
      if (bn < winStart || bn > winEnd) { R.mismatch("값 불일치", "tx-out-of-window", `TX ${h} 가 평가 구간 밖이다(block ${bn})`); n++; }
      if (lc(d.tx.from) !== lc(er.userAddress)) { R.mismatch("값 불일치", "tx-actor", `TX ${h} 의 발신자가 평가 대상이 아니다`); n++; }
    }
    R.step(6, "tx-fetch", n ? "mismatch" : "ok", { count: txData.size });
  }

  // ── 7. 질문 ② 목록에서 빠진 TX가 없는가 (누락 탐지)
  const scope = er.missionScope;
  const inScope = (to, failed) =>
    (scope.includeFailed || !failed) &&
    (scope.targetContracts === null || (to !== null && to !== "" && scope.targetContracts.map(lc).includes(lc(to))));
  const hist = opts.history ?? "none";
  let required = null;
  if (hist === "none") {
    R.unverifiable("history-unavailable", "독립 출처가 지정되지 않아 입력 완전성(누락 탐지)을 판정할 수 없다 (--history rpc-scan|etherscan)");
  } else if (hist === "rpc-scan") {
    const span = winEnd - winStart + 1n;
    const cap = BigInt(opts.historyScanLimit ?? 20000);
    if (span > cap) {
      R.unverifiable("history-unavailable", `평가 구간(${span} 블록)이 스캔 한도(${cap})를 넘어 RPC 스캔으로는 전체 이력을 얻을 수 없다`);
    } else {
      const blocks = [];
      for (let b = winStart; b <= winEnd; b++) blocks.push(b);
      let failedBlocks = 0;
      const found = [];
      await pool(blocks, 16, async (b) => {
        try {
          const blk = await readAny((c) => c.getBlock({ blockNumber: b, includeTransactions: true }));
          for (const t of blk.transactions) if (lc(t.from) === lc(er.userAddress)) found.push(t);
        } catch { failedBlocks++; }
      });
      if (failedBlocks) {
        R.unverifiable("history-unavailable", `구간 내 블록 ${failedBlocks}개를 조회하지 못해 전체 이력을 확보하지 못했다`);
      } else {
        required = [];
        for (const t of found) {
          let failed = false;
          if (!scope.includeFailed) {
            try { failed = (await readAny((c) => c.getTransactionReceipt({ hash: t.hash }))).status !== "success"; } catch { failed = false; }
          }
          if (inScope(t.to, failed)) required.push(lc(t.hash));
        }
      }
    }
  } else if (hist === "etherscan") {
    const key = process.env[opts.etherscanKeyEnv ?? "ETHERSCAN_API_KEY"];
    if (!opts.etherscanUrl || !key) {
      R.unverifiable("history-unavailable", "Etherscan 호환 API URL 또는 키가 없어 이력을 받을 수 없다");
    } else {
      try {
        const offset = 10000;
        const u = new URL(opts.etherscanUrl);
        u.searchParams.set("chainid", String(er.chainId)); u.searchParams.set("module", "account"); u.searchParams.set("action", "txlist");
        u.searchParams.set("address", er.userAddress); u.searchParams.set("startblock", er.windowStart); u.searchParams.set("endblock", er.windowEnd);
        u.searchParams.set("page", "1"); u.searchParams.set("offset", String(offset)); u.searchParams.set("sort", "asc"); u.searchParams.set("apikey", key);
        const j = await retry(() => fetchJson(u.toString()), 3, 800);
        const list = Array.isArray(j.result) ? j.result : [];
        if (j.status === "0" && !/no transactions/i.test(String(j.message))) throw new Error(String(j.result ?? j.message).slice(0, 80));
        if (list.length >= offset) {
          R.unverifiable("history-unavailable", "이력 응답이 페이지 한도에 도달해 전체 이력이 아닐 수 있다");
        } else {
          required = list
            .filter((t) => lc(t.from) === lc(er.userAddress))
            .filter((t) => inScope(t.to === "" ? null : t.to, t.isError === "1" || t.txreceipt_status === "0"))
            .map((t) => lc(t.hash));
        }
      } catch (e) {
        R.unverifiable("history-unavailable", `독립 이력 조회 실패: ${String(e.message).slice(0, 100)}`);
      }
    }
  }
  if (required) {
    const set = new Set(included);
    const missing = [...new Set(required)].filter((h) => !set.has(h));
    if (missing.length) {
      R.mismatch("누락 탐지", "omission-detected", `미션 범위에 해당하는데 목록에 없는 TX ${missing.length}건`, { missing });
      R.step(7, "completeness", "omission", { missing });
    } else {
      R.step(7, "completeness", "ok", { checked: new Set(required).size });
    }
  } else {
    R.step(7, "completeness", "unverifiable");
  }

  // ── 8. 재현 (세션 → 특징 → 점수)
  if (unreachable.length || txData.size !== included.length || !refTimestamp) {
    R.step(8, "reproduce", "skipped");
    return finish(R, opts);
  }
  const rulesets = loadRuleSets(opts.rulesetDirs ?? [resolve(here, "..", "rulesets")]);
  const rs = rulesets.get(lc(er.ruleSetId));
  if (!rs) {
    R.unverifiable("ruleset-unavailable", "ruleSetId에 해당하는 규칙 본문을 찾지 못했다(--ruleset-dir 지정)", { ruleSetId: er.ruleSetId });
    R.step(8, "reproduce", "skipped");
    return finish(R, opts);
  }
  const body = rs.body;
  if (!body.sessionBoundaryRule || !body.featureWeights || !body.gradeThresholds) {
    R.unverifiable("ruleset-unavailable", "규칙 본문이 경로 A 필드(sessionBoundaryRule/featureWeights/gradeThresholds)를 갖고 있지 않다");
    R.step(8, "reproduce", "skipped");
    return finish(R, opts);
  }
  const adapter = new OnchainTxAdapter({ chainId: er.chainId, apiKey: "offline", fetcher: async () => { throw new Error("offline"); } });
  const actions = [];
  for (const h of included) {
    const d = txData.get(h);
    const a = adapter.normalize(toRawTx(d.tx, d.receipt, d.ts));
    const reported = er.txActionTypes?.[h];
    if (reported === undefined) { R.mismatch("값 불일치", "action-type-missing", `txActionTypes 에 ${h} 가 없다`); continue; }
    if (reported !== a.actionType) R.warn(`actionType 차이(${h.slice(0, 10)}…): 보고서=${reported}, selector 기반=${a.actionType} — 탐색기 functionName 기반일 수 있어 보고서 값을 사용`);
    actions.push({ ...a, actionType: reported });
  }
  const normalized = normalize({ actions, anchor: { asOfTimestamp: Number(refTimestamp), asOfBlockNumber: refBn }, parentIntegrity: "skip" }).filter((a) => a.finalized);
  const method = er.sessions[0]?.constructionMethod ?? "combined";
  const sessions = constructSessions({ actions: normalized, rule: body.sessionBoundaryRule, subject: lc(er.userAddress), missionId: er.missionRef, ruleSetId: er.ruleSetId, method });
  const diffs = [];
  if (sessions.length !== er.sessions.length) diffs.push(`세션 수 재계산=${sessions.length} 보고서=${er.sessions.length}`);
  const perScores = [];
  sessions.forEach((s, i) => {
    const r = er.sessions[i];
    const f = extractFeatures({ session: s, ...(body.evidenceMapping ? { evidenceMapping: body.evidenceMapping } : {}) });
    perScores.push(score({ features: f, weights: body.featureWeights, thresholds: body.gradeThresholds }).score);
    if (!r) return;
    for (const k of ["sessionId", "sessionRoot"]) if (lc(s[k]) !== lc(r[k])) diffs.push(`세션#${i + 1}.${k}`);
    for (const k of ["startTime", "endTime", "valid"]) if (s[k] !== r[k]) diffs.push(`세션#${i + 1}.${k}`);
    if (s.actions.length !== r.actionCount) diffs.push(`세션#${i + 1}.actionCount`);
    for (const k of ["efficiency", "stability", "coherence", "riskPattern", "excellence"]) if (f[k] !== r.featureValues[k]) diffs.push(`세션#${i + 1}.feature.${k}`);
  });
  if (lc(aggregateSessionRoots(sessions)) !== lc(er.sessionRoot)) diffs.push("집계 sessionRoot");
  const avg = perScores.length ? Math.round(perScores.reduce((x, y) => x + y, 0) / perScores.length) : 0;
  if (avg !== er.score) diffs.push(`score 재계산=${avg} 보고서=${er.score}`);
  if (GRADE_INDEX[classifyGrade(avg, body.gradeThresholds)] !== er.grade) diffs.push("grade");
  if (diffs.length) {
    R.mismatch("값 불일치", "reproduction", "TX 원문으로 세션·특징·점수를 재계산한 결과가 보고서와 다르다", { differences: diffs });
    R.step(8, "reproduce", "mismatch", { differences: diffs });
  } else {
    R.step(8, "reproduce", "ok", { sessions: sessions.length, score: avg, ruleSetFile: rs.file });
  }
  return finish(R, opts);
}

function finish(R, opts) {
  return { tokenId: String(opts.tokenId), verdict: R.verdict(), reasons: R.reasons, warnings: R.warnings, steps: R.steps };
}

// ───────────────────────────── CLI ─────────────────────────────
function parseArgs(argv) {
  const o = { rpcs: [], reportUrls: [], mirrorUrls: [], rulesetDirs: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    switch (a) {
      case "--rpc": o.rpcs.push(val()); break;
      case "--contract": o.contract = val(); break;
      case "--chain-id": o.chainId = Number(val()); break;
      case "--report-url": o.reportUrls.push(val()); break;
      case "--mirror-url": o.mirrorUrls.push(val()); break;
      case "--report-file": o.reportFile = val(); break;
      case "--issue-tx": o.issueTx = val(); break;
      case "--scan-limit-blocks": o.scanLimitBlocks = Number(val()); break;
      case "--ruleset-dir": o.rulesetDirs.push(resolve(val())); break;
      case "--history": o.history = val(); break;
      case "--history-scan-limit": o.historyScanLimit = Number(val()); break;
      case "--etherscan-url": o.etherscanUrl = val(); break;
      case "--etherscan-key-env": o.etherscanKeyEnv = val(); break;
      case "--json": o.json = true; break;
      default: rest.push(a);
    }
  }
  o.tokenId = rest[0];
  if (!o.rpcs.length && process.env.VERIFY_RPCS) o.rpcs = process.env.VERIFY_RPCS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!o.reportUrls.length) delete o.reportUrls;
  if (!o.mirrorUrls.length) delete o.mirrorUrls;
  if (!o.rulesetDirs.length) delete o.rulesetDirs;
  return o;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const o = parseArgs(process.argv.slice(2));
  if (!o.tokenId) { console.error("usage: verify-credential.mjs <tokenId> --rpc <url> [...]"); process.exit(1); }
  try {
    const res = await verifyCredential(o);
    if (o.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`token ${res.tokenId}`);
      for (const s of res.steps) console.log(`  [${s.n}] ${s.name}: ${s.status}`);
      for (const w of res.warnings) console.log(`  warn: ${w}`);
      for (const r of res.reasons) {
        console.log(`  - ${r.verdict} / ${r.kind} / ${r.code}: ${r.message}`);
        if (r.details?.missing) r.details.missing.forEach((h) => console.log(`      missing: ${h}`));
      }
      console.log(`VERDICT: ${res.verdict}`);
    }
    process.exit(res.verdict === "MATCH" ? 0 : res.verdict === "MISMATCH" ? 2 : 3);
  } catch (e) {
    console.error(String(e.shortMessage ?? e.message).replace(/https?:\/\/\S+/g, "<url>"));
    process.exit(1);
  }
}
