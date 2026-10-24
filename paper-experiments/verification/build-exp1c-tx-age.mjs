#!/usr/bin/env node
/**
 * 실험 1 체인 끝(chain tip) 관찰 — 트랜잭션별 블록 타임스탬프와 PublicNode 조회 성공 여부.
 * 읽기 전용: eth_getTransactionByHash / eth_getBlockByNumber 만 사용한다.
 *
 * 입력 : results/raw/exp1b_chaintip_wallets.json  (지갑별 해시 목록, 관찰 시각 latestTxTime)
 * 출력 : results/exp1c_tx_age.csv, results/exp1c_tx_age_summary.json
 *
 * 환경변수: ALCHEMY_POLYGON_RPC_URL(아카이브, 타임스탬프 조회), PUBLICNODE_POLYGON_RPC_URL(성공 여부 재조회)
 * 주의: PublicNode 성공 여부는 "이 스크립트를 실행한 시점"의 재조회 결과다. 원 실험(2026-10-10)의
 *       관찰값은 raw/exp1b_chaintip_timeseries.json 에 있다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = resolve(HERE, "../results");
const ALCH = process.env.ALCHEMY_POLYGON_RPC_URL;
const PN = process.env.PUBLICNODE_POLYGON_RPC_URL;
if (!ALCH || !PN) throw new Error("ALCHEMY_POLYGON_RPC_URL / PUBLICNODE_POLYGON_RPC_URL 필요");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(url, method, params) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) return { error: String(j.error.message).replace(/https?:\/\/\S+/g, "<url>").slice(0, 120) };
      return { result: j.result };
    } catch (e) { await sleep(800 * (attempt + 1)); }
  }
  return { error: "request failed after retries" };
}

const w = JSON.parse(readFileSync(resolve(RES, "raw/exp1b_chaintip_wallets.json"), "utf-8"));
const tip = Number(w.latestTxTime);
const latestBlock = Number(w.latestBlock);
// 2026-10-10 원 실험의 PublicNode 조회 실패 대조 결과(블록 번호 기준). 파일: results/raw/exp1b_publicnode_availability_check.json
const av = JSON.parse(readFileSync(resolve(RES, "raw/exp1b_publicnode_availability_check.json"), "utf-8"));
const missingBlocks = new Set(av.missingBlocks);
const rows = [];
const blockTs = new Map();
let wi = 0;
for (const [, hashes] of Object.entries(w.walletHashes)) {
  wi++;
  for (const h of hashes) {
    const a = await rpc(ALCH, "eth_getTransactionByHash", [h]);
    let bn = null, ts = null;
    if (a.result) {
      bn = parseInt(a.result.blockNumber, 16);
      if (!blockTs.has(bn)) {
        const b = await rpc(ALCH, "eth_getBlockByNumber", [a.result.blockNumber, false]);
        blockTs.set(bn, b.result ? parseInt(b.result.timestamp, 16) : null);
      }
      ts = blockTs.get(bn);
    }
    const p = await rpc(PN, "eth_getTransactionByHash", [h]);
    const pnStatus = p.error ? "error" : p.result ? "found" : "null";
    rows.push({
      wallet_idx: `w${String(wi).padStart(2, "0")}`, tx_hash: h, block_number: bn, block_timestamp: ts,
      block_time_utc: ts ? new Date(ts * 1000).toISOString() : "",
      age_days_from_tip: ts ? ((tip - ts) / 86400).toFixed(2) : "",
      age_days_if_2s_blocks: bn ? (((latestBlock - bn) * 2) / 86400).toFixed(2) : "",
      publicnode_missing_2026_10_10: bn ? String(missingBlocks.has(bn)) : "",
      alchemy_found: a.result ? "true" : "false", publicnode_status: pnStatus, publicnode_error: p.error ?? "",
    });
  }
}

const cols = Object.keys(rows[0]);
writeFileSync(resolve(RES, "exp1c_tx_age.csv"), [cols.join(","), ...rows.map((r) => cols.map((c) => String(r[c] ?? "").replace(/,/g, ";")).join(","))].join("\n") + "\n");

const rngOf = (list, key) => {
  const a = list.map((r) => Number(r[key]));
  return a.length ? { n: a.length, min: Math.min(...a), max: Math.max(...a) } : { n: 0 };
};
const miss10 = rows.filter((r) => r.publicnode_missing_2026_10_10 === "true");
const found10 = rows.filter((r) => r.publicnode_missing_2026_10_10 === "false");
const todayFound = rows.filter((r) => r.publicnode_status === "found");
const todayNot = rows.filter((r) => r.alchemy_found === "true" && r.publicnode_status !== "found");
const summary = {
  _comment:
    "체인 끝 관찰 시각(latestTxTime) 기준 트랜잭션 나이(일). 실제 블록 타임스탬프(age_days_from_tip)와, 블록 수x2.0초 환산(age_days_if_2s_blocks)을 함께 낸다. 원 실험(2026-10-10) 조회 실패 분류는 exp1b_publicnode_availability_check.json(블록 번호 기준), 오늘 재조회 분류는 publicnode_status.",
  observedAtChainTip: { latestBlock, latestTxTime: tip, latestTxTimeUtc: new Date(tip * 1000).toISOString() },
  totalTx: rows.length,
  alchemyFound: rows.filter((r) => r.alchemy_found === "true").length,
  run_2026_10_10_classification: {
    publicnodeFound: found10.length,
    publicnodeMissing: miss10.length,
    ageDays_actualTimestamps: { found: rngOf(found10, "age_days_from_tip"), missing: rngOf(miss10, "age_days_from_tip") },
    ageDays_blocksTimes2s: { found: rngOf(found10, "age_days_if_2s_blocks"), missing: rngOf(miss10, "age_days_if_2s_blocks") },
  },
  requery_at_script_run_time: {
    publicnode: Object.fromEntries(["found", "null", "error"].map((k) => [k, rows.filter((r) => r.publicnode_status === k).length])),
    ageDays_actualTimestamps: { found: rngOf(todayFound, "age_days_from_tip"), notFound: rngOf(todayNot, "age_days_from_tip") },
  },
};
writeFileSync(resolve(RES, "exp1c_tx_age_summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
