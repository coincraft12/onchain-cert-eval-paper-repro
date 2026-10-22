#!/usr/bin/env node
/**
 * SC-DEV-PRO-M1 ruleSetId 계산 — GENERIC-R1(build-generic-r1.mjs)과 같은 방식.
 *
 * SC-DEV-PRO-M1-ruleset.json은 사람이 읽는 감사용 주석 키(_comment, examMeta._note,
 * sessionBoundaryRule._comment, stateMachine._comment)가 섞여 있다. 운영 도구(scripts/compute-mission-ids.mjs)는
 * 해시 계산 전에 이 주석 키만 제거하고 나머지를 canonicalSerialize 한다. 이 스크립트는 그 정규화를
 * 그대로 재현해, 해시에 실제로 들어간 정규 본문(ruleSetBody)과 ruleSetId를 SC-DEV-PRO-M1.json으로 공개한다.
 *
 * 실행: node rulesets/build-sc-dev-pro-m1.mjs   (sdk 빌드 필요: cd sdk && npm run build)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRuleSetId } from "../sdk/dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(resolve(HERE, "SC-DEV-PRO-M1-ruleset.json"), "utf-8"));

const body = structuredClone(raw);
delete body._comment;
if (body.examMeta?._note !== undefined) delete body.examMeta._note;
if (body.sessionBoundaryRule?._comment !== undefined) delete body.sessionBoundaryRule._comment;
if (body.sessionBoundaryRule?.stateMachine?._comment !== undefined) delete body.sessionBoundaryRule.stateMachine._comment;

const leftover = JSON.stringify(body).match(/"_[A-Za-z]+"\s*:/g);
if (leftover) throw new Error(`주석 키가 남아 있음: ${leftover.join(", ")}`);

const ruleSetId = computeRuleSetId(body);

const output = {
  _comment:
    "SC-DEV-PRO-M1 ruleSet v1.2.0 — 정규 본문(ruleSetBody)과 ruleSetId. SC-DEV-PRO-M1-ruleset.json에서 감사용 주석 키(_comment, examMeta._note, sessionBoundaryRule._comment, stateMachine._comment)만 제거하고 canonicalSerialize+keccak256으로 계산(scripts/compute-mission-ids.mjs와 동일 절차). `node rulesets/build-sc-dev-pro-m1.mjs`로 재현.",
  ruleSetId,
  ruleSetBody: body,
};
writeFileSync(resolve(HERE, "SC-DEV-PRO-M1.json"), JSON.stringify(output, null, 2));
console.log(`ruleSetId = ${ruleSetId}`);
