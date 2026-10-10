#!/usr/bin/env node
/**
 * exp1b(체인 끝 관찰)·exp1c(입력 완전성 검사) 결과 JSON → CSV 변환.
 * 원본 수치를 그대로 옮길 뿐 새로운 계산 없음 — raw/exp1b_chaintip_summary.json,
 * raw/exp1c_integrity_check_result.json 참고.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(HERE, "raw");

// ---- exp1c: 지갑별 완전성 검사 판정 ----
const exp1c = JSON.parse(readFileSync(resolve(RAW_DIR, "exp1c_integrity_check_result.json"), "utf-8"));
const header1c = "wallet_hash,verdict,alchemy_complete,alchemy_sessionRoot,alchemy_avgScore,publicnode_complete,publicnode_sessionRoot,publicnode_avgScore";
const rows1c = exp1c.perWalletResult.map((r) =>
  [
    r.wallet_hash,
    r.verdict,
    r.alchemy.complete,
    r.alchemy.sessionRoot ?? "",
    r.alchemy.avgScore ?? "",
    r.publicnode.complete,
    r.publicnode.sessionRoot ?? "",
    r.publicnode.avgScore ?? "",
  ].join(","),
);
writeFileSync(resolve(HERE, "exp1c_integrity_check.csv"), [header1c, ...rows1c].join("\n") + "\n");
console.log(`exp1c_integrity_check.csv: ${rows1c.length}행 (요약: ${JSON.stringify(exp1c.counts)})`);
